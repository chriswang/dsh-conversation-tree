/**
 * Drag core for the conversation map: one gesture vocabulary for two kinds of row.
 *
 * A drag starts on a conversation row (file the conversation somewhere else) or
 * on a topic row (re-parent the topic), and the same pointer state machine drives
 * both — only the payload differs. This module holds the half of that machine
 * that is pure logic: when a press has travelled far enough to be a drag, and
 * what a release over a given row would do. It touches no React, no DOM, and no
 * store, so the rules can be exercised directly by the Node tests, and the
 * panel half (`MapPanel`) only has to resolve "what is under the pointer" into a
 * {@link DropCandidate} and run the returned {@link DropDecision}.
 *
 * Two judgements are deliberately *not* re-implemented here. Whether a move is
 * legal is {@link moveNodeIssue} / {@link assignThreadIssue} in the shared model
 * — the same functions {@link moveNode} and {@link assignThreads} throw from — so
 * a greyed-out target and a refused commit can never disagree. And whether a
 * move would change anything is computed exactly the way `insertNodeBefore`
 * computes it (drop the moved node from its siblings, insert it at the anchor,
 * compare the sequence), so "no-op" here means "the model would write nothing".
 */

import {
  MAX_DEPTH, assignThreadIssue, moveNodeIssue, threadOfSession, workspaceOfNode,
  type MapNode, type MapState, type MoveIssue,
} from '../shared/model.js'

/**
 * What the pointer is carrying.
 *
 * `workspaceId` is the Workspace the row belongs to, normalised by the caller
 * (`null` = the ungrouped bucket, which never takes part in a drag).
 */
export type DragPayload =
  | { kind: 'session'; sessionId: string; workspaceId: string | null }
  | { kind: 'node'; nodeId: string; workspaceId: string | null }

/**
 * Where on a row the pointer sits.
 *
 * `into` files the payload under that row's row (a conversation under a topic, a
 * topic under a topic); `before`/`after` place it as that row's sibling. Only a
 * topic payload can be placed between siblings — conversations have no manual
 * order, so the caller's edge is ignored for them.
 */
export type DropKind = 'into' | 'before' | 'after'

/**
 * What the pointer is over, as the panel resolves it from the DOM.
 *
 * `row.kind === 'none'` is "no droppable row here" (gutter, column blank, band
 * edge); the panel decides that, this module only explains it.
 */
export interface DropCandidate {
  row:
    | { kind: 'node'; nodeId: string; workspaceId: string | null }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'none' }
  edge: DropKind
}

/**
 * What releasing here would do.
 *
 * `issue` non-null means the target is refused (show `label`, commit nothing);
 * `noop` means the target is fine but the move would change nothing (`action` is
 * then `null` as well, so a caller that only looks at `action` cannot commit
 * one by accident). Otherwise `action` is the plan to hand to the store.
 */
export interface DropDecision {
  action:
    | { kind: 'thread'; sessionId: string; nodeId: string | null }
    | { kind: 'node'; nodeId: string; parentId: string | null; beforeNodeId: string | null }
    | null
  /** Non-null = the drop is refused; the code is the model's own vocabulary. */
  issue: MoveIssue | null
  /** The drop is valid but would change nothing — do not commit. */
  noop: boolean
  /** Follow-the-pointer label, already user-facing Chinese. */
  label: string
}

/** Travel, in CSS pixels, before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 4

/**
 * Whether a press that started at `from` and is now at `to` is a drag.
 *
 * Straight-line distance, so a fast diagonal counts as readily as a horizontal
 * one; the row height (32–34px) leaves far more room than this for a plain click.
 * @param from - where the pointer went down.
 * @param to - where the pointer is now.
 * @returns true once the pointer has travelled {@link DRAG_THRESHOLD_PX}.
 */
export function exceedsDragThreshold(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX
}

/** Refusals the model states in its own words but the pointer label says shorter. */
const ISSUE_LABELS: Readonly<Record<string, string>> = {
  NOT_FOUND: '目标节点已不存在',
  WORKSPACE: '不能移到别的工作区',
  CYCLE: '不能移到自己的子节点下',
  DEPTH: `超过 ${String(MAX_DEPTH)} 层`,
  SPACE: '只能移到默认空间的节点下',
  SUBAGENT: '子智能体会话不能移动',
  ANCHOR: '锚点不在目标位置下',
  NO_THREAD: '对话已不存在',
  NONE: '不能放在这里',
  UNGROUPED: '未分组不参与拖动',
}

/** One refused drop: the model's issue plus the short label the pointer shows. */
function refused(issue: MoveIssue): DropDecision {
  return { action: null, issue, noop: false, label: ISSUE_LABELS[issue.code] ?? issue.message }
}

/** One valid drop that would change nothing. */
function unchanged(): DropDecision {
  return { action: null, issue: null, noop: true, label: '位置不变' }
}

/** Siblings of one parent inside one Workspace, in the model's display order. */
function siblingsOf(state: MapState, parentId: string | null, workspaceId: string | null): MapNode[] {
  return state.nodes
    .filter(node => node.parentId === parentId && workspaceOfNode(node) === workspaceId)
    .sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
}

/** The sibling right after `nodeId` among `siblings`, or `null` when it is last. */
function nextSiblingId(siblings: readonly MapNode[], nodeId: string): string | null {
  const at = siblings.findIndex(node => node.id === nodeId)
  return at === -1 ? null : siblings[at + 1]?.id ?? null
}

/**
 * Whether handing `insertNodeBefore(id, parentId, beforeNodeId)` to the store
 * would actually move anything.
 *
 * The steps mirror `insertNodeBefore`: the anchor is looked up among the target
 * parent's siblings (so "before itself" is a no-op), the moved node is taken out
 * of that sequence and put back at the anchor's index, and the result is compared
 * with the sequence the map already has. A re-parent is always a change; landing
 * back in the same slot is not.
 * @returns true when committing would rewrite the document.
 */
function slotChanges(
  state: MapState,
  moved: MapNode,
  parentId: string | null,
  beforeNodeId: string | null,
  workspaceId: string | null,
): boolean {
  const siblings = siblingsOf(state, parentId, workspaceId)
  const anchor = beforeNodeId === null ? undefined : siblings.find(node => node.id === beforeNodeId)
  if (anchor !== undefined && anchor.id === moved.id) return false
  const withoutMoved = siblings.filter(node => node.id !== moved.id)
  const at = anchor === undefined
    ? withoutMoved.length
    : withoutMoved.findIndex(node => node.id === anchor.id)
  const ordered = [...withoutMoved.slice(0, at), moved, ...withoutMoved.slice(at)]
  const same = moved.parentId === parentId
    && ordered.length === siblings.length
    && ordered.every((node, index) => node.id === siblings[index]?.id)
  return !same
}

/**
 * Decide what a release over `candidate` would do with `payload`.
 *
 * The refusals are computed here, at hit-test time, and never left to the
 * commit: the store's `put` checks the envelope and the revision but not the
 * meaning of a move, and a target that is "null-parented" (a Workspace row, the
 * ungrouped bucket) has no Workspace check in the model at all — so a drop that
 * looked acceptable and landed wrong would be written to the document and only
 * repaired by the next reconciliation. Hence: the ungrouped bucket is excluded
 * wholesale (both as a source and as a target), a Workspace row only accepts its
 * own Workspace, and everything else is the shared model's judgement.
 * @param state - the map, as the panel currently has it.
 * @param payload - the row the drag started from.
 * @param candidate - the row and edge under the pointer.
 * @returns the plan, the refusal, or the no-op, with a label to show.
 */
export function decideDrop(state: MapState, payload: DragPayload, candidate: DropCandidate): DropDecision {
  const row = candidate.row
  if (row.kind === 'none') {
    return refused({ code: 'NONE', message: '这里没有可以放置的目标。' })
  }
  // The ungrouped bucket is a conversation list, not a Workspace: it has no
  // Workspace for a target to agree with, so nothing in it drags and nothing
  // drops into it.
  if (payload.workspaceId === null || (row.kind === 'node' && row.workspaceId === null)) {
    return refused({ code: 'UNGROUPED', message: '未分组的内容不参与拖动。' })
  }

  if (payload.kind === 'session') return decideSession(state, payload, candidate)

  const source = state.nodes.find(node => node.id === payload.nodeId)
  if (source === undefined) {
    return refused({ code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  }
  const workspaceId = workspaceOfNode(source)
  if (row.workspaceId !== workspaceId) {
    return refused({ code: 'WORKSPACE', message: '不能把节点移动到其他工作区的节点下。' })
  }

  if (row.kind === 'workspace') {
    return planNode(state, source, null, null, '移到工作区下')
  }
  const target = state.nodes.find(node => node.id === row.nodeId)
  if (target === undefined) {
    return refused({ code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  }
  if (candidate.edge === 'into') {
    return planNode(state, source, target.id, null, `移到「${target.title}」下`)
  }
  if (candidate.edge === 'before') {
    return planNode(state, source, target.parentId, target.id, `插到「${target.title}」之前`)
  }
  const siblings = siblingsOf(state, target.parentId, workspaceId)
  return planNode(
    state,
    source,
    target.parentId,
    nextSiblingId(siblings, target.id),
    `插到「${target.title}」之后`,
  )
}

/** A conversation drop: into a topic, or directly under its own Workspace row. */
function decideSession(
  state: MapState,
  payload: Extract<DragPayload, { kind: 'session' }>,
  candidate: DropCandidate,
): DropDecision {
  const row = candidate.row
  if (row.kind === 'none') {
    return refused({ code: 'NONE', message: '这里没有可以放置的目标。' })
  }
  const thread = threadOfSession(state, payload.sessionId)
  // The document is the authority on which Workspace accounts for the
  // conversation: an unaccounted row (`workspaceId === undefined`) has no
  // Workspace to agree with yet, so it does not drag (the panel marks such rows
  // undraggable; this is the backstop).
  const owner = thread === undefined ? payload.workspaceId : thread.workspaceId ?? null
  if (owner === null) {
    return refused({ code: 'UNGROUPED', message: '未分组的内容不参与拖动。' })
  }
  if (row.workspaceId !== owner) {
    return refused({ code: 'WORKSPACE', message: '只能把对话关联到它所属工作区里的节点。' })
  }

  const nodeId = row.kind === 'workspace' ? null : row.nodeId
  const issue = assignThreadIssue(state, payload.sessionId, nodeId)
  if (issue !== null) return refused(issue)
  if (thread === undefined) {
    // `assignThreadIssue` stays permissive for a conversation the index has never
    // seen (the model tools need that), but a row on screen that is no longer in
    // the document cannot be dragged anywhere.
    return refused({ code: 'NO_THREAD', message: '这条对话已不在对话树中。' })
  }

  if (row.kind === 'workspace') {
    if (thread.nodeId === null) return unchanged()
    return {
      action: { kind: 'thread', sessionId: payload.sessionId, nodeId: null },
      issue: null,
      noop: false,
      label: edgeSuffix(candidate.edge, '移到工作区下'),
    }
  }
  const target = state.nodes.find(node => node.id === nodeId)
  if (target === undefined) {
    return refused({ code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  }
  if (thread.nodeId === target.id) return unchanged()
  return {
    action: { kind: 'thread', sessionId: payload.sessionId, nodeId: target.id },
    issue: null,
    noop: false,
    label: edgeSuffix(candidate.edge, `移到「${target.title}」下`),
  }
}

/**
 * A conversation is ordered by activity, never by hand, so an edge means nothing
 * to it: the drop is `into`, and the label says so instead of promising a slot.
 */
function edgeSuffix(edge: DropKind, label: string): string {
  return edge === 'into' ? label : `${label}（对话不排序）`
}

/** A topic drop: re-parent to `parentId`, slotting it before `beforeNodeId`. */
function planNode(
  state: MapState,
  source: MapNode,
  parentId: string | null,
  beforeNodeId: string | null,
  label: string,
): DropDecision {
  const issue = moveNodeIssue(state, source.id, parentId)
  if (issue !== null) return refused(issue)
  const workspaceId = workspaceOfNode(source)
  if (!slotChanges(state, source, parentId, beforeNodeId, workspaceId)) return unchanged()
  return {
    action: { kind: 'node', nodeId: source.id, parentId, beforeNodeId },
    issue: null,
    noop: false,
    label,
  }
}
