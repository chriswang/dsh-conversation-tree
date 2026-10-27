/**
 * Behavior tests for the Host-side authoritative map store.
 *
 * The store owns the document file, its backup, the commit sequence and the CAS
 * token; these tests drive the real built module in a temporary directory.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMapFileStore, normalizeDocument } from '../lib/host-store.js'
import { createNode, emptyMap, ensureDefaultSpace } from '../lib/model.js'

/** A fresh, default-space-bearing document. */
function freshDoc() {
  return ensureDefaultSpace(emptyMap())
}

/**
 * Run one test inside an isolated directory that is always removed.
 * @param {string} _name - label (unused).
 * @param {(context: { dir: string, file: string, store: object }) => Promise<void>} run - body.
 * @param {object} options - extra store options.
 */
async function withStore(_name, run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-map-store-'))
  try {
    const file = join(dir, 'map.json')
    const store = createMapFileStore({ filePath: file, ...options })
    await run({ dir, file, store })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('an absent document loads as an empty default-space map', async () => {
  await withStore('empty', async ({ dir, store }) => {
    assert.deepEqual(await store.load(), { corrupt: false })
    await store.ready()
    assert.equal(store.snapshot().revision, 0)
    assert.equal(store.snapshot().doc.nodes.length, 0)
    assert.equal(store.snapshot().doc.spaces.length, 1)
    assert.equal(store.corrupt(), false)
    assert.equal(store.dataDir(), dir)
  })
})

test('a commit persists one envelope, advances revision, and keeps one backup', async () => {
  await withStore('commit', async ({ dir, file, store }) => {
    await store.ready()
    const first = await store.commit(freshDoc(), 0, 'client:test')
    assert.equal(first.revision, 1)

    const envelope = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(envelope.format, 1)
    assert.equal(envelope.revision, 1)
    assert.equal(envelope.writer, 'client:test')
    assert.equal(envelope.doc.version, 2)
    assert.equal(typeof envelope.updatedAt, 'string')

    const second = await store.commit(freshDoc(), 1, 'agent:s1')
    assert.equal(second.revision, 2)
    const backup = JSON.parse(await readFile(`${file}.bak`, 'utf8'))
    assert.equal(backup.revision, 1)

    const leftovers = (await readdir(dir)).filter(name => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  })
})

test('a stale base revision is a conflict carrying the current revision', async () => {
  await withStore('conflict', async ({ store }) => {
    await store.ready()
    await store.commit(freshDoc(), 0, 'client:a')
    await assert.rejects(
      () => store.commit(freshDoc(), 0, 'client:b'),
      error => error instanceof Error
        && error.name === 'MapStoreError'
        && error.code === 'CONFLICT'
        && error.details.revision === 1,
    )
    assert.equal(store.snapshot().revision, 1)
  })
})

test('a document that is not a map document is rejected without advancing', async () => {
  await withStore('invalid', async ({ store }) => {
    await store.ready()
    await assert.rejects(
      () => store.commit({ version: 9, revision: 0, nodes: [], threads: [] }, 0, 'client:test'),
      error => error instanceof Error && error.name === 'MapStoreError' && error.code === 'INVALID',
    )
    assert.equal(store.snapshot().revision, 0)
  })
})

test('an oversized document is rejected before touching the file', async () => {
  await withStore('too-large', async ({ store }) => {
    await store.ready()
    await assert.rejects(
      () => store.commit(freshDoc(), 0, 'client:test'),
      error => error instanceof Error && error.name === 'MapStoreError' && error.code === 'TOO_LARGE',
    )
    assert.equal(store.snapshot().revision, 0)
  }, { maxDocBytes: 64 })
})

test('an unreadable live document falls back to the backup and names the loss', async () => {
  await withStore('backup', async ({ file, store }) => {
    await store.ready()
    const one = freshDoc()
    one.nodes = [createNode(one, { parentId: null, workspaceId: 'ws', title: 'first', id: 'n1' }).state.nodes[0]]
    await store.commit(one, 0, 'client:test')
    const two = store.snapshot().doc
    two.nodes = [createNode(two, { parentId: null, workspaceId: 'ws', title: 'second', id: 'n2' }).state.nodes[0]]
    await store.commit(two, 1, 'client:test')

    await writeFile(file, '{ not json', 'utf8')
    const recovered = createMapFileStore({ filePath: file })
    assert.deepEqual(await recovered.load(), { corrupt: true })
    assert.equal(recovered.snapshot().revision, 1)
    assert.equal(recovered.snapshot().doc.nodes.length, 1)
    assert.equal(recovered.snapshot().doc.nodes[0].title, 'first')
  })
})

test('when both files are unreadable the store resets and preserves the file for inspection', async () => {
  await withStore('corrupt', async ({ dir, file }) => {
    await writeFile(file, 'garbage', 'utf8')
    await writeFile(`${file}.bak`, 'also garbage', 'utf8')
    const store = createMapFileStore({ filePath: file })
    assert.deepEqual(await store.load(), { corrupt: true })
    assert.equal(store.snapshot().revision, 0)
    assert.equal(store.snapshot().doc.nodes.length, 0)
    const preserved = (await readdir(dir)).filter(name => name.includes('.corrupt-'))
    assert.equal(preserved.length, 1)
  })
})

test('concurrent applies are serialized on one write chain', async () => {
  await withStore('serial', async ({ store }) => {
    await store.ready()
    const results = await Promise.all(Array.from({ length: 5 }, (_item, index) => store.apply(doc => {
      const created = createNode(doc, { parentId: null, workspaceId: 'ws', title: `node ${index}`, id: `n${index}` })
      return { doc: created.state, value: created.id }
    }, 'agent:test')))
    assert.deepEqual(results.map(result => result.value).sort(), ['n0', 'n1', 'n2', 'n3', 'n4'])
    assert.equal(store.snapshot().revision, 5)
    assert.equal(store.snapshot().doc.nodes.length, 5)
  })
})

test('normalizeDocument sanitizes ownership and guarantees the default space', () => {
  const doc = normalizeDocument({ version: 2, revision: 3, nodes: [], threads: [] }, 'test')
  assert.equal(doc.version, 2)
  assert.equal(doc.spaces.length, 1)
  assert.equal(doc.defaultSpaceId, doc.spaces[0].id)
  assert.throws(() => normalizeDocument({ version: 2 }, 'test'), error => error.code === 'INVALID')
})
