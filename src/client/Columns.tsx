/**
 * The column strip of the node area.
 *
 * Every column is one level and carries a fixed label, so a column never claims
 * to be the node above it. Rows follow the application's own workspace list: a
 * 34px node row and a 32px conversation row, a 16px leading slot, hover-revealed
 * icon actions, and a trailing time that the actions replace on hover. A node's
 * leading slot is a folder that swaps to a fold arrow while the row is hovered;
 * a conversation's slot carries only an activity dot. Both rows share the same
 * leading geometry, so their titles line up.
 *
 * Columns scroll vertically on their own; horizontal scrolling belongs to the
 * node area that holds them.
 */
import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react'

import { clampColumnWidth } from '../shared/view-state.js'
import type { StatusRollup } from '../shared/status-rollup.js'
import { useT } from './locale.js'
import type { DragPayload } from './row-drag.js'
import { StatusRollupBadge } from './StatusRollup.js'

/** One status mark, drawn exactly as the application's own rows draw it. */
export interface ThreadStatus {
  /** Which mark to draw; `ongoing` is the spinning ring. */
  state: 'done' | 'warning' | 'ongoing'
  /** Full wording, used as the accessible name and the tooltip. */
  label: string
  /** Compact wording that replaces the age while something is pending. */
  compact: string
}

/** One conversation shown under its owning node. */
export interface ThreadRow {
  sessionId: string
  title: string
  /** Compact relative age, empty when unknown. */
  time: string
  /** The status mark, absent for an idle conversation. */
  status?: ThreadStatus
  /**
   * The Workspace the conversation is accounted to; `null` = the ungrouped
   * bucket, `undefined` = the Host has not accounted it yet.
   *
   * Both the ungrouped bucket and an unaccounted conversation take no part in a
   * drag (there is no Workspace for a target to agree with), so the map reads
   * this before a press ever becomes a drag. It is also what a Workspace-level
   * conversation row reports as its parent for hit testing.
   */
  workspaceId?: string | null
  /**
   * Optional second line under the title.
   *
   * The search view uses it for the conversation's home path, or for the
   * message-body snippet with the query highlighted; ordinary rows leave it
   * `undefined` and keep their single 32px line.
   */
  note?: ReactNode
}

/** One node row, with the conversations that belong to it nested beneath. */
export interface NodeRow {
  id: string
  title: string
  /**
   * What this row is. The first level lists Workspaces (and each space's
   * ungrouped bucket); every deeper level lists this plugin's topic nodes. A
   * `hint` row is a non-interactive placeholder (an empty space).
   */
  kind: 'workspace' | 'ungrouped' | 'node' | 'hint'
  /**
   * The Workspace this row belongs to, normalised; `null` for the ungrouped
   * bucket and for a legacy rootless topic. It is what the row reports as its
   * drag identity (`data-node-workspace-id`) and what its conversations inherit.
   */
  workspaceId?: string | null
  /**
   * How many child nodes this node has.
   *
   * Drawn only while the row shows no status rollup: the badge already answers
   * "is there anything in here?", and a second number in the same trailing slot
   * reads as another count of the same thing (see {@link showsStatusRollup}).
   */
  childCount: number
  /**
   * The row's status rollup (this row's conversations plus every descendant).
   *
   * Present only when the map has a status source; absent in the pure model
   * tests and when the profile has no `useSessionStatus` face.
   */
  rollup?: StatusRollup | undefined
  threads: ThreadRow[]
  /** Whether the row offers the per-node actions. */
  tools: boolean
  /**
   * Whether the trailing `⋯` menu is offered. `false` keeps the start action but
   * drops the menu: the ungrouped row has nothing to rename or delete.
   */
  menu?: boolean
  /**
   * Whether clicking the row selects it. `false` renders a static container that
   * still folds and starts conversations but never opens a column (the
   * ungrouped row is a conversation list, not a topic container).
   */
  selectable?: boolean
  /** Whether the nested conversation list is folded away. */
  collapsed: boolean
  /** Rendered after this node's conversations, e.g. a "show more" row. */
  threadFooter?: ReactNode
  /**
   * Optional second line under the title, used by the search view for the
   * node's home path or a description snippet with the query highlighted.
   */
  note?: ReactNode
}

/** One column: a level of nodes, with a label that never changes. */
export interface NodeColumn {
  key: string
  title: string
  rows: NodeRow[]
  /** Buttons belonging to the column itself. */
  headerActions?: ReactNode
}

/** Where a row's "more" menu should open, in viewport coordinates. */
export interface MenuRequest {
  kind: 'node' | 'workspace' | 'thread' | 'space'
  id: string
  x: number
  y: number
}

/**
 * How a release over one row would go; drives that row's `data-drop`.
 *
 * `held` is U3's hysteresis: the pointer left every row (a gutter, a column's
 * blank edge, outside the band) but the last candidate is still what the reader
 * is aiming at, so the row keeps its mark instead of going dark. A release there
 * still writes nothing.
 */
export type DropState = 'valid' | 'invalid' | 'noop' | 'held' | 'none'

/** Which edge of a row an insertion line is drawn on. */
export type InsertEdge = 'before' | 'after'

/**
 * The inline mark one row wears while a drag is in flight.
 *
 * Inline on purpose: the plugin's sheet is shared with a concurrent editor, so
 * the gesture's visuals travel with the element that draws them. A legal target
 * is tinted and ringed, a refused one only says so with the cursor — the
 * refusal's wording belongs to the pointer's label, and greying a whole row
 * would read as "this row is gone" rather than "this drop is refused".
 * @param tone - how a release here would go; `none` marks nothing.
 * @param dragging - whether this row is the one being dragged.
 * @returns the row's inline style, or undefined when it wears nothing.
 */
function rowDragStyle(tone: DropState, dragging: boolean): CSSProperties | undefined {
  const style: CSSProperties = {}
  if (dragging) style.opacity = 0.45
  if (tone === 'valid' || tone === 'noop' || tone === 'held') {
    const tint = tone === 'valid' ? 12 : 6
    style.background = `color-mix(in srgb, var(--dsw-alias-brand-primary, currentColor) ${String(tint)}%, transparent)`
    // Held says "still your last candidate, but nothing is under the pointer",
    // so the same mark is drawn as a hint rather than as a live target.
    style.outline = tone === 'held'
      ? '1px dashed color-mix(in srgb, var(--dsw-alias-brand-primary, currentColor) 45%, transparent)'
      : '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, currentColor) 45%, transparent)'
    style.outlineOffset = -1
  } else if (tone === 'invalid') {
    style.cursor = 'no-drop'
  }
  return Object.keys(style).length === 0 ? undefined : style
}

/**
 * The 2px insertion line a topic drop draws on a row's edge.
 *
 * Inline on purpose: the plugin's sheet is shared with a concurrent editor, so
 * the drag's own visuals travel with the element that draws them. The theme
 * token keeps it in the product's brand colour in both themes.
 * @param edge - the edge the line marks.
 * @returns the line's inline style.
 */
export function insertionLineStyle(edge: InsertEdge): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    background: 'var(--dsw-alias-brand-primary, currentColor)',
    pointerEvents: 'none',
    ...edge === 'before' ? { top: -1 } : { bottom: -1 },
  }
}

/** Props of one rendered column. */
export interface NodeColumnViewProps {
  column: NodeColumn
  width: number
  selectedNodeId: string | null
  /**
   * Row keys above the selection that form the line it lives in: the Workspace
   * row and every ancestor topic, outermost first. These rows wear the
   * selection's quieter mark so the reader can tell which upper level's domain
   * the open column sits in; the selected row itself is not in this set.
   */
  ancestorKeys?: ReadonlySet<string>
  /**
   * The row the search view's keyboard cursor is on (a node id or session id).
   *
   * The column draws one quiet active mark on that row; no other row ever
   * carries it, and ordinary columns pass `null`.
   */
  activeRowKey?: string | null
  openSessionId: string | null
  /** The row whose menu is open, which pins that row's affordances. */
  menuRowId: string | null
  onSelectNode: (nodeId: string) => void
  onOpenThread: (sessionId: string) => void
  onNewThread: (nodeId: string) => void
  onToggleNode: (nodeId: string) => void
  onMenu: (request: MenuRequest) => void
  /**
   * A pointer press on a draggable row: a topic row or a conversation row.
   *
   * The column view knows nothing about dragging — it reports what was pressed,
   * and the map decides whether the press travels far enough to become one. Rows
   * that take no part in a drag (Workspace rows, the ungrouped bucket, legacy
   * rootless topics) do not report at all; the payload's Workspace is the map's
   * second, document-side check.
   */
  onRowPointerDown?: (payload: DragPayload, event: PointerEvent<HTMLDivElement>) => void
  /** The row being dragged, by row key: a node id or a session id. */
  draggingKey?: string | null
  /** The row under the pointer. */
  dropKey?: string | null
  /** How a release on `dropKey` would go; every other row reads `none`. */
  dropState?: DropState
  /** The insertion line to draw inside the row named by `dropKey`. */
  insertEdge?: InsertEdge | null
}

/** Folder glyph marking a node. */
function NodeGlyph(): ReactNode {
  return (
    <svg className="cm-row-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
      <path d="M1.6 4.3c0-.6.5-1.1 1.1-1.1h2.9l1.3 1.6h6.4c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1z" />
    </svg>
  )
}

/** Filled triangle: points right when folded, rotates down when open. */
function FoldGlyph(): ReactNode {
  return (
    <svg className="cm-fold" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4.2 11 8l-5 3.8z" fill="currentColor" />
    </svg>
  )
}

/** Speech glyph with a plus: start a conversation here. */
function NewThreadGlyph(): ReactNode {
  return (
    <svg className="cm-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} aria-hidden="true">
      <path d="M2.1 3.4h11.8v6.9H7.2L4 12.9v-2.6H2.1z" />
      <path d="M8 5.4v3M6.5 6.9h3" />
    </svg>
  )
}

/**
 * The application's own running indicator: a quiet ring with a breathing arc
 * that rotates continuously.
 *
 * Geometry mirrors the client's `StateDot` ongoing state — a 24-unit viewBox
 * drawn at 14px, a 9.5 radius, a 2-unit stroke, and one 1.5s period shared by
 * the spin and the dash — so a running conversation reads exactly like a
 * running session in the application's own list.
 */
function RunningRing(): ReactNode {
  /**
   * Pin the ring to document time zero.
   *
   * A CSS animation starts when its element is inserted, so rings mounted at
   * different moments turn out of phase. The application aligns its own loaders
   * the same way, which keeps the plugin's ring in step with them.
   * @param element - the mounted ring, or null on unmount.
   */
  const sync = (element: SVGSVGElement | null): void => {
    if (element === null) return
    for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0
  }
  return (
    <svg ref={sync} className="cm-ring" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
      <g className="cm-ring-motion">
        <circle className="cm-ring-track" cx={12} cy={12} r={9.5} />
        <circle className="cm-ring-arc" cx={12} cy={12} r={9.5} />
      </g>
    </svg>
  )
}

/** A solid state mark, matching the application's done and warning dots. */
function StatusDot({ state, label }: { state: 'done' | 'warning'; label: string }): ReactNode {
  return <span className="cm-state-dot" data-state={state} role="img" aria-label={label} title={label} />
}

/** Plus glyph: the column's own add action. */
export function PlusGlyph(): ReactNode {
  return (
    <svg className="cm-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.6v8.8M3.6 8h8.8" />
    </svg>
  )
}

/** Three dots: the row's more menu. */
export function EllipsisGlyph(): ReactNode {
  return (
    <svg className="cm-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx={3.4} cy={8} r={1.15} fill="currentColor" />
      <circle cx={8} cy={8} r={1.15} fill="currentColor" />
      <circle cx={12.6} cy={8} r={1.15} fill="currentColor" />
    </svg>
  )
}

/**
 * Below this column width the rollup drops its counts and draws dots only.
 *
 * The default column is 220px; four counts plus their dots would take roughly
 * half the row and truncate the title. 200px keeps the default readable while
 * still giving a dragged-narrow column the quieter mark. The exact number is a
 * first-pass constant, measured against the real column widths in the client.
 */
const ROLLUP_DOTS_WIDTH = 200

/**
 * Whether a row's status rollup draws anything.
 *
 * The badge and the descendant count share one trailing slot, and the count sits
 * immediately left of the badge — two bare numbers in a row read as "this many
 * of the same thing". So the badge takes the slot and the count yields: a row
 * that reports a conversation state no longer prints its child-node count. It is
 * keyed to what is actually drawn, not to whether a status source exists, so an
 * idle row (every count zero) keeps its count exactly as before, and a profile
 * without `useSessionStatus` is untouched.
 * @param rollup - the row's counts, when the map has a status source.
 * @returns whether {@link StatusRollupBadge} renders a badge for this row.
 */
export function showsStatusRollup(rollup: StatusRollup | undefined): boolean {
  return rollup !== undefined && rollup.total > 0
}

/**
 * Render one level.
 * @param props - the column, its width, and the callbacks its rows use.
 * @returns the column body.
 */
export function NodeColumnView(props: NodeColumnViewProps): ReactNode {
  const { column, width } = props
  const t = useT()
  const rollupDensity = width < ROLLUP_DOTS_WIDTH ? 'dots' : 'cluster'
  return (
    <div className="cm-node-col" style={{ width }}>
      <div className="cm-col-head">
        <span className="cm-col-title" title={column.title}>{column.title}</span>
        {column.headerActions !== undefined && <span className="cm-col-actions">{column.headerActions}</span>}
      </div>
      <div className="cm-col-scroll">
        {column.rows.map(row => {
          if (row.kind === 'hint') return <div key={row.id} className="cm-hint-row">{row.title}</div>
          const dropState: DropState = props.dropKey === row.id ? props.dropState ?? 'none' : 'none'
          const insertEdge = props.dropKey === row.id ? props.insertEdge ?? null : null
          const showStatus = showsStatusRollup(row.rollup)
          const rowStyle = {
            ...rowDragStyle(dropState, props.draggingKey === row.id),
            ...insertEdge === null ? {} : { position: 'relative' as const },
          }
          // Only a selectable topic row drags: a Workspace row is not a payload,
          // the ungrouped bucket takes no part in a drag at all, and the search
          // result group heading is a heading (its synthetic id must never
          // become a drop target).
          const payload: DragPayload | null = row.kind === 'node'
            && row.selectable !== false
            && props.onRowPointerDown !== undefined
            ? { kind: 'node', nodeId: row.id, workspaceId: row.workspaceId ?? null }
            : null
          return (
            <div key={row.id}>
              <div
                className="cm-node-row"
                data-kind={row.kind}
                data-node-id={row.kind === 'node' ? row.id : undefined}
                data-node-workspace-id={row.kind === 'node' ? row.workspaceId ?? '' : undefined}
                data-row-key={row.kind === 'workspace' || row.kind === 'ungrouped' ? row.id : undefined}
                data-selected={row.selectable !== false && row.id === props.selectedNodeId}
                data-note={row.note === undefined ? undefined : 'true'}
                data-search-active={props.activeRowKey !== undefined && row.id === props.activeRowKey ? 'true' : undefined}
                data-path-selected={row.selectable !== false
                  && row.id !== props.selectedNodeId
                  && props.ancestorKeys?.has(row.id) === true}
                data-collapsed={row.collapsed}
                data-menu={row.id === props.menuRowId}
                data-selectable={row.selectable !== false}
                data-dragging={props.draggingKey === row.id ? 'true' : 'false'}
                data-drop={dropState}
                style={Object.keys(rowStyle).length === 0 ? undefined : rowStyle}
                role={row.selectable === false ? undefined : 'button'}
                tabIndex={row.selectable === false ? undefined : 0}
                title={row.title}
                onPointerDown={payload === null ? undefined : (event) => { props.onRowPointerDown?.(payload, event) }}
                onClick={row.selectable === false ? undefined : () => { props.onSelectNode(row.id) }}
                onKeyDown={row.selectable === false
                  ? undefined
                  : (event) => { if (event.key === 'Enter') props.onSelectNode(row.id) }}
              >
                <span className="cm-slot">
                  {row.threads.length === 0
                    ? <NodeGlyph />
                    : (
                      <>
                        <span className="cm-folder"><NodeGlyph /></span>
                        <button
                          type="button"
                          className="cm-icon-btn cm-chevron"
                          data-open={!row.collapsed}
                          aria-expanded={!row.collapsed}
                          aria-label={row.collapsed ? t('columns.expandThreads') : t('columns.collapseThreads')}
                          onClick={(event) => { event.stopPropagation(); props.onToggleNode(row.id) }}
                        >
                          <FoldGlyph />
                        </button>
                      </>
                    )}
                </span>
                <span className="cm-row-labels">
                  <span className="cm-row-label">{row.title}</span>
                  {row.note !== undefined && <span className="cm-row-note">{row.note}</span>}
                </span>
                {row.childCount > 0 && !showStatus && (
                  <span className="cm-child-count" title={t('columns.childCount', { n: row.childCount })}>{row.childCount}</span>
                )}
                <StatusRollupBadge rollup={row.rollup} density={rollupDensity} />
                {row.tools && (
                  <span className="cm-row-actions">
                    <button
                      type="button"
                      className="cm-icon-btn"
                      title={row.kind === 'node'
                        ? t('columns.newThreadInNode')
                        : row.kind === 'ungrouped' ? t('columns.newThreadInUngrouped') : t('columns.newThreadInWorkspace')}
                      aria-label={t('common.startConversation')}
                      onClick={(event) => { event.stopPropagation(); props.onNewThread(row.id) }}
                    >
                      <NewThreadGlyph />
                    </button>
                    {row.menu !== false && (
                      <button
                        type="button"
                        className="cm-icon-btn"
                        title={t('common.more')}
                        aria-label={t('common.more')}
                        onClick={(event) => {
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          props.onMenu({ kind: row.kind === 'node' ? 'node' : 'workspace', id: row.id, x: rect.left, y: rect.bottom })
                        }}
                      >
                        <EllipsisGlyph />
                      </button>
                    )}
                  </span>
                )}
                {insertEdge !== null && (
                  <span data-insert={insertEdge} style={insertionLineStyle(insertEdge)} aria-hidden="true" />
                )}
              </div>

              {!row.collapsed && row.threads.map(thread => {
                const threadDrop: DropState = props.dropKey === thread.sessionId ? props.dropState ?? 'none' : 'none'
                const threadStyle = rowDragStyle(threadDrop, props.draggingKey === thread.sessionId)
                return (
                <div
                  className="cm-thread-row"
                  key={thread.sessionId}
                  data-session-id={thread.sessionId}
                  data-parent-node-id={row.kind === 'node' ? row.id : undefined}
                  data-parent-workspace-id={row.kind === 'workspace' ? row.workspaceId ?? '' : undefined}
                  data-selected={thread.sessionId === props.openSessionId}
                  data-note={thread.note === undefined ? undefined : 'true'}
                  data-search-active={props.activeRowKey !== undefined && thread.sessionId === props.activeRowKey ? 'true' : undefined}
                  data-menu={thread.sessionId === props.menuRowId}
                  data-dragging={props.draggingKey === thread.sessionId ? 'true' : 'false'}
                  data-drop={threadDrop}
                  style={threadStyle}
                  aria-current={thread.sessionId === props.openSessionId ? 'page' : undefined}
                  role="button"
                  tabIndex={0}
                  title={thread.title}
                  onPointerDown={props.onRowPointerDown === undefined
                    ? undefined
                    : (event) => {
                      props.onRowPointerDown?.(
                        { kind: 'session', sessionId: thread.sessionId, workspaceId: thread.workspaceId ?? null },
                        event,
                      )
                    }}
                  onClick={() => { props.onOpenThread(thread.sessionId) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') props.onOpenThread(thread.sessionId) }}
                >
                  <span className="cm-slot">
                    {thread.status !== undefined && (thread.status.state === 'ongoing'
                      ? <RunningRing />
                      : <StatusDot state={thread.status.state} label={thread.status.label} />)}
                  </span>
                  <span className="cm-row-labels">
                    <span className="cm-row-label">{thread.title}</span>
                    {thread.note !== undefined && <span className="cm-row-note">{thread.note}</span>}
                  </span>
                  {thread.status !== undefined && thread.status.compact !== ''
                    ? <span className="cm-compact">{thread.status.compact}</span>
                    : thread.time !== '' && <span className="cm-time">{thread.time}</span>}
                  <span className="cm-row-actions">
                    <button
                      type="button"
                      className="cm-icon-btn"
                      title={t('common.more')}
                      aria-label={t('common.more')}
                      onClick={(event) => {
                        event.stopPropagation()
                        const rect = event.currentTarget.getBoundingClientRect()
                        props.onMenu({ kind: 'thread', id: thread.sessionId, x: rect.left, y: rect.bottom })
                      }}
                    >
                      <EllipsisGlyph />
                    </button>
                  </span>
                </div>
                )
              })}

              {!row.collapsed && row.threadFooter}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Props of one resize handle. */
export interface GutterProps {
  /** The width the target had when the drag started. */
  width: number
  /** Called with the requested width while dragging. */
  onResize: (width: number) => void
  /** Set for a handle on the right edge, where dragging left grows the target. */
  inverted?: boolean
  /** Ceiling for this target; defaults to the shared column maximum. */
  max?: number
}

/**
 * A drag handle that resizes the column to its left.
 *
 * It draws nothing: the column's own border-right stays the only vertical on
 * screen and the col-resize cursor carries the affordance — the same contract
 * the shipped handles keep, where no handle paints a pill. The width is exposed
 * to assistive technology through the separator's aria value, not painted.
 * @param props - the target's current width and the width sink.
 * @returns the handle.
 */
export function Gutter({ width, onResize, inverted = false, max }: GutterProps): ReactNode {
  const origin = useRef({ x: 0, width })
  return (
    <div
      className="cm-gutter"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, width }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const delta = event.clientX - origin.current.x
        onResize(clampColumnWidth(origin.current.width + (inverted ? -delta : delta), max))
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
    />
  )
}
