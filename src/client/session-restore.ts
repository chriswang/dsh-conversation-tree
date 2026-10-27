/**
 * The conversation the map re-opens when its band (re)claims the centre.
 *
 * 会话跟界面走：the Conversation column shows the session of whichever band
 * surface is in front, so entering the map switches the column back to the
 * conversation the map remembers (`ViewState.openSessionId`, kept fresh while
 * the band is expanded), the same way the workbench opens its own project
 * conversation when it pulls the column up. Leaving a surface never closes or
 * clears anything — the product exposes no public "no current session" state —
 * so a restore is only ever a switch.
 *
 * The decision is pure so every entry path stays a one-liner and the rules are
 * testable:
 *
 * - nothing remembered → keep whatever is current (a first use has no memory);
 * - the remembered conversation is no longer in the Workspace catalog → keep
 *   the current one rather than navigating into a dead id;
 * - already current → no navigation at all;
 * - otherwise → switch, including when the current binding is unreadable.
 *
 * @module session-restore
 */

/** Inputs of {@link sessionToRestore}. */
export interface SessionRestoreDecision {
  /** The conversation the map remembers, from the persisted view document. */
  remembered: string | null
  /** The shell's current conversation id, or null when it cannot be read. */
  current: string | null
  /** Session ids present in the Workspace catalog. */
  live: ReadonlySet<string>
}

/**
 * Decide which conversation entering the map should select.
 * @param decision - the remembered id, the current id, and the live catalog.
 * @returns the Session id to open, or null when the current one stays.
 */
export function sessionToRestore(decision: SessionRestoreDecision): string | null {
  const { remembered, current, live } = decision
  if (remembered === null || remembered === '') return null
  if (!live.has(remembered)) return null
  if (current === remembered) return null
  return remembered
}
