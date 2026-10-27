/**
 * Memory of the reader's band-collapse choice and its left-column presentation.
 *
 * 对话树栏 is a split of the shipped Conversation column, not a main panel and not
 * a replacement: the product's header, view tabs, body, composer and right
 * column keep rendering, and the plugin only puts a map band over the centre
 * column's left edge while the band is expanded.
 *
 * The band has exactly two states — expanded and **collapsed** — and one
 * control is on screen at any time:
 *
 * - expanded: 「收起」 inside the band's own top bar;
 * - collapsed: 「展开对话树」 in the Conversation header's leading seat.
 *
 * There is no "off": the band is a column, so it is collapsed rather than
 * closed, and it never disappears as a side effect of geometry or of dragging a
 * splitter. The only reason it is not on screen is that the reader collapsed it
 * (or that even its functional minimum cannot fit, in which case it collapses
 * itself and leaves the control in place).
 *
 * One preference lives here: **collapsed** — did the reader collapse the band.
 * A first application starts collapsed, so installing the plugin changes nothing
 * until the reader asks. The product's left column is not a preference: expanding
 * the band always collapses it (the map's first column is that same Workspace
 * navigation, so keeping both would show one navigation twice).
 *
 * Migration: the previous on/off mode key (`mode.v1`) is read once when the new
 * key is absent and then never written again.
 *
 * The stores are plain data with a subscription, so the seats and the page all
 * read the same decision. Storage denial degrades to "nothing remembered" rather
 * than failing the plugin.
 */
import type { KeyValueStore } from './persistence.js'

/** Local key holding whether the reader collapsed the band. */
export const BAND_COLLAPSED_KEY = 'dsh.conversation-map.band-collapsed.v1'

/** Local key holding whether the band's own top bar has room for extra chrome. */
export const MODE_KEY = 'dsh.conversation-map.mode.v1'

/** Local key holding whether the one-time expand hint has been dismissed. */
export const HINT_KEY = 'dsh.conversation-map.hint.v1'

/** Value stored under {@link BAND_COLLAPSED_KEY} for a collapsed band. */
const COLLAPSED = 'collapsed'

/** Value stored under {@link BAND_COLLAPSED_KEY} for an expanded band. */
const EXPANDED = 'expanded'

/** Write the collapse choice, ignoring a denied store: the choice then lasts one page. */
function writeCollapsed(store: KeyValueStore, collapsed: boolean): void {
  try {
    store.setItem(BAND_COLLAPSED_KEY, collapsed ? COLLAPSED : EXPANDED)
  } catch (_denied) {
    // Nothing to persist; the in-memory value still drives this application.
  }
}

/**
 * Read the collapse choice, migrating a previous on/off mode once.
 *
 * A missing value means a first application, and a first application starts
 * collapsed. A legacy `mode.v1` of `on` maps to expanded; every other legacy
 * value (including a missing one) maps to collapsed.
 * @param store - document store (browser local storage or a test double).
 * @returns whether the band starts collapsed.
 */
function readCollapsed(store: KeyValueStore): boolean {
  try {
    const own = store.getItem(BAND_COLLAPSED_KEY)
    if (own === COLLAPSED) return true
    if (own === EXPANDED) return false
    const collapsed = store.getItem(MODE_KEY) !== 'on'
    writeCollapsed(store, collapsed)
    return collapsed
  } catch (_denied) {
    return true
  }
}

/**
 * Observable collapse switch backed by one key in the document store.
 */
export interface BandCollapseStore {
  /** True while the band is collapsed. True on a first application. */
  getSnapshot(): boolean
  /** Observe changes of the collapse choice. */
  subscribe(listener: () => void): () => void
  /** Collapse or expand the band, persisting the choice for the next application. */
  set(collapsed: boolean): void
  /** Flip between collapsed and expanded. */
  toggle(): void
}

/**
 * Open the collapse memory over one local store.
 * @param store - document store (browser local storage or a test double).
 * @returns the observable switch.
 */
export function openBandCollapseMemory(store: KeyValueStore): BandCollapseStore {
  let collapsed = readCollapsed(store)
  const listeners = new Set<() => void>()
  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => collapsed,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: boolean): void {
      if (next === collapsed) return
      collapsed = next
      writeCollapsed(store, next)
      publish()
    },
    toggle(): void {
      const next = !collapsed
      collapsed = next
      writeCollapsed(store, next)
      publish()
    },
  }
}

/**
 * The one-time "here is how you open it" hint.
 *
 * A first application starts with the band collapsed, and the only control is a
 * 28×28 icon in the Conversation header's leading seat. That is quiet but not
 * self-explanatory, so the seat shows one transient hint next to it the first
 * time a reader meets it. The hint is dismissed by the reader's own click, by
 * its own timer, or by expanding the band, and never comes back.
 *
 * Storage denial degrades to "no hint": nagging on every start would be worse
 * than a hint nobody sees.
 */
export interface FirstRunHintStore {
  /** True while the hint has not been dismissed yet. */
  getSnapshot(): boolean
  /** Observe the dismissal. */
  subscribe(listener: () => void): () => void
  /** Mark the hint as seen for this reader, for good. */
  dismiss(): void
}

/**
 * Read whether the hint is still pending, treating a denied store as dismissed.
 * @param store - document store (browser local storage or a test double).
 * @returns whether the one-time hint should be offered.
 */
function readHintPending(store: KeyValueStore): boolean {
  try {
    return store.getItem(HINT_KEY) !== 'seen'
  } catch (_denied) {
    return false
  }
}

/** Write the dismissal, ignoring a denied store. */
function writeHintSeen(store: KeyValueStore): void {
  try {
    store.setItem(HINT_KEY, 'seen')
  } catch (_denied) {
    // Nothing to persist; the in-memory value still drives this application.
  }
}

/**
 * Open the one-time hint memory over one local store.
 * @param store - document store (browser local storage or a test double).
 * @returns the observable hint state.
 */
export function openFirstRunHint(store: KeyValueStore): FirstRunHintStore {
  let pending = readHintPending(store)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => pending,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dismiss(): void {
      if (!pending) return
      pending = false
      writeHintSeen(store)
      for (const listener of [...listeners]) listener()
    },
  }
}
