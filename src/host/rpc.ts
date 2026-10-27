/**
 * Browser-facing RPC over the DSH Connection transport.
 *
 * The plugin mounts one exact `POST /api/conversation-map` route through the
 * Connection Fetch registry. That route sits behind the shared `/api` handler,
 * so Host/Origin checks and the browser session cookie are enforced before this
 * module runs. The envelopes mirror the generic Connection RPC wire (the
 * dispatcher's result goes into `{ type: 'server-response', rpcId, result }`),
 * which lets the browser half call it with the standard
 * `connection.rpc.call('/api', 'conversation-map', …)` carrier.
 *
 * Handlers must never throw: a throw would surface to the browser as a
 * transport failure with no code, so every failure is folded into the result.
 */
import type { MapState } from '../shared/model.js'
import type { ContentSearchRequest } from '../shared/search.js'
import type { ConnectionLike, HostContextLike, RpcResult } from './context.js'
import { MapStoreError } from './errors.js'
import { DOC_VERSION, sessionsDirectory } from './paths.js'
import { createContentSearchIndex, MAX_SEARCH_BUDGET_MS, type ContentSearchIndex } from './search-index.js'
import type { MapFileStore } from './store.js'

/** Exact path the browser posts to (below the authenticated `/api` channel). */
export const RPC_PATH = '/api/conversation-map'

/** Endpoint name the browser carrier posts the envelope as (`method` field). */
export const RPC_METHOD = 'conversation-map'

/** Failure envelope returned to the browser. */
export interface MapRpcFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details?: object }
}

/**
 * Map one thrown failure to the RPC error envelope.
 * @param error - the thrown value.
 * @returns the browser-facing failure.
 */
export function rpcFailure(error: unknown): MapRpcFailure {
  if (error instanceof MapStoreError) {
    switch (error.code) {
      case 'CONFLICT':
        return {
          ok: false,
          error: {
            code: 'map/conflict',
            message: error.message,
            details: { revision: error.details?.revision ?? 0 },
          },
        }
      case 'TOO_LARGE':
        return { ok: false, error: { code: 'map/too-large', message: error.message } }
      case 'INVALID':
        return { ok: false, error: { code: 'map/invalid', message: error.message } }
      case 'IO':
        return { ok: false, error: { code: 'map/io', message: error.message } }
    }
  }
  return {
    ok: false,
    error: { code: 'map/internal', message: error instanceof Error ? error.message : String(error) },
  }
}

/** Payload guard used by the `put` endpoint. */
function putPayload(payload: unknown): { baseRevision: number; doc: MapState; client: string } {
  if (typeof payload !== 'object' || payload === null) {
    throw new MapStoreError('INVALID', 'put payload must be an object')
  }
  const candidate = payload as { baseRevision?: unknown; doc?: unknown; client?: unknown }
  if (typeof candidate.baseRevision !== 'number' || !Number.isInteger(candidate.baseRevision) || candidate.baseRevision < 0) {
    throw new MapStoreError('INVALID', 'put payload baseRevision must be a non-negative integer')
  }
  if (candidate.doc === undefined || typeof candidate.doc !== 'object' || candidate.doc === null) {
    throw new MapStoreError('INVALID', 'put payload must carry a document object')
  }
  const client = typeof candidate.client === 'string' && candidate.client !== '' ? candidate.client : 'client:unknown'
  return { baseRevision: candidate.baseRevision, doc: candidate.doc as MapState, client }
}

/**
 * Payload guard used by the `search-content` endpoint.
 *
 * The payload crosses an untrusted transport boundary; a malformed request is
 * refused with the same `map/invalid` envelope the other endpoints use. The
 * indexing budget is clamped rather than trusted, so a client typo cannot turn
 * one keystroke into a multi-second Host stall.
 * @param payload - decoded JSON payload.
 * @returns a normalized search request.
 */
function searchContentPayload(payload: unknown): ContentSearchRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new MapStoreError('INVALID', 'search-content payload must be an object')
  }
  const candidate = payload as { query?: unknown; sessionIds?: unknown; budgetMs?: unknown }
  if (typeof candidate.query !== 'string') {
    throw new MapStoreError('INVALID', 'search-content payload query must be a string')
  }
  if (!Array.isArray(candidate.sessionIds)) {
    throw new MapStoreError('INVALID', 'search-content payload sessionIds must be an array')
  }
  const sessionIds = candidate.sessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
  let budgetMs: number | undefined
  if (candidate.budgetMs !== undefined) {
    if (typeof candidate.budgetMs !== 'number' || !Number.isFinite(candidate.budgetMs)) {
      throw new MapStoreError('INVALID', 'search-content payload budgetMs must be a finite number')
    }
    budgetMs = Math.min(Math.max(0, Math.trunc(candidate.budgetMs)), MAX_SEARCH_BUDGET_MS)
  }
  return budgetMs === undefined
    ? { query: candidate.query, sessionIds }
    : { query: candidate.query, sessionIds, budgetMs }
}

/**
 * Process-wide conversation-body index, created on first use.
 *
 * The extracted text and the file listing are the expensive parts, so one
 * instance is shared by every request instead of rebuilt per call.
 */
let contentIndex: ContentSearchIndex | undefined

/** @returns the shared conversation-body index over the Host's session store. */
function contentSearchIndex(): ContentSearchIndex {
  contentIndex ??= createContentSearchIndex({ sessionsRoot: sessionsDirectory() })
  return contentIndex
}

/**
 * Dispatch one RPC endpoint without transport concerns (unit-testable).
 * @param store - authoritative map store.
 * @param endpoint - endpoint name (`ping` | `state` | `put` | `search-content`).
 * @param payload - decoded JSON payload.
 * @returns the RPC result envelope.
 */
export async function dispatchMapRpc(store: MapFileStore, endpoint: string, payload: unknown): Promise<RpcResult> {
  try {
    return await dispatchMapRpcUnsafe(store, endpoint, payload)
  } catch (error) {
    return rpcFailure(error)
  }
}

/** The endpoint switch; callers fold thrown failures into the error envelope. */
async function dispatchMapRpcUnsafe(store: MapFileStore, endpoint: string, payload: unknown): Promise<RpcResult> {
  switch (endpoint) {
    case 'ping': {
      await store.ready()
      const snapshot = store.snapshot()
      return {
        ok: true,
        value: {
          host: true,
          revision: snapshot.revision,
          dataDir: store.dataDir(),
          docVersion: DOC_VERSION,
          corrupt: store.corrupt(),
        },
      }
    }
    case 'state': {
      await store.ready()
      const since = typeof payload === 'object' && payload !== null
        ? (payload as { sinceRevision?: unknown }).sinceRevision
        : undefined
      const snapshot = store.snapshot()
      if (typeof since === 'number' && since === snapshot.revision) {
        return { ok: true, value: { revision: snapshot.revision, unchanged: true } }
      }
      return {
        ok: true,
        value: { revision: snapshot.revision, unchanged: false, doc: snapshot.doc },
      }
    }
    case 'put': {
      await store.ready()
      const request = putPayload(payload)
      const outcome = await store.commit(request.doc, request.baseRevision, request.client)
      return { ok: true, value: { revision: outcome.revision } }
    }
    case 'search-content': {
      // Body search reads persisted Session logs, not the map document, so it
      // does not touch the store at all.
      const request = searchContentPayload(payload)
      return { ok: true, value: contentSearchIndex().search(request) }
    }
    default:
      return {
        ok: false,
        error: { code: 'map/not-found', message: `unknown conversation-map endpoint ${JSON.stringify(endpoint)}` },
      }
  }
}

/** One decoded browser envelope. */
interface ClientEnvelope {
  readonly rpcId: string
  readonly endpoint: string
  readonly payload: unknown
}

/** Narrow an untrusted body to a client envelope. */
function clientEnvelope(body: unknown): ClientEnvelope {
  if (typeof body !== 'object' || body === null) throw new MapStoreError('INVALID', 'RPC body must be an object')
  const candidate = body as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (candidate.type !== 'client-request') throw new MapStoreError('INVALID', 'RPC body must be a client-request')
  if (typeof candidate.rpcId !== 'string' || candidate.rpcId === '') throw new MapStoreError('INVALID', 'RPC body needs an rpcId')
  if (candidate.method !== RPC_METHOD) throw new MapStoreError('INVALID', `RPC body method must be ${JSON.stringify(RPC_METHOD)}`)
  if (typeof candidate.payload !== 'object' || candidate.payload === null) {
    throw new MapStoreError('INVALID', 'RPC body needs a payload object')
  }
  const payload = candidate.payload as { endpoint?: unknown; payload?: unknown }
  if (typeof payload.endpoint !== 'string' || payload.endpoint === '') {
    throw new MapStoreError('INVALID', 'RPC payload needs an endpoint name')
  }
  return { rpcId: candidate.rpcId, endpoint: payload.endpoint, payload: payload.payload }
}

/**
 * Answer one HTTP request with the Connection RPC envelope.
 * @param store - authoritative map store.
 * @param request - Fetch request behind the authenticated `/api` channel.
 * @returns the JSON response the browser carrier decodes.
 */
export async function handleMapRpcRequest(store: MapFileStore, request: Request): Promise<Response> {
  let rpcId = 'invalid-request'
  try {
    const body: unknown = await request.json()
    const envelope = clientEnvelope(body)
    rpcId = envelope.rpcId
    const result = await dispatchMapRpc(store, envelope.endpoint, envelope.payload)
    return Response.json({ type: 'server-response', rpcId, result })
  } catch (error) {
    return Response.json({ type: 'server-response', rpcId, result: rpcFailure(error) })
  }
}

/**
 * Register the RPC route once the Connection Fetch registry is available.
 * @param ctx - Host plugin context.
 * @param store - authoritative map store.
 */
export function registerMapRpc(ctx: HostContextLike, store: MapFileStore): void {
  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection') as ConnectionLike | undefined
    if (connection?.fetch?.register === undefined) return
    connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request: Request) => handleMapRpcRequest(store, request),
    })
  })
}
