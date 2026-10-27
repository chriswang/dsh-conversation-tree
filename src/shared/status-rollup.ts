/**
 * Session-status rollups for the conversation map.
 *
 * The map's rows answer one question the shipped sidebar cannot: *where* in a
 * topic tree is there work that changed and still needs attention? Every node
 * row therefore carries a rollup of its own conversations **and** every
 * descendant node's conversations, restricted to sessions whose status has not
 * been cleared yet.
 *
 * Nothing here is persisted or invented: the categories are derived from the
 * application's own Session UI status (`running`, `pendingInteraction`,
 * `completionUnread`), and the only extra fact is when a category last changed,
 * which the client observes. The rollup itself is a pure function of the map,
 * the session index, and that observation, so it is exercised directly by the
 * unit tests.
 *
 * There is deliberately **no time window**: a completed conversation keeps
 * counting until the reader opens it (the application then clears
 * `completionUnread`), a pending request keeps counting until it is answered,
 * and an error keeps counting until the conversation is opened or runs again.
 */

/** One category a session can contribute to its node's rollup. */
export type StatusCategory = 'pending' | 'error' | 'done' | 'running'

/** Every category, in the order rows draw them. */
export const STATUS_CATEGORIES: readonly StatusCategory[] = ['pending', 'error', 'done', 'running']

/** The four counts a rollup carries. */
export interface StatusCounts {
  pending: number
  error: number
  done: number
  running: number
}

/** A fresh zeroed count set. */
export function emptyStatusCounts(): StatusCounts {
  return { pending: 0, error: 0, done: 0, running: 0 }
}

/** Add one count set into another (mutating `target`). */
export function addStatusCounts(target: StatusCounts, source: StatusCounts): void {
  target.pending += source.pending
  target.error += source.error
  target.done += source.done
  target.running += source.running
}

/**
 * One session's contribution, as the observer records it.
 *
 * `changedAt` is wall-clock milliseconds from the observation, used only to
 * order the detail list and to flag a two-minute "new" glow. It is not a
 * filter: no session is dropped because it is old.
 */
export interface ObservedSessionStatus {
  category: StatusCategory
  /** When this category was first observed (epoch ms). */
  changedAt: number
}

/** What one rollup carries for one row. */
export interface StatusRollup {
  /** Direct conversations of this row plus every descendant's conversations. */
  counts: StatusCounts
  /** Conversations filed directly under this row (node rows only). */
  direct: StatusCounts
  /** How many sessions the counts add up to (attention + running). */
  total: number
  /** `pending + error + done`: the "needs a look" total, running excluded. */
  attention: number
  /**
   * The newest category that changed within {@link FRESH_MS}, when there is one.
   *
   * Only used to draw a quiet halo so a reader notices a number that just moved;
   * it never changes the counts.
   */
  fresh?: StatusCategory | undefined
  /** Whether any counted session changed within {@link FRESH_MS}. */
  freshAt?: number | undefined
}

/** How long a changed badge keeps its "new" halo. */
export const FRESH_MS = 2 * 60 * 1000

/** The map facts the rollup needs: nodes and the sessions filed under them. */
export interface RollupNode {
  id: string
  parentId: string | null
}

/** One indexed conversation, narrowed to what the rollup needs. */
export interface RollupThread {
  sessionId: string
  nodeId: string | null
  workspaceId?: string | null
}

/** Everything one rollup pass reads. */
export interface RollupInput {
  nodes: readonly RollupNode[]
  threads: readonly RollupThread[]
  /** Observed status per session; a session without an entry is idle. */
  statuses: ReadonlyMap<string, ObservedSessionStatus>
  /** The conversation currently open in the reading pane. */
  openSessionId?: string | null
  /** Whether running conversations are part of the picture. */
  showRunning?: boolean
  /** Clock override for tests. */
  now?: number
}

/** One row's result, keyed by the row's map key. */
export interface RollupResult {
  /** Node id → rollup (topic rows). */
  nodes: ReadonlyMap<string, StatusRollup>
  /** Workspace id → rollup (L1 rows; sessions across the whole Workspace). */
  workspaces: ReadonlyMap<string, StatusRollup>
  /** The ungrouped bucket's rollup. */
  ungrouped: StatusRollup
}

/** A zeroed rollup a row can render without a map entry. */
export function emptyStatusRollup(): StatusRollup {
  return {
    counts: emptyStatusCounts(),
    direct: emptyStatusCounts(),
    total: 0,
    attention: 0,
  }
}

/**
 * Count one session into a set, honouring the two rules that keep the number
 * honest: an open conversation is already in front of the reader, so it does
 * not add to the "where should I go" total, and running is optional context
 * rather than a to-do.
 * @param counts - target counts.
 * @param status - the observed status, if any.
 * @param openSessionId - the conversation currently open.
 * @param showRunning - whether running sessions are counted.
 * @returns the counted category, or undefined when the session contributes nothing.
 */
function countSession(
  counts: StatusCounts,
  status: ObservedSessionStatus | undefined,
  sessionId: string,
  openSessionId: string | null,
  showRunning: boolean,
): StatusCategory | undefined {
  if (status === undefined) return undefined
  if (status.category === 'running') {
    if (!showRunning) return undefined
    counts.running += 1
    return 'running'
  }
  // Only the conversation actually open in the reading pane is skipped. This
  // must be a per-session check: a global `openSessionId !== null` would drop
  // every other completed/error/pending conversation as soon as any session is
  // open, which is exactly the bug the panel used to have.
  if (openSessionId !== null && sessionId === openSessionId) return undefined
  counts[status.category] += 1
  return status.category
}

/**
 * Derive the status rollups for every node, Workspace, and the ungrouped bucket.
 *
 * One pass over the threads plus one post-order walk over the nodes, so a busy
 * tree costs `O(nodes + threads)` rather than a subtree scan per row.
 * @param input - nodes, indexed threads, observed statuses, and display switches.
 * @returns the three rollup maps the rows read.
 */
export function rollupStatuses(input: RollupInput): RollupResult {
  const now = input.now ?? Date.now()
  const showRunning = input.showRunning !== false
  const openSessionId = input.openSessionId ?? null
  const bySession = new Map<string, RollupThread>()
  for (const thread of input.threads) bySession.set(thread.sessionId, thread)

  // Direct counts per node, and per Workspace for conversations filed directly
  // under the Workspace row (nodeId === null).
  const directByNode = new Map<string, StatusCounts>()
  const directByWorkspace = new Map<string, StatusCounts>()
  const directUngrouped = emptyStatusCounts()
  const freshByNode = new Map<string, { category: StatusCategory; at: number }>()
  const freshByWorkspace = new Map<string, { category: StatusCategory; at: number }>()
  let freshUngrouped: { category: StatusCategory; at: number } | undefined

  const recordFresh = (
    target: Map<string, { category: StatusCategory; at: number }>,
    key: string,
    status: ObservedSessionStatus,
    category: StatusCategory,
  ): void => {
    if (status.category === 'running') return
    if (now - status.changedAt >= FRESH_MS) return
    const previous = target.get(key)
    if (previous === undefined || status.changedAt > previous.at) {
      target.set(key, { category, at: status.changedAt })
    }
  }

  // Workspace ownership is not in the map document for every thread (a legacy
  // row can predate accounting), so the caller passes threads already scoped to
  // a Workspace when it has one. Here we only need the thread's node, plus the
  // workspace id when it was supplied.
  const threadWorkspace = new Map<string, string | null>()
  for (const thread of input.threads) threadWorkspace.set(thread.sessionId, thread.workspaceId ?? null)

  for (const [sessionId, status] of input.statuses) {
    const thread = bySession.get(sessionId)
    if (thread === undefined) continue
    const category = countSession(emptyStatusCounts(), status, sessionId, openSessionId, showRunning)
    if (category === undefined) continue
    if (thread.nodeId !== null) {
      const target = directByNode.get(thread.nodeId) ?? emptyStatusCounts()
      countSession(target, status, sessionId, openSessionId, showRunning)
      directByNode.set(thread.nodeId, target)
      recordFresh(freshByNode, thread.nodeId, status, category)
      continue
    }
    const workspaceId = threadWorkspace.get(sessionId)
    if (workspaceId === null || workspaceId === undefined) {
      countSession(directUngrouped, status, sessionId, openSessionId, showRunning)
      if (freshUngrouped === undefined || status.changedAt > freshUngrouped.at) {
        freshUngrouped = { category, at: status.changedAt }
      }
      continue
    }
    const target = directByWorkspace.get(workspaceId) ?? emptyStatusCounts()
    countSession(target, status, sessionId, openSessionId, showRunning)
    directByWorkspace.set(workspaceId, target)
    recordFresh(freshByWorkspace, workspaceId, status, category)
  }

  // Post-order accumulation: each node's counts start as its direct counts and
  // are then added to every ancestor.
  const children = new Map<string, string[]>()
  const nodeIds = new Set(input.nodes.map(node => node.id))
  for (const node of input.nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId)
    if (siblings === undefined) children.set(node.parentId, [node.id])
    else siblings.push(node.id)
  }
  const totals = new Map<string, StatusCounts>()
  const freshTotals = new Map<string, { category: StatusCategory; at: number } | undefined>()
  const walk = (nodeId: string, seen: Set<string>): StatusCounts => {
    const existing = totals.get(nodeId)
    if (existing !== undefined) return existing
    const counts = { ...(directByNode.get(nodeId) ?? emptyStatusCounts()) }
    if (!seen.has(nodeId)) {
      seen.add(nodeId)
      for (const child of children.get(nodeId) ?? []) {
        const childCounts = walk(child, seen)
        addStatusCounts(counts, childCounts)
      }
    }
    totals.set(nodeId, counts)
    return counts
  }
  for (const node of input.nodes) {
    if (!nodeIds.has(node.id)) continue
    walk(node.id, new Set())
  }

  // Fresh tone propagates to ancestors too: the halo belongs to the row whose
  // number just moved, not only to the row that owns the conversation. Memoized
  // so a 1500-node tree stays a single pass rather than one walk per row.
  const visiting = new Set<string>()
  const collectFresh = (nodeId: string): { category: StatusCategory; at: number } | undefined => {
    if (freshTotals.has(nodeId)) return freshTotals.get(nodeId)
    if (visiting.has(nodeId)) return undefined
    visiting.add(nodeId)
    let best = freshByNode.get(nodeId)
    for (const child of children.get(nodeId) ?? []) {
      const childFresh = collectFresh(child)
      if (childFresh !== undefined && (best === undefined || childFresh.at > best.at)) best = childFresh
    }
    visiting.delete(nodeId)
    freshTotals.set(nodeId, best)
    return best
  }
  for (const node of input.nodes) collectFresh(node.id)

  const nodes = new Map<string, StatusRollup>()
  for (const node of input.nodes) {
    const counts = totals.get(node.id) ?? emptyStatusCounts()
    const direct = directByNode.get(node.id) ?? emptyStatusCounts()
    const fresh = freshTotals.get(node.id)
    nodes.set(node.id, {
      counts,
      direct,
      total: counts.pending + counts.error + counts.done + counts.running,
      attention: counts.pending + counts.error + counts.done,
      fresh: fresh?.category,
      freshAt: fresh?.at,
    })
  }

  // Workspace rows aggregate every topic under them plus their direct threads.
  const workspaces = new Map<string, StatusRollup>()
  const workspaceIds = new Set<string>()
  for (const thread of input.threads) {
    if (thread.workspaceId !== null && thread.workspaceId !== undefined) workspaceIds.add(thread.workspaceId)
  }
  for (const node of input.nodes as readonly (RollupNode & { workspaceId?: string | null })[]) {
    if (node.workspaceId !== null && node.workspaceId !== undefined) workspaceIds.add(node.workspaceId)
  }
  // A Workspace with no conversations still needs a (zero) rollup only when a
  // row renders it; callers merge this map with their Workspace list.
  for (const workspaceId of workspaceIds) {
    const counts = { ...(directByWorkspace.get(workspaceId) ?? emptyStatusCounts()) }
    const direct = { ...counts }
    let fresh = freshByWorkspace.get(workspaceId)
    for (const node of input.nodes as readonly (RollupNode & { workspaceId?: string | null })[]) {
      if (node.workspaceId !== workspaceId) continue
      if (node.parentId !== null) continue
      const childCounts = totals.get(node.id)
      if (childCounts !== undefined) addStatusCounts(counts, childCounts)
      const childFresh = freshTotals.get(node.id)
      if (childFresh !== undefined && (fresh === undefined || childFresh.at > fresh.at)) fresh = childFresh
    }
    workspaces.set(workspaceId, {
      counts,
      direct,
      total: counts.pending + counts.error + counts.done + counts.running,
      attention: counts.pending + counts.error + counts.done,
      fresh: fresh?.category,
      freshAt: fresh?.at,
    })
  }

  const looseCounts = { ...directUngrouped }
  const ungrouped: StatusRollup = {
    counts: looseCounts,
    direct: { ...looseCounts },
    total: looseCounts.pending + looseCounts.error + looseCounts.done + looseCounts.running,
    attention: looseCounts.pending + looseCounts.error + looseCounts.done,
    fresh: freshUngrouped?.category,
    freshAt: freshUngrouped?.at,
  }

  return { nodes, workspaces, ungrouped }
}

/** One indexed conversation with the space the caller resolved for it. */
export interface SpaceRollupThread extends RollupThread {
  /** Effective space of this conversation (the model's `spaceOfThread`). */
  spaceId: string
}

/** Everything {@link rollupStatusesBySpace} reads. */
export interface SpaceRollupInput {
  /** Every space the caller may render; an empty one still gets a zero rollup. */
  spaces?: readonly string[] | undefined
  /** Indexed conversations, already tagged with their space. */
  threads: readonly SpaceRollupThread[]
  /** Observed status per session; a session without an entry is idle. */
  statuses: ReadonlyMap<string, ObservedSessionStatus>
  /** The conversation currently open in the reading pane. */
  openSessionId?: string | null
  /** Whether running conversations are part of the picture. */
  showRunning?: boolean
  /** Clock override for tests. */
  now?: number
}

/**
 * Derive one rollup per space, for the space switcher's menu.
 *
 * The counting rule is the node rows' rule, not a second one: a session is
 * counted in exactly one category by the shipped precedence, the conversation
 * open in the reading pane is skipped on its attention side (running stays as
 * live context), and nothing expires. The grouping is flat — a space is a
 * bucket, not a tree — so this is one pass over the threads, with no subtree
 * walk. A caller can therefore reconcile the three readouts: the sum of these
 * spaces is the sidebar cluster's global count, and the active space's number
 * is what its node rows show.
 * @param input - threads already tagged with their space, observed statuses, and display switches.
 * @returns one rollup per space id; every id in `spaces` appears, even when idle.
 */
export function rollupStatusesBySpace(input: SpaceRollupInput): ReadonlyMap<string, StatusRollup> {
  const now = input.now ?? Date.now()
  const showRunning = input.showRunning !== false
  const openSessionId = input.openSessionId ?? null
  const totals = new Map<string, StatusCounts>()
  const fresh = new Map<string, { category: StatusCategory; at: number }>()
  const seen = new Set<string>()
  for (const thread of input.threads) {
    // A conversation has one thread; a duplicated row must not double count.
    if (seen.has(thread.sessionId)) continue
    seen.add(thread.sessionId)
    const status = input.statuses.get(thread.sessionId)
    if (status === undefined) continue
    const target = totals.get(thread.spaceId) ?? emptyStatusCounts()
    const category = countSession(target, status, thread.sessionId, openSessionId, showRunning)
    if (category === undefined) continue
    totals.set(thread.spaceId, target)
    if (category !== 'running' && now - status.changedAt < FRESH_MS) {
      const previous = fresh.get(thread.spaceId)
      if (previous === undefined || status.changedAt > previous.at) {
        fresh.set(thread.spaceId, { category, at: status.changedAt })
      }
    }
  }
  const ids = new Set<string>(input.spaces ?? [])
  for (const thread of input.threads) ids.add(thread.spaceId)
  const result = new Map<string, StatusRollup>()
  for (const spaceId of ids) {
    const counts = totals.get(spaceId) ?? emptyStatusCounts()
    const freshEntry = fresh.get(spaceId)
    result.set(spaceId, {
      counts,
      direct: { ...counts },
      total: counts.pending + counts.error + counts.done + counts.running,
      attention: counts.pending + counts.error + counts.done,
      ...(freshEntry === undefined ? {} : { fresh: freshEntry.category, freshAt: freshEntry.at }),
    })
  }
  return result
}

/**
 * Total "needs a look" count across every Workspace and the ungrouped bucket.
 * @param result - a rollup result.
 * @returns the number shown on the collapsed-band sidebar badge.
 */
export function attentionTotal(result: RollupResult): number {
  let total = result.ungrouped.attention
  for (const rollup of result.workspaces.values()) total += rollup.attention
  return total
}

/**
 * Whether one row should draw anything at all.
 * @param rollup - a row's rollup.
 * @returns true when at least one category is non-zero.
 */
export function hasStatuses(rollup: StatusRollup): boolean {
  return rollup.total > 0
}
