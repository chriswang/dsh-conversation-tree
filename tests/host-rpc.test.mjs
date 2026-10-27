/**
 * Behavior tests for the browser-facing RPC endpoints over the Host store.
 *
 * `dispatchMapRpc` is transport-free, so these exercise the real endpoint
 * contract (state/put/ping/conflict/unknown) without booting a Web server.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { dispatchMapRpc } from '../lib/host-rpc.js'
import { createMapFileStore } from '../lib/host-store.js'
import { emptyMap, ensureDefaultSpace } from '../lib/model.js'

/** One document the browser may submit. */
function freshDoc() {
  return ensureDefaultSpace(emptyMap())
}

/** Run one case against a temporary store. */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-map-rpc-'))
  try {
    const store = createMapFileStore({ filePath: join(dir, 'map.json') })
    await store.ready()
    await run(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ping reports host, revision, data directory and document version', async () => {
  await withStore(async (store) => {
    const result = await dispatchMapRpc(store, 'ping', {})
    assert.equal(result.ok, true)
    assert.equal(result.value.host, true)
    assert.equal(result.value.revision, 0)
    assert.equal(result.value.docVersion, 2)
    assert.equal(result.value.corrupt, false)
    assert.match(result.value.dataDir, /conversation-map-rpc-/)
  })
})

test('state answers unchanged for the current revision and the document otherwise', async () => {
  await withStore(async (store) => {
    const initial = await dispatchMapRpc(store, 'state', {})
    assert.equal(initial.ok, true)
    assert.equal(initial.value.unchanged, false)
    assert.equal(initial.value.doc.version, 2)

    const unchanged = await dispatchMapRpc(store, 'state', { sinceRevision: 0 })
    assert.equal(unchanged.ok, true)
    assert.equal(unchanged.value.unchanged, true)

    const put = await dispatchMapRpc(store, 'put', { baseRevision: 0, doc: freshDoc(), client: 'client:test' })
    assert.equal(put.ok, true)
    assert.equal(put.value.revision, 1)

    const fresh = await dispatchMapRpc(store, 'state', { sinceRevision: 0 })
    assert.equal(fresh.value.unchanged, false)
    assert.equal(fresh.value.revision, 1)
  })
})

test('put rejects a stale base revision with the conflict envelope', async () => {
  await withStore(async (store) => {
    await dispatchMapRpc(store, 'put', { baseRevision: 0, doc: freshDoc() })
    const conflict = await dispatchMapRpc(store, 'put', { baseRevision: 0, doc: freshDoc() })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'map/conflict')
    assert.equal(conflict.error.details.revision, 1)
  })
})

test('put rejects malformed payloads and invalid documents', async () => {
  await withStore(async (store) => {
    const missing = await dispatchMapRpc(store, 'put', {})
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'map/invalid')

    const invalid = await dispatchMapRpc(store, 'put', { baseRevision: 0, doc: { version: 9 } })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error.code, 'map/invalid')
  })
})

test('unknown endpoints answer a not-found failure instead of throwing', async () => {
  await withStore(async (store) => {
    const result = await dispatchMapRpc(store, 'nope', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'map/not-found')
  })
})

test('the HTTP carrier accepts the browser envelope and echoes its rpcId', async () => {
  const { handleMapRpcRequest } = await import('../lib/host-rpc.js')
  await withStore(async (store) => {
    const request = new Request('http://host/api/conversation-map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-1',
        method: 'conversation-map',
        payload: { endpoint: 'ping', payload: {} },
      }),
    })
    const response = await handleMapRpcRequest(store, request)
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, 'rpc-1')
    assert.equal(envelope.result.ok, true)
    assert.equal(envelope.result.value.host, true)
  })
})

test('a malformed carrier envelope answers an error result instead of throwing', async () => {
  const { handleMapRpcRequest } = await import('../lib/host-rpc.js')
  await withStore(async (store) => {
    const response = await handleMapRpcRequest(store, new Request('http://host/api/conversation-map', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'nope' }),
    }))
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.result.ok, false)
    assert.equal(envelope.result.error.code, 'map/invalid')
  })
})
