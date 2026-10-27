/**
 * Cooperative ownership of the frame's single left band slot.
 *
 * Two plugins (the conversation map and the project chief workbench) both want
 * to draw a band over the left edge of the shipped Conversation column. The
 * frame only has room for one, and each plugin's surface writes the same
 * `padding-left` reservation on the Conversation root, so the two must take
 * turns. This module is the whole protocol; both bundles ship it verbatim.
 *
 * The DOM attribute on `<html>` is the single source of truth for "who owns the
 * slot right now". Window events carry the handshake:
 *
 *   claim    the new owner announces that it holds the slot
 *   request  a plugin wants the slot and asks the current owner to yield
 *   yield     the outgoing owner closed its surface; the requester may claim
 *   release   the owner gave the slot up without a successor
 *
 * A handoff must not restore the product's left column: the outgoing band may be
 * the party that collapsed it, and the incoming band keeps it collapsed. The
 * boolean travels with the yield event so the incoming surface can adopt the
 * collapse and restore it when the reader finally leaves the band.
 *
 * The module has no imports. It is the same file in both bundles by design: a
 * shared package would couple the two plugin releases, and the protocol is small
 * enough to keep in sync by copy.
 *
 * @module band-owner
 */

/** Attribute on `<html>` naming the current band owner. */
export const BAND_OWNER_ATTR = 'data-dsh-band-owner'

/** CSS custom property the owner writes with its reserved width, in px. */
export const BAND_WIDTH_VAR = '--dsh-band-width'

/** Window event carrying the handshake. */
export const BAND_EVENT = 'dsh:frame-band'

/** Protocol version; a mismatched peer is ignored. */
export const BAND_PROTOCOL_VERSION = 1

/** Stable identifiers of the two band plugins. */
export type BandOwnerId = 'conversation-map' | 'project-chief'

/** Handshake message kinds. */
export type BandEventType = 'claim' | 'request' | 'yield' | 'release'

/** Event detail carried by the window CustomEvent. */
export interface BandEventDetail {
  /** Protocol version this message speaks. */
  v: number
  /** Message kind. */
  type: BandEventType
  /** Plugin sending the message. */
  from: BandOwnerId
  /** Plugin the message is addressed to, when known. */
  to?: BandOwnerId
  /**
   * Whether the outgoing owner is the party that collapsed the product's left
   * column. Travels with `yield` so the incoming owner can adopt the collapse.
   */
  collapseOwned?: boolean
}

/** Result of a successful acquisition. */
export interface BandAcquireResult {
  /** False when the current owner did not yield in time (or nobody let go). */
  acquired: boolean
  /** The outgoing band owned the product's left-column collapse. */
  collapseOwned: boolean
}

/** What a handoff needs from the surface being asked to yield. */
export interface BandProtocolOptions {
  /** This plugin's stable identifier. */
  owner: BandOwnerId
  /**
   * Close this plugin's band for a handoff: hide the surface and remove its
   * reservation, WITHOUT restoring the product's left column. Resolves with
   * whether this band was the party that collapsed that column.
   */
  closeForHandoff(): Promise<boolean>
  /** Optional diagnostics sink; the default logs a warning once per failure. */
  log?(message: string, error?: unknown): void
}

/** The protocol handle one plugin keeps for its whole page lifetime. */
export interface BandProtocol {
  /** The current owner, or null while the slot is free. */
  ownerOf(): BandOwnerId | null
  /** Claim the slot when it is free (startup restore); false when occupied. */
  claimIfFree(): boolean
  /** Hand off from the current owner and claim; resolves acquired=false on timeout. */
  acquire(timeoutMs?: number): Promise<BandAcquireResult>
  /** Publish the reserved width while this plugin owns the slot. */
  setWidth(width: number): void
  /** Release the slot; the surface must already be closed. */
  release(): void
  /** Detach from the page; releases the slot when still owned. */
  dispose(): void
}

/** How long a requester waits for the current owner to close. */
const DEFAULT_TIMEOUT_MS = 600

function documentRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

function isOwnerId(value: string | null): value is BandOwnerId {
  return value === 'conversation-map' || value === 'project-chief'
}

/** Read the current owner from the page; useful before opening a band. */
export function currentBandOwner(): BandOwnerId | null {
  const root = documentRoot()
  if (root === null) return null
  const value = root.getAttribute(BAND_OWNER_ATTR)
  return isOwnerId(value) ? value : null
}

/**
 * Create the protocol handle for one plugin.
 *
 * The returned object listens on `window` for the page lifetime; `dispose()`
 * removes the listener and gives up the slot if this plugin still owns it.
 * @param options - owner identity and the surface handoff hook.
 * @returns the protocol handle.
 */
export function createBandProtocol(options: BandProtocolOptions): BandProtocol {
  const owner = options.owner
  const log = options.log ?? ((message: string, error?: unknown): void => {
    if (error === undefined) console.warn(message)
    else console.error(message, error)
  })

  let disposed = false
  let pending: {
    resolve(result: { collapseOwned: boolean } | null): void
    timer: number
    expectedFrom: BandOwnerId
  } | null = null

  const dispatch = (detail: BandEventDetail): void => {
    if (typeof window === 'undefined') return
    try {
      window.dispatchEvent(new CustomEvent<BandEventDetail>(BAND_EVENT, { detail }))
    } catch (error) {
      log('band-owner: could not dispatch the handshake event', error)
    }
  }

  const setOwnerAttr = (value: BandOwnerId | null): void => {
    const root = documentRoot()
    if (root === null) return
    if (value === null) root.removeAttribute(BAND_OWNER_ATTR)
    else root.setAttribute(BAND_OWNER_ATTR, value)
  }

  const setWidthValue = (width: number | null): void => {
    const root = documentRoot()
    if (root === null) return
    if (width === null || !Number.isFinite(width) || width <= 0) root.style.removeProperty(BAND_WIDTH_VAR)
    else root.style.setProperty(BAND_WIDTH_VAR, `${Math.max(0, Math.round(width))}px`)
  }

  const claim = (announce: 'claim' | 'silent'): void => {
    setOwnerAttr(owner)
    if (announce === 'claim') dispatch({ v: BAND_PROTOCOL_VERSION, type: 'claim', from: owner })
  }

  const settleYield = (detail: BandEventDetail): void => {
    if (pending === null) return
    if (detail.from !== pending.expectedFrom) return
    const waiter = pending
    pending = null
    if (typeof window !== 'undefined') window.clearTimeout(waiter.timer)
    waiter.resolve({ collapseOwned: detail.collapseOwned === true })
  }

  const handleEvent = (event: Event): void => {
    if (disposed) return
    const detail = (event as CustomEvent<BandEventDetail>).detail
    if (detail === undefined || detail.v !== BAND_PROTOCOL_VERSION) return
    if (detail.type === 'yield') {
      settleYield(detail)
      return
    }
    if (detail.type !== 'request' || detail.from === owner) return
    if (currentBandOwner() !== owner) return
    // Hand off: close the surface silently, then let the requester claim. The
    // yield is dispatched only after the surface's reservation is gone so the
    // two bands never paint over each other.
    void (async (): Promise<void> => {
      let collapseOwned = false
      try {
        collapseOwned = (await options.closeForHandoff()) === true
      } catch (error) {
        log('band-owner: closeForHandoff failed', error)
      }
      if (disposed) return
      if (currentBandOwner() === owner) setOwnerAttr(null)
      setWidthValue(null)
      dispatch({ v: BAND_PROTOCOL_VERSION, type: 'yield', from: owner, to: detail.from, collapseOwned })
    })()
  }

  if (typeof window !== 'undefined') window.addEventListener(BAND_EVENT, handleEvent)

  return {
    ownerOf: currentBandOwner,

    claimIfFree(): boolean {
      if (disposed) return false
      if (currentBandOwner() !== null) return false
      claim('claim')
      return true
    },

    async acquire(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<BandAcquireResult> {
      if (disposed) return { acquired: false, collapseOwned: false }
      const current = currentBandOwner()
      if (current === owner) return { acquired: true, collapseOwned: false }
      if (current === null) {
        claim('claim')
        // Two plugins can reach "free" in the same tick. Let the loser re-read
        // the attribute; the winner stays the single source of truth.
        await Promise.resolve()
        if (disposed) return { acquired: false, collapseOwned: false }
        return currentBandOwner() === owner
          ? { acquired: true, collapseOwned: false }
          : { acquired: false, collapseOwned: false }
      }
      if (typeof window === 'undefined') return { acquired: false, collapseOwned: false }
      const handoff = await new Promise<{ collapseOwned: boolean } | null>(resolve => {
        const timer = window.setTimeout(() => {
          if (pending === null) return
          pending = null
          resolve(null)
        }, Math.max(50, timeoutMs))
        pending = { resolve, timer, expectedFrom: current }
        dispatch({ v: BAND_PROTOCOL_VERSION, type: 'request', from: owner, to: current })
      })
      if (disposed || handoff === null) return { acquired: false, collapseOwned: false }
      if (currentBandOwner() !== null) return { acquired: false, collapseOwned: false }
      claim('claim')
      return { acquired: true, collapseOwned: handoff.collapseOwned }
    },

    setWidth(width: number): void {
      if (disposed) return
      if (currentBandOwner() !== owner) return
      setWidthValue(width)
    },

    release(): void {
      if (disposed) return
      if (currentBandOwner() !== owner) {
        setWidthValue(null)
        return
      }
      setOwnerAttr(null)
      setWidthValue(null)
      dispatch({ v: BAND_PROTOCOL_VERSION, type: 'release', from: owner })
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      if (typeof window !== 'undefined') window.removeEventListener(BAND_EVENT, handleEvent)
      if (pending !== null) {
        if (typeof window !== 'undefined') window.clearTimeout(pending.timer)
        pending.resolve(null)
        pending = null
      }
      if (currentBandOwner() === owner) {
        setOwnerAttr(null)
        setWidthValue(null)
      }
    },
  }
}
