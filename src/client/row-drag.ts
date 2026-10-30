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
 *
 * The pointer label is structured ({@link DragLabel}) and formatted by the render
 * site through its own dictionary: the model's issue code is the identity, and
 * the wording for "moved under …" / "not ordered" lives in the plugin's locale
 * namespace, never in this module.
 */
import {
  MAX_DEPTH, assignThreadIssue, moveNodeIssue, threadOfSession, workspaceOfNode,
  type MapNode, type MapState, type MoveIssue,
} from '../shared/model.js'
import type { Translate } from '../shared/copy.js'

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

/** The destination sentence a valid drop would produce, before localization. */
export type DragLabel =
  | { kind: 'issue'; code: string }
  | { kind: 'unchanged' }
  | { kind: 'workspace' }
  | { kind: 'under'; title: string }
  | { kind: 'before'; title: string }
  | { kind: 'after'; title: string }
  | { kind: 'sessionWorkspace'; unordered: boolean }
  | { kind: 'sessionUnder'; title: string; unordered: boolean }

/**
 * What releasing here would do.
 *
 * `issue` non-null means the target is refused (show the label for its code,
 * commit nothing); `noop` means the target is fine but the move would change
 * nothing (`action` is then `null` as well, so a caller that only looks at
 * `action` cannot commit one by accident). Otherwise `action` is the plan to
 * hand to the store.
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
  /** Follow-the-pointer label, localized by {@link formatDragLabel}. */
  label: DragLabel
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

/** One refused drop: the model's issue plus the structured label the pointer shows. */
function refused(issue: MoveIssue): DropDecision {
  return { action: null, issue, noop: false, label: { kind: 'issue', code: issue.code } }
}

/** One refused drop stated directly with the model's issue vocabulary. */
function refusedCode(code: string): DropDecision {
  return { action: null, issue: { code, message: code }, noop: false, label: { kind: 'issue', code } }
}

/** One valid drop that would change nothing. */
function unchanged(): DropDecision {
  return { action: null, issue: null, noop: true, label: { kind: 'unchanged' } }
}

/**
 * Format a structured pointer label through the caller's dictionary.
 * @param t - the active translator (namespace `conversation-map`).
 * @param label - the structured label.
 * @returns the user-facing sentence.
 */
export function formatDragLabel(t: Translate, label: DragLabel): string {
  switch (label.kind) {
    case 'issue':
      return label.code === 'DEPTH'
        ? t('drag.issue.DEPTH', { max: MAX_DEPTH })
        : t(`drag.issue.${label.code}`)
    case 'unchanged':
      return t('drag.unchanged')
    case 'workspace':
      return t('drag.workspace')
    case 'under':
      return t('drag.under', { title: label.title })
    case 'before':
      return t('drag.before', { title: label.title })
    case 'after':
      return t('drag.after', { title: label.title })
    case 'sessionWorkspace':
      return withUnorderedNote(t, t('drag.workspace'), label.unordered)
    case 'sessionUnder':
      return withUnorderedNote(t, t('drag.under', { title: label.title }), label.unordered)
  }
}

/**
 * A conversation is ordered by activity, never by hand, so a sibling edge means
 * nothing to it: the label says so instead of promising a slot.
 * @param t - the active translator.
 * @param base - the destination sentence.
 * @param unordered - true when the pointer named a sibling edge.
 * @returns the sentence with the no-ordering note appended when needed.
 */
function withUnorderedNote(t: Translate, base: string, unordered: boolean): string {
  return unordered ? base + t('drag.unorderedSuffix') : base
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
 * @returns the plan, the refusal, or the no-op, with a structured label to show.
 */
export function decideDrop(state: MapState, payload: DragPayload, candidate: DropCandidate): DropDecision {
  const row = candidate.row
  if (row.kind === 'none') {
    return refusedCode('NONE')
  }
  // The ungrouped bucket is a conversation list, not a Workspace: it has no
  // Workspace for a target to agree with, so nothing in it drags and nothing
  // drops into it.
  if (payload.workspaceId === null || (row.kind === 'node' && row.workspaceId === null)) {
    return refusedCode('UNGROUPED')
  }

  if (payload.kind === 'session') return decideSession(state, payload, candidate)

  const source = state.nodes.find(node => node.id === payload.nodeId)
  if (source === undefined) {
    return refusedCode('NOT_FOUND')
  }
  const workspaceId = workspaceOfNode(source)
  if (row.workspaceId !== workspaceId) {
    return refusedCode('WORKSPACE')
  }

  if (row.kind === 'workspace') {
    return planNode(state, source, null, null, { kind: 'workspace' })
  }
  const target = state.nodes.find(node => node.id === row.nodeId)
  if (target === undefined) {
    return refusedCode('NOT_FOUND')
  }
  if (candidate.edge === 'into') {
    return planNode(state, source, target.id, null, { kind: 'under', title: target.title })
  }
  if (candidate.edge === 'before') {
    return planNode(state, source, target.parentId, target.id, { kind: 'before', title: target.title })
  }
  const siblings = siblingsOf(state, target.parentId, workspaceId)
  return planNode(
    state,
    source,
    target.parentId,
    nextSiblingId(siblings, target.id),
    { kind: 'after', title: target.title },
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
    return refusedCode('NONE')
  }
  const thread = threadOfSession(state, payload.sessionId)
  // The document is the authority on which Workspace accounts for the
  // conversation: an unaccounted row (`workspaceId === undefined`) has no
  // Workspace to agree with yet, so it does not drag (the panel marks such rows
  // undraggable; this is the backstop).
  const owner = thread === undefined ? payload.workspaceId : thread.workspaceId ?? null
  if (owner === null) {
    return refusedCode('UNGROUPED')
  }
  if (row.workspaceId !== owner) {
    return refusedCode('WORKSPACE')
  }

  const nodeId = row.kind === 'workspace' ? null : row.nodeId
  const issue = assignThreadIssue(state, payload.sessionId, nodeId)
  if (issue !== null) return refused(issue)
  if (thread === undefined) {
    // `assignThreadIssue` stays permissive for a conversation the index has never
    // seen (the model tools need that), but a row on screen that is no longer in
    // the document cannot be dragged anywhere.
    return refusedCode('NO_THREAD')
  }

  const unordered = candidate.edge !== 'into'
  if (row.kind === 'workspace') {
    if (thread.nodeId === null) return unchanged()
    return {
      action: { kind: 'thread', sessionId: payload.sessionId, nodeId: null },
      issue: null,
      noop: false,
      label: { kind: 'sessionWorkspace', unordered },
    }
  }
  const target = state.nodes.find(node => node.id === nodeId)
  if (target === undefined) {
    return refusedCode('NOT_FOUND')
  }
  if (thread.nodeId === target.id) return unchanged()
  return {
    action: { kind: 'thread', sessionId: payload.sessionId, nodeId: target.id },
    issue: null,
    noop: false,
    label: { kind: 'sessionUnder', title: target.title, unordered },
  }
}

/** A topic drop: re-parent to `parentId`, slotting it before `beforeNodeId`. */
function planNode(
  state: MapState,
  source: MapNode,
  parentId: string | null,
  beforeNodeId: string | null,
  label: DragLabel,
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
