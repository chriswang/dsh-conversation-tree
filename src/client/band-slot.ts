/**
 * Who owns the frame's single left band slot, as an observable.
 *
 * Two plugins draw a band over the left edge of the shipped Conversation column
 * and take turns (see `band-owner.ts`). The protocol's single source of truth is
 * the `data-dsh-band-owner` attribute on `<html>`; this module turns that
 * attribute into a value a React seat can read.
 *
 * The Conversation header's expand seat belongs to the **free** slot. While any
 * band owns the frame's left edge the seam already expresses that band's state,
 * so the map's seat retreats to its own persistent entry (the sidebar foot row)
 * instead of floating beside another plugin's chrome. Reading the attribute —
 * rather than asking a peer — keeps the two bundles independent: no plugin needs
 * the other's identity, and a third band plugin is covered without a change here.
 *
 * The attribute is written by the owner and cleared on release, so the DOM is the
 * only thing to watch. A `MutationObserver` coalesces same-task writes (a handoff
 * clears the attribute and the incoming owner claims it immediately), and the
 * protocol's `dsh:frame-band` event covers environments without an observer.
 */
import { BAND_EVENT, BAND_OWNER_ATTR } from './band-owner.js'
import type { ObservableSnapshot } from './services.js'

/**
 * The page face the store reads.
 *
 * Injectable so the store is testable without a DOM, and so a future host
 * contract (a layout service exposing the slot) can replace the attribute read
 * without touching the seats.
 */
export interface BandSlotEnvironment {
  /** Read the raw owner attribute, or null when the slot is free. */
  read(): string | null
  /** Call `listener` whenever the owner may have changed; returns the unsubscribe. */
  watch(listener: () => void): () => void
}

/** The observable owner plus its page teardown. */
export interface BandSlotStore extends ObservableSnapshot<string | null> {
  /** Disconnect from the page. */
  dispose(): void
}

/**
 * Read the slot owner off the shipped page.
 *
 * The attribute lives on `<html>` and is the protocol's documented source of
 * truth, so the read is a single `getAttribute`; no peer handshake is involved.
 * @returns the page environment, or null where there is no document (Node tests).
 */
function defaultEnvironment(): BandSlotEnvironment | null {
  if (typeof document === 'undefined') return null
  return {
    read: () => document.documentElement.getAttribute(BAND_OWNER_ATTR),
    watch: (listener: () => void): (() => void) => {
      const observer = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => { listener() })
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: [BAND_OWNER_ATTR],
      })
      const onEvent = (): void => { listener() }
      if (typeof window !== 'undefined') window.addEventListener(BAND_EVENT, onEvent)
      return () => {
        observer?.disconnect()
        if (typeof window !== 'undefined') window.removeEventListener(BAND_EVENT, onEvent)
      }
    },
  }
}

/**
 * Normalize one raw attribute value.
 *
 * A blank attribute is "free"; any other value is an owner, including an id this
 * build does not know — a peer speaking a later protocol is still drawing a band
 * over the seam, and the seat must not float beside it.
 * @param raw - attribute value, or null when the attribute is absent.
 * @returns the trimmed owner id, or null while the slot is free.
 */
function normalize(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  return value === '' ? null : value
}

/**
 * Open the slot-ownership store over one page face.
 * @param environment - injectable page face; defaults to the shipped document.
 * @returns the observable owner and its teardown.
 */
export function openBandSlot(environment?: BandSlotEnvironment): BandSlotStore {
  const page = environment ?? defaultEnvironment()
  let owner = normalize(page === null ? null : page.read())
  const listeners = new Set<() => void>()
  const stop = page === null
    ? null
    : page.watch(() => {
      const next = normalize(page.read())
      if (next === owner) return
      owner = next
      for (const listener of [...listeners]) listener()
    })
  return {
    getSnapshot: () => owner,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose(): void {
      stop?.()
      listeners.clear()
    },
  }
}
