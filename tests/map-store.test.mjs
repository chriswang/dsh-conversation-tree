/**
 * Behavior tests for the client map store.
 *
 * The store is exercised against a fake Host RPC channel, a fake clock and a
 * fake Web Storage, so these tests cover the real load/migrate/commit/rebase
 * algorithm without a browser or a DSH runtime.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { contentSearchReply, createMapStore, LOCAL_BACKUP_KEY } from '../lib/map-store.js'
import { createNode, emptyMap, ensureDefaultSpace } from '../lib/model.js'

/** A fresh Host document (default space guaranteed, no organization data). */
function freshDoc() {
  return ensureDefaultSpace(emptyMap())
}

/**
 * One Web-Storage-shaped double.
 * @param entries - initial keys.
 * @returns the storage plus its backing map.
 */
function fakeStorage(entries = {}) {
  const backing = new Map(Object.entries(entries))
  return {
    backing,
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
    removeItem: key => { backing.delete(key) },
  }
}

/**
 * A fake DSH Connection channel with a CAS Host document.
 * @param doc - initial document.
 * @returns the host double.
 */
function fakeHost(doc = freshDoc()) {
  let revision = 0
  let current = doc
  let failNext = false
  return {
    get document() { return { revision, doc: current } },
    /** Simulate another writer (model tool or another window). */
    externalCommit(next) { current = next; revision += 1 },
    failNextCall() { failNext = true },
    rpc: {
      async call(channel, carrierEndpoint, carrierPayload) {
        assert.equal(channel, '/api')
        assert.equal(carrierEndpoint, 'conversation-map')
        const endpoint = carrierPayload.endpoint
        const payload = carrierPayload.payload
        if (failNext) {
          failNext = false
          throw new Error('network down')
        }
        if (endpoint === 'ping') return { ok: true, value: { host: true, revision } }
        if (endpoint === 'state') {
          if (typeof payload?.sinceRevision === 'number' && payload.sinceRevision === revision) {
            return { ok: true, value: { revision, unchanged: true } }
          }
          return { ok: true, value: { revision, unchanged: false, doc: current } }
        }
        if (endpoint === 'put') {
          if (payload.baseRevision !== revision) {
            return { ok: false, error: { code: 'map/conflict', message: 'revision moved', details: { revision } } }
          }
          current = payload.doc
          revision += 1
          return { ok: true, value: { revision } }
        }
        return { ok: false, error: { code: 'map/not-found', message: 'unknown endpoint' } }
      },
    },
  }
}

/** A fake clock whose timers fire only when the test asks. */
function fakeClock() {
  let sequence = 0
  const timeouts = new Map()
  const intervals = new Map()
  return {
    setTimeout(handler) {
      const id = ++sequence
      if (typeof handler === 'function') timeouts.set(id, () => { timeouts.delete(id); handler() })
      return id
    },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(handler) {
      const id = ++sequence
      if (typeof handler === 'function') intervals.set(id, handler)
      return id
    },
    clearInterval(id) { intervals.delete(id) },
    /** Fire every armed timeout, awaiting the async work it starts. */
    async fireTimeouts() {
      const handlers = [...timeouts.values()]
      timeouts.clear()
      for (const handler of handlers) await handler()
      await idle()
    },
    /** Run one polling tick. */
    async fireInterval() {
      for (const handler of [...intervals.values()]) handler()
      await idle()
    },
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
  }
}

/** Wait until the microtask/immediate queue drains (store work is async). */
async function idle() {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

/**
 * Create a store wired to the fakes.
 * @param host - host double, or undefined for "no Host channel".
 * @param storage - storage double.
 * @param clock - fake clock.
 * @returns the store plus the captured options.
 */
function makeStore(host, storage, clock) {
  return createMapStore({
    ctx: { get: name => name === 'connection' && host !== undefined ? { rpc: host.rpc } : undefined },
    storage,
    autoStart: false,
    now: () => 1_000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    isVisible: () => true,
    commitDebounceMs: 10,
    retryMinMs: 10,
    retryMaxMs: 10,
    pollMs: 10,
  })
}

/** A document with one node in workspace `w1`. */
function docWithNode(title, id = 'n1') {
  const doc = freshDoc()
  return createNode(doc, { parentId: null, workspaceId: 'w1', title, id }).state
}

test('without a Host channel the store stays in local mode and persists locally', async () => {
  const storage = fakeStorage({ 'dsh.conversation-map.v1': JSON.stringify(docWithNode('local')) })
  const clock = fakeClock()
  const store = makeStore(undefined, storage, clock)
  await store.load()
  assert.equal(store.getSnapshot().phase, 'local')
  assert.equal(store.getSnapshot().doc.nodes[0].title, 'local')
  store.update(doc => createNode(doc, { parentId: null, workspaceId: 'w1', title: 'second', id: 'n2' }).state)
  const persisted = JSON.parse(storage.getItem('dsh.conversation-map.v1'))
  assert.equal(persisted.nodes.length, 2)
  store.dispose()
})

test('an empty Host adopts the local document once and retires the local key', async () => {
  const host = fakeHost(freshDoc())
  const storage = fakeStorage({ 'dsh.conversation-map.v1': JSON.stringify(docWithNode('migrate me')) })
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().revision, 1)
  assert.equal(host.document.revision, 1)
  assert.equal(host.document.doc.nodes[0].title, 'migrate me')
  assert.equal(storage.getItem('dsh.conversation-map.v1'), null)
  assert.ok(storage.getItem(LOCAL_BACKUP_KEY) !== null, 'local copy kept as backup')
  store.dispose()
})

test('a populated Host always wins and the divergent local copy is backed up', async () => {
  const host = fakeHost(docWithNode('host version'))
  const storage = fakeStorage({ 'dsh.conversation-map.v1': JSON.stringify(docWithNode('local version')) })
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().doc.nodes[0].title, 'host version')
  assert.equal(host.document.revision, 0, 'adopting never commits')
  assert.equal(storage.getItem('dsh.conversation-map.v1'), null)
  assert.match(storage.getItem(LOCAL_BACKUP_KEY), /local version/)
  store.dispose()
})

test('an optimistic update is committed against the Host revision', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  store.update(doc => createNode(doc, { parentId: null, workspaceId: 'w1', title: 'created', id: 'n1' }).state)
  assert.equal(store.getSnapshot().doc.nodes.length, 1, 'optimistically applied')
  assert.equal(store.getSnapshot().pending, 1)
  await clock.fireTimeouts()
  assert.equal(store.getSnapshot().pending, 0)
  assert.equal(store.getSnapshot().revision, 1)
  assert.equal(host.document.doc.nodes[0].title, 'created')
  store.dispose()
})

test('a conflict rebases the pending mutations onto the newer Host document', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  store.update(doc => createNode(doc, { parentId: null, workspaceId: 'w1', title: 'mine', id: 'mine' }).state)
  // Another writer commits before our debounce fires.
  host.externalCommit(createNode(host.document.doc, { parentId: null, workspaceId: 'w1', title: 'theirs', id: 'theirs' }).state)
  await clock.fireTimeouts()
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.pending, 0)
  assert.equal(snapshot.revision, 2, 'the external commit plus the rebased commit')
  assert.deepEqual(host.document.doc.nodes.map(node => node.title).sort(), ['mine', 'theirs'])
  assert.deepEqual(snapshot.doc.nodes.map(node => node.title).sort(), ['mine', 'theirs'])
  store.dispose()
})

test('a transport failure keeps the mutation queued and a retry commits it', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  host.failNextCall()
  store.update(doc => createNode(doc, { parentId: null, workspaceId: 'w1', title: 'retry me', id: 'n1' }).state)
  await clock.fireTimeouts()
  assert.equal(store.getSnapshot().pending, 1, 'mutation stays queued')
  assert.equal(store.getSnapshot().error?.kind, 'sync-retry')
  await clock.fireTimeouts()
  assert.equal(store.getSnapshot().pending, 0)
  assert.equal(host.document.doc.nodes[0].title, 'retry me')
  store.dispose()
})

test('polling adopts an externally written document', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  host.externalCommit(docWithNode('from the model'))
  await clock.fireInterval()
  assert.equal(store.getSnapshot().doc.nodes[0].title, 'from the model')
  assert.equal(store.getSnapshot().revision, 1)
  store.dispose()
})

test('polling does not clobber pending local writes', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  store.update(doc => createNode(doc, { parentId: null, workspaceId: 'w1', title: 'pending', id: 'n1' }).state)
  host.externalCommit(docWithNode('theirs', 'theirs'))
  // A tick flushes then adopts; it must not drop the pending mutation.
  await clock.fireInterval()
  assert.equal(store.getSnapshot().doc.nodes.some(node => node.title === 'pending'), true)
  assert.equal(store.getSnapshot().doc.nodes.some(node => node.title === 'theirs'), true)
  store.dispose()
})

test('dispose clears timers and subscriptions', async () => {
  const host = fakeHost()
  const storage = fakeStorage()
  const clock = fakeClock()
  const store = makeStore(host, storage, clock)
  await store.load()
  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.dispose()
  assert.equal(clock.intervalCount(), 0)
  assert.equal(clock.timeoutCount(), 0)
  assert.equal(notified, 0)
})

test('conversation-body replies are sanitised at the store boundary', () => {
  const reply = contentSearchReply({
    hits: [
      { sessionId: 's1', messages: 3, snippet: { before: 'a', match: 'B', after: 'c' } },
      { sessionId: '', messages: 1 },
      { messages: 2 },
      { sessionId: 's2', messages: 'x', snippet: { before: 1, match: 'B', after: 'c' } },
    ],
    scanned: 2,
    total: 4,
    done: false,
  })
  assert.deepEqual(reply.hits.map(hit => hit.sessionId), ['s1', 's2'], 'malformed hits are dropped, not rendered')
  assert.equal(reply.hits[1].messages, 0, 'a non-numeric count degrades to zero')
  assert.equal(reply.hits[1].snippet, null, 'an incomplete snippet degrades to none')
  assert.equal(reply.scanned, 2)
  assert.equal(reply.total, 4)
  assert.equal(reply.done, false)
  assert.equal(contentSearchReply(null), undefined)
  assert.equal(contentSearchReply({ hits: 'nope' }), undefined)
})
