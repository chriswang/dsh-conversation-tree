/**
 * Pure conversation-map model: the topic tree, the conversation index, and
 * every mutation as a state transition.
 *
 * The map hangs off the application's real container hierarchy: a first-level
 * "node" is a Workspace, not a topic this plugin invented. Topic nodes are
 * always inside exactly one Workspace (or in the ungrouped bucket), and a
 * conversation keeps the Workspace the Host accounts it to. That is what makes
 * the map agree with the shipped sidebar: creating a conversation here creates
 * it in that Workspace, and a conversation created anywhere else shows up here.
 *
 * Nothing here touches React, the DOM, or a storage backend, so the same code
 * is inlined into the browser bundle and exercised directly by the unit tests.
 */

/** One topic node. It always belongs to one Workspace (or to the ungrouped bucket). */
export interface MapNode {
  id: string
  parentId: string | null
  title: string
  description: string
  position: number
  /**
   * When the topic was created, as an ISO stamp.
   *
   * Absent on documents written before the info bar existed. The bar then
   * reads "—" instead of inventing a date from `updatedAt`.
   */
  createdAt?: string
  updatedAt: string
  /**
   * Owning Workspace id; `null` means the ungrouped bucket. `undefined` is the
   * migration marker for a node persisted before Workspaces became the map's
   * first level — it is resolved once the Workspace list is known.
   */
  workspaceId?: string | null
}

/**
 * One indexed conversation. `nodeId` is its optional topic inside the owning
 * Workspace; `null` means it sits directly under that Workspace (or, when the
 * Workspace is `null`, in the ungrouped bucket).
 */
export interface ThreadRef {
  sessionId: string
  nodeId: string | null
  title: string
  updatedAt: string
  importedAt: string
  /**
   * Coarse durable origin as the catalog reports it, kept for the Host half.
   *
   * The map's visibility rule is decided from the catalog, but the Host has no
   * catalog: persisting the field lets it recognise a conversation the map
   * never gives a row to (a subagent's Session is reached from its parent).
   * Absent means an ordinary conversation.
   */
  origin?: string
  /** Owning Workspace id; `undefined` until the Host's accounting is known. */
  workspaceId?: string | null
  /**
   * Plugin-local space of a conversation that no Workspace accounts for.
   *
   * Only meaningful while `workspaceId` is `null`; absent means the default
   * space. It is cleared as soon as the Host files the conversation under a
   * Workspace, because Workspace membership wins.
   */
  spaceId?: string | null
}

/** One Workspace projection the map groups by. */
export interface WorkspaceRef {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/**
 * One plugin-local group of Workspaces.
 *
 * Spaces are organizational data that only this plugin knows about: the Host
 * never sees them, and they never change Session accounting.
 */
export interface SpaceRef {
  id: string
  title: string
  /** Display order, starting at 1. The default space always sorts first. */
  position: number
  createdAt: string
}

/** The whole persisted map. */
export interface MapState {
  version: 2
  revision: number
  nodes: MapNode[]
  threads: ThreadRef[]
  /** Plugin-local Workspace groups, shown in `position` order. */
  spaces: SpaceRef[]
  /** Id of the space every unassigned Workspace belongs to; always a member. */
  defaultSpaceId: string
  /**
   * Conversations the map knows to be subagent children, durable after their
   * rows are gone.
   *
   * Index-time filtering drops a subagent row before it can be stored, so the
   * document cannot answer "was this a subagent?" from `threads` alone — yet the
   * Host half must answer exactly that when a caller asks to file a conversation
   * under a node. The ledger is written at the one moment the fact is still
   * known (the prune that removes the row) and is append-only: membership means
   * "was recorded as a subagent", which is all the rejection rule needs.
   */
  subagentSessionIds: string[]
  /**
   * Explicit `workspaceId → spaceId` overrides. A missing key means "the
   * default space", which keeps the map sparse: Workspaces created outside the
   * plugin need no write, and deleting a space is just dropping its keys.
   */
  spaceOf: Record<string, string>
}

/** The catalog row a sync feeds in. */
export interface SessionSummaryLike {
  id: string
  displayTitle?: string
  title?: string
  running?: boolean
  /** Host-reported last-activity time, in milliseconds since the epoch. */
  updatedAt?: number
  /** True while the session has been created but never used. */
  blank?: boolean
  /**
   * Coarse durable origin; `'subagent'` marks a child the map never gives a
   * row to, because it is reached from its parent.
   */
  origin?: string
  /** Owning parent conversation, when this is a subagent child. */
  parentId?: string | null
}

/**
 * Selection key naming the ungrouped bucket.
 *
 * Every Workspace is a first-level node whose id is `@ws:<workspaceId>`; the
 * sessions no Workspace accounts for trail in this one bucket, exactly where the
 * shipped sidebar puts them.
 */
export const UNGROUPED_ID = '@ungrouped'

/** Prefix shared by every Workspace selection key. */
export const WORKSPACE_SELECTION_PREFIX = '@ws:'

/** Prefix shared by the per-space "ungrouped" row keys (except the default space). */
export const LOOSE_ROW_PREFIX = '@loose:'

/**
 * Stored title marker of the space the plugin creates on first use.
 *
 * This is document data, not display copy: the label shown for it comes from the
 * client dictionary (`common.defaultSpace`), and a renamed space renders its
 * stored title verbatim. Keeping the marker language-neutral is what lets a
 * document move between languages without rewriting user data; the legacy
 * Chinese marker is migrated on read (see `parseMapState`).
 */
export const DEFAULT_SPACE_TITLE = '@default-space'

/** The Chinese marker written by versions before the locale refactor. */
const LEGACY_DEFAULT_SPACE_TITLE = '默认空间'

/** Limits mirroring the plugin's stated first-version bounds. */
export const MAX_DEPTH = 12
export const MAX_NODES = 1500
export const MAX_TITLE = 80
export const MAX_DESCRIPTION = 6000
export const MAX_SPACES = 50
export const MAX_SPACE_TITLE = 40

/** A rejected mutation, carrying a stable code the render site explains. */
export class MapError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly params?: Readonly<Record<string, string | number>>,
  ) {
    super(message)
    this.name = 'MapError'
  }
}

/** A fresh, empty map. */
export function emptyMap(): MapState {
  return {
    version: 2, revision: 0, nodes: [], threads: [],
    spaces: [], defaultSpaceId: '', spaceOf: {}, subagentSessionIds: [],
  }
}

/** Read one node, throwing when the caller names a node that is gone. */
function requireNode(state: MapState, id: string): MapNode {
  const node = state.nodes.find(candidate => candidate.id === id)
  if (node === undefined) throw new MapError('NOT_FOUND', 'The target no longer exists; refresh and try again.')
  return node
}

/** Apply one change and bump the revision. */
function mutate(state: MapState, change: (draft: MapState) => void): MapState {
  const next: MapState = {
    ...state,
    version: 2,
    revision: state.revision + 1,
    nodes: state.nodes.map(node => ({ ...node })),
    threads: state.threads.map(thread => ({ ...thread })),
    spaces: state.spaces.map(space => ({ ...space })),
    spaceOf: { ...state.spaceOf },
    subagentSessionIds: [...(state.subagentSessionIds ?? [])],
  }
  change(next)
  return next
}

/** Normalize the optional owner to the value the map groups by. */
function ownerOf(value: string | null | undefined): string | null {
  return value ?? null
}

/** Root topics of one Workspace, in display order. */
export function topNodesOf(state: MapState, workspaceId: string | null): MapNode[] {
  return sorted(state.nodes.filter(node => node.parentId === null && ownerOf(node.workspaceId) === ownerOf(workspaceId)))
}

/** Every topic in one Workspace, in no particular order. */
export function nodesOfWorkspace(state: MapState, workspaceId: string | null): MapNode[] {
  return state.nodes.filter(node => ownerOf(node.workspaceId) === ownerOf(workspaceId))
}

/** Direct children of one parent, in display order. */
export function childrenOf(state: MapState, parentId: string | null): MapNode[] {
  return sorted(state.nodes.filter(node => node.parentId === parentId))
}

/** Stable display order: explicit position, then title. */
function sorted(nodes: readonly MapNode[]): MapNode[] {
  return [...nodes].sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
}

/** The root-to-node path, nearest root first. Cycle-safe. */
export function nodePath(state: MapState, nodeId: string): MapNode[] {
  const byId = new Map(state.nodes.map(node => [node.id, node]))
  const seen = new Set<string>()
  const path: MapNode[] = []
  let current = byId.get(nodeId)
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return path
}

/** The Workspace a topic belongs to, normalized. */
export function workspaceOfNode(node: MapNode): string | null {
  return ownerOf(node.workspaceId)
}

/** The selection key that opens one Workspace. */
export function workspaceNodeId(workspaceId: string): string {
  return `${WORKSPACE_SELECTION_PREFIX}${workspaceId}`
}

/** The selection key for the ungrouped bucket. */
export function workspaceKey(workspaceId: string | null): string {
  return workspaceId === null ? UNGROUPED_ID : workspaceNodeId(workspaceId)
}

/**
 * The rows that place a selected topic in its lineage, from the top down.
 *
 * One key per level above the topic — every ancestor topic id, root first — and
 * the Workspace row that owns the chain (`workspaceKey`; the ungrouped bucket
 * for a legacy rootless topic). The selected row itself is left out: it carries
 * the selection's own mark, and repeating it here would only draw one row twice.
 * Unknown ids yield no rows, so a view pointing at a deleted node marks nothing.
 * @param state - the map document.
 * @param nodeId - the selected topic.
 * @returns row keys from the outermost container inward; empty when unknown.
 */
export function ancestorRowKeys(state: MapState, nodeId: string): string[] {
  const path = nodePath(state, nodeId)
  if (path.length === 0) return []
  return [
    ...path.slice(0, -1).map(node => node.id),
    workspaceKey(workspaceOfNode(path[0])),
  ]
}

/** The selection key that would be selected after deleting one topic node. */
export function selectionAfterNodeDeletion(state: MapState, nodeId: string): string | null {
  const node = state.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) return null
  return node.parentId ?? workspaceKey(workspaceOfNode(node))
}

/** Whether a selection key names a Workspace (or the ungrouped bucket) rather than a topic. */
export function isWorkspaceSelectionKey(key: string | null): boolean {
  return key !== null && (key === UNGROUPED_ID || key.startsWith(WORKSPACE_SELECTION_PREFIX))
}

/**
 * Read a Workspace selection key.
 * @param key - selection key, or null.
 * @returns the Workspace it names (null for the ungrouped bucket), or undefined
 *   when the key is not a Workspace selection at all.
 */
export function workspaceSelection(key: string | null): { workspaceId: string | null } | undefined {
  if (key === null) return undefined
  if (key === UNGROUPED_ID) return { workspaceId: null }
  if (!key.startsWith(WORKSPACE_SELECTION_PREFIX)) return undefined
  return { workspaceId: key.slice(WORKSPACE_SELECTION_PREFIX.length) }
}

/* ── spaces ──────────────────────────────────────────────────────────────── */

/** Validate and normalize one space title, rejecting duplicates. */
function cleanSpaceTitle(state: MapState, title: string, selfId: string | null): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new MapError('SPACE_TITLE_EMPTY', 'A space name is required.')
  if (trimmed.length > MAX_SPACE_TITLE) throw new MapError('SPACE_TITLE_LONG', `A space name is limited to ${String(MAX_SPACE_TITLE)} characters.`, { max: MAX_SPACE_TITLE })
  const wanted = trimmed.toLocaleLowerCase()
  if (state.spaces.some(space => space.id !== selfId && space.title.toLocaleLowerCase() === wanted)) {
    throw new MapError('SPACE_TITLE_DUP', 'A space with that name already exists; choose another name.')
  }
  return trimmed
}

/** Read one space, throwing when the caller names a space that is gone. */
function requireSpace(state: MapState, id: string): SpaceRef {
  const space = state.spaces.find(candidate => candidate.id === id)
  if (space === undefined) throw new MapError('SPACE_NOT_FOUND', 'That space no longer exists; refresh and try again.')
  return space
}

/** Spaces in display order. */
export function spaceList(state: MapState): SpaceRef[] {
  return [...state.spaces].sort((left, right) => left.position - right.position || left.title.localeCompare(right.title))
}

/**
 * Create the default space on first use, or repair a broken pointer.
 *
 * Idempotent: a healthy document is returned as the same object, so callers can
 * run it on every load without churning the revision.
 * @param state - the map.
 * @returns the map with exactly one default space.
 */
export function ensureDefaultSpace(state: MapState): MapState {
  const known = new Set(state.spaces.map(space => space.id))
  if (state.defaultSpaceId !== '' && known.has(state.defaultSpaceId)) return state
  const first = spaceList(state)[0]
  if (first !== undefined) {
    return { ...state, version: 2, revision: state.revision + 1, defaultSpaceId: first.id }
  }
  const id = crypto.randomUUID()
  return {
    ...state,
    version: 2,
    revision: state.revision + 1,
    spaces: [{ id, title: DEFAULT_SPACE_TITLE, position: 1, createdAt: new Date().toISOString() }],
    defaultSpaceId: id,
  }
}

/** The effective space of one Workspace: an explicit override, else the default space. */
export function spaceOfWorkspace(state: MapState, workspaceId: string): string {
  const explicit = state.spaceOf[workspaceId]
  if (explicit !== undefined && state.spaces.some(space => space.id === explicit)) return explicit
  return state.defaultSpaceId
}

/** The effective space of one conversation. */
export function spaceOfThread(state: MapState, thread: ThreadRef): string {
  const workspaceId = ownerOf(thread.workspaceId)
  if (workspaceId !== null) return spaceOfWorkspace(state, workspaceId)
  const local = thread.spaceId ?? null
  if (local !== null && state.spaces.some(space => space.id === local)) return local
  return state.defaultSpaceId
}

/** Workspaces of one space, in Host order. */
export function workspacesInSpace(
  state: MapState,
  workspaces: readonly WorkspaceRef[],
  spaceId: string,
): WorkspaceRef[] {
  return workspaces.filter(workspace => spaceOfWorkspace(state, workspace.workspaceId) === spaceId)
}

/** Conversations filed directly under one space's ungrouped row, newest first. */
export function looseThreadsInSpace(state: MapState, spaceId: string): ThreadRef[] {
  return newestFirst(state.threads.filter(thread =>
    thread.nodeId === null
    && ownerOf(thread.workspaceId) === null
    && spaceOfThread(state, thread) === spaceId))
}

/**
 * Selection/memory key of one space's ungrouped row.
 *
 * The default space keeps the historical `@ungrouped` key so a restored view
 * still points at the same place; other spaces get a stable key of their own.
 */
export function looseRowKey(state: MapState, spaceId: string): string {
  return spaceId === state.defaultSpaceId ? UNGROUPED_ID : `${LOOSE_ROW_PREFIX}${spaceId}`
}

/**
 * Create one space.
 *
 * An explicit `id` keeps the transition replayable: when a queued client
 * mutation is re-applied on top of a newer Host document, a regenerated uuid
 * would leave the view's `activeSpace` naming a space that no longer exists.
 * Callers that may replay pass the id they already selected.
 * @param state - the current map.
 * @param input - space title and optional caller-owned id.
 * @returns the updated map plus the created space's id.
 */
export function createSpace(state: MapState, input: { title: string; id?: string }): { state: MapState; id: string } {
  const title = cleanSpaceTitle(state, input.title, null)
  if (state.spaces.length >= MAX_SPACES) throw new MapError('SPACE_LIMIT', `At most ${String(MAX_SPACES)} spaces are supported.`, { max: MAX_SPACES })
  const id = input.id ?? crypto.randomUUID()
  const position = state.spaces.reduce((max, space) => Math.max(max, space.position), 0) + 1
  const next = mutate(state, draft => {
    draft.spaces.push({ id, title, position, createdAt: new Date().toISOString() })
  })
  return { state: next, id }
}

/** Rename one space. The default space may be renamed too. */
export function renameSpace(state: MapState, input: { id: string; title: string }): MapState {
  const space = requireSpace(state, input.id)
  const title = cleanSpaceTitle(state, input.title, space.id)
  if (title === space.title) return state
  return mutate(state, draft => {
    const target = draft.spaces.find(candidate => candidate.id === input.id)
    if (target !== undefined) target.title = title
  })
}

/**
 * Delete one non-default space.
 *
 * Its Workspaces and loose conversations fall back to the default space; the
 * Workspaces themselves, their topics, and the conversations are untouched.
 */
export function deleteSpace(state: MapState, id: string): MapState {
  requireSpace(state, id)
  if (id === state.defaultSpaceId) throw new MapError('DEFAULT_SPACE', 'The default space cannot be deleted; rename it instead.')
  return mutate(state, draft => {
    draft.spaces = draft.spaces.filter(space => space.id !== id)
    for (const [workspaceId, spaceId] of Object.entries(draft.spaceOf)) {
      if (spaceId === id) delete draft.spaceOf[workspaceId]
    }
    for (const thread of draft.threads) {
      if (thread.spaceId === id) delete thread.spaceId
    }
  })
}

/** Move one Workspace into a space (its own space is a no-op). */
export function setWorkspaceSpace(state: MapState, workspaceId: string, spaceId: string): MapState {
  requireSpace(state, spaceId)
  if (spaceOfWorkspace(state, workspaceId) === spaceId) return state
  return mutate(state, draft => {
    if (spaceId === state.defaultSpaceId) delete draft.spaceOf[workspaceId]
    else draft.spaceOf[workspaceId] = spaceId
  })
}

/**
 * Move one loose conversation into a space.
 *
 * Leaving the default space also detaches it from a legacy ungrouped topic: a
 * conversation cannot sit in one space and inside another space's topic tree.
 */
export function setThreadSpace(state: MapState, sessionId: string, spaceId: string): MapState {
  requireSpace(state, spaceId)
  const thread = state.threads.find(candidate => candidate.sessionId === sessionId)
  if (thread === undefined) throw new MapError('NOT_FOUND', 'That conversation no longer exists; refresh and try again.')
  if (ownerOf(thread.workspaceId) !== null) throw new MapError('WORKSPACE', 'Only conversations outside every Workspace can be filed into a space.')
  if (spaceOfThread(state, thread) === spaceId) return state
  return mutate(state, draft => {
    const target = draft.threads.find(candidate => candidate.sessionId === sessionId)
    if (target === undefined) return
    if (spaceId === state.defaultSpaceId) delete target.spaceId
    else {
      target.spaceId = spaceId
      target.nodeId = null
    }
  })
}

/**
 * Reconcile the space organization with the Host's Workspace projection.
 *
 * Runs only once the Workspace list is ready (a pending snapshot would prune
 * live overrides). It drops overrides for Workspaces and spaces that no longer
 * exist, normalizes "explicitly the default space" to the sparse form, and
 * clears a loose conversation's space as soon as a Workspace owns it.
 * @param state - the map.
 * @param workspaces - the Host's Workspace rows.
 * @returns the reconciled map, or the same object when nothing changed.
 */
export function reconcileSpaces(state: MapState, workspaces: readonly WorkspaceRef[]): MapState {
  const ensured = ensureDefaultSpace(state)
  const knownWorkspaces = new Set(workspaces.map(workspace => workspace.workspaceId))
  const knownSpaces = new Set(ensured.spaces.map(space => space.id))
  let changed = ensured !== state

  const spaceOf: Record<string, string> = {}
  for (const [workspaceId, spaceId] of Object.entries(ensured.spaceOf)) {
    if (!knownWorkspaces.has(workspaceId) || !knownSpaces.has(spaceId) || spaceId === ensured.defaultSpaceId) {
      changed = true
      continue
    }
    spaceOf[workspaceId] = spaceId
  }

  const threads = ensured.threads.map(thread => {
    const owned = ownerOf(thread.workspaceId) !== null
    const stale = thread.spaceId !== undefined && thread.spaceId !== null
      && (owned || !knownSpaces.has(thread.spaceId))
    if (!stale) return thread
    changed = true
    const next: ThreadRef = { ...thread }
    delete next.spaceId
    return next
  })

  if (!changed) return state
  return {
    version: 2,
    revision: ensured.revision + 1,
    nodes: ensured.nodes,
    threads,
    spaces: ensured.spaces,
    defaultSpaceId: ensured.defaultSpaceId,
    spaceOf,
    subagentSessionIds: ensured.subagentSessionIds ?? [],
  }
}

/** Every node at or below `nodeId`. */
export function descendantIds(state: MapState, nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId])
  let grew = true
  while (grew) {
    grew = false
    for (const node of state.nodes) {
      if (node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        grew = true
      }
    }
  }
  return ids
}

/**
 * Depth of one node, counting the node itself.
 *
 * Walks the parent chain with a visited set rather than recursing: the parser
 * accepts a hand-built document whose parent pointers form a loop, and both the
 * UI hit test and the depth ceiling call this on every drag frame, so a cycle
 * must answer with a bounded number instead of exhausting the stack.
 * @param state - the map.
 * @param nodeId - the node to measure.
 * @returns its depth in nodes, `0` when the node is gone.
 */
function depthOf(state: MapState, nodeId: string): number {
  const byId = new Map(state.nodes.map(node => [node.id, node]))
  const seen = new Set<string>()
  let current = byId.get(nodeId)
  let depth = 0
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    depth += 1
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return depth
}

/**
 * Height of the deepest subtree under `nodeId`, counting the node itself.
 *
 * Breadth-first over the children map with a visited set: a corrupt document
 * whose parent pointers loop would otherwise recurse forever, and the depth
 * ceiling must stay answerable on bad data.
 * @param state - the map.
 * @param nodeId - the subtree root.
 * @returns its height in nodes, `1` for a leaf or an unknown id.
 */
function heightOf(state: MapState, nodeId: string): number {
  const children = new Map<string, string[]>()
  for (const node of state.nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId)
    if (siblings === undefined) children.set(node.parentId, [node.id])
    else siblings.push(node.id)
  }
  const seen = new Set<string>([nodeId])
  let height = 1
  let frontier: string[] = [nodeId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        next.push(child)
      }
    }
    if (next.length === 0) break
    height += 1
    frontier = next
  }
  return height
}

/** Conversation count per node. */
export function countsByNode(state: MapState): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const thread of state.threads) {
    if (thread.nodeId === null) continue
    counts[thread.nodeId] = (counts[thread.nodeId] ?? 0) + 1
  }
  return counts
}

/**
 * Leap directory name of a supported path.
 * @param path - a POSIX or Windows directory path.
 * @returns the final segment, without a trailing separator.
 */
export function pathBaseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(at + 1)
}

/** Localized labels the Workspace title fallback needs. */
export interface WorkspaceTitleLabels {
  /** Shown for the Host's `default-workspace` placeholder title. */
  defaultWorkspace: string
  /** Shown when neither a title nor a directory name is available. */
  workspaceFallback: string
}

/**
 * The label one Workspace row shows.
 * @param workspace - the Host's Workspace row (title and path).
 * @param labels - localized fallback labels; user data renders verbatim.
 * @returns the stored title, the directory name, or a localized fallback.
 */
export function workspaceDisplayTitle(
  workspace: Pick<WorkspaceRef, 'title' | 'path'>,
  labels: WorkspaceTitleLabels,
): string {
  const title = workspace.title.trim()
  if (title === 'default-workspace') return labels.defaultWorkspace
  if (title !== '') return title
  return pathBaseName(workspace.path) || workspace.path || labels.workspaceFallback
}

/**
 * Read one ISO stamp as epoch milliseconds, treating junk as the far past so a
 * malformed row sorts to the bottom instead of poisoning the comparison.
 * @param iso - the stored time stamp.
 * @returns the stamp in milliseconds.
 */
function stampOf(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Order conversations the way the application's own list reads: latest
 * activity first. A conversation just started through the map has "now" as its
 * stamp, so it leads the list it was started under instead of trailing it.
 * @param threads - the conversations to order.
 * @returns a new array, newest activity first.
 */
function newestFirst(threads: readonly ThreadRef[]): ThreadRef[] {
  return [...threads].sort((left, right) => stampOf(right.updatedAt) - stampOf(left.updatedAt))
}

/** Conversations owned by one topic, newest activity first. */
export function threadsOf(state: MapState, nodeId: string): ThreadRef[] {
  return newestFirst(state.threads.filter(thread => thread.nodeId === nodeId))
}

/** Conversations at the top of one Workspace (no topic), newest activity first. */
export function directThreadsOf(state: MapState, workspaceId: string | null): ThreadRef[] {
  return newestFirst(state.threads.filter(thread =>
    thread.nodeId === null && ownerOf(thread.workspaceId) === ownerOf(workspaceId)))
}

/** One indexed conversation, by session id. */
export function threadOfSession(state: MapState, sessionId: string): ThreadRef | undefined {
  return state.threads.find(thread => thread.sessionId === sessionId)
}

/**
 * The node selection a conversation makes active.
 *
 * Reading a conversation inside the map means being at its home: the topic it is
 * filed under, or the Workspace row when it sits directly under one. A stale
 * index may still name a deleted topic, so the topic only wins while it exists.
 *
 * An ungrouped conversation has no node to activate: its row is a conversation
 * list, not a container, so it returns `null` and the caller leaves the reader's
 * selection alone.
 * @param state - the map.
 * @param thread - the conversation that was opened.
 * @returns the selection key to activate, or null when there is nothing to activate.
 */
export function selectionOfThread(state: MapState, thread: ThreadRef): string | null {
  if (thread.nodeId !== null && state.nodes.some(node => node.id === thread.nodeId)) return thread.nodeId
  const workspaceId = ownerOf(thread.workspaceId)
  return workspaceId === null ? null : workspaceKey(workspaceId)
}

/**
 * Where one Session lives in the map, as far as the index and the Host know.
 *
 * Native navigation (a sidebar row, a shortcut, another plugin) arrives with a
 * Session identity; the map has to land on the same place instead of keeping an
 * unrelated strip of columns on screen. A Session the index already files is
 * located by its thread — the topic it is filed under, its Workspace row, or the
 * ungrouped row of its own space. One the index has not seen yet is located by
 * the Host's Workspace accounting; an unknown Session with no Workspace has no
 * place to land and returns `undefined`.
 *
 * An ungrouped conversation resolves to its space's ungrouped row rather than
 * "no selection": navigation from outside the map is an explicit destination,
 * and leaving the reader's old (possibly other-space) selection behind would mix
 * two places on screen.
 * @param state - the map.
 * @param sessionId - the Session to locate.
 * @param workspaceId - its Host Workspace when the caller knows it, `null` when
 *   the Host accounts it to none, `undefined` when nothing names one.
 * @returns the space and the row key to select, or undefined for an unknown Session.
 */
export function homeOfSession(
  state: MapState,
  sessionId: string,
  workspaceId?: string | null,
): { spaceId: string; selection: string } | undefined {
  const thread = threadOfSession(state, sessionId)
  if (thread !== undefined) {
    const spaceId = spaceOfThread(state, thread)
    return { spaceId, selection: selectionOfThread(state, thread) ?? looseRowKey(state, spaceId) }
  }
  if (workspaceId === undefined) return undefined
  if (workspaceId === null) {
    return { spaceId: state.defaultSpaceId, selection: looseRowKey(state, state.defaultSpaceId) }
  }
  return { spaceId: spaceOfWorkspace(state, workspaceId), selection: workspaceKey(workspaceId) }
}

/** Validate a user-supplied node title. */
function cleanTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new MapError('TITLE_EMPTY', 'A topic name is required.')
  if (trimmed.length > MAX_TITLE) throw new MapError('TITLE_LONG', `A topic name is limited to ${String(MAX_TITLE)} characters.`, { max: MAX_TITLE })
  return trimmed
}

/** Validate a user-supplied description. */
function cleanDescription(description: string): string {
  if (description.length > MAX_DESCRIPTION) throw new MapError('DESCRIPTION_LONG', `A description is limited to ${String(MAX_DESCRIPTION)} characters.`, { max: MAX_DESCRIPTION })
  return description
}

/**
 * Create a topic node.
 *
 * A child inherits its parent's Workspace — a topic never straddles two
 * Workspaces — while a top-level topic takes the Workspace named by the caller.
 * @param state - the current map.
 * @param input - parent (null for a workspace root), owning Workspace, and copy.
 * @returns the updated map plus the created node's id.
 */
export function createNode(
  state: MapState,
  input: { parentId: string | null; workspaceId?: string | null; title: string; description?: string; id?: string },
): { state: MapState; id: string } {
  const title = cleanTitle(input.title)
  const description = cleanDescription(input.description ?? '')
  let workspaceId: string | null
  if (input.parentId !== null) {
    const parent = requireNode(state, input.parentId)
    workspaceId = workspaceOfNode(parent)
    if (input.workspaceId !== undefined && ownerOf(input.workspaceId) !== workspaceId) {
      throw new MapError('WORKSPACE', 'A child topic must live in the same Workspace as its parent.')
    }
  } else {
    workspaceId = ownerOf(input.workspaceId)
  }
  if (state.nodes.length >= MAX_NODES) throw new MapError('LIMIT', `At most ${String(MAX_NODES)} nodes are supported.`, { max: MAX_NODES })
  const parentDepth = input.parentId === null ? 0 : depthOf(state, input.parentId)
  if (parentDepth + 1 > MAX_DEPTH) throw new MapError('DEPTH', `At most ${String(MAX_DEPTH)} levels are supported.`, { max: MAX_DEPTH })
  const id = input.id ?? crypto.randomUUID()
  const siblings = state.nodes.filter(node =>
    node.parentId === input.parentId && ownerOf(node.workspaceId) === workspaceId)
  const position = siblings.reduce((max, node) => Math.max(max, node.position), 0) + 1
  const now = new Date().toISOString()
  const next = mutate(state, draft => {
    draft.nodes.push({
      id, parentId: input.parentId, title, description, position,
      createdAt: now, updatedAt: now, workspaceId,
    })
  })
  return { state: next, id }
}

/** Rename or re-describe one node. */
export function updateNode(state: MapState, input: { id: string; title: string; description: string }): MapState {
  requireNode(state, input.id)
  const title = cleanTitle(input.title)
  const description = cleanDescription(input.description)
  return mutate(state, draft => {
    const node = draft.nodes.find(candidate => candidate.id === input.id)
    if (node === undefined) return
    node.title = title
    node.description = description
    node.updatedAt = new Date().toISOString()
  })
}

/**
 * One reason a move cannot be committed, in the shape every caller reports.
 *
 * The code is the same vocabulary {@link MapError} uses, so a hit test, a dialog,
 * and a model tool can all explain the same refusal without committing anything.
 */
export interface MoveIssue {
  readonly code: string
  readonly message: string
  /** Values the client dictionary interpolates (limits, names). */
  readonly params?: Readonly<Record<string, string | number>>
}

/**
 * Why one node cannot be re-parented where the caller asked, or `null` when the
 * move is committable.
 *
 * This is the one judgement the model, the Web UI, and the model tools share:
 * {@link moveNode} throws exactly the issue this returns, and a drag hit test can
 * ask without touching the document. Issues are reported in the order a caller
 * meets them — missing node, then a missing or foreign target parent, then the
 * cycle the re-parent would create, and finally the depth ceiling.
 * @param state - the map.
 * @param id - the node to move.
 * @param parentId - the target parent; `null` = the Workspace root.
 * @returns the blocking issue, or `null` when the move may be committed.
 */
export function moveNodeIssue(state: MapState, id: string, parentId: string | null): MoveIssue | null {
  const node = state.nodes.find(candidate => candidate.id === id)
  if (node === undefined) return { code: 'NOT_FOUND', message: 'The target node no longer exists; refresh and try again.' }
  const workspaceId = workspaceOfNode(node)
  if (parentId !== null) {
    const parent = state.nodes.find(candidate => candidate.id === parentId)
    if (parent === undefined) return { code: 'NOT_FOUND', message: 'The target node no longer exists; refresh and try again.' }
    if (workspaceOfNode(parent) !== workspaceId) {
      return { code: 'WORKSPACE', message: 'A node cannot move under a node of a different Workspace.' }
    }
    if (descendantIds(state, id).has(parentId)) {
      return { code: 'CYCLE', message: 'A node cannot move under itself or its descendants.' }
    }
  }
  const targetDepth = parentId === null ? 0 : depthOf(state, parentId)
  if (targetDepth + heightOf(state, id) > MAX_DEPTH) return { code: 'DEPTH', message: `At most ${String(MAX_DEPTH)} levels are supported.`, params: { max: MAX_DEPTH } }
  return null
}

/** Re-parent one node inside its own Workspace, rejecting cycles and over-deep moves. */
export function moveNode(state: MapState, id: string, parentId: string | null): MapState {
  const issue = moveNodeIssue(state, id, parentId)
  if (issue !== null) throw new MapError(issue.code, issue.message, issue.params)
  const workspaceId = workspaceOfNode(requireNode(state, id))
  const siblings = state.nodes.filter(candidate =>
    candidate.parentId === parentId && candidate.id !== id && ownerOf(candidate.workspaceId) === workspaceId)
  const position = siblings.reduce((max, candidate) => Math.max(max, candidate.position), 0) + 1
  return mutate(state, draft => {
    const target = draft.nodes.find(candidate => candidate.id === id)
    if (target === undefined) return
    target.parentId = parentId
    target.position = position
    target.updatedAt = new Date().toISOString()
  })
}

/**
 * Move one node to an exact slot among the destination parent's children.
 *
 * `insertBefore` semantics, borrowed from the DOM: `beforeNodeId` names the
 * sibling the node is placed in front of, and omitting it appends — which is
 * exactly {@link moveNode}. Re-parenting and re-ordering are therefore the same
 * operation, and the target's children are renumbered `position = 1..n`, which
 * also repairs the duplicate positions older documents may carry.
 *
 * The judgement is {@link moveNodeIssue}, so a missing node, a foreign
 * Workspace, a cycle, or an over-deep target is refused with the same code and
 * wording as a plain re-parent. An anchor that is not a child of the destination
 * parent is refused as `ANCHOR` rather than silently treated as "append": a drop
 * that lands somewhere other than the drawn insertion line is worse than a
 * visible refusal. Dropping a node where it already is reports success without
 * writing — the same state comes back, revision and all.
 * @param state - the map.
 * @param id - the node to move.
 * @param parentId - the destination parent; `null` = the Workspace root.
 * @param beforeNodeId - the sibling to insert before; omitted = append.
 * @returns the updated map, or the same state when nothing had to change.
 */
export function insertNodeBefore(
  state: MapState,
  id: string,
  parentId: string | null,
  beforeNodeId?: string,
): MapState {
  const issue = moveNodeIssue(state, id, parentId)
  if (issue !== null) throw new MapError(issue.code, issue.message, issue.params)
  const moved = requireNode(state, id)
  const workspaceId = workspaceOfNode(moved)
  const siblings = sorted(state.nodes.filter(candidate =>
    candidate.parentId === parentId && ownerOf(candidate.workspaceId) === workspaceId))
  const anchor = beforeNodeId === undefined
    ? undefined
    : siblings.find(candidate => candidate.id === beforeNodeId)
  if (beforeNodeId !== undefined && anchor === undefined) {
    throw new MapError('ANCHOR', 'The anchor node is not under the target parent.')
  }
  // `insertBefore(x, x)` keeps x exactly where it is: nothing to recompute.
  if (anchor !== undefined && anchor.id === id) return state

  const withoutMoved = siblings.filter(candidate => candidate.id !== id)
  // The anchor is a sibling and is not the moved node, so it survives the filter
  // above and this index always names a real slot.
  const at = anchor === undefined
    ? withoutMoved.length
    : withoutMoved.findIndex(candidate => candidate.id === anchor.id)
  const ordered = [...withoutMoved.slice(0, at), moved, ...withoutMoved.slice(at)]
  if (moved.parentId === parentId && ordered.length === siblings.length
    && ordered.every((candidate, index) => candidate.id === siblings[index].id)) {
    return state
  }

  return mutate(state, draft => {
    const positions = new Map(ordered.map((candidate, index) => [candidate.id, index + 1]))
    for (const node of draft.nodes) {
      const position = positions.get(node.id)
      if (position !== undefined) node.position = position
    }
    const target = draft.nodes.find(candidate => candidate.id === id)
    if (target === undefined) return
    target.parentId = parentId
    target.updatedAt = new Date().toISOString()
  })
}

/** Delete a leaf node; its conversations stay in the Workspace, unassigned. */
export function deleteNode(state: MapState, id: string): MapState {
  requireNode(state, id)
  if (state.nodes.some(node => node.parentId === id)) throw new MapError('HAS_CHILDREN', 'Move or delete the child topics first.')
  return mutate(state, draft => {
    draft.nodes = draft.nodes.filter(node => node.id !== id)
    for (const thread of draft.threads) if (thread.nodeId === id) thread.nodeId = null
  })
}

/**
 * Why one conversation cannot be filed under the named node, or `null` when the
 * move is committable.
 *
 * Mirrors what {@link assignThreads} enforces and adds the subagent refusal the
 * model was missing: a child Session is reached from its parent conversation, so
 * the map gives it no row and filing one under a node is meaningless. An
 * unaccounted conversation (`workspaceId === undefined`) and one the index has
 * never seen stay permissive — there is nothing to file yet.
 * @param state - the map.
 * @param sessionId - the conversation to file.
 * @param nodeId - the target node; `null` = directly under its Workspace.
 * @returns the blocking issue, or `null` when the move may be committed.
 */
export function assignThreadIssue(state: MapState, sessionId: string, nodeId: string | null): MoveIssue | null {
  const node = nodeId === null ? undefined : state.nodes.find(candidate => candidate.id === nodeId)
  if (nodeId !== null && node === undefined) return { code: 'NOT_FOUND', message: 'The target node no longer exists; refresh and try again.' }
  const thread = state.threads.find(candidate => candidate.sessionId === sessionId)
  // A subagent child never becomes a row of its own, so it can never be a row
  // under a node either: it is reached from its parent conversation instead.
  if (thread?.origin === 'subagent' || isRecordedSubagent(state, sessionId)) {
    return { code: 'SUBAGENT', message: 'A subagent conversation cannot be filed under a topic.' }
  }
  if (thread === undefined || thread.workspaceId === undefined || node === undefined) return null
  const nodeWorkspace = workspaceOfNode(node)
  if (ownerOf(thread.workspaceId) !== nodeWorkspace) {
    return { code: 'WORKSPACE', message: 'A conversation can only be filed under a node of its own Workspace.' }
  }
  // A legacy rootless topic lives in the default space only, so a loose
  // conversation filed there must not belong to another space.
  if (nodeWorkspace === null && spaceOfThread(state, thread) !== state.defaultSpaceId) {
    return { code: 'SPACE', message: 'Only ungrouped conversations in the default space can be filed under the ungrouped topic.' }
  }
  return null
}

/**
 * Set the topic each named conversation is filed under. `nodeId === null`
 * leaves the conversation directly under its Workspace. A conversation can only
 * be filed under a topic of the Workspace that accounts for it.
 *
 * Every id is judged before the document is touched, so a rejected batch leaves
 * the map exactly as it was, and the refusal comes from
 * {@link assignThreadIssue} — the same judgement a drag hit test reads.
 */
export function assignThreads(state: MapState, sessionIds: readonly string[], nodeId: string | null): MapState {
  const node = nodeId === null ? undefined : requireNode(state, nodeId)
  const nodeWorkspace = node === undefined ? undefined : workspaceOfNode(node)
  for (const sessionId of sessionIds) {
    const issue = assignThreadIssue(state, sessionId, nodeId)
    if (issue !== null) throw new MapError(issue.code, issue.message, issue.params)
  }
  const wanted = new Set(sessionIds)
  return mutate(state, draft => {
    for (const thread of draft.threads) {
      if (!wanted.has(thread.sessionId)) continue
      thread.nodeId = nodeId
      if (node !== undefined) {
        thread.workspaceId = nodeWorkspace
        if (nodeWorkspace !== null) delete thread.spaceId
      }
    }
  })
}

/**
 * Merge the visible conversation catalog into the index, preserving ownership.
 * New conversations are filed under the Workspace the Host accounts them to;
 * existing ones keep their topic and refresh their title.
 *
 * Visibility is applied here rather than by the caller because this is also
 * where a subagent child becomes a durable fact: the child is recorded in
 * {@link MapState.subagentSessionIds} while the catalog still reports its
 * `origin`, and only then dropped — the Host half must reject filing one under a
 * node later, after the row (which never existed) and even the catalog row are
 * gone.
 * @param state - the map.
 * @param sessions - the whole catalog, unfiltered.
 * @param openSessionId - the conversation currently open, if any.
 * @param owners - session id to owning Workspace id (null for ungrouped), when known.
 */
export function syncThreads(
  state: MapState,
  sessions: readonly SessionSummaryLike[],
  openSessionId: string | null = null,
  owners?: ReadonlyMap<string, string | null>,
): MapState {
  return mutate(state, draft => {
    const byId = new Map(draft.threads.map(thread => [thread.sessionId, thread]))
    const recorded = new Set(draft.subagentSessionIds ?? [])
    const now = new Date().toISOString()
    for (const session of sessions) {
      // Record before deciding visibility: a subagent child is exactly the row
      // that will never be stored, so this is the only chance to keep the fact.
      if (session.origin === 'subagent' && !recorded.has(session.id)) {
        recorded.add(session.id)
        draft.subagentSessionIds = [...(draft.subagentSessionIds ?? []), session.id]
      }
      if (!conversationVisible(session, openSessionId)) continue
      const title = session.displayTitle ?? session.title ?? session.id
      // Keep the Host's own activity stamp when it offers one: a row's age has
      // to describe the conversation, not the last time this plugin synced.
      const stamp = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? new Date(session.updatedAt).toISOString()
        : now
      const owned = owners !== undefined && owners.has(session.id) ? owners.get(session.id) ?? null : undefined
      const existing = byId.get(session.id)
      if (existing === undefined) {
        const created: ThreadRef = {
          sessionId: session.id, nodeId: null, title, updatedAt: stamp, importedAt: now, workspaceId: owned,
        }
        // Only a row that carries an origin writes one: an absent origin is not
        // the same claim as an empty one, and old documents stay untouched.
        if (session.origin !== undefined) created.origin = session.origin
        draft.threads.push(created)
        byId.set(session.id, created)
        continue
      }
      existing.title = title
      existing.updatedAt = stamp
      if (owned !== undefined) existing.workspaceId = owned
      if (session.origin !== undefined) existing.origin = session.origin
    }
  })
}

/**
 * Run one catalog sync end to end: index, prune, and report what stayed.
 *
 * The two passes have an order that must not be improvised — the whole catalog
 * has to reach {@link syncThreads} so a subagent child is recorded before it is
 * dropped, while only the visible rows may be the {@link pruneMissing} target.
 * A caller that filtered first would still render identically and silently stop
 * recording, so the pair lives here and callers pass the unfiltered catalog.
 * @param state - the stored document.
 * @param catalog - the whole catalog, unfiltered.
 * @param options - the open conversation and the Workspace accounting, when known.
 * @returns the synced document and the rows the map gives a row to.
 */
export function syncCatalog(
  state: MapState,
  catalog: readonly SessionSummaryLike[],
  options: { readonly openSessionId?: string | null; readonly owners?: ReadonlyMap<string, string | null> } = {},
): { readonly state: MapState; readonly visible: SessionSummaryLike[] } {
  const openSessionId = options.openSessionId ?? null
  const visible = indexableSessions(catalog, openSessionId)
  const synced = syncThreads(state, catalog, openSessionId, options.owners)
  return { state: pruneMissing(synced, new Set(visible.map(row => row.id))), visible }
}

/**
 * Drop indexed conversations the catalog no longer lists.
 *
 * The subagent ledger is not this function's business: {@link syncThreads}
 * records a child while the catalog still reports its origin, which happens
 * before a row could exist here.
 * @param state - the map.
 * @param liveIds - ids the catalog still lists.
 * @returns the map without those rows, or the input when nothing changed.
 */
export function pruneMissing(state: MapState, liveIds: ReadonlySet<string>): MapState {
  // Every production path builds a `MapState` through `mutate`, which defines
  // this field; a document read from JSON gets `[]` from `parseMapState`. An
  // object without it is therefore a programming error, and pruning there would
  // destroy the only evidence of which conversations were subagents.
  if (state.subagentSessionIds === undefined) return state
  if (state.threads.every(thread => liveIds.has(thread.sessionId))) return state
  return mutate(state, draft => {
    draft.threads = draft.threads.filter(thread => liveIds.has(thread.sessionId))
  })
}

/**
 * Whether the map recorded one Session as a subagent child.
 *
 * Membership survives the row: see {@link MapState.subagentSessionIds}.
 * @param state - the map.
 * @param sessionId - the Session to classify.
 * @returns true when the id was recorded as a subagent.
 */
export function isRecordedSubagent(state: MapState, sessionId: string): boolean {
  return state.subagentSessionIds?.includes(sessionId) === true
}

/**
 * Whether one Session is a conversation the map gives a row to.
 *
 * Mirrors the shipped sidebar: a subagent child is reached from its parent, so
 * it never becomes a row of its own — not even while it is the open Session.
 * Everything else follows the blank rule: a created-but-unused Session counts
 * only while it is the open one, so abandoning a provisional row removes it
 * instead of leaving an invalid conversation behind.
 * @param session - one catalog row.
 * @param openSessionId - the conversation currently open, if any.
 * @returns true when the row may appear in the index.
 */
export function conversationVisible(session: SessionSummaryLike, openSessionId: string | null): boolean {
  if (session.origin === 'subagent') return false
  return session.blank !== true || session.id === openSessionId
}

/**
 * Drop the sessions that are not conversations yet.
 *
 * The client keeps a created-but-unused session (a "blank" one) in its catalog
 * and leaves the filtering to consumers: only the selected blank entry is shown,
 * and even that stops being shown once focus moves on. Following the same rule
 * keeps never-started sessions out of the index. Subagent children are dropped
 * too, for a different reason: the map gives them no row, and their parent's row
 * carries their state.
 * @param sessions - the catalog rows, in host order.
 * @param openSessionId - the conversation currently open, if any.
 * @returns the rows worth indexing.
 */
export function indexableSessions(sessions: readonly SessionSummaryLike[], openSessionId: string | null): SessionSummaryLike[] {
  return sessions.filter(session => conversationVisible(session, openSessionId))
}

/**
 * Nearest ancestor conversation the map gives a row to.
 *
 * A subagent child is located by its parent's row, never by itself. A row the
 * catalog does not know, a missing or empty parent pointer, and a cyclic parent
 * chain all stop the walk at the last conversation it could name, so the caller
 * never loops and never invents an ancestor.
 * @param byId - catalog rows by session id, as the client holds them.
 * @param sessionId - the Session to resolve.
 * @returns the id of the nearest visible ancestor, or the last id the walk could reach.
 */
export function visibleAncestorOf(
  byId: Readonly<Record<string, { origin?: string; parentId?: string | null } | undefined>>,
  sessionId: string,
): string {
  const seen = new Set<string>()
  let cursor = sessionId
  while (!seen.has(cursor)) {
    seen.add(cursor)
    const row = byId[cursor]
    if (row === undefined || row.origin !== 'subagent') return cursor
    const parent = row.parentId
    if (parent === undefined || parent === null || parent === '') return cursor
    cursor = parent
  }
  return sessionId
}

/** One session's owning Workspace in the current Host projection. */
function membershipOf(workspaces: readonly WorkspaceRef[]): Map<string, string> {
  const membership = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) membership.set(sessionId, workspace.workspaceId)
  }
  return membership
}

/**
 * Reconcile the map with the Host's Workspace projection.
 *
 * Three things happen here, in order:
 * 1. A topic persisted before Workspaces became the map's first level is filed
 *    into the Workspace its own conversations live in (title/path as the
 *    fallback), and inherited by its children. A topic whose Workspace was
 *    deleted moves to the ungrouped bucket instead of disappearing.
 * 2. Every conversation takes the Workspace the Host accounts it to. A
 *    conversation that is no longer a member of its topic's Workspace leaves
 *    that topic, so the map never shows it twice or in the wrong group.
 * 3. Aliases are normalized: `undefined` becomes the concrete owner, so the
 *    document persists a stable shape.
 * @param state - the map.
 * @param workspaces - the Host's Workspace rows, in Host order.
 * @returns the reconciled map, or the same object when nothing changed.
 */
export function reconcileWorkspaces(state: MapState, workspaces: readonly WorkspaceRef[]): MapState {
  const known = new Set(workspaces.map(workspace => workspace.workspaceId))
  const membership = membershipOf(workspaces)
  const byId = new Map(state.nodes.map(node => [node.id, node]))
  const resolved = new Map<string, string | null>()

  /** Descendants of one node, computed from the original tree. */
  const descendantsOf = (rootId: string): Set<string> => {
    const ids = new Set<string>([rootId])
    let grew = true
    while (grew) {
      grew = false
      for (const node of state.nodes) {
        if (node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)) {
          ids.add(node.id)
          grew = true
        }
      }
    }
    return ids
  }

  /** The Workspace a legacy root topic most plausibly belongs to. */
  const inferWorkspace = (node: MapNode): string | null => {
    const subtree = descendantsOf(node.id)
    const votes = new Map<string, number>()
    for (const thread of state.threads) {
      if (thread.nodeId === null || !subtree.has(thread.nodeId)) continue
      const owner = membership.get(thread.sessionId)
      if (owner === undefined) continue
      votes.set(owner, (votes.get(owner) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [owner, count] of votes) {
      if (count > bestCount) { best = owner; bestCount = count }
    }
    if (best !== null) return best
    const wanted = node.title.trim().toLocaleLowerCase()
    for (const workspace of workspaces) {
      const title = workspace.title.trim().toLocaleLowerCase()
      const base = pathBaseName(workspace.path).toLocaleLowerCase()
      if (wanted !== '' && (wanted === title || wanted === base)) return workspace.workspaceId
    }
    return null
  }

  /** Resolve one node's owner, walking ancestors and remembering the answer. */
  const resolve = (nodeId: string, guard: Set<string>): string | null => {
    if (resolved.has(nodeId)) return resolved.get(nodeId) ?? null
    const node = byId.get(nodeId)
    if (node === undefined) return null
    let owner: string | null
    if (node.workspaceId !== undefined) {
      owner = node.workspaceId !== null && known.has(node.workspaceId) ? node.workspaceId : null
    } else if (guard.has(nodeId)) {
      owner = null
    } else if (node.parentId !== null && byId.has(node.parentId)) {
      guard.add(nodeId)
      owner = resolve(node.parentId, guard)
    } else {
      owner = inferWorkspace(node)
    }
    resolved.set(nodeId, owner)
    return owner
  }

  let changed = false
  const nodes = state.nodes.map(node => {
    const owner = resolve(node.id, new Set<string>())
    if (owner === ownerOf(node.workspaceId)) return node
    changed = true
    return { ...node, workspaceId: owner }
  })

  const nodeWorkspace = new Map(nodes.map(node => [node.id, ownerOf(node.workspaceId)]))
  const threads = state.threads.map(thread => {
    const knownMember = membership.has(thread.sessionId)
    const owner = knownMember
      ? membership.get(thread.sessionId) ?? null
      : thread.workspaceId !== undefined
        ? ownerOf(thread.workspaceId)
        : null
    let nodeId = thread.nodeId
    if (nodeId !== null) {
      const topicWorkspace = nodeWorkspace.get(nodeId)
      if (topicWorkspace === undefined || topicWorkspace !== owner) nodeId = null
    }
    // A Workspace owns the conversation: its plugin-local space no longer applies.
    const spaceId = owner === null ? thread.spaceId : undefined
    if (nodeId === thread.nodeId && owner === thread.workspaceId && spaceId === thread.spaceId) return thread
    changed = true
    const next: ThreadRef = { ...thread, nodeId, workspaceId: owner }
    if (spaceId === undefined) delete next.spaceId
    return next
  })

  if (!changed) return state
  return {
    version: 2,
    revision: state.revision + 1,
    nodes,
    threads,
    spaces: state.spaces,
    defaultSpaceId: state.defaultSpaceId,
    spaceOf: state.spaceOf,
    subagentSessionIds: state.subagentSessionIds ?? [],
  }
}

/** Whether a parsed value is a usable persisted map (current version). */
export function isMapState(value: unknown): value is MapState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<MapState>
  return candidate.version === 2
    && typeof candidate.revision === 'number'
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.threads)
}

/** Read a persisted owner, keeping `undefined` as the "not reconciled yet" marker. */
function readOwner(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  return undefined
}

/**
 * Read persisted spaces, dropping rows that cannot name a group.
 * @param value - the parsed `spaces` field.
 * @returns sanitized spaces, in persisted order.
 */
function readSpaces(value: unknown): SpaceRef[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const space = row as Partial<SpaceRef>
    if (typeof space.id !== 'string' || space.id === '') return []
    if (typeof space.title !== 'string' || space.title.trim() === '') return []
    if (seen.has(space.id)) return []
    seen.add(space.id)
    return [{
      id: space.id,
      title: space.title,
      position: typeof space.position === 'number' && Number.isFinite(space.position) ? space.position : 1,
      createdAt: typeof space.createdAt === 'string' ? space.createdAt : '',
    }]
  })
}

/**
 * Read persisted Workspace→space overrides, keeping only live references.
 * @param value - the parsed `spaceOf` field.
 * @param spaces - the spaces the document defines.
 * @returns the sanitized override table.
 */
function readSpaceOf(value: unknown, spaces: readonly SpaceRef[]): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const known = new Set(spaces.map(space => space.id))
  const result: Record<string, string> = {}
  for (const [workspaceId, spaceId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spaceId === 'string' && known.has(spaceId)) result[workspaceId] = spaceId
  }
  return result
}

/**
 * Read one persisted node/thread document into the current row shapes.
 * @param value - the parsed document.
 * @param keepOwner - whether version-2 ownership fields are preserved.
 * @param spaces - the spaces a loose conversation may be filed into.
 * @returns sanitized nodes and threads, or undefined when the shape is unusable.
 */
function readRows(
  value: { nodes?: unknown; threads?: unknown },
  keepOwner: boolean,
  spaces: readonly SpaceRef[],
): { nodes: MapNode[]; threads: ThreadRef[] } | undefined {
  if (!Array.isArray(value.nodes) || !Array.isArray(value.threads)) return undefined
  const knownSpaces = new Set(spaces.map(space => space.id))
  const nodes = value.nodes.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const node = row as Partial<MapNode>
    if (typeof node.id !== 'string' || typeof node.title !== 'string') return []
    const created: MapNode = {
      id: node.id,
      parentId: typeof node.parentId === 'string' ? node.parentId : null,
      title: node.title,
      description: typeof node.description === 'string' ? node.description : '',
      position: typeof node.position === 'number' ? node.position : 1,
      updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : '',
    }
    if (typeof node.createdAt === 'string' && node.createdAt !== '') created.createdAt = node.createdAt
    const owner = keepOwner ? readOwner(node.workspaceId) : undefined
    if (owner !== undefined) created.workspaceId = owner
    return [created]
  })
  const ids = new Set(nodes.map(node => node.id))
  const threads = value.threads.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const thread = row as Partial<ThreadRef>
    if (typeof thread.sessionId !== 'string') return []
    const created: ThreadRef = {
      sessionId: thread.sessionId,
      nodeId: typeof thread.nodeId === 'string' && ids.has(thread.nodeId) ? thread.nodeId : null,
      title: typeof thread.title === 'string' ? thread.title : thread.sessionId,
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : '',
      importedAt: typeof thread.importedAt === 'string' ? thread.importedAt : '',
    }
    const owner = keepOwner ? readOwner(thread.workspaceId) : undefined
    if (owner !== undefined) created.workspaceId = owner
    // The origin outlives the catalog: the Host half reads it to recognise a
    // conversation the map never gives a row to.
    if (typeof thread.origin === 'string' && thread.origin !== '') created.origin = thread.origin
    // A space only applies to a conversation no Workspace accounts for.
    if (keepOwner && ownerOf(owner) === null && typeof thread.spaceId === 'string' && knownSpaces.has(thread.spaceId)) {
      created.spaceId = thread.spaceId
    }
    return [created]
  })
  return { nodes, threads }
}

/**
 * Parse persisted JSON.
 *
 * A version-1 document — written before Workspaces were the map's first level —
 * upgrades in place: its topic tree is kept, and {@link reconcileWorkspaces}
 * files the roots once the Workspace list arrives. Space fields are additive:
 * an older document simply reads as "no spaces yet" and the panel creates the
 * default space on load.
 * @param text - raw JSON, or null.
 * @returns the parsed map, or an empty one.
 */
export function parseMapState(text: string | null): MapState {
  if (text === null || text === '') return emptyMap()
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return emptyMap()
    const candidate = parsed as {
      version?: unknown; revision?: unknown; nodes?: unknown; threads?: unknown
      spaces?: unknown; defaultSpaceId?: unknown; spaceOf?: unknown; subagentSessionIds?: unknown
    }
    const current = candidate.version === 2 || candidate.version === 1
    if (!current) return emptyMap()
    const parsedSpaces = readSpaces(candidate.spaces)
    const known = new Set(parsedSpaces.map(space => space.id))
    const defaultSpaceId = typeof candidate.defaultSpaceId === 'string' && known.has(candidate.defaultSpaceId)
      ? candidate.defaultSpaceId
      : ''
    // Older documents stored the default space's label as Chinese text; rewrite
    // only the default space's marker so it reads in any language without
    // touching a title the user actually typed on another space.
    const spaces = parsedSpaces.map(space =>
      space.id === defaultSpaceId && space.title === LEGACY_DEFAULT_SPACE_TITLE
        ? { ...space, title: DEFAULT_SPACE_TITLE }
        : space)
    const rows = readRows(candidate, candidate.version === 2, spaces)
    if (rows === undefined) return emptyMap()
    return {
      version: 2,
      revision: typeof candidate.revision === 'number' ? candidate.revision : 0,
      nodes: rows.nodes,
      threads: rows.threads,
      spaces,
      defaultSpaceId,
      spaceOf: readSpaceOf(candidate.spaceOf, spaces),
      subagentSessionIds: Array.isArray(candidate.subagentSessionIds)
        ? candidate.subagentSessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
        : [],
    }
  } catch (_malformed) {
    return emptyMap()
  }
}

/** One node whose title or description matched a search. */
export interface NodeSearchHit {
  node: MapNode
  /** Whether the title carried the hit (title hits rank above description hits). */
  titleMatch: boolean
  /** Case-insensitive match range inside the description, or null. */
  descriptionMatch: { start: number; end: number } | null
}

/** One conversation whose title matched a search. */
export interface ThreadSearchHit {
  thread: ThreadRef
  /** Case-insensitive match range inside the title. */
  titleMatch: { start: number; end: number } | null
}

/** What a query matched, split by kind. */
export interface SearchResults {
  nodes: NodeSearchHit[]
  threads: ThreadSearchHit[]
}

/**
 * First case-insensitive occurrence of `query` inside `text`.
 *
 * Case folding can change a string's length in a few scripts; the returned end
 * is clamped to the original text so a range always slices safely.
 * @param text - haystack.
 * @param query - raw needle (trimmed inside).
 * @returns the matched range in `text`, or null.
 */
export function findTextMatch(text: string, query: string): { start: number; end: number } | null {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '' || text === '') return null
  const folded = text.toLocaleLowerCase()
  const start = folded.indexOf(needle)
  if (start < 0) return null
  return { start, end: Math.min(text.length, start + needle.length) }
}

/**
 * Case-insensitive substring search over node titles and descriptions, and over
 * indexed conversation titles. A blank query matches nothing.
 *
 * Hits carry where they matched: the result column uses the description range
 * for its snippet and the title flag for ranking.
 * @param state - the map to search.
 * @param query - raw user input.
 * @param spaceId - scope the search to one space; omitted searches everything.
 * @returns the matching nodes and conversations, document order preserved.
 */
export function searchMap(state: MapState, query: string, spaceId?: string): SearchResults {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return { nodes: [], threads: [] }
  const inScope = (workspaceId: string | null | undefined, localSpaceId: string | null | undefined): boolean => {
    if (spaceId === undefined) return true
    if (workspaceId === undefined || workspaceId === null) {
      return (localSpaceId ?? state.defaultSpaceId) === spaceId
    }
    return spaceOfWorkspace(state, workspaceId) === spaceId
  }
  const nodes: NodeSearchHit[] = []
  for (const node of state.nodes) {
    if (!inScope(node.workspaceId, undefined)) continue
    const descriptionMatch = findTextMatch(node.description, needle)
    const titleMatch = findTextMatch(node.title, needle) !== null
    if (!titleMatch && descriptionMatch === null) continue
    nodes.push({ node, titleMatch, descriptionMatch })
  }
  const threads: ThreadSearchHit[] = []
  for (const thread of state.threads) {
    if (!inScope(thread.workspaceId, thread.spaceId)) continue
    const titleMatch = findTextMatch(thread.title, needle)
    if (titleMatch === null) continue
    threads.push({ thread, titleMatch })
  }
  return { nodes, threads }
}

/**
 * Human-readable node path, used wherever a node is shown out of tree.
 * @param state - the map.
 * @param nodeId - the node to describe.
 * @returns titles joined with a slash, nearest root first.
 */
export function breadcrumb(state: MapState, nodeId: string): string {
  return nodePath(state, nodeId).map(node => node.title).join(' / ')
}

/** Label of the "directly under the Workspace" destination (localized fallback). */
const WORKSPACE_ROOT_TARGET_LABEL = '(Workspace top level)'

/**
 * Every node one conversation of a Workspace may move to, in the order the map
 * shows them.
 *
 * Built for the 「移动到…」 picker: the Workspace row itself comes first (a
 * conversation can always live directly under its Workspace), then each node
 * depth-first, labelled with its full path so two same-named topics stay apart.
 * A cycle in a hand-built document cannot make the list grow — an id is emitted
 * once — and no document is touched, so a dialog can build the list per open.
 * @param state - the map.
 * @param workspaceId - the Workspace whose nodes are the targets; `null` = the ungrouped bucket.
 * @param workspaceRootLabel - localized label of the Workspace-row destination.
 * @returns the selectable destinations, the Workspace root (`null`) first.
 */
export function threadMoveTargets(
  state: MapState,
  workspaceId: string | null,
  workspaceRootLabel: string = WORKSPACE_ROOT_TARGET_LABEL,
): Array<{ nodeId: string | null; label: string }> {
  const wanted = ownerOf(workspaceId)
  const targets: Array<{ nodeId: string | null; label: string }> = [
    { nodeId: null, label: workspaceRootLabel },
  ]
  const children = new Map<string, MapNode[]>()
  for (const node of state.nodes) {
    if (node.parentId === null) continue
    const siblings = children.get(node.parentId)
    if (siblings === undefined) children.set(node.parentId, [node])
    else siblings.push(node)
  }
  const seen = new Set<string>()
  const walk = (node: MapNode): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    targets.push({ nodeId: node.id, label: breadcrumb(state, node.id) })
    const kids = (children.get(node.id) ?? []).filter(candidate => ownerOf(candidate.workspaceId) === wanted)
    for (const child of sorted(kids)) walk(child)
  }
  for (const root of sorted(state.nodes.filter(node => node.parentId === null && ownerOf(node.workspaceId) === wanted))) {
    walk(root)
  }
  // "Every node of the Workspace" has to hold for a hand-built document too: a
  // node whose parent is missing or looped hangs off no root, and leaving it out
  // would hide a destination the map still shows a column for.
  const orphans = state.nodes.filter(node => ownerOf(node.workspaceId) === wanted)
  for (const node of sorted(orphans)) walk(node)
  return targets
}

/**
 * Short, stable fragment of a session id.
 *
 * Titles repeat in practice, so the index shows this beside every conversation:
 * identity comes from the id, never from the title. Session ids carry a
 * `session-` prefix, stripped first — otherwise every chip would read the same.
 * @param sessionId - the full session id.
 * @returns the first eight identifying characters.
 */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  return bare.slice(0, 8)
}

/**
 * Index a conversation that was just created for one node.
 *
 * `syncThreads` only refreshes rows the catalog already lists, so a brand-new
 * session has to be adopted before its first turn lands — otherwise the new
 * discussion would appear in the ungrouped bucket instead of under the node
 * that started it. Its activity stamp is "now", so it leads that node's list.
 * @param state - the map.
 * @param input - the created session, its provisional title, its owner, and the Workspace it was created in.
 * @returns the updated map.
 */
export function adoptThread(
  state: MapState,
  input: {
    sessionId: string
    title: string
    nodeId: string | null
    workspaceId?: string | null
    /** Space of a loose conversation; ignored when the row owns a Workspace. */
    spaceId?: string | null
  },
): MapState {
  const node = input.nodeId === null ? undefined : requireNode(state, input.nodeId)
  const workspaceId = node === undefined
    ? ownerOf(input.workspaceId)
    : workspaceOfNode(node)
  const requestedSpace = input.spaceId ?? null
  const spaceId = workspaceId !== null || requestedSpace === null || requestedSpace === state.defaultSpaceId
    ? undefined
    : state.spaces.some(space => space.id === requestedSpace) ? requestedSpace : undefined
  return mutate(state, draft => {
    const now = new Date().toISOString()
    const existing = draft.threads.find(thread => thread.sessionId === input.sessionId)
    if (existing === undefined) {
      draft.threads.push({
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        workspaceId,
        spaceId,
        title: input.title === '' ? input.sessionId : input.title,
        updatedAt: now,
        importedAt: now,
      })
      return
    }
    existing.nodeId = input.nodeId
    existing.workspaceId = workspaceId
    if (spaceId === undefined) delete existing.spaceId
    else existing.spaceId = spaceId
    if (input.title !== '') existing.title = input.title
    existing.updatedAt = now
  })
}
