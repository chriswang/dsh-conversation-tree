/// <reference types="node" />
/**
 * Model-facing `map_*` tools: the control surface the harness uses to create and
 * manage the persistent node tree.
 *
 * Tools are registered as plain structural definitions (no DSH package import),
 * validate their own arguments, mutate through the store's atomic `apply`, and
 * return a canonical value: `{ ok: true, revision, ... }` on success or
 * `{ ok: false, code, message }` on failure. Registration at the profile root
 * puts them in the global tool layer, so every session and subagent sees them.
 */
import { randomUUID } from 'node:crypto'

import type { MapState } from '../shared/model.js'
import type {
  HostContextLike, ToolDefinitionLike, ToolExecLike, WorkspaceLike, WorkspaceRegistryLike,
} from './context.js'
import { MapToolError, mapToolFailure } from './errors.js'
import type { MapFileStore } from './store.js'
import {
  parseAttachSessions, parseCreateNodes, parseDeleteNodes, parseGetState, parseMoveNodes,
  parseMoveSessions, parsePlanGoal, parseUpdateNodes,
} from './args.js'
import {
  attachSessions, createNodes, deleteNodes, moveNodes, moveSessions, planGoal, updateNodes, viewState,
} from './ops.js'

/** Canonical output contract shared by every map tool. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    revision: { type: 'number' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
} as const

/** One tool outcome the model reads. */
type ToolOutcome = ({ ok: true; revision: number } & Record<string, unknown>) | { ok: false; code: string; message: string }

/** Description shown in the conversation card and the model schema. */
interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly concurrencySafe: boolean
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>
}

/** Render one canonical tool value as model content. */
function renderValue(_args: unknown, value: unknown): ReadonlyArray<Record<string, unknown>> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * Wrap one tool spec into the registry's structural definition.
 * @param spec - tool metadata and body.
 * @returns the registrable definition.
 */
function define(spec: ToolSpec): ToolDefinitionLike {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: TOOL_OUTPUT_SCHEMA, render: renderValue },
    isConcurrencySafe: () => spec.concurrencySafe,
    // The registry passes model arguments straight through, and workspace
    // resolution / argument parsing can raise before the store runs. Fold every
    // failure into the canonical value so the model always reads a code.
    async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
      try {
        return await spec.execute(args, exec)
      } catch (error) {
        return mapToolFailure(error)
      }
    },
  }
}

/** The writer identity recorded in the document envelope. */
function writerOf(exec: ToolExecLike): string {
  const sessionId = exec.agent?.session?.id
  return typeof sessionId === 'string' && sessionId !== '' ? `agent:${sessionId}` : 'agent:unknown'
}

/**
 * Run one pure document transition through the store, mapping failures to the
 * canonical tool value.
 * @param store - authoritative map store.
 * @param exec - tool execution identity.
 * @param mutate - transition from the current document.
 * @returns the canonical tool outcome.
 */
async function runOperation<T extends Record<string, unknown>>(
  store: MapFileStore,
  exec: ToolExecLike,
  mutate: (doc: MapState) => { doc: MapState; value: T },
): Promise<ToolOutcome> {
  try {
    const outcome = await store.apply(mutate, writerOf(exec))
    return { ok: true, revision: outcome.revision, ...outcome.value }
  } catch (error) {
    return mapToolFailure(error)
  }
}

/** Feature-probed workspace registry. */
function workspaceRegistry(ctx: HostContextLike): WorkspaceRegistryLike | undefined {
  const candidate = ctx.get('workspaceRegistry')
  return typeof candidate === 'object' && candidate !== null ? candidate as WorkspaceRegistryLike : undefined
}

/** Known workspaces from the registry, richest first. */
function knownWorkspaces(ctx: HostContextLike): WorkspaceLike[] {
  const registry = workspaceRegistry(ctx)
  const list = registry?.list?.()
  if (Array.isArray(list)) return list
  return []
}

/**
 * Resolve the workspace a write should target.
 *
 * Explicit `workspace_id` wins; otherwise the calling session's cwd resolved
 * through the workspace registry, then the single known workspace, else a
 * model-readable failure asking for `map_list_workspaces`.
 * @param ctx - Host context.
 * @param exec - tool execution identity.
 * @param explicit - model-provided workspace id.
 * @returns the resolved workspace id.
 */
async function resolveWorkspaceId(ctx: HostContextLike, exec: ToolExecLike, explicit?: string): Promise<string> {
  if (explicit !== undefined && explicit !== '') return explicit
  const registry = workspaceRegistry(ctx)
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '' && typeof registry?.resolveByPath === 'function') {
    const found = registry.resolveByPath(cwd)
    if (found !== undefined && typeof found.id === 'string') return found.id
  }
  const list = knownWorkspaces(ctx)
  if (list.length === 1) return list[0].id
  throw new MapToolError(
    'WORKSPACE_REQUIRED',
    'no workspace_id was given and it could not be inferred from the session directory; call map_list_workspaces first',
  )
}

/** Model-facing description of one created node. */
function createdSummary(created: ReadonlyArray<{ nodeId: string; title: string; parentId: string | null; ref?: string }>): unknown[] {
  return created.map(node => ({
    node_id: node.nodeId,
    title: node.title,
    parent_id: node.parentId,
    ...node.ref === undefined ? {} : { ref: node.ref },
  }))
}

/** Build the tool set bound to one store. */
function toolSpecs(ctx: HostContextLike, store: MapFileStore): ToolSpec[] {
  return [
    {
      name: 'map_list_workspaces',
      description: 'List the map workspaces (the L1 column) with their node and conversation counts. '
        + 'Call this before creating nodes so the tree lands in the right workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      concurrencySafe: true,
      async execute(): Promise<unknown> {
        await store.ready()
        const snapshot = store.snapshot()
        const view = viewState(snapshot.doc, { depth: 1 }).value
        const counts = new Map<string, { nodeCount: number; threadCount: number }>()
        for (const entry of view.workspaces ?? []) counts.set(entry.workspaceId, entry)
        const known = new Map(knownWorkspaces(ctx).map(workspace => [workspace.id, workspace]))
        const ids = new Set<string>([...known.keys(), ...counts.keys()])
        const workspaces = [...ids].map((workspaceId) => {
          const workspace = known.get(workspaceId)
          const count = counts.get(workspaceId)
          return {
            workspace_id: workspaceId,
            title: workspace?.title ?? workspaceId,
            ...workspace?.path === undefined ? {} : { path: workspace.path },
            node_count: count?.nodeCount ?? 0,
            thread_count: count?.threadCount ?? 0,
          }
        })
        return { ok: true, revision: snapshot.revision, workspaces }
      },
    },
    {
      name: 'map_get_state',
      description: 'Read the persistent map tree below the workspace level: one subtree, one workspace topic tree, '
        + 'or workspace-level counts (L1 workspaces themselves are not editable by tools). '
        + 'Use it before creating/updating nodes and after a conflict. The tree is truncated (depth and node budget) '
        + 'and reports `truncated`.',
      parameters: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Workspace id to read its top-level nodes.' },
          node_id: { type: 'string', description: 'Node id to read that subtree.' },
          depth: { type: 'integer', description: 'Expansion depth 1-12; defaults to 3.' },
          include_sessions: { type: 'boolean', description: 'Reserved; conversation titles are not included yet.' },
        },
        additionalProperties: false,
      },
      concurrencySafe: true,
      async execute(args: unknown): Promise<unknown> {
        await store.ready()
        const input = parseGetState(args)
        const snapshot = store.snapshot()
        const view = viewState(snapshot.doc, {
          ...input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId },
          ...input.nodeId === undefined ? {} : { nodeId: input.nodeId },
          depth: input.depth,
        }).value
        const known = new Map(knownWorkspaces(ctx).map(workspace => [workspace.id, workspace]))
        return {
          ok: true,
          revision: snapshot.revision,
          ...view,
          ...view.workspaces === undefined ? {} : {
            workspaces: view.workspaces.map((entry) => {
              const workspace = known.get(entry.workspaceId)
              return {
                workspace_id: entry.workspaceId,
                title: workspace?.title ?? entry.workspaceId,
                node_count: entry.nodeCount,
                thread_count: entry.threadCount,
              }
            }),
          },
        }
      },
    },
    {
      name: 'map_plan_goal',
      description: 'Create one goal topic node (L2, directly under an existing workspace) with '
        + 'its strategy nodes (L3) and optional task nodes (L4) in a single '
        + 'atomic call. Workspaces are user-owned local directories and cannot be created by tools; pick one with '
        + 'map_list_workspaces. '
        + 'Use this when the user gives a goal and the map should hold the implementation plan. '
        + 'Returns every created node id. Creates at most 50 nodes.',
      parameters: {
        type: 'object',
        required: ['goal', 'strategies'],
        properties: {
          workspace_id: { type: 'string', description: 'Target workspace; inferred from the session directory when omitted.' },
          goal: {
            type: 'object',
            required: ['title'],
            properties: { title: { type: 'string' }, description: { type: 'string' } },
            additionalProperties: false,
          },
          strategies: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title'],
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                tasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['title'],
                    properties: { title: { type: 'string' }, description: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parsePlanGoal(args)
        const workspaceId = await resolveWorkspaceId(ctx, exec, input.workspaceId)
        return runOperation(store, exec, doc => planGoal(doc, { ...input, workspaceId }, randomUUID))
      },
    },
    {
      name: 'map_create_nodes',
      description: 'Create a batch of L2+ nodes (optionally nested through `children`) directly under an '
        + 'existing workspace, or under a parent node. Workspaces themselves are user-owned and cannot be created '
        + 'by tools. Returns the created node ids. Creates at most 50 nodes per call.',
      parameters: {
        type: 'object',
        required: ['nodes'],
        properties: {
          workspace_id: { type: 'string', description: 'Existing workspace id; required when parent_id is omitted.' },
          parent_id: { type: 'string', description: 'Parent node id; omit to create at the workspace root.' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title'],
              properties: {
                ref: { type: 'string', description: 'Optional in-batch reference echoed back in the result.' },
                title: { type: 'string' },
                description: { type: 'string' },
                children: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['title'],
                    properties: {
                      ref: { type: 'string' },
                      title: { type: 'string' },
                      description: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseCreateNodes(args)
        const workspaceId = input.parentId === null
          ? await resolveWorkspaceId(ctx, exec, input.workspaceId)
          : ''
        return runOperation(store, exec, doc => {
          const outcome = createNodes(doc, { ...input, workspaceId }, randomUUID)
          return { doc: outcome.doc, value: { created: createdSummary(outcome.value.created) } }
        })
      },
    },
    {
      name: 'map_update_nodes',
      description: 'Rename and/or re-describe up to 50 existing nodes atomically. Node ids come from map_get_state '
        + 'or an earlier create/plan result.',
      parameters: {
        type: 'object',
        required: ['updates'],
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              required: ['node_id'],
              properties: {
                node_id: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseUpdateNodes(args)
        return runOperation(store, exec, doc => updateNodes(doc, input))
      },
    },
    {
      name: 'map_move_nodes',
      description: 'Re-parent up to 50 nodes inside their own workspace atomically. Omit parent_id to move a node '
        + 'to the workspace root. Omit before_node_id to append (the default); give a sibling\'s id to insert the '
        + 'node before it — re-ordering inside one parent is the same call. Rejects cycles, over-deep moves, and '
        + 'an anchor that is not a child of the target parent.',
      parameters: {
        type: 'object',
        required: ['moves'],
        properties: {
          moves: {
            type: 'array',
            items: {
              type: 'object',
              required: ['node_id'],
              properties: {
                node_id: { type: 'string' },
                parent_id: { type: 'string', description: 'New parent node id; omit for the workspace root.' },
                before_node_id: {
                  type: 'string',
                  description: 'Sibling to insert before; omit to append at the end of the new parent.',
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseMoveNodes(args)
        return runOperation(store, exec, doc => moveNodes(doc, input))
      },
    },
    {
      name: 'map_move_session',
      description: 'Move up to 20 existing conversations to another topic of their own workspace, or to the workspace '
        + 'row itself when node_id is omitted or null. Only the map\'s filing changes: the Host workspace, the '
        + 'session and its working directory are untouched, and the conversation keeps its activity stamp instead '
        + 'of jumping to the top of the target list. Rejected per session id: conversations accounted to another '
        + 'workspace, conversations no workspace accounts for when the target is a workspace topic, subagent '
        + 'children, and ids that have no row yet (NO_THREAD — file those with map_attach_sessions first).',
      parameters: {
        type: 'object',
        required: ['session_ids'],
        properties: {
          session_ids: { type: 'array', items: { type: 'string' } },
          node_id: {
            type: ['string', 'null'],
            description: 'Target topic id; omit or pass null to move the conversations under their workspace row.',
          },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseMoveSessions(args)
        return runOperation(store, exec, doc => {
          const outcome = moveSessions(doc, input)
          return {
            doc: outcome.doc,
            value: {
              moved: outcome.value.moved,
              rejected: outcome.value.rejected.map(entry => ({
                session_id: entry.sessionId,
                code: entry.code,
                message: entry.message,
              })),
            },
          }
        })
      },
    },
    {
      name: 'map_delete_nodes',
      description: 'Delete up to 50 nodes. mode="leaf" refuses nodes that still have children; mode="subtree" '
        + 'deletes each target with its whole subtree (children first). Requires confirm=true.',
      parameters: {
        type: 'object',
        required: ['node_ids', 'mode', 'confirm'],
        properties: {
          node_ids: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string', enum: ['leaf', 'subtree'] },
          confirm: { type: 'boolean', description: 'Must be true; deletion is destructive.' },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseDeleteNodes(args)
        return runOperation(store, exec, doc => deleteNodes(doc, input))
      },
    },
    {
      name: 'map_attach_sessions',
      description: 'File existing conversations under one node so the map shows them beneath that goal/strategy. '
        + 'Sessions already accounted to another workspace are rejected, and so are subagent children '
        + '(they never appear as rows of their own; reach them from their parent conversation instead).',
      parameters: {
        type: 'object',
        required: ['node_id', 'session_ids'],
        properties: {
          node_id: { type: 'string' },
          session_ids: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      concurrencySafe: false,
      async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
        const input = parseAttachSessions(args)
        return runOperation(store, exec, doc => {
          const outcome = attachSessions(doc, input)
          return {
            doc: outcome.doc,
            value: {
              attached: outcome.value.attached,
              rejected: outcome.value.rejected.map(entry => ({
                session_id: entry.sessionId,
                code: entry.code,
                message: entry.message,
              })),
            },
          }
        })
      },
    },
  ]
}

/**
 * Register every map tool in the calling (profile-root) context.
 * @param ctx - Host plugin context with `tools`.
 * @param store - authoritative map store.
 * @returns aggregate disposer for the registrations.
 */
export function registerMapTools(ctx: HostContextLike, store: MapFileStore): () => void {
  const disposers: Array<() => void> = []
  try {
    for (const spec of toolSpecs(ctx, store)) {
      disposers.push(ctx.tools.register(define(spec)))
    }
  } catch (error) {
    for (const dispose of disposers) dispose()
    throw error
  }
  return () => { for (const dispose of disposers) dispose() }
}
