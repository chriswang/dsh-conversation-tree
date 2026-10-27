/**
 * Behavior tests for the model-facing map tools.
 *
 * The tool registry and system-prompt services are stubbed by shape; the store,
 * the pure node ops and the tool wrappers are the real built modules. The fake
 * execution identity mirrors what the agent loop passes to `execute`.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMapFileStore } from '../lib/host-store.js'
import { registerMapPromptSection, MAP_GUIDANCE } from '../lib/host-prompt.js'
import { registerMapTools } from '../lib/host-tools.js'
import { emptyMap, ensureDefaultSpace } from '../lib/model.js'

/** The workspace fixture the fake registry reports. */
const WORKSPACES = [
  { id: 'w1', title: 'alpha', path: '/tmp/alpha' },
  { id: 'w2', title: 'beta', path: '/tmp/beta' },
]

/**
 * A Host context double: records tool registrations and prompt sections.
 * @returns the context plus captured registrations.
 */
function fakeContext() {
  const registrations = []
  const promptSections = []
  const systemPrompt = { section: section => { promptSections.push(section) } }
  const ctx = {
    tools: { register(definition) { registrations.push(definition); return () => {} } },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => WORKSPACES,
          get: id => WORKSPACES.find(workspace => workspace.id === id),
          resolveByPath: path => WORKSPACES.find(workspace => workspace.path === path),
        }
      }
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    inject(deps, callback) {
      if (deps.includes('systemPrompt')) callback(ctx)
    },
  }
  return { ctx, registrations, promptSections }
}

/** A tool execution identity whose session runs in workspace alpha. */
function execIn(cwd = '/tmp/alpha') {
  return { agent: { session: { id: 'session-1', header: { cwd } } } }
}

/**
 * Register the tools against a temporary store.
 * @returns helpers for invoking registered tools.
 */
async function withTools(run) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-map-tools-'))
  try {
    const store = createMapFileStore({ filePath: join(dir, 'map.json') })
    await store.ready()
    const { ctx, registrations, promptSections } = fakeContext()
    registerMapTools(ctx, store)
    registerMapPromptSection(ctx)
    const tools = new Map(registrations.map(definition => [definition.name, definition]))
    await run({ store, tools, registrations, promptSections, invoke: async (name, args, exec = execIn()) => {
      const definition = tools.get(name)
      assert.ok(definition !== undefined, `tool ${name} is registered`)
      return definition.execute(args, exec)
    } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the nine map tools are registered with model-facing schemas', async () => {
  await withTools(async ({ registrations }) => {
    assert.deepEqual(
      registrations.map(definition => definition.name).sort(),
      [
        'map_attach_sessions', 'map_create_nodes', 'map_delete_nodes', 'map_get_state',
        'map_list_workspaces', 'map_move_nodes', 'map_move_session', 'map_plan_goal', 'map_update_nodes',
      ],
    )
    for (const definition of registrations) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.output.render, 'function')
    }
    const getState = registrations.find(definition => definition.name === 'map_get_state')
    assert.ok(Object.hasOwn(getState.parameters.properties, 'workspace_id'))

    const moveSession = registrations.find(definition => definition.name === 'map_move_session')
    assert.deepEqual(moveSession.parameters.required, ['session_ids'])
    assert.equal(moveSession.parameters.additionalProperties, false)
    assert.deepEqual(moveSession.parameters.properties.node_id.type, ['string', 'null'])
    assert.equal(moveSession.isConcurrencySafe(), false)
  })
})

test('map_plan_goal creates the goal/strategy/task tree in one call', async () => {
  await withTools(async ({ invoke, store }) => {
    const result = await invoke('map_plan_goal', {
      goal: { title: '发布 v1', description: 'ship it' },
      strategies: [
        { title: '技术方案', tasks: [{ title: '任务 1' }, { title: '任务 2' }] },
        { title: '推广方案' },
      ],
    })
    assert.equal(result.ok, true)
    assert.equal(result.createdCount, 5)
    assert.equal(result.revision, 1)
    assert.equal(typeof result.goalNodeId, 'string')
    assert.deepEqual(result.strategies.map(entry => entry.taskNodeIds.length), [2, 0])

    const doc = store.snapshot().doc
    assert.equal(doc.nodes.length, 5)
    const goal = doc.nodes.find(node => node.id === result.goalNodeId)
    assert.equal(goal.title, '发布 v1')
    assert.equal(goal.workspaceId, 'w1')
    assert.equal(doc.nodes.filter(node => node.parentId === goal.id).length, 2)
  })
})

test('map_create_nodes resolves the workspace from the session directory', async () => {
  await withTools(async ({ invoke, store }) => {
    const result = await invoke('map_create_nodes', {
      nodes: [{ ref: 'a', title: 'alpha node', children: [{ title: 'alpha child' }] }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.created.length, 2)
    assert.equal(store.snapshot().doc.nodes.every(node => node.workspaceId === 'w1'), true)
  })
})

test('a missing workspace is a model-readable failure, not an exception', async () => {
  await withTools(async ({ invoke }) => {
    const result = await invoke('map_create_nodes', { nodes: [{ title: 'orphan' }] }, execIn('/tmp/unknown'))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'WORKSPACE_REQUIRED')
  })
})

test('map_get_state reports workspace counts and then the tree', async () => {
  await withTools(async ({ invoke }) => {
    await invoke('map_create_nodes', { nodes: [{ title: 'root node' }] })
    const summary = await invoke('map_get_state', {})
    assert.equal(summary.ok, true)
    assert.equal(summary.workspaces[0].workspace_id, 'w1')
    assert.equal(summary.workspaces[0].title, 'alpha')
    assert.equal(summary.workspaces[0].node_count, 1)

    const tree = await invoke('map_get_state', { workspace_id: 'w1' })
    assert.equal(tree.nodes.length, 1)
    assert.equal(tree.nodes[0].title, 'root node')
    assert.equal(tree.truncated, false)
  })
})

test('map_update_nodes and map_delete_nodes validate their input and act atomically', async () => {
  await withTools(async ({ invoke, store }) => {
    const created = await invoke('map_create_nodes', { nodes: [{ title: 'to rename' }] })
    const nodeId = created.created[0].node_id

    const missingConfirm = await invoke('map_delete_nodes', { node_ids: [nodeId], mode: 'leaf' })
    assert.equal(missingConfirm.ok, false)
    assert.equal(missingConfirm.code, 'INVALID_ARGS')

    const renamed = await invoke('map_update_nodes', { updates: [{ node_id: nodeId, title: 'renamed' }] })
    assert.equal(renamed.ok, true)
    assert.equal(store.snapshot().doc.nodes[0].title, 'renamed')

    const notFound = await invoke('map_update_nodes', { updates: [{ node_id: 'missing', title: 'x' }] })
    assert.equal(notFound.ok, false)
    assert.equal(notFound.code, 'NOT_FOUND')

    const deleted = await invoke('map_delete_nodes', { node_ids: [nodeId], mode: 'leaf', confirm: true })
    assert.equal(deleted.ok, true)
    assert.equal(store.snapshot().doc.nodes.length, 0)
  })
})

test('map_move_nodes re-parents inside the workspace model rules', async () => {
  await withTools(async ({ invoke, store }) => {
    const first = await invoke('map_create_nodes', { nodes: [{ title: 'parent' }] })
    const parentId = first.created[0].node_id
    const second = await invoke('map_create_nodes', { parent_id: parentId, nodes: [{ title: 'child' }] })
    const childId = second.created[0].node_id

    const cycle = await invoke('map_move_nodes', { moves: [{ node_id: parentId, parent_id: childId }] })
    assert.equal(cycle.ok, false)
    assert.equal(cycle.code, 'CYCLE')

    const root = await invoke('map_move_nodes', { moves: [{ node_id: childId }] })
    assert.equal(root.ok, true)
    assert.equal(store.snapshot().doc.nodes.find(node => node.id === childId).parentId, null)
  })
})

test('map_move_nodes places a node before a sibling through before_node_id', async () => {
  await withTools(async ({ invoke, store }) => {
    const created = await invoke('map_create_nodes', { nodes: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })
    const ids = created.created.map(node => node.node_id)

    const inserted = await invoke('map_move_nodes', { moves: [{ node_id: ids[2], before_node_id: ids[0] }] })
    assert.equal(inserted.ok, true)
    const order = store.snapshot().doc.nodes
      .filter(node => node.parentId === null)
      .sort((left, right) => left.position - right.position)
      .map(node => node.id)
    assert.deepEqual(order, [ids[2], ids[0], ids[1]], 'C now leads, A and B follow')
    assert.deepEqual(
      store.snapshot().doc.nodes.filter(node => node.parentId === null).map(node => node.position).sort((a, b) => a - b),
      [1, 2, 3],
    )

    const missingAnchor = await invoke('map_move_nodes', { moves: [{ node_id: ids[0], before_node_id: 'ghost' }] })
    assert.equal(missingAnchor.ok, false)
    assert.equal(missingAnchor.code, 'ANCHOR')
  })
})

test('map_attach_sessions files a conversation under a node', async () => {
  await withTools(async ({ invoke, store }) => {
    const created = await invoke('map_create_nodes', { nodes: [{ title: 'goal node' }] })
    const nodeId = created.created[0].node_id
    const result = await invoke('map_attach_sessions', { node_id: nodeId, session_ids: ['session-9'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.attached, ['session-9'])
    const thread = store.snapshot().doc.threads.find(candidate => candidate.sessionId === 'session-9')
    assert.equal(thread.nodeId, nodeId)
    assert.equal(thread.workspaceId, 'w1')
  })
})

test('map_attach_sessions refuses a recorded subagent child through the tool path', async () => {
  await withTools(async ({ invoke, store }) => {
    // Seed the document the way a client sync would leave it: the child was
    // recorded in the ledger and never indexed, so no row carries its origin.
    await store.apply(doc => ({
      doc: {
        ...ensureDefaultSpace(doc),
        nodes: [{ id: 'n1', parentId: null, title: 'goal', description: '', position: 1, updatedAt: '', workspaceId: 'w1' }],
        threads: [],
        subagentSessionIds: ['child-1'],
      },
      value: undefined,
    }), 'test')
    assert.equal(store.snapshot().doc.threads.length, 0, 'the child holds no row to inspect')

    const result = await invoke('map_attach_sessions', { node_id: 'n1', session_ids: ['child-1'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.attached, [], 'nothing is filed')
    assert.deepEqual(result.rejected.map(entry => [entry.session_id, entry.code]), [['child-1', 'SUBAGENT']])
    assert.equal(
      store.snapshot().doc.threads.some(thread => thread.sessionId === 'child-1'),
      false,
      'a refused id is not adopted either',
    )
  })
})

test('map_move_session validates its arguments before touching the store', async () => {
  await withTools(async ({ invoke, store }) => {
    const before = store.snapshot()

    const noSessions = await invoke('map_move_session', { session_ids: [] })
    assert.equal(noSessions.ok, false)
    assert.equal(noSessions.code, 'INVALID_ARGS')

    const missing = await invoke('map_move_session', {})
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'INVALID_ARGS')

    const badNode = await invoke('map_move_session', { session_ids: ['session-9'], node_id: 7 })
    assert.equal(badNode.ok, false)
    assert.equal(badNode.code, 'INVALID_ARGS')

    assert.equal(store.snapshot().revision, before.revision, 'a rejected call never writes the document')
    assert.deepEqual(store.snapshot().doc, before.doc)
  })
})

test('map_move_session moves a filed conversation to the workspace row and back', async () => {
  await withTools(async ({ invoke, store }) => {
    const created = await invoke('map_create_nodes', { nodes: [{ title: 'goal node' }] })
    const nodeId = created.created[0].node_id
    await invoke('map_attach_sessions', { node_id: nodeId, session_ids: ['session-9'] })
    const stamped = store.snapshot().doc.threads.find(thread => thread.sessionId === 'session-9').updatedAt

    // node_id omitted = the workspace row.
    const toRow = await invoke('map_move_session', { session_ids: ['session-9'] })
    assert.equal(toRow.ok, true)
    assert.deepEqual(toRow.moved, ['session-9'])
    assert.deepEqual(toRow.rejected, [])
    let thread = store.snapshot().doc.threads.find(candidate => candidate.sessionId === 'session-9')
    assert.equal(thread.nodeId, null)
    assert.equal(thread.workspaceId, 'w1', 'only the map filing changes; the workspace does not')
    assert.equal(thread.updatedAt, stamped, 'the tool path never rewrites the activity stamp')

    // node_id: null is the same request, spelled out.
    const spelled = await invoke('map_move_session', { session_ids: ['session-9'], node_id: null })
    assert.equal(spelled.ok, true)
    assert.deepEqual(spelled.moved, ['session-9'])

    // And back under the topic: same stamp, still exactly one row.
    const back = await invoke('map_move_session', { session_ids: ['session-9'], node_id: nodeId })
    assert.equal(back.ok, true)
    thread = store.snapshot().doc.threads.find(candidate => candidate.sessionId === 'session-9')
    assert.equal(thread.nodeId, nodeId)
    assert.equal(thread.updatedAt, stamped)
    assert.equal(store.snapshot().doc.threads.length, 1, 'a move never adopts a new row')

    // An unknown id is reported, not silently dropped.
    const unknown = await invoke('map_move_session', { session_ids: ['ghost'], node_id: nodeId })
    assert.equal(unknown.ok, true)
    assert.deepEqual(unknown.moved, [])
    assert.deepEqual(unknown.rejected.map(entry => [entry.session_id, entry.code]), [['ghost', 'NO_THREAD']])
  })
})

test('the guidance prompt section is registered once orders before the workflow tools', async () => {
  await withTools(async ({ promptSections }) => {
    assert.equal(promptSections.length, 1)
    assert.equal(promptSections[0].name, 'conversation-map:guidance')
    assert.equal(promptSections[0].order, 2500)
    assert.equal(promptSections[0].text, MAP_GUIDANCE)
    assert.match(promptSections[0].text, /map_plan_goal/)
  })
})
