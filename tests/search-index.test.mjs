/**
 * Behavior tests for the Host conversation-body search index.
 *
 * A full session store is far too large to index in one pass, so the index is
 * budgeted and progressive: one call covers what fits and reports `done: false`,
 * the caller polls until every candidate is covered, and the cache makes repeat
 * queries and unchanged conversations cheap. The fixtures below build temporary
 * sessions roots with plaintext JSONL logs (the compressed variant's decoding is
 * covered by `session-text.test.mjs`), plus one RPC-level integration case.
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dispatchMapRpc } from '../lib/host-rpc.js'
import { createContentSearchIndex } from '../lib/host-search-index.js'
import { createMapFileStore } from '../lib/host-store.js'

/** The persisted Session header (not a message). */
const HEADER = { type: 'session', version: 4, id: 'session-header', createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0 }

/** One real user message. */
function userRecord(text) {
  return {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** One assistant message (current v4 shape). */
function assistantRecord(text) {
  return {
    type: 'assistant/message',
    seq: 2,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

/**
 * Write one Session's log under the sessions root.
 * @returns {Promise<string>} the log file path.
 */
async function writeSessionLog(root, project, sessionId, records) {
  const directory = join(root, project, sessionId)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'session.v4.jsonl')
  await writeFile(file, records.map(record => `${JSON.stringify(record)}\n`).join(''))
  return file
}

/** Write one Session whose messages are the given user texts. */
function writeUserSession(root, project, sessionId, texts) {
  return writeSessionLog(root, project, sessionId, [HEADER, ...texts.map(userRecord)])
}

/** Run one body inside an isolated temporary directory. */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-map-search-index-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A clock the test advances by hand. */
function manualClock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance(milliseconds) {
      value += milliseconds
    },
  }
}

/** Search until the index reports `done`, with a hard iteration ceiling. */
function drain(index, request, limit = 100) {
  let reply = index.search(request)
  let rounds = 1
  while (!reply.done && rounds < limit) {
    reply = index.search(request)
    rounds += 1
  }
  assert.equal(reply.done, true, `search never completed after ${rounds} rounds`)
  return reply
}

test('indexing is progressive under a zero budget and converges to one stable reply', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    for (const id of ['session-a', 'session-b', 'session-c']) {
      await writeUserSession(root, 'project-1', id, [`${id} 提到 needle`])
    }
    const index = createContentSearchIndex({ sessionsRoot: root })
    const request = { query: 'needle', sessionIds: ['session-a', 'session-b', 'session-c'], budgetMs: 0 }

    const first = index.search(request)
    assert.equal(first.done, false)
    assert.equal(first.total, 3)
    assert.ok(first.scanned < first.total, `scanned ${first.scanned} should trail total ${first.total}`)
    assert.ok(first.hits.length < 3)

    const final = drain(index, request)
    assert.equal(final.scanned, 3)
    assert.deepEqual(final.hits.map(hit => hit.sessionId), ['session-a', 'session-b', 'session-c'])

    // Once covered, another call answers from the cache and returns the same hits.
    const again = index.search(request)
    assert.equal(again.done, true)
    assert.deepEqual(again.hits, final.hits)
  })
})

test('an unchanged Session is not re-read and a changed one is', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    const file = await writeUserSession(root, 'project-1', 'session-a', ['alpha only'])
    const index = createContentSearchIndex({ sessionsRoot: root })
    const request = { query: 'beta', sessionIds: ['session-a'] }

    assert.deepEqual(index.search(request).hits, [])

    // Same size and mtime would be indistinguishable; the rewrite changes both.
    await writeFile(file, [HEADER, userRecord('beta appears now')].map(record => `${JSON.stringify(record)}\n`).join(''))
    const changed = index.search(request)
    assert.equal(changed.done, true)
    assert.equal(changed.hits.length, 1)
    assert.equal(changed.hits[0].sessionId, 'session-a')

    // A vanished log stops contributing instead of failing the search.
    await unlink(file)
    const removed = index.search({ query: 'beta', sessionIds: ['session-a'] })
    assert.equal(removed.done, true)
    assert.deepEqual(removed.hits, [])
  })
})

test('matching is case-insensitive and the snippet keeps the source casing', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    const long = `${'开头'.repeat(60)}NEEDLE hidden${'结尾'.repeat(60)}`
    await writeSessionLog(root, 'project-1', 'session-ascii', [HEADER, userRecord(long)])
    await writeSessionLog(root, 'project-1', 'session-assistant', [HEADER, assistantRecord('助手也提到了 Needle')])
    await writeUserSession(root, 'project-1', 'session-chinese', ['今天的任务清单'])

    const index = createContentSearchIndex({ sessionsRoot: root })
    const ids = ['session-ascii', 'session-assistant', 'session-chinese']

    const lower = drain(index, { query: 'needle', sessionIds: ids })
    assert.deepEqual(lower.hits.map(hit => hit.sessionId).sort(), ['session-ascii', 'session-assistant'])
    const asciiSnippet = lower.hits.find(hit => hit.sessionId === 'session-ascii').snippet
    assert.equal(asciiSnippet.match, 'NEEDLE')
    assert.ok(asciiSnippet.before.startsWith('…'))
    assert.ok(asciiSnippet.after.endsWith('…'))

    const upper = drain(index, { query: 'NEEDLE', sessionIds: ids })
    assert.deepEqual(upper.hits.map(hit => hit.sessionId).sort(), ['session-ascii', 'session-assistant'])

    const chinese = drain(index, { query: '任务', sessionIds: ids })
    assert.equal(chinese.hits.length, 1)
    assert.equal(chinese.hits[0].sessionId, 'session-chinese')
    assert.equal(chinese.hits[0].snippet.match, '任务')
  })
})

test('a query shorter than two characters searches no bodies but still indexes', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    await writeUserSession(root, 'project-1', 'session-a', ['任意内容'])
    const index = createContentSearchIndex({ sessionsRoot: root })
    const reply = drain(index, { query: ' 任 ', sessionIds: ['session-a'] })
    assert.deepEqual(reply.hits, [])
    assert.equal(reply.scanned, 1)
    assert.equal(reply.total, 1)
    assert.equal(reply.done, true)
  })
})

test('hits count matched messages, rank by count, and cap the reported count', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    await writeUserSession(root, 'project-1', 'session-two', ['needle one', 'needle two'])
    await writeUserSession(root, 'project-1', 'session-one', ['just one needle'])
    await writeUserSession(root, 'project-1', 'session-none', ['nothing here'])
    await writeUserSession(root, 'project-1', 'session-many', Array.from({ length: 120 }, (_, i) => `needle ${i}`))

    const index = createContentSearchIndex({ sessionsRoot: root })
    const reply = drain(index, {
      query: 'needle',
      sessionIds: ['session-two', 'session-one', 'session-none', 'session-many'],
    })

    assert.deepEqual(reply.hits.map(hit => hit.sessionId), ['session-many', 'session-two', 'session-one'])
    assert.equal(reply.hits[0].messages, 99) // capped
    assert.equal(reply.hits[1].messages, 2)
    assert.equal(reply.hits[2].messages, 1)
    assert.equal(reply.hits[1].snippet.match, 'needle')
  })
})

test('hits are capped and candidates are deduplicated and capped', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    const ids = Array.from({ length: 45 }, (_, i) => `session-${String(i).padStart(2, '0')}`)
    for (const id of ids) await writeUserSession(root, 'project-1', id, [`needle in ${id}`])

    const index = createContentSearchIndex({ sessionsRoot: root })
    const reply = drain(index, { query: 'needle', sessionIds: ids })
    assert.equal(reply.hits.length, 40)
    assert.deepEqual(reply.hits.map(hit => hit.sessionId), ids.slice(0, 40))

    const deduped = index.search({ query: 'needle', sessionIds: [ids[0], ids[0]], budgetMs: 0 })
    assert.equal(deduped.total, 1)

    const many = Array.from({ length: 600 }, (_, i) => `ghost-${i}`)
    const capped = index.search({ query: 'needle', sessionIds: many, budgetMs: 0 })
    assert.equal(capped.total, 500)
  })
})

test('a Session missing from the store is not retried until the listing refreshes', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'sessions')
    await writeUserSession(root, 'project-1', 'session-present', ['needle here'])
    const clock = manualClock()
    const index = createContentSearchIndex({ sessionsRoot: root, now: clock.now })
    const request = { query: 'needle', sessionIds: ['session-present', 'session-ghost'] }

    const first = index.search(request)
    assert.equal(first.done, true)
    assert.equal(first.scanned, 2)
    assert.equal(first.hits.length, 1)

    // The log appears, but the cached listing does not know about it yet: the
    // missing Session is treated as covered empty, not re-probed on every call.
    await writeUserSession(root, 'project-1', 'session-ghost', ['needle appeared'])
    const cached = index.search(request)
    assert.equal(cached.done, true)
    assert.equal(cached.hits.length, 1)

    // After the listing TTL the new directory is discovered and indexed.
    clock.advance(11_000)
    const refreshed = index.search(request)
    assert.equal(refreshed.done, true)
    assert.equal(refreshed.scanned, 2)
    assert.deepEqual(refreshed.hits.map(hit => hit.sessionId).sort(), ['session-ghost', 'session-present'])
  })
})

test('an empty candidate list answers done with no hits', async () => {
  await withTempDir(async (dir) => {
    const index = createContentSearchIndex({ sessionsRoot: join(dir, 'sessions') })
    const reply = index.search({ query: 'needle', sessionIds: [] })
    assert.deepEqual(reply, { hits: [], scanned: 0, total: 0, done: true })
  })
})

test('search-content RPC validates payloads and answers body hits', async () => {
  await withTempDir(async (dir) => {
    const sessionsRoot = join(dir, 'sessions')
    await writeUserSession(sessionsRoot, 'project-1', 'session-rpc', ['RPC 正文里的 Needle'])
    const store = createMapFileStore({ filePath: join(dir, 'map.json') })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = dir
    try {
      const reply = await dispatchMapRpc(store, 'search-content', {
        query: 'needle',
        sessionIds: ['session-rpc'],
        budgetMs: 200,
      })
      assert.equal(reply.ok, true)
      assert.equal(reply.value.total, 1)
      assert.equal(reply.value.scanned, 1)
      assert.equal(reply.value.done, true)
      assert.equal(reply.value.hits.length, 1)
      assert.equal(reply.value.hits[0].sessionId, 'session-rpc')
      assert.equal(reply.value.hits[0].messages, 1)
      assert.equal(reply.value.hits[0].snippet.match, 'Needle')

      // An oversized budget is clamped, not trusted.
      const clamped = await dispatchMapRpc(store, 'search-content', {
        query: 'needle',
        sessionIds: ['session-rpc'],
        budgetMs: 999_999,
      })
      assert.equal(clamped.ok, true)
      assert.equal(clamped.value.done, true)

      // Non-string session ids are dropped at the transport edge.
      const junkIds = await dispatchMapRpc(store, 'search-content', {
        query: 'needle',
        sessionIds: [123, '', 'session-rpc'],
      })
      assert.equal(junkIds.ok, true)
      assert.equal(junkIds.value.total, 1)

      const invalid = [
        null,
        {},
        { query: 5, sessionIds: [] },
        { query: 'needle' },
        { query: 'needle', sessionIds: 'session-rpc' },
        { query: 'needle', sessionIds: [], budgetMs: 'fast' },
      ]
      for (const payload of invalid) {
        const failed = await dispatchMapRpc(store, 'search-content', payload)
        assert.equal(failed.ok, false, `payload ${JSON.stringify(payload)} should be refused`)
        assert.equal(failed.error.code, 'map/invalid')
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
