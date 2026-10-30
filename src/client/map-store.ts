/**
 * Client-side store for the authoritative Host map document.
 *
 * The browser used to own the map document in `localStorage`. It is now a
 * projection of the Host file: this store loads it over the plugin's
 * `/conversation-map` RPC channel, migrates existing local data once, applies
 * UI mutations optimistically, commits whole documents against a CAS revision
 * (replaying the queued mutations when the Host moved underneath), polls for
 * changes made by model tools or other windows, and falls back to
 * `localStorage`-only behavior when no Host channel is available.
 *
 * `ViewState` stays in `localStorage` and is not this store's concern.
 */
import { emptyMap, ensureDefaultSpace, MapError, type MapState } from '../shared/model.js'
import type { Translate } from '../shared/copy.js'
import type { ContentSearchHit, ContentSearchReply, ContentSearchRequest } from '../shared/search.js'
import { loadMap, saveMap, STORAGE_KEY, type KeyValueStore } from '../shared/persistence.js'

/**
 * The Host half mounts an exact `POST /api/conversation-map` route inside the
 * authenticated shared channel; the Connection carrier posts the standard RPC
 * envelope there with `method: 'conversation-map'`.
 */
export const MAP_RPC_CHANNEL = '/api'
export const MAP_RPC_ENDPOINT = 'conversation-map'

/** `localStorage` key holding the one-time migration backup. */
export const LOCAL_BACKUP_KEY = 'dsh.conversation-map.v1.host-backup'

/** Lifecycle of the store. */
export type MapPhase = 'loading' | 'ready' | 'local'

/**
 * One synchronization notice, localized only at the render site.
 *
 * The store never holds user-facing copy: it reports what happened and lets the
 * UI translate it, exactly like a model issue code. `host-error` is the one
 * opaque case — a Host wire message is external data and renders verbatim.
 */
export type MapNotice =
  | { readonly kind: 'sync-retry'; readonly detail: string }
  | { readonly kind: 'local-adopted' }
  | { readonly kind: 'dropped-changes'; readonly count: number }
  | { readonly kind: 'refreshed-conflict' }
  | { readonly kind: 'host-error'; readonly message: string }

/**
 * Format one store notice through the active dictionary.
 * @param t - the active translator (namespace `conversation-map`).
 * @param notice - the notice the store published.
 * @returns the user-facing sentence.
 */
export function formatMapNotice(t: Translate, notice: MapNotice): string {
  switch (notice.kind) {
    case 'sync-retry':
      return t('store.syncRetry', { detail: notice.detail })
    case 'local-adopted':
      return t('store.localAdopted')
    case 'dropped-changes':
      return t('store.droppedChanges', { count: notice.count })
    case 'refreshed-conflict':
      return t('store.refreshedConflict')
    case 'host-error':
      return notice.message
  }
}

/** One immutable snapshot read by React. */
export interface MapStoreSnapshot {
  /** `loading` until the Host (or local fallback) document is settled. */
  readonly phase: MapPhase
  /** The authoritative map document (optimistically applied). */
  readonly doc: MapState
  /** Host commit sequence; `0` while loading or in local mode. */
  readonly revision: number
  /** Number of local mutations not yet acknowledged by the Host. */
  readonly pending: number
  /** Last synchronization/conflict notice, when there is one. */
  readonly error?: MapNotice
}

/** Outcome of a local mutation attempt. */
export type MapUpdateResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

/** Store surface consumed by the page. */
export interface MapStore {
  getSnapshot(): MapStoreSnapshot
  subscribe(listener: () => void): () => void
  /** Apply one pure document transition optimistically and commit it. */
  update(change: (current: MapState) => MapState): MapUpdateResult
  /** Pull the latest Host document now (no-op while pending writes exist). */
  refresh(options?: { force?: boolean }): Promise<void>
  /** Resolve after the initial load/migration settles. */
  load(): Promise<void>
  /**
   * Search conversation message bodies through the Host index.
   *
   * Resolves `undefined` when the profile has no Host channel (localStorage
   * mode) or the Host does not answer, so the panel can simply show fewer
   * results instead of failing the search.
   */
  searchContent(request: ContentSearchRequest): Promise<ContentSearchReply | undefined>
  /** Stop timers/listeners. */
  dispose(): void
}

/** The client context face the store probes for the Connection service. */
export interface MapStoreContextLike {
  get(name: string): unknown
}

/** Injected timing/environment overrides (unit tests). */
export interface MapStoreOptions {
  readonly ctx: MapStoreContextLike
  readonly storage: KeyValueStore
  readonly pollMs?: number
  readonly commitDebounceMs?: number
  readonly retryMinMs?: number
  readonly retryMaxMs?: number
  readonly now?: () => number
  readonly setInterval?: (handler: () => void, timeout: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly setTimeout?: (handler: () => void, timeout: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  readonly isVisible?: () => boolean
  /** Start loading immediately (default true); tests may await `load()` instead. */
  readonly autoStart?: boolean
}

/** One Connection RPC reply. */
type RpcReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: object } }

/** `ctx.connection.rpc` subset. */
interface ClientRpcLike {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcReply>
}

/** `ctx.remote` subset used for the already-forwarded activity event. */
interface ClientRemoteLike {
  $on?(event: string, listener: (...args: unknown[]) => void): (() => void) | void
}

/** Default polling cadence while the map surface is visible. */
const DEFAULT_POLL_MS = 1800
/** Debounce before committing a burst of UI mutations. */
const DEFAULT_COMMIT_DEBOUNCE_MS = 250
/** Retry backoff bounds for transport failures. */
const DEFAULT_RETRY_MIN_MS = 1000
const DEFAULT_RETRY_MAX_MS = 15000
/** Debounce between a session activity notification and a refresh. */
const ACTIVITY_DEBOUNCE_MS = 500

/** Whether a document carries any organization data. */
function hasContent(doc: MapState): boolean {
  return doc.nodes.length > 0
    || doc.threads.length > 0
    || doc.spaces.length > 1
    || Object.keys(doc.spaceOf).length > 0
}

/**
 * Compare two documents by serialized form.
 *
 * Pure model passes (`syncThreads`) always return a fresh object even when
 * nothing changed; this keeps a busy catalog from committing on every event.
 * @param left - first document.
 * @param right - second document.
 * @returns whether the documents are content-identical.
 */
function sameDocument(left: MapState, right: MapState): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch (_unserializable) {
    return false
  }
}

/** Read the Host state value shape. */
function hostState(reply: RpcReply): { revision: number; doc?: MapState } {
  if (!reply.ok) return { revision: 0 }
  const value = reply.value as { revision?: unknown; doc?: unknown }
  return {
    revision: typeof value.revision === 'number' ? value.revision : 0,
    ...value.doc === undefined ? {} : { doc: value.doc as MapState },
  }
}

/**
 * Create the client map store.
 * @param options - context, storage, and timing overrides.
 * @returns the store surface.
 */
/**
 * Validate one Host conversation-body reply.
 *
 * The reply crosses an untrusted transport boundary; only well-formed hits are
 * kept so a malformed field can never break the result column.
 * @param value - decoded RPC value.
 * @returns the reply, or undefined when the shape is unusable.
 */
export function contentSearchReply(value: unknown): ContentSearchReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as {
    hits?: unknown
    scanned?: unknown
    total?: unknown
    done?: unknown
  }
  if (!Array.isArray(candidate.hits)) return undefined
  const hits: ContentSearchHit[] = []
  for (const raw of candidate.hits) {
    if (typeof raw !== 'object' || raw === null) continue
    const hit = raw as { sessionId?: unknown; messages?: unknown; snippet?: unknown }
    if (typeof hit.sessionId !== 'string' || hit.sessionId === '') continue
    let snippet: ContentSearchHit['snippet'] = null
    if (typeof hit.snippet === 'object' && hit.snippet !== null) {
      const parts = hit.snippet as { before?: unknown; match?: unknown; after?: unknown }
      if (typeof parts.before === 'string' && typeof parts.match === 'string' && typeof parts.after === 'string') {
        snippet = { before: parts.before, match: parts.match, after: parts.after }
      }
    }
    hits.push({
      sessionId: hit.sessionId,
      messages: typeof hit.messages === 'number' && Number.isFinite(hit.messages) ? hit.messages : 0,
      snippet,
    })
  }
  const scanned = typeof candidate.scanned === 'number' ? candidate.scanned : 0
  const total = typeof candidate.total === 'number' ? candidate.total : hits.length
  return { hits, scanned, total, done: candidate.done === true }
}

export function createMapStore(options: MapStoreOptions): MapStore {
  const storage = options.storage
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const commitDebounceMs = options.commitDebounceMs ?? DEFAULT_COMMIT_DEBOUNCE_MS
  const retryMinMs = options.retryMinMs ?? DEFAULT_RETRY_MIN_MS
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
  const now = options.now ?? (() => Date.now())
  const setIntervalFn = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout))
  const clearIntervalFn = options.clearInterval ?? ((handle) => { clearInterval(handle as ReturnType<typeof setInterval>) })
  const setTimeoutFn = options.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout))
  const clearTimeoutFn = options.clearTimeout ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const isVisible = options.isVisible ?? (() => {
    if (typeof document === 'undefined') return true
    return document.visibilityState !== 'hidden'
  })

  const listeners = new Set<() => void>()
  const tabId = `tab-${Math.random().toString(36).slice(2, 10)}-${String(now())}`

  let disposed = false
  let phase: MapPhase = 'loading'
  let doc = ensureDefaultSpace(loadMap(storage))
  let hostRevision = 0
  let pending: Array<(current: MapState) => MapState> = []
  let lastError: MapNotice | undefined
  let snapshot: MapStoreSnapshot = buildSnapshot()

  let pollTimer: unknown
  let flushTimer: unknown
  let retryTimer: unknown
  let retryDelay = retryMinMs
  let flushing: Promise<void> | undefined
  let loading: Promise<void> | undefined
  let refreshing = false
  let started = false
  let activityDisposed = false
  let activityTimer: unknown
  const cleanups: Array<() => void> = []

  /** Rebuild and publish the immutable snapshot. */
  function buildSnapshot(): MapStoreSnapshot {
    return {
      phase,
      doc,
      revision: hostRevision,
      pending: pending.length,
      ...lastError === undefined ? {} : { error: lastError },
    }
  }

  /** Publish a new snapshot to every subscriber. */
  function notify(): void {
    snapshot = buildSnapshot()
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('conversation-map: map store subscriber failed', error)
      }
    }
  }

  /** Resolve the live Connection channel, when the page has one. */
  function connectionRpc(): ClientRpcLike | undefined {
    const connection = options.ctx.get('connection') as { rpc?: ClientRpcLike } | undefined
    if (connection === undefined || connection === null) return undefined
    const candidate = connection.rpc
    return candidate !== undefined && typeof candidate.call === 'function' ? candidate : undefined
  }

  /** Call one endpoint; throws when no channel is available. */
  async function call(endpoint: string, payload: unknown): Promise<RpcReply> {
    const rpc = connectionRpc()
    if (rpc === undefined) throw new Error('conversation-map: no Host connection')
    return rpc.call(MAP_RPC_CHANNEL, MAP_RPC_ENDPOINT, { endpoint, payload })
  }

  /** Persist the document to `localStorage` (local fallback only). */
  function saveLocal(next: MapState): void {
    try {
      saveMap(storage, next)
    } catch (error) {
      console.warn('conversation-map: could not persist the local map document', error)
    }
  }

  /** Keep a copy of the browser document before the Host takes ownership. */
  function backupLocal(next: MapState): void {
    try {
      storage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(next))
    } catch (error) {
      console.warn('conversation-map: could not back up the local map document', error)
    }
  }

  /** Retire the migrated local document. */
  function clearLocalMain(): void {
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(STORAGE_KEY)
      else storage.setItem(STORAGE_KEY, '')
    } catch (error) {
      console.warn('conversation-map: could not retire the local map document', error)
    }
  }

  /** Adopt one Host document as authoritative. */
  function adopt(next: MapState, revision: number): void {
    doc = next
    hostRevision = revision
    lastError = undefined
  }

  /** Drop into localStorage-only mode. */
  function enterLocal(): void {
    phase = 'local'
    hostRevision = 0
    pending = []
    notify()
  }

  /** Re-read the full Host document after a conflict or an invalid submit. */
  async function adoptHost(): Promise<boolean> {
    try {
      const reply = await call('state', {})
      if (!reply.ok) return false
      const value = hostState(reply)
      adopt(value.doc ?? ensureDefaultSpace(emptyMap()), value.revision)
      phase = 'ready'
      notify()
      return true
    } catch (error) {
      lastError = { kind: 'host-error', message: error instanceof Error ? error.message : String(error) }
      notify()
      return false
    }
  }

  /**
   * Load the Host document, migrating the local one on the first run.
   *
   * Rules: a Host with no organization data adopts the local document (CAS
   * from revision 0; a concurrent migration wins and the loser keeps a backup);
   * a Host with data always wins and any divergent local document is backed up.
   */
  async function performLoad(): Promise<void> {
    if (disposed) return
    const wasLocal = phase === 'local'
    const local = ensureDefaultSpace(loadMap(storage))
    if (hasContent(local)) doc = local
    if (connectionRpc() === undefined) {
      enterLocal()
      startPolling()
      return
    }
    if (!wasLocal) {
      phase = 'loading'
      notify()
    }
    try {
      const reply = await call('state', {})
      if (!reply.ok) throw new Error(reply.error.message)
      const value = hostState(reply)
      const host = value.doc ?? ensureDefaultSpace(emptyMap())
      const hostHasContent = hasContent(host)
      const localHasContent = hasContent(local)
      if (!hostHasContent && localHasContent) {
        backupLocal(local)
        const put = await call('put', { baseRevision: value.revision, doc: local, client: tabId })
        if (put.ok) {
          adopt(local, (put.value as { revision: number }).revision)
          clearLocalMain()
        } else if (put.error.code === 'map/conflict') {
          const adopted = await adoptHost()
          if (!adopted) throw new Error(put.error.message)
          lastError = { kind: 'local-adopted' }
          notify()
          clearLocalMain()
        } else {
          throw new Error(put.error.message)
        }
      } else {
        adopt(host, value.revision)
        if (localHasContent) {
          backupLocal(local)
          if (!sameDocument(local, host)) {
            lastError = { kind: 'local-adopted' }
          }
          clearLocalMain()
        }
      }
      phase = 'ready'
      notify()
      startPolling()
      startActivityTrigger()
    } catch (_error) {
      enterLocal()
      startPolling()
    }
  }

  /**
   * Run one queued-write flush loop.
   *
   * Each iteration takes the current queue batch, submits the optimistically
   * applied document against the last Host revision, and either acknowledges
   * (advance revision, drop the batch) or rebases the batch onto the latest Host
   * document and retries once. Transport failures keep the batch queued and arm
   * a backoff retry.
   */
  async function runFlush(): Promise<void> {
    if (disposed) return
    while (!disposed && phase === 'ready' && pending.length > 0) {
        const batch = pending.splice(0, pending.length)
        let reply: RpcReply
        try {
              reply = await call('put', { baseRevision: hostRevision, doc, client: tabId })
        } catch (error) {
          pending = batch.concat(pending)
          lastError = { kind: 'sync-retry', detail: error instanceof Error ? error.message : String(error) }
          notify()
          scheduleRetry()
          return
        }
        if (!reply.ok && reply.error.code === 'map/conflict') {
          let latest: RpcReply
          try {
            latest = await call('state', {})
          } catch (error) {
            pending = batch.concat(pending)
            lastError = { kind: 'sync-retry', detail: error instanceof Error ? error.message : String(error) }
            notify()
            scheduleRetry()
            return
          }
          const value = hostState(latest)
          let rebased = value.doc ?? ensureDefaultSpace(emptyMap())
          let dropped = 0
          for (const change of batch) {
            try {
              rebased = change(rebased)
            } catch (_rejected) {
              dropped += 1
            }
          }
          doc = rebased
          hostRevision = value.revision
          lastError = dropped > 0 ? { kind: 'dropped-changes', count: dropped } : undefined
          notify()
          if (dropped === batch.length) continue
          try {
            reply = await call('put', { baseRevision: hostRevision, doc, client: tabId })
          } catch (error) {
            lastError = { kind: 'sync-retry', detail: error instanceof Error ? error.message : String(error) }
            notify()
            scheduleRetry()
            return
          }
          if (!reply.ok) {
            if (reply.error.code === 'map/conflict') {
              await adoptHost()
              lastError = { kind: 'refreshed-conflict' }
              notify()
              return
            }
            await adoptHost()
            lastError = { kind: 'host-error', message: reply.error.message }
            notify()
            return
          }
        } else if (!reply.ok) {
          pending = batch.concat(pending)
          lastError = { kind: 'host-error', message: reply.error.message }
          notify()
          return
        }
        hostRevision = (reply.value as { revision: number }).revision
        lastError = undefined
        retryDelay = retryMinMs
        notify()
    }
  }

  /**
   * Start (or join) the flush loop.
   *
   * The loop promise is cleared here, not inside `runFlush`: a zero-pending loop
   * finishes synchronously, and clearing the field from its own body would race
   * the assignment below (leaving a resolved promise behind forever, which would
   * block every later flush).
   */
  function flushNow(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (flushing !== undefined) return flushing
    const task = (async () => {
      try {
        await runFlush()
      } catch (error) {
        lastError = { kind: 'sync-retry', detail: error instanceof Error ? error.message : String(error) }
        notify()
      } finally {
        flushing = undefined
      }
    })()
    flushing = task
    return task
  }

  /** Schedule the debounced flush. */
  function scheduleFlush(): void {
    if (disposed) return
    if (flushTimer !== undefined) clearTimeoutFn(flushTimer)
    flushTimer = setTimeoutFn(() => {
      flushTimer = undefined
      void flushNow()
    }, commitDebounceMs)
  }

  /** Arm one backoff retry for a transport failure. */
  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return
    const delay = retryDelay
    retryDelay = Math.min(retryDelay * 2, retryMaxMs)
    retryTimer = setTimeoutFn(() => {
      retryTimer = undefined
      if (pending.length > 0) void flushNow()
    }, delay)
  }

  /** One polling tick. */
  function tick(): void {
    if (disposed) return
    if (!isVisible()) return
    if (phase === 'local') {
      void performLoad()
      return
    }
    if (phase !== 'ready') return
    if (pending.length > 0) {
      void flushNow()
      return
    }
    void refresh()
  }

  /** Start the polling loop and page visibility hooks once. */
  function startPolling(): void {
    if (pollTimer !== undefined || disposed) return
    pollTimer = setIntervalFn(tick, pollMs)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVisibility = (): void => { if (isVisible()) tick() }
      document.addEventListener('visibilitychange', onVisibility)
      cleanups.push(() => { document.removeEventListener('visibilitychange', onVisibility) })
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onFocus = (): void => { tick() }
      window.addEventListener('focus', onFocus)
      cleanups.push(() => { window.removeEventListener('focus', onFocus) })
    }
  }

  /** Subscribe to the already-forwarded session activity event as a refresh trigger. */
  function startActivityTrigger(): void {
    if (activityDisposed) return
    const remote = options.ctx.get('remote') as ClientRemoteLike | undefined
    if (remote === undefined || remote === null || typeof remote.$on !== 'function') return
    try {
      const dispose = remote.$on('api-session/activity', () => {
        if (disposed || phase !== 'ready' || pending.length > 0) return
        if (activityTimer !== undefined) clearTimeoutFn(activityTimer)
        activityTimer = setTimeoutFn(() => {
          activityTimer = undefined
          void refresh()
        }, ACTIVITY_DEBOUNCE_MS)
      })
      if (typeof dispose === 'function') cleanups.push(dispose)
      activityDisposed = true
    } catch (error) {
      console.warn('conversation-map: could not subscribe to session activity', error)
    }
  }

  /** Pull the latest Host document. */
  async function refresh(options: { force?: boolean } = {}): Promise<void> {
    if (disposed || phase !== 'ready' || refreshing) return
    refreshing = true
    try {
      const payload = options.force === true ? {} : { sinceRevision: hostRevision }
      const reply = await call('state', payload)
      if (!reply.ok) {
        lastError = { kind: 'host-error', message: reply.error.message }
        notify()
        return
      }
      const value = hostState(reply)
      if (value.doc === undefined) return
      if (pending.length > 0) return
      if (sameDocument(value.doc, doc)) {
        if (hostRevision !== value.revision) {
          hostRevision = value.revision
          notify()
        }
        return
      }
      adopt(value.doc, value.revision)
      notify()
    } catch (error) {
      lastError = { kind: 'sync-retry', detail: error instanceof Error ? error.message : String(error) }
      notify()
    } finally {
      refreshing = false
    }
  }

  /** Start the initial load once. */
  function ensureStarted(): void {
    if (started) return
    started = true
    loading = performLoad().finally(() => { loading = undefined })
  }

  const store: MapStore = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(change: (current: MapState) => MapState): MapUpdateResult {
      if (disposed) return { ok: false, error: new Error('conversation-map: store disposed') }
      if (phase === 'loading') {
        return { ok: false, error: new MapError('STORE_LOADING', 'The conversation tree is still loading; try again shortly.') }
      }
      let next: MapState
      try {
        next = change(doc)
      } catch (error) {
        return { ok: false, error }
      }
      if (next === doc || sameDocument(next, doc)) return { ok: true }
      doc = next
      lastError = undefined
      if (phase === 'local') {
        saveLocal(doc)
        notify()
        return { ok: true }
      }
      pending.push(change)
      notify()
      scheduleFlush()
      return { ok: true }
    },
    refresh(options?: { force?: boolean }): Promise<void> {
      return refresh(options)
    },
    load(): Promise<void> {
      ensureStarted()
      return loading ?? Promise.resolve()
    },
    async searchContent(request: ContentSearchRequest): Promise<ContentSearchReply | undefined> {
      if (disposed || phase === 'local') return undefined
      try {
        const reply = await call('search-content', request)
        if (!reply.ok) return undefined
        return contentSearchReply(reply.value)
      } catch (error) {
        console.warn('conversation-map: conversation-body search unavailable', error)
        return undefined
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (pollTimer !== undefined) clearIntervalFn(pollTimer)
      if (flushTimer !== undefined) clearTimeoutFn(flushTimer)
      if (retryTimer !== undefined) clearTimeoutFn(retryTimer)
      if (activityTimer !== undefined) clearTimeoutFn(activityTimer)
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup()
        } catch (_ignored) { /* disposal must not throw */ }
      }
      listeners.clear()
    },
  }

  if (options.autoStart !== false) ensureStarted()
  return store
}
