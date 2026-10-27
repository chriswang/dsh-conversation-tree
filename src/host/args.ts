/**
 * Manual argument validation for the model tools.
 *
 * The tool registry passes model-produced arguments straight to `execute`; it
 * does not compile or enforce the tool's `parameters` JSON Schema (that schema
 * is only the model-facing function contract). Every tool therefore validates
 * its own input here and raises {@link MapToolError} with `INVALID_ARGS`, which
 * the tool wrapper folds into the canonical failure value.
 */
import { MapToolError } from './errors.js'
import { MAX_BATCH_NODES } from './paths.js'

/** One decoded argument object. */
type Args = Record<string, unknown>

/** A node draft accepted by create/plan tools. */
export interface NodeInput {
  readonly ref?: string
  readonly title: string
  readonly description?: string
  readonly children?: readonly NodeInput[]
}

/** Decoded `map_get_state` input. */
export interface GetStateInput {
  readonly workspaceId?: string
  readonly nodeId?: string
  readonly depth: number
  readonly includeSessions: boolean
}

/** Decoded `map_plan_goal` input. */
export interface PlanGoalInput {
  readonly workspaceId?: string
  readonly goal: { readonly title: string; readonly description?: string }
  readonly strategies: ReadonlyArray<{
    readonly title: string
    readonly description?: string
    readonly tasks?: ReadonlyArray<{ readonly title: string; readonly description?: string }>
  }>
}

/** Decoded `map_create_nodes` input. */
export interface CreateNodesInput {
  readonly workspaceId?: string
  readonly parentId: string | null
  readonly nodes: readonly NodeInput[]
}

/** Decoded `map_update_nodes` input. */
export interface UpdateNodesInput {
  readonly updates: ReadonlyArray<{ readonly nodeId: string; readonly title?: string; readonly description?: string }>
}

/** Decoded `map_move_nodes` input. */
export interface MoveNodesInput {
  readonly moves: ReadonlyArray<{
    readonly nodeId: string
    readonly parentId: string | null
    /** Sibling to insert before; omitted = append at the end of the parent. */
    readonly beforeNodeId?: string
  }>
}

/** Decoded `map_delete_nodes` input. */
export interface DeleteNodesInput {
  readonly nodeIds: readonly string[]
  readonly mode: 'leaf' | 'subtree'
}

/** Decoded `map_attach_sessions` input. */
export interface AttachSessionsInput {
  readonly nodeId: string
  readonly sessionIds: readonly string[]
}

/** Decoded `map_move_session` input. `nodeId === null` = the workspace row. */
export interface MoveSessionsInput {
  readonly nodeId: string | null
  readonly sessionIds: readonly string[]
}

/** Reject one malformed argument. */
function invalid(message: string): never {
  throw new MapToolError('INVALID_ARGS', message)
}

/**
 * Read one argument object.
 * @param value - raw tool arguments.
 * @returns the record view.
 */
function asRecord(value: unknown): Args {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('arguments must be an object')
  return value as Args
}

/**
 * Read an optional non-empty string.
 * @param args - argument record.
 * @param key - argument name.
 * @param max - optional length ceiling.
 * @returns the string, or undefined when absent.
 */
function optionalString(args: Args, key: string, max = 200): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') invalid(`${key} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) invalid(`${key} must be at most ${max} characters`)
  return trimmed
}

/** Read a required non-empty string. */
function requiredString(args: Args, key: string, max = 200): string {
  const value = optionalString(args, key, max)
  if (value === undefined) invalid(`${key} is required`)
  return value
}

/** Read an optional integer within bounds. */
function optionalInteger(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(`${key} must be an integer`)
  if (value < min || value > max) invalid(`${key} must be between ${min} and ${max}`)
  return value
}

/** Read an optional boolean. */
function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') invalid(`${key} must be a boolean`)
  return value
}

/**
 * Read one array argument and map every entry.
 * @param args - argument record.
 * @param key - argument name.
 * @param min - minimum entries.
 * @param max - maximum entries.
 * @param parse - entry parser.
 * @returns the typed entries.
 */
function arrayOf<T>(args: Args, key: string, min: number, max: number, parse: (entry: unknown, path: string) => T): T[] {
  const value = args[key]
  if (!Array.isArray(value)) invalid(`${key} must be an array`)
  if (value.length < min || value.length > max) invalid(`${key} must contain between ${min} and ${max} entries`)
  return value.map((entry, index) => parse(entry, `${key}[${index}]`))
}

/** Parse one node draft (recursively through children). */
function parseNodeInput(entry: unknown, path: string): NodeInput {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid(`${path} must be an object`)
  const candidate = entry as Args
  const title = requiredString(candidate, 'title', 80)
  const description = optionalString(candidate, 'description', 6000)
  const ref = optionalString(candidate, 'ref', 80)
  const children = candidate.children === undefined || candidate.children === null
    ? undefined
    : arrayOf(candidate, 'children', 0, MAX_BATCH_NODES, (child, childPath) => parseNodeInput(child, childPath))
  return {
    title,
    ...description === undefined ? {} : { description },
    ...ref === undefined ? {} : { ref },
    ...children === undefined || children.length === 0 ? {} : { children },
  }
}

/** Count every node draft including nested children. */
export function countNodeInputs(nodes: readonly NodeInput[]): number {
  let total = 0
  for (const node of nodes) {
    total += 1 + countNodeInputs(node.children ?? [])
  }
  return total
}

/** Decode `map_get_state`. */
export function parseGetState(args: unknown): GetStateInput {
  const record = asRecord(args)
  return {
    workspaceId: optionalString(record, 'workspace_id'),
    nodeId: optionalString(record, 'node_id'),
    depth: optionalInteger(record, 'depth', 1, 12) ?? 3,
    includeSessions: optionalBoolean(record, 'include_sessions') ?? false,
  }
}

/** Decode `map_plan_goal`. */
export function parsePlanGoal(args: unknown): PlanGoalInput {
  const record = asRecord(args)
  const goalRecord = record.goal
  if (typeof goalRecord !== 'object' || goalRecord === null || Array.isArray(goalRecord)) {
    invalid('goal must be an object')
  }
  const goal = goalRecord as Args
  const strategies = arrayOf(record, 'strategies', 1, 20, (entry, path) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid(`${path} must be an object`)
    const strategy = entry as Args
    const tasks = strategy.tasks === undefined || strategy.tasks === null
      ? undefined
      : arrayOf(strategy, 'tasks', 0, MAX_BATCH_NODES, (task, taskPath) => {
        if (typeof task !== 'object' || task === null || Array.isArray(task)) invalid(`${taskPath} must be an object`)
        const fields = task as Args
        return {
          title: requiredString(fields, 'title', 80),
          ...optionalDescription(fields),
        }
      })
    return {
      title: requiredString(strategy, 'title', 80),
      ...optionalDescription(strategy),
      ...tasks === undefined || tasks.length === 0 ? {} : { tasks },
    }
  })
  const total = 1 + strategies.length
    + strategies.reduce((sum, strategy) => sum + (strategy.tasks?.length ?? 0), 0)
  if (total > MAX_BATCH_NODES) invalid(`map_plan_goal creates ${total} nodes; the limit is ${MAX_BATCH_NODES}`)
  return {
    workspaceId: optionalString(record, 'workspace_id'),
    goal: { title: requiredString(goal, 'title', 80), ...optionalDescription(goal) },
    strategies,
  }
}

/** Optional `description` field spread. */
function optionalDescription(source: Args): { description?: string } {
  const description = optionalString(source, 'description', 6000)
  return description === undefined ? {} : { description }
}

/** Decode `map_create_nodes`. */
export function parseCreateNodes(args: unknown): CreateNodesInput {
  const record = asRecord(args)
  const nodes = arrayOf(record, 'nodes', 1, MAX_BATCH_NODES, (entry, path) => parseNodeInput(entry, path))
  const total = countNodeInputs(nodes)
  if (total > MAX_BATCH_NODES) invalid(`map_create_nodes creates ${total} nodes; the limit is ${MAX_BATCH_NODES}`)
  const parent = record.parent_id
  if (parent !== undefined && parent !== null && typeof parent !== 'string') invalid('parent_id must be a string when present')
  const parentId = typeof parent === 'string' && parent.trim() !== '' ? parent.trim() : null
  return {
    workspaceId: optionalString(record, 'workspace_id'),
    parentId,
    nodes,
  }
}

/** Decode `map_update_nodes`. */
export function parseUpdateNodes(args: unknown): UpdateNodesInput {
  const record = asRecord(args)
  return {
    updates: arrayOf(record, 'updates', 1, MAX_BATCH_NODES, (entry, path) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid(`${path} must be an object`)
      const fields = entry as Args
      const title = optionalString(fields, 'title', 80)
      const description = optionalString(fields, 'description', 6000)
      if (title === undefined && description === undefined) invalid(`${path} must change title or description`)
      return {
        nodeId: requiredString(fields, 'node_id', 200),
        ...title === undefined ? {} : { title },
        ...description === undefined ? {} : { description },
      }
    }),
  }
}

/** Decode `map_move_nodes`. */
export function parseMoveNodes(args: unknown): MoveNodesInput {
  const record = asRecord(args)
  return {
    moves: arrayOf(record, 'moves', 1, MAX_BATCH_NODES, (entry, path) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) invalid(`${path} must be an object`)
      const fields = entry as Args
      const parent = fields.parent_id
      if (parent !== undefined && parent !== null && typeof parent !== 'string') invalid(`${path}.parent_id must be a string when present`)
      const parentId = typeof parent === 'string' && parent.trim() !== '' ? parent.trim() : null
      const before = fields.before_node_id
      if (before !== undefined && before !== null && typeof before !== 'string') {
        invalid(`${path}.before_node_id must be a string when present`)
      }
      const beforeNodeId = typeof before === 'string' && before.trim() !== '' ? before.trim() : undefined
      return {
        nodeId: requiredString(fields, 'node_id', 200),
        parentId,
        ...beforeNodeId === undefined ? {} : { beforeNodeId },
      }
    }),
  }
}

/** Decode `map_delete_nodes`. */
export function parseDeleteNodes(args: unknown): DeleteNodesInput {
  const record = asRecord(args)
  const mode = record.mode
  if (mode !== 'leaf' && mode !== 'subtree') invalid('mode must be "leaf" or "subtree"')
  if (record.confirm !== true) invalid('confirm must be true to delete nodes')
  const nodeIds = arrayOf(record, 'node_ids', 1, MAX_BATCH_NODES, (entry, path) => {
    if (typeof entry !== 'string' || entry.trim() === '') invalid(`${path} must be a node id string`)
    return entry.trim()
  })
  return { nodeIds, mode }
}

/** Decode `map_attach_sessions`. */
export function parseAttachSessions(args: unknown): AttachSessionsInput {
  const record = asRecord(args)
  return {
    nodeId: requiredString(record, 'node_id', 200),
    sessionIds: arrayOf(record, 'session_ids', 1, 20, (entry, path) => {
      if (typeof entry !== 'string' || entry.trim() === '') invalid(`${path} must be a session id string`)
      return entry.trim()
    }),
  }
}

/** Decode `map_move_session`. */
export function parseMoveSessions(args: unknown): MoveSessionsInput {
  const record = asRecord(args)
  const node = record.node_id
  if (node !== undefined && node !== null && typeof node !== 'string') invalid('node_id must be a string when present')
  return {
    nodeId: typeof node === 'string' && node.trim() !== '' ? node.trim() : null,
    sessionIds: arrayOf(record, 'session_ids', 1, 20, (entry, path) => {
      if (typeof entry !== 'string' || entry.trim() === '') invalid(`${path} must be a session id string`)
      return entry.trim()
    }),
  }
}
