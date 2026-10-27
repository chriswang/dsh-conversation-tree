/**
 * Recoverable view state: which node is selected, which branches are open, and
 * where the user was before the navigation collapsed.
 *
 * This is deliberately kept apart from {@link MapState}: it is presentation
 * memory, not the conversation index, and the document that owns the
 * organization should not churn its revision because a branch was folded.
 */
import { UNGROUPED_ID } from './model.js'
import type { KeyValueStore } from './persistence.js'

/** Storage key holding the view document. */
export const VIEW_STORAGE_KEY = 'dsh.conversation-map.view.v1'

/** One node's remembered canvas state. */
export interface NodeView {
  nodeId: string
  scrollTop: number
}

/** Everything the navigation needs to come back the way the user left it. */
export interface ViewState {
  version: 1
  selectedNodeId: string | null
  /** Nodes whose conversations are hidden. Everything else shows them. */
  collapsedIds: string[]
  /** Whether the navigation is folded to its rail. */
  navCollapsed: boolean
  /** The conversation currently shown in the reading pane. */
  openSessionId: string | null
  /**
   * Which space the target column is scoped to.
   *
   * A space id; empty or referring to a deleted space means "the default
   * space". The panel derives the effective value, so a removed space never
   * needs the stored one rewritten.
   */
  activeSpace: string
  /** Width of each cascading node column, by index, in CSS pixels. */
  columnWidths: number[]
  /** Width of the selected node's panel. */
  nodePanelWidth: number
  /**
   * Width of the map band on the centre column's left edge.
   *
   * The shipped Conversation column keeps the rest of the centre; this is the
   * only width the split owns. It is remembered across reloads like a column
   * width, and clamped against the live centre width so the Conversation column
   * always keeps its minimum.
   */
  mapWidth: number
  /** How many of a node's conversations are revealed, by node id. */
  revealedThreads: Record<string, number>
  /** Per-node scroll offsets, so returning to a node lands where it was. */
  scroll: NodeView[]
}

/** A fresh view state. */
export function emptyView(): ViewState {
  return {
    version: 1,
    selectedNodeId: null,
    collapsedIds: [],
    navCollapsed: false,
    openSessionId: null,
    activeSpace: '',
    scroll: [],
    columnWidths: [],
    nodePanelWidth: DEFAULT_NODE_PANEL_WIDTH,
    mapWidth: DEFAULT_MAP_WIDTH,
    revealedThreads: {},
  }
}

/** Fallback width of the selected node's panel. */
export const DEFAULT_NODE_PANEL_WIDTH = 300
/** Fallback width of the map band. */
export const DEFAULT_MAP_WIDTH = 560
/** Smallest width the map band may be dragged to. */
export const MIN_MAP_WIDTH = 320
/** Smallest centre-column width the shipped Conversation column keeps. */
export const MIN_CHAT_WIDTH = 420
/** Smallest width a column may be dragged to. */
export const MIN_COLUMN_WIDTH = 150
/** Largest width a column may be dragged to. */
export const MAX_COLUMN_WIDTH = 720
/** Thickness of one resize handle, in CSS pixels. */
export const GUTTER_WIDTH = 6
/**
 * Narrowest centre that can hold the band at its own functional minimum.
 *
 * The band is never closed by geometry — it collapses only when the reader asks
 * — but below this width even its minimum plus the resize handle do not fit.
 * At that point the band collapses itself so exactly one control remains (the
 * 「展开对话树」 seat in the Conversation header), and it can be expanded again as
 * soon as the frame can hold it.
 */
export const MIN_CENTRE_FOR_BAND = MIN_MAP_WIDTH + GUTTER_WIDTH
/** Safety ceiling for a stored map width; the live layout sets the real one. */
export const MAX_MAP_WIDTH = 4000

/**
 * Clamp one dragged width.
 * @param width - the requested width.
 * @param max - ceiling for this particular target.
 * @returns the width the target may actually take.
 */
export function clampColumnWidth(width: number, max: number = MAX_COLUMN_WIDTH): number {
  if (!Number.isFinite(width)) return MIN_COLUMN_WIDTH
  return Math.round(Math.min(Math.max(max, MIN_COLUMN_WIDTH), Math.max(MIN_COLUMN_WIDTH, width)))
}

/**
 * Widest the map band may be on a given centre-column width.
 *
 * The band takes the centre's left edge; the shipped Conversation column keeps
 * the rest, and MIN_CHAT_WIDTH is what it *asks* for. **The band's own minimum
 * comes first**: when the centre is too cramped for both, the band stays at
 * MIN_MAP_WIDTH and the Conversation column takes what is left (it is never
 * squeezed out of existence, and the band is never squeezed out either — the
 * reader collapses it explicitly). Only below MIN_CENTRE_FOR_BAND is even that
 * impossible, and the caller collapses the band instead of rendering it.
 * @param centerWidth - live width of the centre column.
 * @param minChatWidth - width the Conversation column asks to keep.
 * @returns the ceiling for the map width; never below MIN_MAP_WIDTH.
 */
export function maxMapWidth(centerWidth: number, minChatWidth: number = MIN_CHAT_WIDTH): number {
  if (!Number.isFinite(centerWidth) || centerWidth <= 0) return MAX_MAP_WIDTH
  const width = Math.round(centerWidth)
  const reserve = Math.min(minChatWidth, width)
  const ceiling = Math.round(width - reserve - GUTTER_WIDTH)
  return Math.max(MIN_MAP_WIDTH, Math.min(ceiling, width - GUTTER_WIDTH))
}

/**
 * Clamp one map-band width to a ceiling the live layout can afford.
 *
 * The result may be below MIN_MAP_WIDTH (that floor only applies to a reader's
 * drag, which always has a wide-enough centre); a cramped centre squeezes the
 * band instead, and the caller hides it when it gets useless.
 * @param width - the requested width.
 * @param max - ceiling for this particular centre width.
 * @returns the clamped width.
 */
export function clampMapWidth(width: number, max: number = MAX_MAP_WIDTH): number {
  if (!Number.isFinite(width)) return DEFAULT_MAP_WIDTH
  const requested = Number.isFinite(max) ? Math.max(0, Math.round(max)) : MAX_MAP_WIDTH
  return Math.round(Math.min(requested, Math.max(MIN_MAP_WIDTH, width)))
}

/** Whether a parsed value is a usable view document. */
export function isViewState(value: unknown): value is ViewState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ViewState>
  return candidate.version === 1
    && (candidate.collapsedIds === undefined || Array.isArray(candidate.collapsedIds))
    && Array.isArray(candidate.scroll)
}

/**
 * Parse a persisted view document, falling back to a fresh one.
 *
 * The old `@inbox` sentinel is the ungrouped bucket's former name: it reads
 * as the same place now that the map's first level is the Workspace list.
 * @param text - raw JSON, or null.
 * @returns the parsed view, or an empty one.
 */
export function parseViewState(text: string | null): ViewState {
  if (text === null || text === '') return emptyView()
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isViewState(parsed)) return emptyView()
    // The retired information bar left its expansion flag in older documents;
    // drop it instead of carrying an unknown field into the fresh view.
    const { infoBarOpen: _retired, ...stored } = parsed as ViewState & { infoBarOpen?: unknown }
    return {
      ...emptyView(),
      ...stored,
      selectedNodeId: parsed.selectedNodeId === '@inbox' ? UNGROUPED_ID : parsed.selectedNodeId,
      columnWidths: Array.isArray(parsed.columnWidths) ? parsed.columnWidths.map(width => clampColumnWidth(width)) : [],
      mapWidth: clampMapWidth(parsed.mapWidth, MAX_MAP_WIDTH),
      revealedThreads: parsed.revealedThreads !== null && typeof parsed.revealedThreads === 'object'
        ? parsed.revealedThreads
        : {},
    }
  } catch (_malformed) {
    return emptyView()
  }
}

/**
 * Read the remembered view.
 * @param store - backing key/value store.
 * @returns the stored view, or a fresh one.
 */
export function loadView(store: KeyValueStore): ViewState {
  try {
    return parseViewState(store.getItem(VIEW_STORAGE_KEY))
  } catch (_unreadable) {
    return emptyView()
  }
}

/**
 * Remember the view.
 * @param store - backing key/value store.
 * @param view - the view to persist.
 */
export function saveView(store: KeyValueStore, view: ViewState): void {
  store.setItem(VIEW_STORAGE_KEY, JSON.stringify(view))
}

/**
 * Drop remembered state that no longer points at something live, so a restored
 * view comes back sane: a removed topic, a removed Workspace, or an indexed
 * conversation that left the index all lose their memory.
 * @param view - the remembered view.
 * @param liveNodeIds - topic ids still present.
 * @param liveSessionIds - conversation ids still present.
 * @param liveWorkspaceKeys - first-level selection keys still present (Workspace ids and the ungrouped bucket).
 * @returns the reconciled view, or the same object when nothing changed.
 */
export function reconcileView(
  view: ViewState,
  liveNodeIds: ReadonlySet<string>,
  liveSessionIds: ReadonlySet<string>,
  liveWorkspaceKeys: ReadonlySet<string> = new Set(),
): ViewState {
  const liveKey = (id: string): boolean => liveNodeIds.has(id) || liveWorkspaceKeys.has(id)
  const selectedNodeId = view.selectedNodeId === null
    ? null
    : liveKey(view.selectedNodeId) ? view.selectedNodeId : null
  const openSessionId = view.openSessionId !== null && liveSessionIds.has(view.openSessionId) ? view.openSessionId : null
  const collapsedIds = view.collapsedIds.filter(liveKey)
  const revealedEntries = Object.entries(view.revealedThreads).filter(([id]) => liveKey(id))
  const scroll = view.scroll.filter(entry => liveKey(entry.nodeId))
  const unchanged = selectedNodeId === view.selectedNodeId
    && openSessionId === view.openSessionId
    && collapsedIds.length === view.collapsedIds.length
    && revealedEntries.length === Object.keys(view.revealedThreads).length
    && scroll.length === view.scroll.length
  if (unchanged) return view
  return {
    ...view,
    selectedNodeId,
    openSessionId,
    collapsedIds,
    scroll,
    revealedThreads: Object.fromEntries(revealedEntries),
  }
}

/**
 * Keep the reader where they were after a node is deleted.
 *
 * A view pointing at the node that just disappeared must not simply lose its
 * selection: an empty selection takes away the column that still lists the
 * deleted node's siblings. The reader lands one level up, on the parent, or on
 * nothing when a root was removed.
 * @param view - the current view.
 * @param deletedId - the node being removed.
 * @param parentId - that node's parent, or null when it was a root.
 * @returns the view, with a selection that survives.
 */
export function selectionAfterDelete(view: ViewState, deletedId: string, parentId: string | null): ViewState {
  if (view.selectedNodeId !== deletedId) return view
  return { ...view, selectedNodeId: parentId }
}

/**
 * Remember one node's scroll offset.
 * @param view - the current view.
 * @param nodeId - node whose offset changed.
 * @param scrollTop - the new offset.
 * @returns the updated view.
 */
export function withScroll(view: ViewState, nodeId: string, scrollTop: number): ViewState {
  const scroll = view.scroll.filter(entry => entry.nodeId !== nodeId)
  scroll.push({ nodeId, scrollTop })
  return { ...view, scroll }
}

/**
 * Read one node's remembered offset.
 * @param view - the current view.
 * @param nodeId - node to look up.
 * @returns the offset, or 0 when nothing was remembered.
 */
export function scrollOf(view: ViewState, nodeId: string): number {
  return view.scroll.find(entry => entry.nodeId === nodeId)?.scrollTop ?? 0
}
