/**
 * Behavior tests for the drag core (`src/client/row-drag.ts`).
 *
 * The module is pure — no React, no DOM, no store — so these exercise the real
 * shipped source through the neutral `lib/` build, the same way the model tests
 * do. Every case states the pointer situation and the decision the panel will
 * show: refusal code and wording, no-op, plan, and the follow-the-pointer label.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  assignThreads, childrenOf, createNode, emptyMap, insertNodeBefore, syncThreads, threadsOf,
} from '../lib/model.js'
import { DRAG_THRESHOLD_PX, decideDrop, exceedsDragThreshold } from '../lib/row-drag.js'

/** A topic row under the pointer. */
function nodeRow(nodeId, workspaceId = 'w1') {
  return { kind: 'node', nodeId, workspaceId }
}

/** A Workspace (L1) row under the pointer. */
function workspaceRow(workspaceId = 'w1') {
  return { kind: 'workspace', workspaceId }
}

/** The pointer is not over any droppable row. */
const NO_ROW = { kind: 'none' }

/** The pointer is over the middle of a row. */
function into(row) {
  return { row, edge: 'into' }
}

/** The pointer is on a row's top or bottom edge. */
function edgeOf(row, edge) {
  return { row, edge }
}

/**
 * w1: 外贸探索(a) > 获客方式(a1) > 深一层(a1x), a > 转化路径(a2), 渠道复盘(a3);
 *     产品设计(b). w2: 另一块(c). Ungrouped bucket: 未分组主题(u1).
 * Conversations: s1 under a, s2 under w2's root, s3 unaccounted, `sub` a subagent.
 */
function seed() {
  let state = emptyMap()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '外贸探索', id: 'a' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '产品设计', id: 'b' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w2', title: '另一块', id: 'c' }).state
  state = createNode(state, { parentId: null, workspaceId: null, title: '未分组主题', id: 'u1' }).state
  state = createNode(state, { parentId: 'a', workspaceId: 'w1', title: '获客方式', id: 'a1' }).state
  state = createNode(state, { parentId: 'a', workspaceId: 'w1', title: '转化路径', id: 'a2' }).state
  state = createNode(state, { parentId: 'a', workspaceId: 'w1', title: '渠道复盘', id: 'a3' }).state
  state = createNode(state, { parentId: 'a1', workspaceId: 'w1', title: '深一层', id: 'a1x' }).state
  state = syncThreads(state, [
    { id: 's1', displayTitle: '会话一' },
    { id: 's2', displayTitle: '会话二' },
    { id: 's3', displayTitle: '未对账' },
    { id: 'sub', displayTitle: '子会话', origin: 'subagent' },
  ], null, new Map([['s1', 'w1'], ['s2', 'w2'], ['sub', 'w1']]))
  return assignThreads(state, ['s1'], 'a')
}

/** A Workspace filled to the depth ceiling: d1 → … → d12, plus a loose leaf. */
function deep() {
  let state = emptyMap()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '第 1 层', id: 'd1' }).state
  for (let level = 2; level <= 12; level += 1) {
    state = createNode(state, {
      parentId: `d${String(level - 1)}`, workspaceId: 'w1', title: `第 ${String(level)} 层`, id: `d${String(level)}`,
    }).state
  }
  return createNode(state, { parentId: null, workspaceId: 'w1', title: '待移动', id: 'leaf' }).state
}

test('a press becomes a drag only past the threshold', () => {
  const from = { x: 100, y: 100 }
  assert.equal(DRAG_THRESHOLD_PX, 4)
  assert.equal(exceedsDragThreshold(from, from), false, 'a still pointer is a click')
  assert.equal(exceedsDragThreshold(from, { x: 103, y: 100 }), false, '3px across is still a click')
  assert.equal(exceedsDragThreshold(from, { x: 100, y: 97 }), false, '3px along is still a click')
  assert.equal(exceedsDragThreshold(from, { x: 104, y: 100 }), true, '4px across is a drag')
  assert.equal(exceedsDragThreshold(from, { x: 105, y: 100 }), true, '5px across is a drag')
  assert.equal(exceedsDragThreshold(from, { x: 96, y: 100 }), true, 'the direction does not matter')
  assert.equal(exceedsDragThreshold(from, { x: 103, y: 104 }), true, 'a diagonal measures the same')
})

test('a conversation drops under a topic of its own Workspace', () => {
  const decision = decideDrop(seed(), { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.deepEqual(decision.action, { kind: 'thread', sessionId: 's1', nodeId: 'a1' })
  assert.equal(decision.issue, null)
  assert.equal(decision.noop, false)
  assert.equal(decision.label, '移到「获客方式」下')
})

test('a conversation drops back under its Workspace row', () => {
  const decision = decideDrop(seed(), { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(workspaceRow('w1')))
  assert.deepEqual(decision.action, { kind: 'thread', sessionId: 's1', nodeId: null })
  assert.equal(decision.issue, null)
  assert.equal(decision.label, '移到工作区下')
})

test('a conversation already filed there reports no change', () => {
  const state = seed()
  const sameNode = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('a')))
  assert.equal(sameNode.noop, true)
  assert.equal(sameNode.action, null, 'a no-op hands the store nothing to commit')
  assert.equal(sameNode.issue, null)
  assert.equal(sameNode.label, '位置不变')

  const sameRow = decideDrop(state, { kind: 'session', sessionId: 's2', workspaceId: 'w2' }, into(workspaceRow('w2')))
  assert.equal(sameRow.noop, true)
  assert.equal(sameRow.action, null)
})

test('a conversation never crosses Workspaces, not even onto an L1 row', () => {
  const state = seed()
  const foreignNode = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('c', 'w2')))
  assert.equal(foreignNode.issue.code, 'WORKSPACE')
  assert.equal(foreignNode.action, null)
  assert.equal(foreignNode.noop, false)
  assert.equal(foreignNode.label, '不能移到别的工作区')

  const foreignRow = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(workspaceRow('w2')))
  assert.equal(foreignRow.issue.code, 'WORKSPACE')
  assert.equal(foreignRow.label, '不能移到别的工作区')
})

test('a subagent conversation is refused', () => {
  const decision = decideDrop(seed(), { kind: 'session', sessionId: 'sub', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.equal(decision.issue.code, 'SUBAGENT')
  assert.equal(decision.action, null)
  assert.equal(decision.label, '子智能体会话不能移动')
})

test('the ungrouped bucket takes part in no drag', () => {
  const state = seed()
  const loose = decideDrop(state, { kind: 'session', sessionId: 's3', workspaceId: null }, into(nodeRow('a1')))
  assert.equal(loose.issue.code, 'UNGROUPED')
  assert.equal(loose.label, '未分组不参与拖动')

  // The document outranks the payload: a row the Host has not accounted for yet
  // does not drag even when the caller claims a Workspace.
  const stale = decideDrop(state, { kind: 'session', sessionId: 's3', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.equal(stale.issue.code, 'UNGROUPED')
  assert.equal(stale.label, '未分组不参与拖动')

  const looseTarget = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('u1', null)))
  assert.equal(looseTarget.issue.code, 'UNGROUPED')
})

test('a conversation ignores an edge and says so', () => {
  const state = seed()
  const before = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, edgeOf(nodeRow('a1'), 'before'))
  assert.deepEqual(before.action, { kind: 'thread', sessionId: 's1', nodeId: 'a1' })
  assert.equal(before.label, '移到「获客方式」下（对话不排序）')

  const after = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, edgeOf(workspaceRow('w1'), 'after'))
  assert.deepEqual(after.action, { kind: 'thread', sessionId: 's1', nodeId: null })
  assert.equal(after.label, '移到工作区下（对话不排序）')
})

test('a release over no row, a vanished row, or a vanished conversation is refused', () => {
  const state = seed()
  const nowhere = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(NO_ROW))
  assert.equal(nowhere.issue.code, 'NONE')
  assert.equal(nowhere.label, '不能放在这里')

  const goneTarget = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('ghost')))
  assert.equal(goneTarget.issue.code, 'NOT_FOUND')
  assert.equal(goneTarget.label, '目标节点已不存在')

  const goneSession = decideDrop(state, { kind: 'session', sessionId: 'ghost', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.equal(goneSession.issue.code, 'NO_THREAD')
  assert.equal(goneSession.label, '对话已不存在')

  const goneNode = decideDrop(state, { kind: 'node', nodeId: 'ghost', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.equal(goneNode.issue.code, 'NOT_FOUND')
  assert.equal(goneNode.label, '目标节点已不存在')
})

test('a topic drops under another topic', () => {
  const decision = decideDrop(seed(), { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, into(nodeRow('b')))
  assert.deepEqual(decision.action, { kind: 'node', nodeId: 'a1', parentId: 'b', beforeNodeId: null })
  assert.equal(decision.issue, null)
  assert.equal(decision.noop, false)
  assert.equal(decision.label, '移到「产品设计」下')
})

test('a topic drops to the top of its own Workspace', () => {
  const decision = decideDrop(seed(), { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, into(workspaceRow('w1')))
  assert.deepEqual(decision.action, { kind: 'node', nodeId: 'a1', parentId: null, beforeNodeId: null })
  assert.equal(decision.label, '移到工作区下')
})

test('a topic slots in before or after a sibling', () => {
  const state = seed()
  const before = decideDrop(state, { kind: 'node', nodeId: 'a3', workspaceId: 'w1' }, edgeOf(nodeRow('a1'), 'before'))
  assert.deepEqual(before.action, { kind: 'node', nodeId: 'a3', parentId: 'a', beforeNodeId: 'a1' })
  assert.equal(before.label, '插到「获客方式」之前')

  const after = decideDrop(state, { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, edgeOf(nodeRow('a2'), 'after'))
  assert.deepEqual(after.action, { kind: 'node', nodeId: 'a1', parentId: 'a', beforeNodeId: 'a3' })
  assert.equal(after.label, '插到「转化路径」之后')
})

test('after the last sibling appends', () => {
  const decision = decideDrop(seed(), { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, edgeOf(nodeRow('a3'), 'after'))
  assert.deepEqual(decision.action, { kind: 'node', nodeId: 'a1', parentId: 'a', beforeNodeId: null })
  assert.equal(decision.label, '插到「渠道复盘」之后')
})

test('a topic dropped where it already is reports no change', () => {
  const state = seed()
  const alreadyFirst = decideDrop(state, { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, edgeOf(nodeRow('a2'), 'before'))
  assert.equal(alreadyFirst.noop, true)
  assert.equal(alreadyFirst.action, null)
  assert.equal(alreadyFirst.issue, null)
  assert.equal(alreadyFirst.label, '位置不变')

  const alreadyLast = decideDrop(state, { kind: 'node', nodeId: 'a3', workspaceId: 'w1' }, into(nodeRow('a')))
  assert.equal(alreadyLast.noop, true, 'the last child dropped into its own parent stays put')

  const alreadyAfter = decideDrop(state, { kind: 'node', nodeId: 'a2', workspaceId: 'w1' }, edgeOf(nodeRow('a1'), 'after'))
  assert.equal(alreadyAfter.noop, true, 'right after the sibling it follows')
})

test('dropping a non-last topic into its own parent is a real move, not a no-op', () => {
  const decision = decideDrop(seed(), { kind: 'node', nodeId: 'a1', workspaceId: 'w1' }, into(nodeRow('a')))
  assert.equal(decision.noop, false, 'the model would append it, which is a change')
  assert.deepEqual(decision.action, { kind: 'node', nodeId: 'a1', parentId: 'a', beforeNodeId: null })
})

test('a no-op decision is exactly a document the model would not write', () => {
  const state = seed()
  const decision = decideDrop(state, { kind: 'node', nodeId: 'a3', workspaceId: 'w1' }, into(nodeRow('a')))
  assert.equal(decision.noop, true)
  assert.equal(insertNodeBefore(state, 'a3', 'a', undefined), state, 'the model hands the same document back')
})

test('a topic cannot land on itself or inside its own subtree', () => {
  const state = seed()
  const self = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, into(nodeRow('a')))
  assert.equal(self.issue.code, 'CYCLE')
  assert.equal(self.label, '不能移到自己的子节点下')
  assert.equal(self.action, null)

  const descendant = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, into(nodeRow('a1x')))
  assert.equal(descendant.issue.code, 'CYCLE')

  const besideDescendant = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, edgeOf(nodeRow('a1x'), 'before'))
  assert.equal(besideDescendant.issue.code, 'CYCLE', 'a sibling slot inside the subtree is the same refusal')
})

test('a topic that would break the depth ceiling is refused', () => {
  const state = deep()
  const tooDeep = decideDrop(state, { kind: 'node', nodeId: 'leaf', workspaceId: 'w1' }, into(nodeRow('d12')))
  assert.equal(tooDeep.issue.code, 'DEPTH')
  assert.equal(tooDeep.action, null)
  assert.equal(tooDeep.label, '超过 12 层')

  const fits = decideDrop(state, { kind: 'node', nodeId: 'leaf', workspaceId: 'w1' }, into(nodeRow('d11')))
  assert.equal(fits.issue, null)
  assert.equal(fits.action.parentId, 'd11')
})

test('a topic never crosses Workspaces, not even onto an L1 row', () => {
  const state = seed()
  const foreignNode = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, into(nodeRow('c', 'w2')))
  assert.equal(foreignNode.issue.code, 'WORKSPACE')
  assert.equal(foreignNode.label, '不能移到别的工作区')
  assert.equal(foreignNode.action, null)

  const foreignRow = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, into(workspaceRow('w2')))
  assert.equal(foreignRow.issue.code, 'WORKSPACE')
  assert.equal(foreignRow.label, '不能移到别的工作区')
})

test('an ungrouped topic neither drags nor takes a drop', () => {
  const state = seed()
  const loose = decideDrop(state, { kind: 'node', nodeId: 'u1', workspaceId: null }, into(nodeRow('a')))
  assert.equal(loose.issue.code, 'UNGROUPED')
  assert.equal(loose.label, '未分组不参与拖动')

  const ontoLoose = decideDrop(state, { kind: 'node', nodeId: 'a', workspaceId: 'w1' }, into(nodeRow('u1', null)))
  assert.equal(ontoLoose.issue.code, 'UNGROUPED')
  assert.equal(ontoLoose.label, '未分组不参与拖动')
})

test('the plan commits cleanly through the model', () => {
  let state = seed()
  const threadPlan = decideDrop(state, { kind: 'session', sessionId: 's1', workspaceId: 'w1' }, into(nodeRow('a1')))
  assert.notEqual(threadPlan.action, null)
  state = assignThreads(state, [threadPlan.action.sessionId], threadPlan.action.nodeId)
  assert.deepEqual(threadsOf(state, 'a1').map(thread => thread.sessionId), ['s1'])

  const nodePlan = decideDrop(state, { kind: 'node', nodeId: 'a3', workspaceId: 'w1' }, edgeOf(nodeRow('a1'), 'before'))
  assert.notEqual(nodePlan.action, null)
  state = insertNodeBefore(
    state,
    nodePlan.action.nodeId,
    nodePlan.action.parentId,
    nodePlan.action.beforeNodeId ?? undefined,
  )
  assert.deepEqual(childrenOf(state, 'a').map(node => node.id), ['a3', 'a1', 'a2'])
})
