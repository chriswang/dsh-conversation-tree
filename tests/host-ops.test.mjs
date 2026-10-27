/**
 * Behavior tests for the pure node operations behind the map tools.
 *
 * The ops are state transitions over the shared model; these tests assert the
 * resulting tree shape, the atomicity of batches, and the model error vocabulary
 * the model reads.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  attachSessions, createNodes, deleteNodes, moveNodes, moveSessions, planGoal, updateNodes, viewState,
} from '../lib/host-ops.js'
import { adoptThread, childrenOf, createNode, createSpace, emptyMap, ensureDefaultSpace, setThreadSpace } from '../lib/model.js'

const WORKSPACE = 'ws-1'

/** Deterministic id factory shared by every case. */
function idFactory() {
  let sequence = 0
  return () => `id-${++sequence}`
}

/** A document with one root goal node in `WORKSPACE`. */
function seed() {
  const state = ensureDefaultSpace(emptyMap())
  const created = createNode(state, { parentId: null, workspaceId: WORKSPACE, title: 'goal', id: 'goal' })
  return created.state
}

test('createNodes builds a nested batch in one transition and echoes refs', () => {
  const doc = seed()
  const outcome = createNodes(doc, {
    workspaceId: WORKSPACE,
    parentId: null,
    nodes: [
      { ref: 'a', title: 'alpha', children: [{ title: 'alpha-1' }] },
      { ref: 'b', title: 'beta' },
    ],
  }, idFactory())

  assert.deepEqual(outcome.value.created.map(node => node.title), ['alpha', 'alpha-1', 'beta'])
  assert.deepEqual(outcome.value.created.map(node => node.ref), ['a', undefined, 'b'])
  assert.equal(outcome.doc.nodes.length, 4)
  const alpha = outcome.doc.nodes.find(node => node.title === 'alpha')
  const child = outcome.doc.nodes.find(node => node.title === 'alpha-1')
  assert.equal(child.parentId, alpha.id)
  assert.equal(alpha.workspaceId, WORKSPACE)
  assert.equal(child.workspaceId, WORKSPACE)
  // The input document is untouched (pure transition).
  assert.equal(doc.nodes.length, 1)
})

test('createNodes reports the model error codes for bad titles and ceilings', () => {
  const doc = seed()
  assert.throws(
    () => createNodes(doc, { workspaceId: WORKSPACE, parentId: null, nodes: [{ title: '   ' }] }, idFactory()),
    error => error.name === 'MapError' && error.code === 'TITLE_EMPTY',
  )
  assert.throws(
    () => createNodes(doc, { workspaceId: WORKSPACE, parentId: null, nodes: [{ title: 'x'.repeat(81) }] }, idFactory()),
    error => error.name === 'MapError' && error.code === 'TITLE_LONG',
  )
  const tooMany = Array.from({ length: 51 }, (_entry, index) => ({ title: `node ${index}` }))
  assert.throws(
    () => createNodes(doc, { workspaceId: WORKSPACE, parentId: null, nodes: tooMany }, idFactory()),
    error => error.name === 'MapToolError' && error.code === 'TOO_MANY_NODES',
  )
  assert.equal(doc.nodes.length, 1)
})

test('planGoal creates goal → strategies → tasks in one pass', () => {
  const doc = seed()
  const outcome = planGoal(doc, {
    workspaceId: WORKSPACE,
    goal: { title: '发布 v1', description: 'ship it' },
    strategies: [
      { title: '技术方案', tasks: [{ title: '任务 1' }, { title: '任务 2' }] },
      { title: '推广方案' },
    ],
  }, idFactory())

  assert.equal(outcome.value.createdCount, 1 + 2 + 2)
  assert.deepEqual(outcome.value.strategies.map(strategy => strategy.taskNodeIds.length), [2, 0])
  const goal = outcome.doc.nodes.find(node => node.id === outcome.value.goalNodeId)
  assert.equal(goal.parentId, null)
  assert.equal(goal.workspaceId, WORKSPACE)
  for (const strategy of outcome.value.strategies) {
    const strategyNode = outcome.doc.nodes.find(node => node.id === strategy.nodeId)
    assert.equal(strategyNode.parentId, goal.id)
    for (const taskId of strategy.taskNodeIds) {
      assert.equal(outcome.doc.nodes.find(node => node.id === taskId).parentId, strategy.nodeId)
    }
  }
})

test('updateNodes is atomic and refuses unknown ids', () => {
  const doc = seed()
  const updated = updateNodes(doc, { updates: [{ nodeId: 'goal', title: 'renamed', description: 'desc' }] })
  assert.equal(updated.doc.nodes[0].title, 'renamed')
  assert.equal(updated.doc.nodes[0].description, 'desc')
  assert.throws(
    () => updateNodes(doc, { updates: [{ nodeId: 'goal', title: 'ok' }, { nodeId: 'missing', title: 'nope' }] }),
    error => error.name === 'MapToolError' && error.code === 'NOT_FOUND',
  )
  assert.equal(doc.nodes[0].title, 'goal')
})

test('moveNodes re-parents inside the workspace and rejects cycles', () => {
  const doc = seed()
  const child = createNode(doc, { parentId: 'goal', title: 'child' })
  const state = child.state
  const moved = moveNodes(state, { moves: [{ nodeId: child.id, parentId: null }] })
  assert.equal(moved.doc.nodes.find(node => node.id === child.id).parentId, null)
  assert.throws(
    () => moveNodes(state, { moves: [{ nodeId: 'goal', parentId: child.id }] }),
    error => error.name === 'MapError' && error.code === 'CYCLE',
  )
})

test('moveNodes inserts before a sibling, appends by default, and skips unchanged slots', () => {
  let state = seed()
  for (const id of ['A', 'B', 'C']) state = createNode(state, { parentId: 'goal', title: id, id }).state

  const inserted = moveNodes(state, { moves: [{ nodeId: 'C', parentId: 'goal', beforeNodeId: 'A' }] })
  assert.deepEqual(childrenOf(inserted.doc, 'goal').map(node => node.id), ['C', 'A', 'B'])
  assert.deepEqual(childrenOf(inserted.doc, 'goal').map(node => node.position), [1, 2, 3])

  // The old call shape still appends.
  const appended = moveNodes(state, { moves: [{ nodeId: 'A', parentId: 'goal' }] })
  assert.deepEqual(childrenOf(appended.doc, 'goal').map(node => node.id), ['B', 'C', 'A'])

  // An anchor that is not a child of the target parent is refused, never appended.
  assert.throws(
    () => moveNodes(state, { moves: [{ nodeId: 'C', parentId: 'goal', beforeNodeId: 'ghost' }] }),
    error => error.name === 'MapError' && error.code === 'ANCHOR',
  )

  // Dropping a node on the slot it already occupies writes nothing at all.
  const unchanged = moveNodes(state, { moves: [{ nodeId: 'B', parentId: 'goal', beforeNodeId: 'C' }] })
  assert.equal(unchanged.doc, state)
  assert.equal(unchanged.doc.revision, state.revision)
})

test('deleteNodes deletes leaves, refuses parents in leaf mode, and expands subtrees', () => {
  const doc = seed()
  const child = createNode(doc, { parentId: 'goal', title: 'child' })
  const grandchild = createNode(child.state, { parentId: child.id, title: 'grandchild' })
  const state = grandchild.state

  assert.throws(
    () => deleteNodes(state, { nodeIds: ['goal'], mode: 'leaf' }),
    error => error.name === 'MapError' && error.code === 'HAS_CHILDREN',
  )
  const leaf = deleteNodes(state, { nodeIds: [grandchild.id], mode: 'leaf' })
  assert.deepEqual(leaf.value.deleted, [grandchild.id])
  assert.equal(leaf.doc.nodes.length, 2)

  const subtree = deleteNodes(state, { nodeIds: ['goal'], mode: 'subtree' })
  assert.deepEqual(subtree.value.deleted, [grandchild.id, child.id, 'goal'])
  assert.equal(subtree.doc.nodes.length, 0)
})

test('deleteNodes unassigns conversations filed under a deleted node', () => {
  const doc = seed()
  const child = createNode(doc, { parentId: 'goal', title: 'child' })
  const filed = adoptThread(child.state, { sessionId: 's-1', title: 'talk', nodeId: child.id, workspaceId: WORKSPACE })
  const outcome = deleteNodes(filed, { nodeIds: [child.id], mode: 'subtree' })
  assert.equal(outcome.doc.threads[0].nodeId, null)
})

test('attachSessions files sessions under a node and rejects foreign workspaces', () => {
  const doc = seed()
  const other = adoptThread(doc, { sessionId: 's-other', title: 'foreign', nodeId: null, workspaceId: 'ws-other' })
  const outcome = attachSessions(other, { nodeId: 'goal', sessionIds: ['s-new', 's-other'] })
  assert.deepEqual(outcome.value.attached, ['s-new'])
  assert.deepEqual(outcome.value.rejected.map(entry => entry.sessionId), ['s-other'])
  const adopted = outcome.doc.threads.find(thread => thread.sessionId === 's-new')
  assert.equal(adopted.nodeId, 'goal')
  assert.equal(adopted.workspaceId, WORKSPACE)
})

test('attachSessions refuses a subagent conversation, leaving the document unchanged', () => {
  const doc = seed()
  // A subagent row reaches the document only through a legacy/hand-built one,
  // so both signals are exercised: the recorded ledger and a stored row origin.
  const ledger = { ...doc, subagentSessionIds: ['s-recorded'] }
  const withRow = adoptThread(
    { ...doc, threads: [{ sessionId: 's-child', nodeId: null, title: 'child', updatedAt: '', importedAt: '', origin: 'subagent' }] },
    { sessionId: 's-child', title: 'child', nodeId: null, workspaceId: WORKSPACE },
  )
  const fromLedger = attachSessions(ledger, { nodeId: 'goal', sessionIds: ['s-recorded', 's-ok'] })
  assert.deepEqual(fromLedger.value.attached, ['s-ok'])
  assert.deepEqual(fromLedger.value.rejected.map(entry => [entry.sessionId, entry.code]), [['s-recorded', 'SUBAGENT']])
  assert.equal(fromLedger.doc.threads.some(thread => thread.sessionId === 's-recorded'), false, 'a refused id is never adopted')

  const fromRow = attachSessions(withRow, { nodeId: 'goal', sessionIds: ['s-child'] })
  assert.deepEqual(fromRow.value.attached, [])
  assert.deepEqual(fromRow.value.rejected.map(entry => entry.code), ['SUBAGENT'])
  assert.equal(fromRow.doc.nodes.length, withRow.nodes.length)
})

test('attachSessions re-files an indexed row without refreshing its activity stamp', () => {
  const doc = seed()
  const other = createNode(doc, { parentId: null, workspaceId: WORKSPACE, title: 'other', id: 'other' })
  const filed = adoptThread(other.state, { sessionId: 's-1', title: 'talk', nodeId: 'goal', workspaceId: WORKSPACE })
  // A fixed stamp makes "did the second attach rewrite it?" an exact assertion.
  const stamped = {
    ...filed,
    threads: filed.threads.map(thread => ({ ...thread, updatedAt: '2020-01-01T00:00:00.000Z' })),
  }

  const outcome = attachSessions(stamped, { nodeId: 'other', sessionIds: ['s-1'] })
  assert.deepEqual(outcome.value.attached, ['s-1'])
  const thread = outcome.doc.threads.find(candidate => candidate.sessionId === 's-1')
  assert.equal(thread.nodeId, 'other', 'an indexed row is moved, not adopted again')
  assert.equal(thread.updatedAt, '2020-01-01T00:00:00.000Z', 're-filing must not rewrite the activity stamp')
  assert.equal(thread.workspaceId, WORKSPACE)
})

test('moveSessions re-files a row between topics and back to the workspace row', () => {
  const doc = seed()
  const child = createNode(doc, { parentId: 'goal', title: 'child', id: 'child' })
  const filed = adoptThread(child.state, { sessionId: 's-1', title: 'talk', nodeId: 'goal', workspaceId: WORKSPACE })
  const stamp = filed.threads[0].updatedAt

  const under = moveSessions(filed, { nodeId: child.id, sessionIds: ['s-1'] })
  assert.deepEqual(under.value.moved, ['s-1'])
  assert.deepEqual(under.value.rejected, [])
  assert.equal(under.doc.threads[0].nodeId, child.id)

  const back = moveSessions(under.doc, { nodeId: null, sessionIds: ['s-1'] })
  assert.deepEqual(back.value.moved, ['s-1'])
  assert.equal(back.doc.threads[0].nodeId, null, 'null = the workspace row')
  assert.equal(back.doc.threads[0].workspaceId, WORKSPACE, 'moving never changes the workspace')
  assert.equal(back.doc.threads[0].updatedAt, stamp, 'no hop rewrites the activity stamp')
})

test('moveSessions rejects unknown, foreign, ungrouped and subagent conversations per id', () => {
  const doc = seed()
  const loose = createNode(doc, { parentId: null, title: 'loose topic', id: 'loose' })
  let state = loose.state
  state = adoptThread(state, { sessionId: 's-loose', title: 'loose', nodeId: 'loose', workspaceId: null })
  state = adoptThread(state, { sessionId: 's-foreign', title: 'foreign', nodeId: null, workspaceId: 'ws-other' })
  state = adoptThread(state, { sessionId: 's-child', title: 'child', nodeId: null, workspaceId: WORKSPACE })
  // Two subagent signals: the ledger (no row at all) and a stored row origin.
  state = {
    ...state,
    subagentSessionIds: ['s-ledger'],
    threads: state.threads.map(thread => thread.sessionId === 's-child' ? { ...thread, origin: 'subagent' } : thread),
  }

  const outcome = moveSessions(state, {
    nodeId: 'goal',
    sessionIds: ['s-ghost', 's-foreign', 's-loose', 's-ledger', 's-child'],
  })
  assert.deepEqual(outcome.value.moved, [])
  assert.deepEqual(
    outcome.value.rejected.map(entry => [entry.sessionId, entry.code]),
    [
      ['s-ghost', 'NO_THREAD'],
      ['s-foreign', 'WORKSPACE'],
      ['s-loose', 'WORKSPACE'],
      ['s-ledger', 'SUBAGENT'],
      ['s-child', 'SUBAGENT'],
    ],
  )
  assert.equal(outcome.doc.threads.length, state.threads.length, 'a move never adopts a new row')
})

test('moveSessions refuses to file a loose conversation into another space topic', () => {
  const doc = seed()
  const family = createSpace(doc, { title: '家庭空间', id: 'sp-2' })
  const loose = createNode(family.state, { parentId: null, title: 'loose topic', id: 'loose' })
  const filed = adoptThread(loose.state, { sessionId: 's-loose', title: 'loose', nodeId: null, workspaceId: null })
  const spaced = setThreadSpace(filed, 's-loose', family.id)

  const outcome = moveSessions(spaced, { nodeId: 'loose', sessionIds: ['s-loose'] })
  assert.deepEqual(outcome.value.moved, [])
  assert.deepEqual(outcome.value.rejected.map(entry => entry.code), ['SPACE'])
  assert.equal(outcome.doc.threads[0].nodeId, null)
})

test('viewState projects a bounded subtree and workspace-level counts', () => {
  const doc = seed()
  const child = createNode(doc, { parentId: 'goal', title: 'child' })
  const grandchild = createNode(child.state, { parentId: child.id, title: 'grandchild' })
  const state = grandchild.state

  const subtree = viewState(state, { nodeId: 'goal', depth: 2 }).value
  assert.equal(subtree.nodes.length, 1)
  assert.equal(subtree.nodes[0].childCount, 1)
  assert.equal(subtree.nodes[0].children[0].title, 'child')
  assert.equal(subtree.nodes[0].children[0].childCount, 1)
  // Depth 2 stops before the grandchild.
  assert.equal(subtree.nodes[0].children[0].children, undefined)
  assert.equal(subtree.truncated, true)

  const summary = viewState(state, { depth: 1 }).value
  assert.deepEqual(summary.workspaces, [{ workspaceId: WORKSPACE, nodeCount: 3, threadCount: 0 }])

  const workspaceView = viewState(state, { workspaceId: WORKSPACE, depth: 1 }).value
  assert.equal(workspaceView.nodes.length, 1)
  assert.equal(workspaceView.nodes[0].id, 'goal')
})
