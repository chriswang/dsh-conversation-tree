/**
 * Completion watch for the conversation the product considers current.
 *
 * The application never sets `completionUnread` on its main view: `ui-session`'s
 * status controller adds the flag only when a turn stops on a session that is
 * **not** main (`observeRunning`), and it clears the flag whenever a session is
 * main (`reconcileStatus`). That is right while the Conversation is in front of
 * the reader — but a global main panel can cover the Conversation while
 * `mainView` still points at the same session (`layout.selectPanel` only sets
 * `activePanelId`; it never touches the retention). A turn that finishes then is
 * silent: the product draws no dot, and the map's own rollup skips the main
 * session by design ("it is already in front of the reader" — which is no longer
 * true while a panel covers it).
 *
 * The sidebar row is the map's always-mounted observer, so it watches the
 * running → stopped transition itself and holds the completion until the
 * conversation is actually back in front of the reader. This module is the pure
 * bookkeeping behind that watch, so the transition rules are exercised without a
 * DOM.
 */

/** One status observation handed to {@link nextCoveredCompletions}. */
export interface CoveredCompletionInput {
  /** Completions currently held: session id → when the stop was observed. */
  readonly held: ReadonlyMap<string, number>
  /** Running state per session from the previous observation; null on the first. */
  readonly previous: ReadonlyMap<string, boolean> | null
  /** Running state per session now (own turn or a running subagent). */
  readonly running: ReadonlyMap<string, boolean>
  /** Sessions the product marks `completionUnread` now. */
  readonly unread: ReadonlySet<string>
  /** The conversation the product considers current, if any. */
  readonly mainSessionId: string | null
  /** Whether a global main panel covers the Conversation. */
  readonly covered: boolean
  /** Observation time for a newly held completion. */
  readonly now: number
}

/**
 * Advance the held completions by one status observation.
 *
 * A completion is held when the main session stops running while a panel covers
 * the Conversation, and it is released when:
 *
 * - the product marks it unread (the normal rollup owns it then — this only
 *   happens once the session is no longer main, e.g. the reader opened another
 *   conversation and it ran again);
 * - it runs again (a new turn started, so the old stop is no longer the latest
 *   thing that happened);
 * - it leaves the catalog (the conversation is gone);
 * - the conversation is back in front of the reader (`mainView` and no panel
 *   covers it), which is the plugin's "done until seen" rule. Opening it from
 *   anywhere also clears it through the ledger's `acknowledge`, exactly like a
 *   forwarded error.
 *
 * The returned map keeps its identity when nothing changed, so React can bail out
 * of the state update.
 * @param input - the previous observation and the current one.
 * @returns the completions to hold now.
 */
export function nextCoveredCompletions(input: CoveredCompletionInput): ReadonlyMap<string, number> {
  const { held, previous, running, unread, mainSessionId, covered, now } = input
  let next: ReadonlyMap<string, number> = held
  const mutable = (): Map<string, number> => {
    if (next === held) next = new Map(held)
    return next as Map<string, number>
  }
  for (const sessionId of [...held.keys()]) {
    const isRunning = running.get(sessionId)
    const backInFront = sessionId === mainSessionId && !covered
    if (isRunning === undefined || isRunning || unread.has(sessionId) || backInFront) {
      mutable().delete(sessionId)
    }
  }
  // Only the transition is a completion: a session that was already stopped when
  // this observer first saw it is history, not news.
  if (previous !== null && covered && mainSessionId !== null) {
    const wasRunning = previous.get(mainSessionId) === true
    const isRunning = running.get(mainSessionId) === true
    if (wasRunning && !isRunning && !unread.has(mainSessionId)) mutable().set(mainSessionId, now)
  }
  return next
}
