/**
 * Narrow service surfaces the plugin talks to.
 *
 * The client bundle keeps cross-plugin value imports out of its runtime graph
 * (only React is required from the loader's module table), so services are
 * reached through `ctx` and typed here by the shape this plugin actually uses.
 *
 * The map no longer renders a Conversation occurrence: it reserves a left band
 * of the centre column and leaves the shipped Conversation column untouched.
 * The conversation-rendering services (`sessions.retain`, Session references,
 * the embedded Conversation factory surface) are therefore gone; what remains
 * is the catalog, Workspace navigation, the Host-backed map document, and the
 * native Session/panel bindings the map follows for selection and navigation.
 */
import { useCallback, useSyncExternalStore } from 'react'

import type { MapStore } from './map-store.js'

/** A readable, subscribable value source. */
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** The subset of the Slot service this plugin registers through. */
export interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** One Workspace exactly as the map groups by it. */
export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/** The Workspace Controller snapshot the plugin reads. */
export interface WorkspaceSnapshotLike {
  items: readonly WorkspaceViewLike[]
  /** Arrival lifecycle: a pending list must not be mistaken for "no Workspaces". */
  phase?: 'pending' | 'ready'
}

/** The Workspace Controller's client face, narrowed to what the map uses. */
export interface WorkspacesService {
  /** Host-authoritative Workspace rows, order, and follow lifecycle. */
  readonly list: ObservableSnapshot<WorkspaceSnapshotLike>
  /** Register an existing directory as a Workspace. */
  create(input: { path: string }): Promise<WorkspaceViewLike>
  /** Rename a Workspace without touching its Sessions or files. */
  rename(workspaceId: string, title: string): Promise<WorkspaceViewLike>
  /** Remove a Workspace registration; Sessions and files stay where they are. */
  delete(workspaceId: string): Promise<void>
}

/** The catalog's arrival lifecycle as the sessions service reports it. */
export interface CatalogSnapshotLike {
  phase?: 'pending' | 'ready'
}

/**
 * The sessions service face this plugin uses.
 *
 * The map drives native navigation through `openSession`; it never retains a
 * Session for rendering any more, so only the catalog lifecycle, creation and
 * refresh remain.
 */
export interface SessionsService {
  /** Catalog snapshot, optional so a caller without it still works. */
  readonly list?: ObservableSnapshot<CatalogSnapshotLike>
  /** Ask the Host for a fresh catalog; optional so a caller without it still works. */
  refresh?(): Promise<void>
  /** Create a new conversation in one Workspace and return its identity. */
  create?(options?: { workspaceId?: string; cwd?: string }): Promise<string>
}

/**
 * The application's own Session navigation.
 *
 * `ctx.uiWorkspace.openSession()` retains the Session as the main view and
 * reveals the Conversation; the shipped Conversation column therefore shows the
 * same Session the map's rows highlight.
 */
export interface UiWorkspaceLike {
  openSession?(target: unknown): void
}

/** One current-session binding as the application's slot-scope adapter reports it. */
export interface CurrentSessionLike {
  /** The binding value; only its Session key is read here. */
  getSnapshot(): { key?: string } | undefined
  /** Observe binding changes (navigation, generation replacement). */
  subscribe(listener: () => void): () => void
}

/**
 * The application's `uiSession` face, narrowed to the current-Session binding.
 *
 * `uiSession.adapter.current` is the source the shell itself drives: the
 * Conversation column, the document title and every current-Session marker read
 * it. The map follows it so native navigation (a sidebar row, a shortcut,
 * another plugin) moves the selection exactly like opening a row in the map.
 */
export interface UiSessionLike {
  readonly adapter?: { readonly current?: CurrentSessionLike }
}

/** The layout's main-panel selection as the plugin reads it. */
export interface PanelInfoLike {
  /** The selected global main panel, or null for the shipped Conversation. */
  readonly activePanelId: string | null
}

/** Services the page and its entries are wired with by the client half. */
export interface MapServices {
  /** Host catalog lifecycle plus conversation creation. */
  sessions: SessionsService
  /** Host-authoritative Workspace list plus its mutations. */
  workspaces: WorkspacesService
  /**
   * The authoritative map document: loaded from and committed to the Host,
   * with a localStorage-only fallback when no Host channel is available.
   */
  store: MapStore
  /**
   * The in-memory observation of session traffic behind the node rollups.
   *
   * Absent in pure model/render tests and in profiles whose client half cannot
   * see the Session status face; rows then render no status badges and the page
   * behaves exactly as before.
   */
  statusLedger?: import('./status-ledger.js').StatusLedger | undefined
  /**
   * The layout's current main-panel selection.
   *
   * The map band is rendered into the frame-wide overlay layer, which is mounted
   * while any main panel is selected. The band must disappear while another
   * panel is in front and come back when the Conversation returns, so the page
   * reads this source instead of assuming it is always visible.
   */
  panelInfo?: ObservableSnapshot<PanelInfoLike> | undefined
  /** Open the Host's native directory chooser, when the profile provides one. */
  pickDirectory?: PickDirectory
  /** Native navigation used to open a conversation (keeps the pane aligned). */
  openSession?: (target: unknown) => void
  /**
   * The application's current-Session binding, absent when the profile has no
   * `uiSession` face.
   *
   * The page follows it so navigation that happens outside the map (a native
   * sidebar row, a shortcut, another plugin) moves the selection; without it the
   * page falls back to the catalog's `mainView` marker.
   */
  externalCurrent?: ObservableSnapshot<string | null>
  /** Collapse the band and hand the centre back to the shipped Conversation. */
  collapse?: () => void
}

/** Open the Host's native directory chooser; resolves null when cancelled. */
export type PickDirectory = () => Promise<string | null>

/** The subset of the layout service this plugin registers through. */
export interface LayoutService {
  /** Subscribable main-panel selection, shared with the shipped sidebar. */
  readonly panelInfo: ObservableSnapshot<PanelInfoLike>
  /** Select a registered main panel; null returns to the Conversation. */
  selectPanel(panelId: string | null): void
  /** Collapse ⇄ expand the product's left navigation column. */
  toggleSidebar(): void
}

/** The Client root context, narrowed to the services this plugin uses. */
export interface ClientContext {
  readonly slots: SlotsService
  readonly sessions: SessionsService
  /** Main-panel selection; consumed so the map can hide itself behind panels. */
  readonly layout: LayoutService
  /** Read an optional service by name (undefined when the profile does not provide it). */
  get(name: string): unknown
  effect(callback: () => unknown, label?: string): unknown
}

/** One session's status as the application's own rows read it. */
export interface SessionStatusLike {
  /** Latest known running state; absent until something establishes it. */
  running?: boolean | undefined
  /** Highest-precedence domain request currently awaiting the user. */
  pendingInteraction?: { kind?: string } | undefined
  /** Whether a stop outside the conversation still needs acknowledgement. */
  completionUnread?: boolean | undefined
}

/** A session's own projection values, as the client holds them. */
export interface SessionProjectionLike {
  values?: { subagentCatalog?: ReadonlyArray<{ id: string }> | undefined } | undefined
}

/** One catalog row this plugin reads. */
export interface CatalogRow {
  displayTitle?: string
  title?: string
  running?: boolean
  blank?: boolean
  parentId?: string | null
  origin?: string
  updatedAt?: number
  /**
   * Local reference counts by source, as the Session Controller reports them.
   * `mainView` marks the Session the application considers current.
   */
  retainedBy?: Readonly<Record<string, number>> | undefined
}

/** The catalog snapshot this plugin reads. */
export interface CatalogState {
  ids: string[]
  byId: Record<string, CatalogRow>
  /** Arrival lifecycle: a pending catalog must not be mistaken for "no sessions". */
  phase?: 'pending' | 'ready'
  /** Projection values per session, including each session's subagent catalog. */
  projectionsBySession?: Readonly<Record<string, SessionProjectionLike>>
}

/** Props the framework injects into the root-scoped map-band entry. */
export interface RootPanelProps {
  useSessions?: (selector: (state: CatalogState) => unknown) => unknown
  /**
   * The application's unified per-session UI status.
   *
   * This is the very source its own sidebar rows read, so consuming it keeps
   * every status mark in the map identical to the shipped list.
   */
  useSessionStatus?: (selector: (state: ReadonlyMap<string, SessionStatusLike>) => unknown) => unknown
}

/**
 * Subscribe to a snapshot source from a component.
 *
 * The server snapshot is the same reading: the page renders identically while
 * server-rendered in tests, and the browser subscribes for live updates.
 * @param source - readable, subscribable value source.
 * @returns the current value.
 */
export function useSnapshot<T>(source: ObservableSnapshot<T>): T {
  return useSyncExternalStore(
    useCallback((notify: () => void) => source.subscribe(notify), [source]),
    useCallback(() => source.getSnapshot(), [source]),
    useCallback(() => source.getSnapshot(), [source]),
  )
}
