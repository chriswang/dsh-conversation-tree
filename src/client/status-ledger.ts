/**
 * Client-side observation behind the node rollups.
 *
 * The map does not own a status: the categories it shows are exactly the ones
 * the application's own `useSessionStatus` snapshot reports, in the same
 * precedence its sidebar uses. The observer adds only three observations that the
 * snapshot itself cannot answer:
 *
 * - **when** a session entered its current category, used for ordering and the
 *   two-minute "new" halo (never for filtering — nothing expires);
 * - **error events**, because the product has no failed state in its UI status.
 *   `api-session/error` is an already-forwarded Host event for a turn that
 *   failed; an abort does not emit it;
 * - **completions behind a covering panel**, because the product never marks its
 *   main view unread. The sidebar row watches the transition and stores it here,
 *   so the node rows and the sidebar cluster can both show it until the
 *   conversation is opened (`completion-watch.ts` explains the gap).
 *
 * Everything here is in-memory and per client instance, on purpose: the reader
 * asked the map to follow the product, not to grow a second source of truth.
 * A reload starts clean, exactly like the product's own `completionUnread`.
 */
import type { SessionStatusLike } from './services.js'
import type { ObservedSessionStatus, StatusCategory } from '../shared/status-rollup.js'

/** Subscribable observation used by the panel and the sidebar entry. */
export interface StatusLedger {
  /** Observed category and timestamp by session id. */
  getSnapshot(): ReadonlyMap<string, ObservedSessionStatus>
  /** Unacknowledged error timestamps by session id. */
  getErrors(): ReadonlyMap<string, number>
  /**
   * Completions held for the product's main view.
   *
   * The product never marks that conversation unread, so a turn that stops while
   * a global panel covers the Conversation is held here until it is opened (see
   * `completion-watch.ts`). Session id → when the stop was observed.
   */
  getCompletions(): ReadonlyMap<string, number>
  /**
   * Replace the held completions.
   *
   * The sidebar row owns the transition watch; this is the shared store both
   * surfaces read, so the tree and the sidebar always agree.
   * @param next - the completions to hold now.
   */
  setCompletions(next: ReadonlyMap<string, number>): void
  /** Subscribe to observation changes. */
  subscribe(listener: () => void): () => void
  /**
   * Fold one live snapshot in.
   * @param statuses - the application's unified status map.
   * @param liveSessionIds - sessions the map currently indexes, for pruning.
   */
  observe(statuses: ReadonlyMap<string, SessionStatusLike>, liveSessionIds?: readonly string[]): void
  /** Record one forwarded session error. */
  observeError(sessionId: string): void
  /** Note that a session is running again, clearing an earlier error. */
  observeRunning(sessionId: string): void
  /** Clear an error after the reader opened the conversation. */
  acknowledge(sessionId: string): void
  /** Drop observations for sessions outside the current index. */
  prune(liveSessionIds: ReadonlySet<string>): void
  /** No-op for symmetry with the other client memories. */
  dispose(): void
}

/** Options for {@link createStatusLedger}. */
export interface StatusLedgerOptions {
  /** Clock override for tests. */
  now?: () => number
}

/**
 * Derive one session's category from the application's status facts.
 *
 * The order mirrors the shipped rows: a pending request is the actionable
 * state, running is live context, then an unread completion. An error is
 * overlaid from the forwarded event only while the session is not running; a
 * pending request still wins over it, because that is what the reader can act on
 * right now.
 * @param status - one session's status facts.
 * @param errorAt - when a forwarded error was last seen, if any.
 * @param running - whether the session is currently running.
 * @returns the category, or undefined for an idle session.
 */
export function categoryOf(
  status: SessionStatusLike | undefined,
  errorAt: number | undefined,
  running: boolean,
): StatusCategory | undefined {
  if (status?.pendingInteraction !== undefined) return 'pending'
  if (running) return 'running'
  if (errorAt !== undefined) return 'error'
  if (status?.completionUnread === true) return 'done'
  return undefined
}

/**
 * Create the in-memory observation.
 * @param options - clock override.
 * @returns the ledger.
 */
export function createStatusLedger(options: StatusLedgerOptions = {}): StatusLedger {
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<() => void>()
  let entries = new Map<string, ObservedSessionStatus>()
  let errors = new Map<string, number>()
  /** Sessions seen at least once; their first category is a baseline. */
  const seen = new Set<string>()
  let initialized = false
  /** The first non-empty status snapshot is a baseline, not a set of transitions. */
  let statusBaselineDone = false
  let completions = new Map<string, number>()
  let snapshot: ReadonlyMap<string, ObservedSessionStatus> = new Map()
  let disposed = false

  /** Whether two held-completion maps carry the same entries. */
  const sameCompletions = (
    left: ReadonlyMap<string, number>,
    right: ReadonlyMap<string, number>,
  ): boolean => {
    if (left.size !== right.size) return false
    for (const [sessionId, at] of left) if (right.get(sessionId) !== at) return false
    return true
  }

  const publish = (): void => {
    const next = new Map<string, ObservedSessionStatus>()
    for (const [sessionId, entry] of entries) next.set(sessionId, { ...entry })
    snapshot = next
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('conversation-map: status ledger subscriber failed', error)
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    getErrors: () => errors,
    getCompletions: () => completions,
    setCompletions: next => {
      if (disposed || sameCompletions(completions, next)) return
      completions = new Map(next)
      publish()
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observe: (statuses, liveSessionIds) => {
      if (disposed) return
      let changed = false
      const live = liveSessionIds === undefined ? undefined : new Set(liveSessionIds)
      const statusBaseline = !statusBaselineDone && statuses.size > 0
      if (statusBaseline) statusBaselineDone = true
      const baselinePass = !initialized
      if (baselinePass) {
        // The first pass establishes the baseline: whatever is already pending,
        // running, or unread at mount must not light the "new" halo.
        initialized = true
        for (const sessionId of live ?? statuses.keys()) seen.add(sessionId)
      }
      for (const [sessionId, status] of statuses) {
        if (live !== undefined && !live.has(sessionId)) continue
        const running = status.running === true
        if (running) errors.delete(sessionId)
        // A new turn or the product's own unread flag takes the completion over;
        // the held copy only exists for the gap the product cannot see.
        if ((running || status.completionUnread === true) && completions.delete(sessionId)) changed = true
        const category = categoryOf(status, running ? undefined : errors.get(sessionId), running)
        const previous = entries.get(sessionId)
        const first = !seen.has(sessionId)
        seen.add(sessionId)
        if (category === undefined) {
          if (previous !== undefined) {
            entries.delete(sessionId)
            changed = true
          }
          continue
        }
        if (previous?.category === category) continue
        // A first sighting is a baseline, not a transition. A session that was
        // already known and idle followed by a real change gets "now".
        entries.set(sessionId, { category, changedAt: baselinePass || statusBaseline || first ? 0 : now() })
        changed = true
      }
      if (live !== undefined) {
        for (const sessionId of [...entries.keys()]) {
          if (live.has(sessionId)) continue
          entries.delete(sessionId)
          errors.delete(sessionId)
          seen.delete(sessionId)
          changed = true
        }
        for (const sessionId of [...completions.keys()]) {
          if (live.has(sessionId)) continue
          completions.delete(sessionId)
          changed = true
        }
      }
      if (changed) publish()
    },
    observeError: sessionId => {
      if (disposed) return
      errors.set(sessionId, now())
      const previous = entries.get(sessionId)
      if (previous?.category !== 'running') {
        entries.set(sessionId, { category: 'error', changedAt: now() })
        publish()
      }
    },
    observeRunning: sessionId => {
      if (disposed) return
      const hadError = errors.delete(sessionId)
      const hadCompletion = completions.delete(sessionId)
      const previous = entries.get(sessionId)
      if (previous?.category === 'error') {
        entries.delete(sessionId)
        publish()
        return
      }
      if (hadError || hadCompletion) publish()
    },
    acknowledge: sessionId => {
      if (disposed) return
      const hadError = errors.delete(sessionId)
      const hadCompletion = completions.delete(sessionId)
      const previous = entries.get(sessionId)
      if (previous?.category === 'error') {
        entries.delete(sessionId)
        publish()
        return
      }
      if (hadError || hadCompletion) publish()
    },
    prune: liveSessionIds => {
      if (disposed) return
      let changed = false
      for (const sessionId of [...entries.keys()]) {
        if (liveSessionIds.has(sessionId)) continue
        entries.delete(sessionId)
        changed = true
      }
      for (const sessionId of [...errors.keys()]) {
        if (liveSessionIds.has(sessionId)) continue
        errors.delete(sessionId)
        changed = true
      }
      for (const sessionId of [...completions.keys()]) {
        if (liveSessionIds.has(sessionId)) continue
        completions.delete(sessionId)
        changed = true
      }
      if (changed) publish()
    },
    dispose: () => {
      disposed = true
      completions.clear()
      listeners.clear()
    },
  }
}
