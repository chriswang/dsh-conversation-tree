/**
 * Behavior tests for the conversation-map model and persistence.
 *
 * The model is pure, so these exercise the real shipped source through the
 * neutral `lib/` build rather than a re-implementation.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  DEFAULT_SPACE_TITLE, LOOSE_ROW_PREFIX, MAX_SPACES, MAX_DEPTH, MapError, UNGROUPED_ID, adoptThread, ancestorRowKeys,
  assignThreadIssue, assignThreads, breadcrumb, childrenOf, conversationVisible, createNode, createSpace, deleteNode, deleteSpace, descendantIds,
  directThreadsOf, emptyMap, ensureDefaultSpace, homeOfSession, indexableSessions, insertNodeBefore,
  isRecordedSubagent, isWorkspaceSelectionKey, looseRowKey, looseThreadsInSpace, moveNode, moveNodeIssue, nodePath, parseMapState,
  pathBaseName, pruneMissing, reconcileSpaces, reconcileWorkspaces, renameSpace, searchMap,
  selectionAfterNodeDeletion, selectionOfThread, setThreadSpace, setWorkspaceSpace, shortSessionId,
  spaceList, spaceOfThread, spaceOfWorkspace, syncThreads, threadMoveTargets, threadOfSession, threadsOf, topNodesOf,
  updateNode, visibleAncestorOf, workspaceDisplayTitle, workspaceKey, workspaceNodeId,
  workspaceOfNode, workspaceSelection, workspacesInSpace,
} from '../lib/model.js'
import { STORAGE_KEY, loadMap, saveMap } from '../lib/persistence.js'

/** One Workspace projection, as the Host reports it. */
function workspace(workspaceId, title, sessionIds = [], path = `/tmp/${title}`) {
  return { workspaceId, path, title, sessionIds }
}

/** A map with one topic per Workspace and a child under the first. */
function seed() {
  let state = emptyMap()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '外贸探索', id: 'a' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w2', title: '产品设计', id: 'b' }).state
  state = createNode(state, { parentId: 'a', workspaceId: 'w1', title: '获客方式', id: 'a1' }).state
  return state
}

test('a session created but never used is not indexed', () => {
  const rows = [
    { id: 's1', title: '用过的' },
    { id: 's2', title: '刚建的空会话', blank: true },
    { id: 's3', title: '另一个空会话', blank: true },
  ]
  const indexed = indexableSessions(rows, null)
  assert.deepEqual(indexed.map(row => row.id), ['s1'], 'blank sessions stay out of the index')
})

test('the open blank session is indexed so its provisional row can show', () => {
  const rows = [
    { id: 's1', title: '用过的' },
    { id: 's2', title: '刚建的空会话', blank: true },
  ]
  assert.deepEqual(indexableSessions(rows, 's2').map(row => row.id), ['s1', 's2'])
  assert.deepEqual(indexableSessions(rows, 's1').map(row => row.id), ['s1'], 'focus moving on drops it again')
})

test('a subagent conversation is never indexed, not even while it is open', () => {
  const rows = [
    { id: 'p', title: '父会话' },
    { id: 'c', title: '子智能体', origin: 'subagent', parentId: 'p' },
  ]
  assert.deepEqual(indexableSessions(rows, null).map(row => row.id), ['p'], 'the child is not a row of its own')
  assert.deepEqual(indexableSessions(rows, 'c').map(row => row.id), ['p'], 'the parent is the entry point')
  assert.equal(conversationVisible(rows[1], 'c'), false, 'being the open one does not make it a conversation')
  assert.equal(conversationVisible(rows[0], null), true)
})

test('the blank rule still decides every ordinary conversation', () => {
  const blank = { id: 'b', blank: true }
  assert.equal(conversationVisible(blank, null), false, 'an unused session stays out')
  assert.equal(conversationVisible(blank, 'b'), true, 'the open one may show its provisional row')
  assert.equal(conversationVisible({ id: 'used' }, null), true)
  assert.equal(conversationVisible({ id: 'used', blank: false }, null), true)
})

test('visibleAncestorOf walks up to the nearest ordinary conversation', () => {
  const byId = {
    p: { title: '父会话' },
    c: { origin: 'subagent', parentId: 'p' },
    c2: { origin: 'subagent', parentId: 'c' },
    c3: { origin: 'subagent', parentId: 'c2' },
  }
  assert.equal(visibleAncestorOf(byId, 'c'), 'p', 'one level up')
  assert.equal(visibleAncestorOf(byId, 'c2'), 'p', 'two levels up')
  assert.equal(visibleAncestorOf(byId, 'c3'), 'p', 'three levels up')
  assert.equal(visibleAncestorOf(byId, 'p'), 'p', 'an ordinary row is its own answer')
  assert.equal(visibleAncestorOf(byId, 'unknown'), 'unknown', 'an unknown session names itself')
})

test('a subagent without a usable parent pointer stops the walk', () => {
  assert.equal(visibleAncestorOf({ c: { origin: 'subagent' } }, 'c'), 'c', 'no parent at all')
  assert.equal(visibleAncestorOf({ c: { origin: 'subagent', parentId: null } }, 'c'), 'c', 'a null parent')
  assert.equal(visibleAncestorOf({ c: { origin: 'subagent', parentId: '' } }, 'c'), 'c', 'an empty parent')
  assert.equal(visibleAncestorOf({ c: { origin: 'subagent', parentId: 'gone' } }, 'c'), 'gone', 'the walk names the parent it cannot see')
})

test('a cyclic parent chain terminates instead of looping', () => {
  const byId = {
    a: { origin: 'subagent', parentId: 'b' },
    b: { origin: 'subagent', parentId: 'a' },
    self: { origin: 'subagent', parentId: 'self' },
  }
  assert.equal(visibleAncestorOf(byId, 'a'), 'a', 'a two-row loop ends on the row it started from')
  assert.equal(visibleAncestorOf(byId, 'b'), 'b')
  assert.equal(visibleAncestorOf(byId, 'self'), 'self', 'a self-parented row ends on itself')
})

test('syncing records a subagent child in the ledger instead of giving it a row', () => {
  const state = syncThreads(emptyMap(), [
    { id: 'child', displayTitle: '子智能体', origin: 'subagent', parentId: 'p' },
    { id: 'plain', displayTitle: '普通会话' },
  ])
  assert.deepEqual(state.threads.map(thread => thread.sessionId), ['plain'], 'the child never becomes a row')
  assert.deepEqual(state.subagentSessionIds, ['child'], 'the fact is kept where the Host half can read it')
  assert.equal(isRecordedSubagent(state, 'child'), true)
  assert.equal(isRecordedSubagent(state, 'plain'), false, 'an ordinary conversation is never recorded')

  const again = syncThreads(state, [
    { id: 'child', displayTitle: '子智能体', origin: 'subagent', parentId: 'p' },
    { id: 'plain', displayTitle: '普通会话' },
  ])
  assert.deepEqual(again.subagentSessionIds, ['child'], 'recording is idempotent, not cumulative')
})

test('the subagent ledger survives a reload', () => {
  const state = syncThreads(emptyMap(), [{ id: 'child', displayTitle: '子智能体', origin: 'subagent' }])
  const reloaded = parseMapState(JSON.stringify(state))
  assert.deepEqual(reloaded.subagentSessionIds, ['child'], 'the Host half reads it back from the document')
  assert.equal(isRecordedSubagent(reloaded, 'child'), true)
})

test('a subagent row that predates the rule is pruned once the catalog reports the origin', () => {
  // A stored subagent row can only come from a legacy or hand-built document.
  const stale = syncThreads(emptyMap(), [{ id: 'child', displayTitle: '子智能体' }])
  assert.deepEqual(stale.threads.map(thread => thread.sessionId), ['child'], 'the fixture really stores one')
  const rows = indexableSessions([
    { id: 'p', title: '父会话' },
    { id: 'child', title: '子智能体', origin: 'subagent', parentId: 'p' },
  ], null)
  const synced = syncThreads(stale, [
    { id: 'p', title: '父会话' },
    { id: 'child', title: '子智能体', origin: 'subagent', parentId: 'p' },
  ], null)
  const pruned = pruneMissing(synced, new Set(rows.map(row => row.id)))
  assert.deepEqual(pruned.threads.map(thread => thread.sessionId), ['p'], 'the stale row leaves')
  assert.equal(isRecordedSubagent(pruned, 'child'), true, 'and its id is still known')
})

test('a new map is empty and starts at revision zero', () => {
  const state = emptyMap()
  assert.equal(state.revision, 0)
  assert.equal(state.version, 2)
  assert.deepEqual(topNodesOf(state, 'w1'), [])
  assert.deepEqual(directThreadsOf(state, 'w1'), [])
})

test('a topic belongs to the Workspace it is created in, and children inherit it', () => {
  const state = seed()
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a')), 'w1')
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a1')), 'w1')
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'b')), 'w2')
  assert.deepEqual(topNodesOf(state, 'w1').map(node => node.id), ['a'])
  assert.deepEqual(topNodesOf(state, 'w2').map(node => node.id), ['b'])
  assert.deepEqual(childrenOf(state, 'a').map(node => node.id), ['a1'])
})

test('a child may not be created in another Workspace than its parent', () => {
  assert.throws(
    () => createNode(seed(), { parentId: 'a', workspaceId: 'w2', title: '错位' }),
    (error) => error instanceof MapError && error.code === 'WORKSPACE',
  )
})

test('nodePath returns the root-first path', () => {
  const state = seed()
  assert.deepEqual(nodePath(state, 'a1').map(node => node.title), ['外贸探索', '获客方式'])
  assert.deepEqual(nodePath(state, 'a').map(node => node.title), ['外贸探索'])
})

test('ancestorRowKeys lists the lineage above the selection, Workspace last', () => {
  const state = seed()
  assert.deepEqual(ancestorRowKeys(state, 'a1'), ['a', '@ws:w1'], 'the top-level topic then the owning Workspace row')
  assert.deepEqual(ancestorRowKeys(state, 'a'), ['@ws:w1'], 'a top-level topic sits directly in its Workspace')
  assert.deepEqual(ancestorRowKeys(state, 'gone'), [], 'an unknown id marks no row')
})

test('ancestorRowKeys ends a legacy rootless chain in the ungrouped bucket', () => {
  const root = createNode(emptyMap(), { parentId: null, workspaceId: null, title: '散落主题' })
  const child = createNode(root.state, { parentId: root.id, workspaceId: null, title: '散落子主题' })
  assert.deepEqual(ancestorRowKeys(child.state, child.id), [root.id, UNGROUPED_ID])
})

test('descendantIds covers the whole subtree', () => {
  const state = seed()
  assert.deepEqual([...descendantIds(state, 'a')].sort(), ['a', 'a1'])
})

test('a blank title is rejected', () => {
  const state = emptyMap()
  assert.throws(() => createNode(state, { parentId: null, workspaceId: 'w1', title: '   ' }), (error) => error instanceof MapError && error.code === 'TITLE_EMPTY')
})

test('nesting deeper than the limit is rejected', () => {
  let state = emptyMap()
  let parentId = null
  for (let level = 1; level <= MAX_DEPTH; level += 1) {
    const created = createNode(state, { parentId, workspaceId: 'w1', title: `L${level}` })
    state = created.state
    parentId = created.id
  }
  assert.throws(
    () => createNode(state, { parentId, workspaceId: 'w1', title: 'too deep' }),
    (error) => error instanceof MapError && error.code === 'DEPTH',
  )
})

test('a node cannot be moved into its own subtree', () => {
  const state = seed()
  assert.throws(
    () => moveNode(state, 'a', 'a1'),
    (error) => error instanceof MapError && error.code === 'CYCLE',
  )
})

test('a node cannot be moved into another Workspace', () => {
  assert.throws(
    () => moveNode(seed(), 'a1', 'b'),
    (error) => error instanceof MapError && error.code === 'WORKSPACE',
  )
})

test('moving a node keeps its subtree and its conversations', () => {
  let state = seed()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '第二主题', id: 'a2' }).state
  state = syncThreads(state, [{ id: 's1', displayTitle: '跨境建议' }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a1')
  state = moveNode(state, 'a1', 'a2')
  assert.deepEqual(nodePath(state, 'a1').map(node => node.title), ['第二主题', '获客方式'])
  assert.deepEqual(threadsOf(state, 'a1').map(thread => thread.sessionId), ['s1'])
})

test('deleting a leaf leaves its conversations directly under the Workspace', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '跨境建议' }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a1')
  assert.equal(threadsOf(state, 'a1').map(thread => thread.sessionId).length, 1)
  state = deleteNode(state, 'a1')
  assert.equal(state.nodes.some(node => node.id === 'a1'), false)
  assert.deepEqual(directThreadsOf(state, 'w1').map(thread => thread.sessionId), ['s1'])
})

test('a node with children cannot be deleted', () => {
  const state = seed()
  assert.throws(
    () => deleteNode(state, 'a'),
    (error) => error instanceof MapError && error.code === 'HAS_CHILDREN',
  )
})

test('each conversation has exactly one topic inside its Workspace', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '跨境建议' }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a')
  assert.deepEqual(threadsOf(state, 'a').map(thread => thread.sessionId), ['s1'])
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '另一个主题', id: 'a2' }).state
  state = assignThreads(state, ['s1'], 'a2')
  assert.deepEqual(threadsOf(state, 'a'), [])
  assert.deepEqual(threadsOf(state, 'a2').map(thread => thread.sessionId), ['s1'])
  state = assignThreads(state, ['s1'], null)
  assert.deepEqual(directThreadsOf(state, 'w1').map(thread => thread.sessionId), ['s1'])
})

test('a conversation can only be filed under a topic of its own Workspace', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '跨境建议' }], null, new Map([['s1', 'w1']]))
  assert.throws(
    () => assignThreads(state, ['s1'], 'b'),
    (error) => error instanceof MapError && error.code === 'WORKSPACE',
  )
})

test('syncing the catalog keeps topic ownership and files new conversations by Workspace', () => {
  let state = syncThreads(seed(), [{ id: 's1', displayTitle: '旧标题' }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a')
  state = syncThreads(state, [
    { id: 's1', displayTitle: '新标题' },
    { id: 's2', displayTitle: '另一条' },
  ], null, new Map([['s1', 'w1'], ['s2', 'w2']]))
  assert.deepEqual(threadsOf(state, 'a').map(thread => thread.title), ['新标题'])
  assert.equal(state.threads.find(thread => thread.sessionId === 's2')?.workspaceId, 'w2')
  assert.deepEqual(directThreadsOf(state, 'w2').map(thread => thread.sessionId), ['s2'])
})

test('pruning drops conversations the catalog no longer lists', () => {
  let state = syncThreads(seed(), [{ id: 's1', displayTitle: 'A' }, { id: 's2', displayTitle: 'B' }], null, new Map([['s1', 'w1'], ['s2', 'w1']]))
  const pruned = pruneMissing(state, new Set(['s1']))
  assert.deepEqual(pruned.threads.map(thread => thread.sessionId), ['s1'])
  assert.equal(pruneMissing(pruned, new Set(['s1', 's2'])), pruned, 'an unchanged catalog keeps state identity')
})

test('syncing records a subagent child without giving it a row, and never invents one', () => {
  let state = syncThreads(seed(), [
    { id: 'p', displayTitle: '父会话' },
    { id: 'c', displayTitle: '子智能体', origin: 'subagent', parentId: 'p' },
    { id: 'o', displayTitle: '普通会话' },
  ], null, new Map([['p', 'w1'], ['c', 'w1'], ['o', 'w1']]))
  assert.deepEqual(state.threads.map(thread => thread.sessionId), ['p', 'o'], 'the child is not indexed')
  assert.deepEqual(state.subagentSessionIds, ['c'], 'the fact survives where the Host half can read it')
  assert.equal(isRecordedSubagent(state, 'c'), true)
  assert.equal(isRecordedSubagent(state, 'p'), false, 'an ordinary conversation is never recorded')
  assert.equal(isRecordedSubagent(state, 'o'), false)

  // Recording is a fact about the catalog, not a guess: without an origin the
  // id is treated as an ordinary conversation.
  state = syncThreads(state, [{ id: 'mystery', displayTitle: '没有来源' }], null, new Map([['mystery', 'w1']]))
  assert.equal(isRecordedSubagent(state, 'mystery'), false)
})

test('a real pre-ledger document parses to an empty ledger and still prunes', () => {
  // The guard in pruneMissing must not misfire on genuine old data: JSON that
  // predates the field parses to [], not undefined.
  const stored = JSON.stringify({
    version: 2, revision: 4, nodes: [], spaces: [], defaultSpaceId: '', spaceOf: {},
    threads: [{ sessionId: 'c', nodeId: null, title: '子智能体', updatedAt: '', importedAt: '', origin: 'subagent' }],
  })
  const legacy = parseMapState(stored)
  assert.deepEqual(legacy.subagentSessionIds, [], 'an absent field reads as an empty ledger')
  assert.deepEqual(pruneMissing(legacy, new Set()).threads, [], 'so the stale row is pruned')
})

test('a hand-built document missing the ledger is left alone rather than pruned blind', () => {
  const broken = { ...emptyMap(), threads: [{ sessionId: 'c', nodeId: null, title: '子智能体', updatedAt: '', importedAt: '', origin: 'subagent' }] }
  delete broken.subagentSessionIds
  assert.equal(pruneMissing(broken, new Set()), broken, 'an impossible state is not destroyed')
})

test('the subagent ledger survives a save and load round trip', () => {
  const state = { ...emptyMap(), subagentSessionIds: ['c1', 'c2'] }
  const loaded = parseMapState(JSON.stringify(state))
  assert.deepEqual(loaded.subagentSessionIds, ['c1', 'c2'])
  assert.deepEqual(parseMapState(JSON.stringify({ ...emptyMap(), subagentSessionIds: ['ok', 7, ''] })).subagentSessionIds, ['ok'],
    'non-string and empty entries are dropped')
})

test('updating a node refreshes title and description', () => {
  const state = updateNode(seed(), { id: 'b', title: '产品设计 2', description: '下一阶段问题' })
  const node = state.nodes.find(candidate => candidate.id === 'b')
  assert.equal(node?.title, '产品设计 2')
  assert.equal(node?.description, '下一阶段问题')
})

test('creating a node records both creation and update time', () => {
  const created = createNode(seed(), { parentId: null, workspaceId: 'w1', title: '第三个主题', id: 'n3' })
  const node = created.state.nodes.find(candidate => candidate.id === 'n3')
  assert.equal(typeof node?.createdAt, 'string')
  assert.equal(node?.createdAt, node?.updatedAt, 'a new node is created and updated at the same instant')
})

test('editing a node keeps its creation time', () => {
  const created = createNode(seed(), { parentId: null, workspaceId: 'w1', title: '第三个主题', id: 'n3' })
  const createdAt = created.state.nodes.find(candidate => candidate.id === 'n3')?.createdAt
  const edited = updateNode(created.state, { id: 'n3', title: '第三个主题 2', description: '补充说明' })
  const node = edited.nodes.find(candidate => candidate.id === 'n3')
  assert.equal(node?.createdAt, createdAt)
  assert.equal(typeof node?.updatedAt, 'string')
})

test('a document written before createdAt existed still parses', () => {
  const legacy = JSON.stringify({
    version: 2,
    revision: 1,
    nodes: [{ id: 'a', parentId: null, title: '旧节点', description: '', position: 1, updatedAt: '' }],
    threads: [],
  })
  const state = parseMapState(legacy)
  assert.equal(state.nodes[0].createdAt, undefined)
})

test('createdAt survives a save and load round trip', () => {
  const backing = new Map()
  const store = {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
  const state = createNode(seed(), { parentId: null, workspaceId: 'w1', title: '带创建时间', id: 'n4' }).state
  saveMap(store, state)
  const loaded = loadMap(store)
  const node = loaded.nodes.find(candidate => candidate.id === 'n4')
  assert.equal(typeof node?.createdAt, 'string')
  assert.equal(node?.createdAt, state.nodes.find(candidate => candidate.id === 'n4')?.createdAt)
})

test('every mutation advances the revision', () => {
  const state = seed()
  const after = createNode(state, { parentId: null, workspaceId: 'w1', title: '第三个主题' }).state
  assert.equal(after.revision, state.revision + 1)
})

test('the map round-trips through a key/value store', () => {
  const backing = new Map()
  const store = {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
  const state = assignThreads(
    syncThreads(seed(), [{ id: 's1', displayTitle: 'A' }], null, new Map([['s1', 'w1']])),
    ['s1'],
    'a',
  )
  saveMap(store, state)
  assert.equal(backing.has(STORAGE_KEY), true)
  assert.deepEqual(loadMap(store), state)
})

test('unreadable persisted content falls back to an empty map', () => {
  assert.deepEqual(parseMapState('{ not json'), emptyMap())
  assert.deepEqual(parseMapState(JSON.stringify({ version: 9 })), emptyMap())
  assert.deepEqual(loadMap({ getItem: () => { throw new Error('denied') }, setItem: () => {} }), emptyMap())
})

test('a version-1 document upgrades without losing its tree', () => {
  const legacy = JSON.stringify({
    version: 1,
    revision: 7,
    nodes: [{ id: 'a', parentId: null, title: '外贸探索', description: '', position: 1, updatedAt: '' }],
    threads: [{ sessionId: 's1', nodeId: 'a', title: '旧对话', updatedAt: '', importedAt: '' }],
  })
  const state = parseMapState(legacy)
  assert.equal(state.version, 2)
  assert.equal(state.revision, 7)
  assert.deepEqual(state.nodes.map(node => node.id), ['a'])
  assert.equal(state.nodes[0].workspaceId, undefined, 'the owner is resolved once the Workspace list is known')
  assert.deepEqual(state.threads.map(thread => thread.sessionId), ['s1'])
})

test('reconciliation files legacy roots into the Workspace their conversations live in', () => {
  let state = parseMapState(JSON.stringify({
    version: 1,
    revision: 1,
    nodes: [{ id: 'a', parentId: null, title: '随便起的标题', description: '', position: 1, updatedAt: '' }],
    threads: [{ sessionId: 's1', nodeId: 'a', title: '在 w2 里', updatedAt: '', importedAt: '' }],
  }))
  state = syncThreads(state, [{ id: 's1', displayTitle: '在 w2 里' }], null, new Map([['s1', 'w2']]))
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha'), workspace('w2', 'beta', ['s1'])])
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a')), 'w2', 'membership outranks the title guess')
  assert.equal(state.threads[0].workspaceId, 'w2')
  assert.equal(state.threads[0].nodeId, 'a')
})

test('reconciliation falls back to a Workspace title when conversations say nothing', () => {
  let state = parseMapState(JSON.stringify({
    version: 1,
    revision: 1,
    nodes: [{ id: 'a', parentId: null, title: 'alpha', description: '', position: 1, updatedAt: '' }],
    threads: [],
  }))
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha'), workspace('w2', 'beta')])
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a')), 'w1')
})

test('a legacy child inherits the Workspace its root was filed into', () => {
  let state = parseMapState(JSON.stringify({
    version: 1,
    revision: 1,
    nodes: [
      { id: 'a', parentId: null, title: 'alpha', description: '', position: 1, updatedAt: '' },
      { id: 'a1', parentId: 'a', title: '子主题', description: '', position: 1, updatedAt: '' },
    ],
    threads: [],
  }))
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha')])
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a1')), 'w1')
})

test('deleting a Workspace moves its topics to the ungrouped bucket', () => {
  let state = seed()
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha'), workspace('w2', 'beta')])
  state = reconcileWorkspaces(state, [workspace('w2', 'beta')])
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a')), null)
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'a1')), null)
  assert.deepEqual(topNodesOf(state, null).map(node => node.id), ['a'])
  assert.equal(workspaceOfNode(state.nodes.find(node => node.id === 'b')), 'w2')
})

test('a conversation that leaves a Workspace also leaves its topic', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '跨境' }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a')
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha', ['s1']), workspace('w2', 'beta')])
  assert.equal(state.threads[0].nodeId, 'a')
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha'), workspace('w2', 'beta', ['s1'])])
  assert.equal(state.threads[0].workspaceId, 'w2')
  assert.equal(state.threads[0].nodeId, null, 'the topic belonged to the old Workspace')
})

test('reconciliation is identity-stable when nothing changed', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: 'A' }], null, new Map([['s1', 'w1']]))
  const folded = reconcileWorkspaces(state, [workspace('w1', 'alpha', ['s1']), workspace('w2', 'beta')])
  assert.equal(reconcileWorkspaces(folded, [workspace('w1', 'alpha', ['s1']), workspace('w2', 'beta')]), folded)
})

test('search matches node titles, node descriptions, and conversation titles', () => {
  let state = updateNode(seed(), { id: 'b', title: '产品设计', description: '下一阶段的定价问题' })
  state = syncThreads(state, [{ id: 's1', displayTitle: '阿里国际站外贸模式' }], null, new Map([['s1', 'w1']]))
  assert.deepEqual(searchMap(state, '定价').nodes.map(hit => hit.node.id), ['b'])
  assert.deepEqual(searchMap(state, '外贸').nodes.map(hit => hit.node.id), ['a'])
  assert.deepEqual(searchMap(state, '国际站').threads.map(hit => hit.thread.sessionId), ['s1'])
  assert.deepEqual(searchMap(state, '   '), { nodes: [], threads: [] })
})

test('search is case-insensitive', () => {
  const state = syncThreads(seed(), [{ id: 's1', displayTitle: 'Codex Notes' }], null, new Map([['s1', 'w1']]))
  assert.deepEqual(searchMap(state, 'codex').threads.map(hit => hit.thread.sessionId), ['s1'])
})

test('breadcrumb names the path from the Workspace root', () => {
  const state = seed()
  assert.equal(breadcrumb(state, 'a1'), '外贸探索 / 获客方式')
  assert.equal(breadcrumb(state, 'b'), '产品设计')
})

test('Workspace selection keys name the first level unambiguously', () => {
  assert.equal(workspaceNodeId('w1'), '@ws:w1')
  assert.equal(workspaceKey('w1'), '@ws:w1')
  assert.equal(workspaceKey(null), UNGROUPED_ID)
  assert.equal(isWorkspaceSelectionKey('@ws:w1'), true)
  assert.equal(isWorkspaceSelectionKey(UNGROUPED_ID), true)
  assert.equal(isWorkspaceSelectionKey('node-1'), false)
  assert.deepEqual(workspaceSelection('@ws:w1'), { workspaceId: 'w1' })
  assert.deepEqual(workspaceSelection(UNGROUPED_ID), { workspaceId: null })
  assert.equal(workspaceSelection('node-1'), undefined)
})

test('deleting a top-level node selects its Workspace', () => {
  const state = seed()
  assert.equal(selectionAfterNodeDeletion(state, 'a'), '@ws:w1')
  assert.equal(selectionAfterNodeDeletion(state, 'a1'), 'a')
})

test('Workspace titles prefer the stored title, then the directory name', () => {
  assert.equal(workspaceDisplayTitle({ title: '外贸探索', path: '/tmp/x' }), '外贸探索')
  assert.equal(workspaceDisplayTitle({ title: 'default-workspace', path: '/tmp/x' }), '默认工作区')
  assert.equal(workspaceDisplayTitle({ title: '', path: '/home/me/projects/task-map/' }), 'task-map')
  assert.equal(pathBaseName('/home/me/projects/task-map/'), 'task-map')
  assert.equal(pathBaseName('C:\\work\\alpha'), 'alpha')
})

test('a newly created conversation is adopted under its row and Workspace', () => {
  const state = adoptThread(seed(), { sessionId: 's9', title: '', nodeId: 'a1', workspaceId: 'w1' })
  assert.deepEqual(threadsOf(state, 'a1').map(thread => thread.sessionId), ['s9'])
  assert.equal(state.threads.find(thread => thread.sessionId === 's9')?.title, 's9')
  assert.equal(state.threads.find(thread => thread.sessionId === 's9')?.workspaceId, 'w1')
})

test('adopting directly under a Workspace keeps it out of every topic', () => {
  const state = adoptThread(seed(), { sessionId: 's9', title: '', nodeId: null, workspaceId: 'w2' })
  assert.deepEqual(directThreadsOf(state, 'w2').map(thread => thread.sessionId), ['s9'])
  assert.deepEqual(threadsOf(state, 'b'), [])
})

test('adopting an already indexed conversation moves its ownership', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '旧标题' }], null, new Map([['s1', 'w2']]))
  state = adoptThread(state, { sessionId: 's1', title: '新标题', nodeId: 'b', workspaceId: 'w2' })
  assert.deepEqual(threadsOf(state, 'b').map(thread => thread.title), ['新标题'])
})

test('adopting into a missing node is rejected', () => {
  assert.throws(
    () => adoptThread(seed(), { sessionId: 's9', title: 't', nodeId: 'missing', workspaceId: 'w1' }),
    (error) => error instanceof MapError && error.code === 'NOT_FOUND',
  )
})

test('the id chip strips the session- prefix so ids stay distinguishable', () => {
  assert.equal(shortSessionId('session-4f2a9c31-0000-4000-8000-000000000000'), '4f2a9c31')
  assert.equal(shortSessionId('80556a84-1111-4222-8333-444444444444'), '80556a84')
  assert.notEqual(
    shortSessionId('session-4f2a9c31-0000-4000-8000-000000000000'),
    shortSessionId('session-9b7e1d20-0000-4000-8000-000000000000'),
  )
})

test('a node lists its conversations newest activity first', () => {
  let state = seed()
  state = syncThreads(state, [
    { id: 'old', displayTitle: '更早的一轮', updatedAt: Date.parse('2024-01-01T00:00:00.000Z') },
    { id: 'newer', displayTitle: '中间的一轮', updatedAt: Date.parse('2024-06-01T00:00:00.000Z') },
    { id: 'newest', displayTitle: '最近的一轮', updatedAt: Date.parse('2024-12-01T00:00:00.000Z') },
  ], null, new Map([['old', 'w1'], ['newer', 'w1'], ['newest', 'w1']]))
  state = assignThreads(state, ['old', 'newer', 'newest'], 'a')
  assert.deepEqual(threadsOf(state, 'a').map(thread => thread.sessionId), ['newest', 'newer', 'old'])
})

test('a Workspace lists its direct conversations newest activity first', () => {
  const state = syncThreads(seed(), [
    { id: 'old', displayTitle: '更早的一轮', updatedAt: Date.parse('2024-01-01T00:00:00.000Z') },
    { id: 'newest', displayTitle: '最近的一轮', updatedAt: Date.parse('2024-12-01T00:00:00.000Z') },
  ], null, new Map([['old', 'w1'], ['newest', 'w1']]))
  assert.deepEqual(directThreadsOf(state, 'w1').map(thread => thread.sessionId), ['newest', 'old'])
})

test('a conversation just started under a node lands at the top of its list', () => {
  let state = seed()
  state = syncThreads(state, [
    { id: 's1', displayTitle: '旧的一轮', updatedAt: Date.parse('2024-01-01T00:00:00.000Z') },
    { id: 's2', displayTitle: '另一轮', updatedAt: Date.parse('2024-06-01T00:00:00.000Z') },
  ], null, new Map([['s1', 'w1'], ['s2', 'w1']]))
  state = assignThreads(state, ['s1', 's2'], 'a')
  state = adoptThread(state, { sessionId: 's9', title: '', nodeId: 'a', workspaceId: 'w1' })
  assert.deepEqual(threadsOf(state, 'a').map(thread => thread.sessionId), ['s9', 's2', 's1'])
})

test('a conversation just started directly under a Workspace lands at the top', () => {
  let state = seed()
  state = syncThreads(state, [
    { id: 's1', displayTitle: '旧的一轮', updatedAt: Date.parse('2024-01-01T00:00:00.000Z') },
  ], null, new Map([['s1', 'w1']]))
  state = adoptThread(state, { sessionId: 's9', title: '', nodeId: null, workspaceId: 'w1' })
  assert.deepEqual(directThreadsOf(state, 'w1').map(thread => thread.sessionId), ['s9', 's1'])
})

test('conversations sharing an activity stamp keep the Host order', () => {
  const stamp = Date.parse('2024-06-01T00:00:00.000Z')
  const state = syncThreads(seed(), [
    { id: 'first', displayTitle: '先列的', updatedAt: stamp },
    { id: 'second', displayTitle: '后列的', updatedAt: stamp },
  ], null, new Map([['first', 'w1'], ['second', 'w1']]))
  assert.deepEqual(directThreadsOf(state, 'w1').map(thread => thread.sessionId), ['first', 'second'])
})

test('a conversation is looked up by session id', () => {
  const state = syncThreads(seed(), [
    { id: 'known', displayTitle: '已知的', updatedAt: 0 },
  ], null, new Map([['known', 'w1']]))
  assert.equal(threadOfSession(state, 'known').sessionId, 'known')
  assert.equal(threadOfSession(state, 'missing'), undefined)
})

/* ── opening a conversation activates its home ──────────────────────────── */

test('opening a conversation activates the topic it is filed under', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's1', displayTitle: '挂在主题下', updatedAt: 0 }], null, new Map([['s1', 'w1']]))
  state = assignThreads(state, ['s1'], 'a1')
  assert.equal(selectionOfThread(state, threadOfSession(state, 's1')), 'a1')
})

test('opening a conversation filed directly under a Workspace activates that Workspace row', () => {
  const state = syncThreads(seed(), [{ id: 's2', displayTitle: '工作区直挂', updatedAt: 0 }], null, new Map([['s2', 'w2']]))
  const thread = threadOfSession(state, 's2')
  assert.equal(thread.nodeId, null)
  assert.equal(selectionOfThread(state, thread), workspaceKey('w2'))
})

test('a topic that outlived its deletion in the index activates its Workspace instead', () => {
  let state = seed()
  state = syncThreads(state, [{ id: 's3', displayTitle: '孤儿', updatedAt: 0 }], null, new Map([['s3', 'w1']]))
  state = assignThreads(state, ['s3'], 'a1')
  // A topic copy that vanished from the document while the index still names it.
  const stale = { ...state, nodes: state.nodes.filter(node => node.id !== 'a1') }
  const thread = threadOfSession(stale, 's3')
  assert.equal(thread.nodeId, 'a1')
  assert.equal(selectionOfThread(stale, thread), workspaceKey('w1'))
})

test('an ungrouped conversation activates no node', () => {
  const state = syncThreads(seed(), [{ id: 's4', displayTitle: '散落', updatedAt: 0 }], null, new Map([['s4', null]]))
  assert.equal(selectionOfThread(state, threadOfSession(state, 's4')), null)
})

/* ── spaces ─────────────────────────────────────────────────────────────── */

/** A map that has passed first-use bootstrapping. */
function bootstrapped() {
  const state = ensureDefaultSpace(emptyMap())
  return { state, defaultSpaceId: state.defaultSpaceId }
}

/** Two user spaces over a two-Workspace map, plus one loose conversation. */
function spaced() {
  let state = ensureDefaultSpace(emptyMap())
  const defaultSpaceId = state.defaultSpaceId
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  const family = createSpace(state, { title: '家庭空间' })
  state = family.state
  state = setWorkspaceSpace(state, 'w1', work.id)
  state = setWorkspaceSpace(state, 'w2', family.id)
  state = syncThreads(state, [
    { id: 's1', displayTitle: '工作对话' },
    { id: 's2', displayTitle: '家庭对话' },
    { id: 's3', displayTitle: '散落对话' },
  ], null, new Map([['s1', 'w1'], ['s2', 'w2'], ['s3', null]]))
  return { state, defaultSpaceId, work: work.id, family: family.id }
}

test('the first load creates one default space', () => {
  const state = ensureDefaultSpace(emptyMap())
  assert.equal(state.spaces.length, 1)
  assert.equal(state.spaces[0].title, DEFAULT_SPACE_TITLE)
  assert.equal(state.spaces[0].position, 1)
  assert.equal(state.defaultSpaceId, state.spaces[0].id)
  assert.equal(ensureDefaultSpace(state), state, 'bootstrapping is idempotent')
})

test('a broken default space pointer is repaired to the first space', () => {
  const { state } = spaced()
  const repaired = ensureDefaultSpace({ ...state, defaultSpaceId: 'gone' })
  assert.equal(repaired.defaultSpaceId, spaceList(repaired)[0].id)
})

test('a Workspace with no override belongs to the default space', () => {
  const { state, defaultSpaceId } = bootstrapped()
  assert.equal(spaceOfWorkspace(state, 'w1'), defaultSpaceId)
  assert.deepEqual(state.spaceOf, {}, 'the default space is never written')
})

test('spaces can be created and renamed, and names must be unique and non-empty', () => {
  let { state } = bootstrapped()
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  assert.deepEqual(spaceList(state).map(space => space.title), [DEFAULT_SPACE_TITLE, '工作空间'])
  assert.throws(() => createSpace(state, { title: '工作空间' }), (error) => error instanceof MapError && error.code === 'SPACE_TITLE_DUP')
  assert.throws(() => renameSpace(state, { id: work.id, title: '   ' }), (error) => error instanceof MapError && error.code === 'SPACE_TITLE_EMPTY')
  assert.throws(() => createSpace(state, { title: 'x'.repeat(41) }), (error) => error instanceof MapError && error.code === 'SPACE_TITLE_LONG')
  state = renameSpace(state, { id: work.id, title: '个人项目空间' })
  assert.equal(spaceList(state)[1].title, '个人项目空间')
  assert.equal(renameSpace(state, { id: work.id, title: '个人项目空间' }), state, 'renaming to the same title is a no-op')
})

test('the number of spaces is bounded', () => {
  let state = ensureDefaultSpace(emptyMap())
  for (let index = 1; index < MAX_SPACES; index += 1) {
    state = createSpace(state, { title: `空间 ${String(index)}` }).state
  }
  assert.equal(state.spaces.length, MAX_SPACES)
  assert.throws(() => createSpace(state, { title: '多出来的' }), (error) => error instanceof MapError && error.code === 'SPACE_LIMIT')
})

test('the default space cannot be deleted', () => {
  const { state, defaultSpaceId } = bootstrapped()
  assert.throws(() => deleteSpace(state, defaultSpaceId), (error) => error instanceof MapError && error.code === 'DEFAULT_SPACE')
})

test('a Workspace moves between spaces and falls back to the default space', () => {
  let { state, defaultSpaceId } = bootstrapped()
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  state = setWorkspaceSpace(state, 'w1', work.id)
  assert.equal(spaceOfWorkspace(state, 'w1'), work.id)
  assert.deepEqual(state.spaceOf, { w1: work.id }, 'the override is sparse')
  assert.equal(setWorkspaceSpace(state, 'w1', work.id), state, 'moving to the same space changes nothing')
  state = setWorkspaceSpace(state, 'w1', defaultSpaceId)
  assert.deepEqual(state.spaceOf, {}, 'the default space is the absence of an override')
})

test('a space lists only its Workspaces, in Host order', () => {
  const { state, work, family } = spaced()
  const workspaces = [workspace('w2', 'beta'), workspace('w1', 'alpha')]
  assert.deepEqual(workspacesInSpace(state, workspaces, work).map(entry => entry.workspaceId), ['w1'])
  assert.deepEqual(workspacesInSpace(state, workspaces, family).map(entry => entry.workspaceId), ['w2'])
})

test('each space lists only its own loose conversations', () => {
  const { state, defaultSpaceId, work } = spaced()
  assert.deepEqual(looseThreadsInSpace(state, defaultSpaceId).map(thread => thread.sessionId), ['s3'])
  assert.deepEqual(looseThreadsInSpace(state, work), [])
})

test('a loose conversation moves between spaces without touching its Workspace', () => {
  const { state: seeded, defaultSpaceId, work, family } = spaced()
  const state = setThreadSpace(seeded, 's3', work)
  const thread = state.threads.find(candidate => candidate.sessionId === 's3')
  assert.equal(spaceOfThread(state, thread), work)
  assert.equal(thread.workspaceId, null)
  assert.deepEqual(looseThreadsInSpace(state, work).map(entry => entry.sessionId), ['s3'])
  assert.deepEqual(looseThreadsInSpace(state, defaultSpaceId), [])
  const back = setThreadSpace(state, 's3', family)
  assert.deepEqual(looseThreadsInSpace(back, family).map(entry => entry.sessionId), ['s3'])
  assert.throws(() => setThreadSpace(state, 's1', work), (error) => error instanceof MapError && error.code === 'WORKSPACE')
})

test('moving a loose conversation out of the default space detaches it from a rootless topic', () => {
  let { state } = bootstrapped()
  state = createNode(state, { parentId: null, workspaceId: null, title: '无主主题', id: 'u1' }).state
  state = syncThreads(state, [{ id: 's3', displayTitle: '散落' }], null, new Map([['s3', null]]))
  state = assignThreads(state, ['s3'], 'u1')
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  state = setThreadSpace(state, 's3', work.id)
  const thread = state.threads.find(candidate => candidate.sessionId === 's3')
  assert.equal(thread.nodeId, null)
  assert.equal(spaceOfThread(state, thread), work.id)
})

test('a loose conversation filed into another space cannot join a rootless topic', () => {
  let { state } = bootstrapped()
  state = createNode(state, { parentId: null, workspaceId: null, title: '无主主题', id: 'u1' }).state
  state = syncThreads(state, [{ id: 's3', displayTitle: '散落' }], null, new Map([['s3', null]]))
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  state = setThreadSpace(state, 's3', work.id)
  assert.throws(() => assignThreads(state, ['s3'], 'u1'), (error) => error instanceof MapError && error.code === 'SPACE')
})

test('deleting a space returns its Workspaces and loose conversations to the default space', () => {
  let { state } = bootstrapped()
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  state = setWorkspaceSpace(state, 'w1', work.id)
  state = syncThreads(state, [{ id: 's3', displayTitle: '散落' }], null, new Map([['s3', null]]))
  state = setThreadSpace(state, 's3', work.id)
  const after = deleteSpace(state, work.id)
  assert.equal(spaceList(after).length, 1)
  assert.deepEqual(after.spaceOf, {})
  assert.equal(spaceOfThread(after, after.threads.find(thread => thread.sessionId === 's3')), after.defaultSpaceId)
  assert.deepEqual(looseThreadsInSpace(after, after.defaultSpaceId).map(thread => thread.sessionId), ['s3'])
})

test('a conversation claimed by a Workspace loses its local space', () => {
  const { state: seeded, work } = spaced()
  let state = setThreadSpace(seeded, 's3', work)
  state = reconcileWorkspaces(state, [workspace('w1', 'alpha', ['s1', 's3']), workspace('w2', 'beta', ['s2'])])
  const thread = state.threads.find(candidate => candidate.sessionId === 's3')
  assert.equal(thread.workspaceId, 'w1')
  assert.equal(thread.spaceId, undefined)
})

test('space reconciliation drops references to Workspaces and spaces that are gone', () => {
  const { state: seeded } = spaced()
  const orphanWorkspace = { ...seeded, spaceOf: { w1: 'gone-space' } }
  assert.deepEqual(reconcileSpaces(orphanWorkspace, [workspace('w1', 'alpha')]).spaceOf, {})
  const orphanThread = {
    ...seeded,
    threads: seeded.threads.map(thread => thread.sessionId === 's3' ? { ...thread, spaceId: 'gone-space' } : thread),
  }
  const reconciled = reconcileSpaces(orphanThread, [workspace('w1', 'alpha'), workspace('w2', 'beta')])
  assert.equal(reconciled.threads.find(thread => thread.sessionId === 's3').spaceId, undefined)
  assert.equal(reconcileSpaces(seeded, [workspace('w1', 'alpha'), workspace('w2', 'beta')]), seeded, 'a clean map keeps identity')
})

test('the ungrouped row key is stable per space', () => {
  const { state, defaultSpaceId, work } = spaced()
  assert.equal(looseRowKey(state, defaultSpaceId), UNGROUPED_ID)
  assert.equal(looseRowKey(state, work), `${LOOSE_ROW_PREFIX}${work}`)
})

test('a loose conversation started in a space is recorded there', () => {
  const { state: seeded, work, defaultSpaceId } = spaced()
  const state = adoptThread(seeded, { sessionId: 's9', title: '', nodeId: null, workspaceId: null, spaceId: work })
  const thread = state.threads.find(candidate => candidate.sessionId === 's9')
  assert.equal(thread.workspaceId, null)
  assert.equal(spaceOfThread(state, thread), work)
  const back = adoptThread(state, { sessionId: 's9', title: '', nodeId: null, workspaceId: null, spaceId: defaultSpaceId })
  assert.equal(back.threads.find(candidate => candidate.sessionId === 's9').spaceId, undefined)
})

test('an older document reads as having no spaces yet', () => {
  const parsed = parseMapState(JSON.stringify({ version: 2, revision: 4, nodes: [], threads: [] }))
  assert.deepEqual(parsed.spaces, [])
  assert.equal(parsed.defaultSpaceId, '')
  assert.deepEqual(parsed.spaceOf, {})
})

test('spaces survive a save/load round-trip', () => {
  const { state } = spaced()
  const backing = new Map()
  const store = {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
  saveMap(store, state)
  const loaded = loadMap(store)
  assert.deepEqual(loaded.spaces, state.spaces)
  assert.equal(loaded.defaultSpaceId, state.defaultSpaceId)
  assert.deepEqual(loaded.spaceOf, state.spaceOf)
  assert.equal(loaded.threads.find(thread => thread.sessionId === 's3').spaceId, undefined)
})

test('a malformed space document is sanitized instead of breaking the map', () => {
  const parsed = parseMapState(JSON.stringify({
    version: 2,
    revision: 1,
    nodes: [],
    threads: [
      { sessionId: 's1', nodeId: null, workspaceId: 'w1', spaceId: 'sp1', title: 't', updatedAt: '', importedAt: '' },
      { sessionId: 's2', nodeId: null, workspaceId: null, spaceId: 'sp2', title: 't', updatedAt: '', importedAt: '' },
      { sessionId: 's3', nodeId: null, workspaceId: null, spaceId: 'missing', title: 't', updatedAt: '', importedAt: '' },
    ],
    spaces: [
      { id: 'sp1', title: '工作空间', position: 2, createdAt: '' },
      { id: 'sp2', title: '家庭空间', position: 3, createdAt: '' },
      { id: 'sp1', title: '重复', position: 4, createdAt: '' },
      { id: '', title: '无 id', position: 5, createdAt: '' },
    ],
    defaultSpaceId: 'sp1',
    spaceOf: { w1: 'sp1', w2: 'missing' },
  }))
  assert.deepEqual(parsed.spaces.map(space => space.id), ['sp1', 'sp2'])
  assert.deepEqual(parsed.spaceOf, { w1: 'sp1' })
  assert.equal(parsed.threads.find(thread => thread.sessionId === 's1').spaceId, undefined, 'Workspace membership wins')
  assert.equal(parsed.threads.find(thread => thread.sessionId === 's2').spaceId, 'sp2')
  assert.equal(parsed.threads.find(thread => thread.sessionId === 's3').spaceId, undefined)
})

test('search can be scoped to one space', () => {
  let { state } = bootstrapped()
  const work = createSpace(state, { title: '工作空间' })
  state = work.state
  const family = createSpace(state, { title: '家庭空间' })
  state = family.state
  state = setWorkspaceSpace(state, 'w1', work.id)
  state = setWorkspaceSpace(state, 'w2', family.id)
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '外贸主题', id: 'n1' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w2', title: '家庭主题', id: 'n2' }).state
  state = createNode(state, { parentId: null, workspaceId: null, title: '无主主题', id: 'n3' }).state
  state = syncThreads(state, [
    { id: 's1', displayTitle: '外贸对话' },
    { id: 's2', displayTitle: '家庭对话' },
    { id: 's3', displayTitle: '散落主题对话' },
  ], null, new Map([['s1', 'w1'], ['s2', 'w2'], ['s3', null]]))
  assert.deepEqual(searchMap(state, '主题', work.id).nodes.map(hit => hit.node.id), ['n1'])
  assert.deepEqual(searchMap(state, '主题', family.id).nodes.map(hit => hit.node.id), ['n2'])
  assert.deepEqual(searchMap(state, '主题', state.defaultSpaceId).nodes.map(hit => hit.node.id), ['n3'])
  assert.deepEqual(searchMap(state, '对话', state.defaultSpaceId).threads.map(hit => hit.thread.sessionId), ['s3'])
  assert.deepEqual(searchMap(state, '对话', work.id).threads.map(hit => hit.thread.sessionId), ['s1'])
})

test('ordinary mutations keep the space organization', () => {
  const { state: seeded, defaultSpaceId, work } = spaced()
  const before = seeded.spaces.map(space => space.id)
  let state = createNode(seeded, { parentId: null, workspaceId: 'w1', title: '新主题', id: 'n1' }).state
  state = syncThreads(state, [{ id: 's1', displayTitle: '改名' }, { id: 's3', displayTitle: '散落' }], null, new Map([['s1', 'w1'], ['s3', null]]))
  state = assignThreads(state, ['s1'], 'n1')
  state = updateNode(state, { id: 'n1', title: '改名后', description: '' })
  state = renameSpace(state, { id: work, title: '工作区空间' })
  assert.deepEqual(state.spaces.map(space => space.id), before)
  assert.equal(state.defaultSpaceId, defaultSpaceId)
  assert.deepEqual(state.spaceOf, seeded.spaceOf)
})

/*
 * Native navigation lands where the Session lives. The map follows a Session
 * clicked in the product sidebar, so its space and highlighted row must be the
 * Session's home — including a home in a space the map is not currently scoped
 * to (the reader named the destination by clicking it).
 */
test('an indexed conversation resolves to its Workspace row and that Workspace space', () => {
  const { state, work } = spaced()
  assert.deepEqual(homeOfSession(state, 's1'), {
    spaceId: work,
    selection: workspaceKey('w1'),
  })
})

test('an indexed conversation filed under a topic resolves to the topic', () => {
  const { state, work } = spaced()
  const withTopic = createNode(state, { parentId: null, workspaceId: 'w1', title: '主题', id: 'n1' }).state
  const filed = assignThreads(withTopic, ['s1'], 'n1')
  assert.deepEqual(homeOfSession(filed, 's1'), { spaceId: work, selection: 'n1' })
})

test('a loose conversation resolves to the ungrouped row of its own space', () => {
  const { state, defaultSpaceId, work } = spaced()
  assert.deepEqual(homeOfSession(state, 's3'), {
    spaceId: defaultSpaceId,
    selection: UNGROUPED_ID,
  })
  const moved = setThreadSpace(state, 's3', work)
  assert.deepEqual(homeOfSession(moved, 's3'), {
    spaceId: work,
    selection: looseRowKey(moved, work),
  })
})

test('a Session the index has not seen resolves through the Host Workspace accounting', () => {
  const { state, work, family } = spaced()
  assert.deepEqual(homeOfSession(state, 'new-in-w1', 'w1'), {
    spaceId: work,
    selection: workspaceKey('w1'),
  })
  assert.deepEqual(homeOfSession(state, 'new-in-w2', 'w2'), {
    spaceId: family,
    selection: workspaceKey('w2'),
  })
  assert.deepEqual(homeOfSession(state, 'new-loose', null), {
    spaceId: state.defaultSpaceId,
    selection: UNGROUPED_ID,
  })
})

test('an unknown Session with no Workspace has no place to land', () => {
  const { state } = spaced()
  assert.equal(homeOfSession(state, 'ghost'), undefined)
  assert.equal(homeOfSession(state, 'ghost', undefined), undefined)
})

/* ── move issues: the judgement drag, dialogs, and tools all read ───────── */

test('moveNodeIssue names every reason a re-parent is refused', () => {
  const state = seed()
  assert.deepEqual(moveNodeIssue(state, 'ghost', null), { code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  assert.deepEqual(moveNodeIssue(state, 'a1', 'ghost'), { code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  assert.deepEqual(moveNodeIssue(state, 'a1', 'b'), {
    code: 'WORKSPACE', message: '不能把节点移动到其他工作区的节点下。',
  })
  assert.deepEqual(moveNodeIssue(state, 'a', 'a'), {
    code: 'CYCLE', message: '不能把节点移动到它自己或它的子节点下。',
  })
  assert.deepEqual(moveNodeIssue(state, 'a', 'a1'), {
    code: 'CYCLE', message: '不能把节点移动到它自己或它的子节点下。',
  })
  assert.equal(moveNodeIssue(state, 'a1', null), null, 'the Workspace root is always in reach')
  const sibling = createNode(state, { parentId: null, workspaceId: 'w1', title: '第二个主题', id: 'a2' }).state
  assert.equal(moveNodeIssue(sibling, 'a2', 'a'), null, 'a root may become a child of another root')
  assert.equal(moveNodeIssue(state, 'a1', 'a'), null, 're-parenting to the current parent stays committable')
})

test('moveNodeIssue enforces depth as target depth plus subtree height', () => {
  let deep = seed()
  for (let level = 1; level <= MAX_DEPTH; level += 1) {
    deep = createNode(deep, {
      parentId: level === 1 ? null : `c${level - 1}`,
      workspaceId: 'w1',
      title: `层 ${level}`,
      id: `c${level}`,
    }).state
  }
  let tall = createNode(deep, { parentId: null, workspaceId: 'w1', title: '高子树', id: 'tall' }).state
  tall = createNode(tall, { parentId: 'tall', title: '叶子', id: 'tall-leaf' }).state

  assert.deepEqual(moveNodeIssue(tall, 'tall', `c${MAX_DEPTH - 1}`), {
    code: 'DEPTH', message: `最多支持 ${MAX_DEPTH} 层。`,
  }, '11 + a two-node subtree breaks the ceiling')
  assert.equal(moveNodeIssue(tall, 'tall', `c${MAX_DEPTH - 2}`), null, 'exactly 12 levels still fits')
  assert.deepEqual(moveNodeIssue(tall, 'c1', 'tall'), {
    code: 'DEPTH', message: `最多支持 ${MAX_DEPTH} 层。`,
  }, 'a 12-deep subtree cannot hang under another root')
})

test('moveNode refuses with exactly the issue moveNodeIssue reported', () => {
  const state = seed()
  const before = state.revision
  const refused = [['ghost', null], ['a1', 'ghost'], ['a1', 'b'], ['a', 'a'], ['a', 'a1']]
  for (const [id, parentId] of refused) {
    const issue = moveNodeIssue(state, id, parentId)
    assert.notEqual(issue, null, `${id} → ${String(parentId)} is refused`)
    assert.throws(
      () => moveNode(state, id, parentId),
      (error) => error instanceof MapError && error.code === issue.code && error.message === issue.message,
    )
  }
  assert.equal(state.revision, before, 'a refused move never touches the document')
})

test('assignThreadIssue mirrors the conversation rules and names the refusing code', () => {
  const state = syncThreads(seed(), [
    { id: 'own', displayTitle: '本区会话', updatedAt: 0 },
    { id: 'foreign', displayTitle: '外区会话', updatedAt: 0 },
  ], null, new Map([['own', 'w1'], ['foreign', 'w2']]))

  assert.equal(assignThreadIssue(state, 'own', 'a1'), null, 'a node of its own Workspace is committable')
  assert.equal(assignThreadIssue(state, 'own', null), null, 'so is the Workspace row itself')
  assert.deepEqual(assignThreadIssue(state, 'foreign', 'a1'), {
    code: 'WORKSPACE', message: '只能把对话关联到它所属工作区里的节点。',
  })
  assert.deepEqual(assignThreadIssue(state, 'own', 'ghost'), { code: 'NOT_FOUND', message: '节点已不存在，请刷新。' })
  assert.equal(assignThreadIssue(state, 'never-indexed', 'a1'), null, 'an unknown Session holds no row to file')

  const unreconciled = {
    ...state,
    threads: [...state.threads, { sessionId: 'unreconciled', nodeId: null, title: '未对账', updatedAt: '', importedAt: '' }],
  }
  assert.equal(assignThreadIssue(unreconciled, 'unreconciled', 'a1'), null,
    'a conversation whose Workspace is not known yet stays permissive')
})

test('assignThreadIssue refuses a subagent conversation by origin and by ledger', () => {
  const state = syncThreads(seed(), [{ id: 'own', displayTitle: '本区会话', updatedAt: 0 }], null, new Map([['own', 'w1']]))
  const child = {
    sessionId: 'child-row', nodeId: null, title: '子智能体', updatedAt: '', importedAt: '', origin: 'subagent',
  }
  const byOrigin = { ...state, threads: [...state.threads, child] }
  assert.deepEqual(assignThreadIssue(byOrigin, 'child-row', 'a1'), {
    code: 'SUBAGENT', message: '子智能体会话不能挂到节点下。',
  })
  assert.deepEqual(assignThreadIssue(byOrigin, 'child-row', null)?.code, 'SUBAGENT',
    'a child is refused even for the Workspace row')

  const byLedger = { ...state, subagentSessionIds: ['child-ledger'] }
  assert.deepEqual(assignThreadIssue(byLedger, 'child-ledger', 'a1')?.code, 'SUBAGENT',
    'the ledger outlives the row it was recorded from')
})

test('assignThreadIssue keeps the rootless-topic space rule', () => {
  let { state } = bootstrapped()
  state = createNode(state, { parentId: null, workspaceId: null, title: '无主主题', id: 'u1' }).state
  state = syncThreads(state, [{ id: 's3', displayTitle: '散落', updatedAt: 0 }], null, new Map([['s3', null]]))
  assert.equal(assignThreadIssue(state, 's3', 'u1'), null, 'the default space may join a rootless topic')

  const work = createSpace(state, { title: '工作空间' })
  const elsewhere = setThreadSpace(work.state, 's3', work.id)
  assert.deepEqual(assignThreadIssue(elsewhere, 's3', 'u1'), {
    code: 'SPACE', message: '只能把默认空间的未分组对话关联到未分组主题。',
  })
  assert.throws(
    () => assignThreads(elsewhere, ['s3'], 'u1'),
    (error) => error instanceof MapError && error.code === 'SPACE',
  )
})

test('assignThreads refuses a subagent conversation and keeps a rejected batch atomic', () => {
  const base = syncThreads(seed(), [{ id: 'ok', displayTitle: '普通会话', updatedAt: 0 }], null, new Map([['ok', 'w1']]))
  const ledger = { ...base, subagentSessionIds: ['child-ledger'] }
  assert.throws(
    () => assignThreads(ledger, ['child-ledger'], 'a1'),
    (error) => error instanceof MapError && error.code === 'SUBAGENT',
  )
  assert.throws(
    () => assignThreads(ledger, ['ok', 'child-ledger'], 'a1'),
    (error) => error instanceof MapError && error.code === 'SUBAGENT',
  )
  assert.equal(threadOfSession(ledger, 'ok').nodeId, null, 'the ordinary id in a rejected batch is not filed either')

  const withRow = {
    ...base,
    threads: [
      ...base.threads,
      { sessionId: 'child-row', nodeId: null, title: '子智能体', updatedAt: '', importedAt: '', origin: 'subagent' },
    ],
  }
  assert.throws(
    () => assignThreads(withRow, ['child-row'], 'a1'),
    (error) => error instanceof MapError && error.code === 'SUBAGENT',
  )
})

test('threadMoveTargets lists the Workspace row first, then the tree depth-first', () => {
  const state = seed()
  assert.deepEqual(threadMoveTargets(state, 'w1'), [
    { nodeId: null, label: '（工作区顶层）' },
    { nodeId: 'a', label: '外贸探索' },
    { nodeId: 'a1', label: '外贸探索 / 获客方式' },
  ])
  assert.deepEqual(threadMoveTargets(state, 'w2'), [
    { nodeId: null, label: '（工作区顶层）' },
    { nodeId: 'b', label: '产品设计' },
  ])

  const wider = createNode(state, { parentId: null, workspaceId: 'w1', title: '第二个主题', id: 'a2' }).state
  assert.deepEqual(threadMoveTargets(wider, 'w1').map(target => target.nodeId), [null, 'a', 'a1', 'a2'],
    'a child stays with its parent, before the next root')
})

test('threadMoveTargets breaks sibling ties by title and never repeats an id', () => {
  const tied = {
    ...emptyMap(),
    nodes: [
      { id: 'z', parentId: null, workspaceId: 'w1', title: 'Z 主题', description: '', position: 1, updatedAt: '' },
      { id: 'm', parentId: null, workspaceId: 'w1', title: 'M 主题', description: '', position: 1, updatedAt: '' },
      { id: 'other', parentId: null, workspaceId: 'w2', title: '别的工作区', description: '', position: 1, updatedAt: '' },
    ],
  }
  assert.deepEqual(threadMoveTargets(tied, 'w1').map(target => target.nodeId), [null, 'm', 'z'])
})

test('a document whose parent pointers loop cannot exhaust the stack', () => {
  const cyclic = {
    ...emptyMap(),
    nodes: [
      { id: 'x', parentId: 'y', workspaceId: 'w1', title: 'X', description: '', position: 1, updatedAt: '' },
      { id: 'y', parentId: 'x', workspaceId: 'w1', title: 'Y', description: '', position: 1, updatedAt: '' },
      { id: 'z', parentId: null, workspaceId: 'w1', title: 'Z', description: '', position: 1, updatedAt: '' },
    ],
  }
  // A target inside the loop is still a cycle, reported as a plain model error.
  assert.throws(
    () => moveNode(cyclic, 'x', 'y'),
    (error) => error instanceof MapError && error.code === 'CYCLE',
  )
  // Moving a looped node under an outside parent used to recurse forever in the
  // depth ceiling: it has to answer and land.
  const moved = moveNode(cyclic, 'x', 'z')
  assert.equal(moved.nodes.find(node => node.id === 'x').parentId, 'z')
  assert.deepEqual(threadMoveTargets(cyclic, 'w1').map(target => target.nodeId), [null, 'z', 'x', 'y'],
    'every node is still offered exactly once')
})

/* ── inserting at a slot: N7/N10 (drag position) ────────────────────────── */

/** One parent `p` with three ordered children A, B, C, all in `w1`. */
function slotted() {
  let state = createNode(emptyMap(), { parentId: null, workspaceId: 'w1', title: '父', id: 'p' }).state
  for (const id of ['A', 'B', 'C']) {
    state = createNode(state, { parentId: 'p', workspaceId: 'w1', title: id, id }).state
  }
  return state
}

/** Child ids of one parent, in display order. */
function idsUnder(state, parentId) {
  return childrenOf(state, parentId).map(node => node.id)
}

/** Positions of the named nodes, in the order given. */
function positionsOf(state, ids) {
  return ids.map(id => state.nodes.find(node => node.id === id).position)
}

test('insertNodeBefore appends when no anchor is given', () => {
  let state = slotted()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: 'D', id: 'D' }).state

  const appended = insertNodeBefore(state, 'D', 'p')
  assert.deepEqual(idsUnder(appended, 'p'), ['A', 'B', 'C', 'D'])
  assert.deepEqual(positionsOf(appended, ['A', 'B', 'C', 'D']), [1, 2, 3, 4])
  assert.equal(appended.nodes.find(node => node.id === 'D').parentId, 'p')
})

test('insertNodeBefore places a node at the middle, the head, and before the last sibling', () => {
  let state = slotted()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: 'D', id: 'D' }).state

  const middle = insertNodeBefore(state, 'D', 'p', 'B')
  assert.deepEqual(idsUnder(middle, 'p'), ['A', 'D', 'B', 'C'])
  assert.deepEqual(positionsOf(middle, ['A', 'D', 'B', 'C']), [1, 2, 3, 4])

  const head = insertNodeBefore(state, 'D', 'p', 'A')
  assert.deepEqual(idsUnder(head, 'p'), ['D', 'A', 'B', 'C'])
  assert.deepEqual(positionsOf(head, ['D', 'A', 'B', 'C']), [1, 2, 3, 4])

  const beforeLast = insertNodeBefore(state, 'D', 'p', 'C')
  assert.deepEqual(idsUnder(beforeLast, 'p'), ['A', 'B', 'D', 'C'])
})

test('re-ordering inside one parent is insertNodeBefore, and an unchanged slot is not written', () => {
  const state = slotted()

  // N10: the same-parent reorder M6 exists for — moveNode would append instead.
  const reordered = insertNodeBefore(state, 'C', 'p', 'A')
  assert.deepEqual(idsUnder(reordered, 'p'), ['C', 'A', 'B'])
  assert.deepEqual(positionsOf(reordered, ['C', 'A', 'B']), [1, 2, 3])

  // Already directly before C: the document must not move, revision and all.
  const unchanged = insertNodeBefore(state, 'B', 'p', 'C')
  assert.equal(unchanged, state, 'an unchanged slot returns the very same state')
  assert.equal(unchanged.revision, state.revision)

  // insertBefore(x, x) keeps x where it is.
  assert.equal(insertNodeBefore(state, 'B', 'p', 'B'), state)
})

test('insertNodeBefore refuses an anchor that is not a child of the target parent', () => {
  let state = slotted()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '另一个父', id: 'q' }).state
  state = createNode(state, { parentId: 'q', title: 'Q', id: 'Q' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w2', title: '别的区', id: 'other' }).state

  assert.throws(
    () => insertNodeBefore(state, 'A', 'p', 'Q'),
    (error) => error instanceof MapError && error.code === 'ANCHOR' && error.message === '锚点节点不在目标位置下。',
  )
  assert.throws(
    () => insertNodeBefore(state, 'A', 'p', 'other'),
    (error) => error instanceof MapError && error.code === 'ANCHOR',
  )
  assert.throws(
    () => insertNodeBefore(state, 'A', 'p', 'ghost'),
    (error) => error instanceof MapError && error.code === 'ANCHOR',
  )
  // The move itself is judged first: a foreign target reports WORKSPACE, not ANCHOR.
  assert.throws(
    () => insertNodeBefore(state, 'A', 'other', 'ghost'),
    (error) => error instanceof MapError && error.code === 'WORKSPACE',
  )
  assert.deepEqual(idsUnder(state, 'p'), ['A', 'B', 'C'], 'every refusal left the tree alone')
})

test('insertNodeBefore reuses the re-parent judgement for cycles and depth', () => {
  const state = slotted()
  assert.throws(
    () => insertNodeBefore(state, 'p', 'A'),
    (error) => error instanceof MapError && error.code === 'CYCLE',
  )

  let deep = createNode(emptyMap(), { parentId: null, workspaceId: 'w1', title: '层 1', id: 'c1' }).state
  for (let level = 2; level <= MAX_DEPTH; level += 1) {
    deep = createNode(deep, { parentId: `c${level - 1}`, title: `层 ${level}`, id: `c${level}` }).state
  }
  deep = createNode(deep, { parentId: null, workspaceId: 'w1', title: '高', id: 'tall' }).state
  deep = createNode(deep, { parentId: 'tall', title: '叶', id: 'leaf' }).state
  assert.throws(
    () => insertNodeBefore(deep, 'tall', `c${MAX_DEPTH - 1}`, `c${MAX_DEPTH}`),
    (error) => error instanceof MapError && error.code === 'DEPTH',
  )
  assert.throws(
    () => insertNodeBefore(deep, 'c1', 'tall', 'leaf'),
    (error) => error instanceof MapError && error.code === 'DEPTH',
  )
})

test('insertNodeBefore renumbers the target children and repairs duplicate positions', () => {
  let state = slotted()
  // A hand-built document may carry two children claiming the same slot.
  state = { ...state, nodes: state.nodes.map(node => node.id === 'B' ? { ...node, position: 1 } : node) }
  assert.deepEqual(idsUnder(state, 'p'), ['A', 'B', 'C'], 'the tie is broken by title, as sorted() does')

  const reordered = insertNodeBefore(state, 'C', 'p', 'A')
  assert.deepEqual(idsUnder(reordered, 'p'), ['C', 'A', 'B'])
  assert.deepEqual(positionsOf(reordered, ['C', 'A', 'B']), [1, 2, 3], 'duplicates are gone')
})

test('insertNodeBefore leaves the parent it came from in order', () => {
  let state = slotted()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '另一个父', id: 'q' }).state
  state = createNode(state, { parentId: 'q', title: 'Q1', id: 'Q1' }).state
  state = createNode(state, { parentId: 'q', title: 'Q2', id: 'Q2' }).state

  const moved = insertNodeBefore(state, 'Q2', 'p', 'B')
  assert.deepEqual(idsUnder(moved, 'p'), ['A', 'Q2', 'B', 'C'])
  assert.deepEqual(idsUnder(moved, 'q'), ['Q1'], 'the old parent keeps its remaining child')
  assert.equal(moved.nodes.find(node => node.id === 'Q1').position, 1, 'and its position is not renumbered')
})

test('moveNode still appends, so same-parent reordering stays insertNodeBefore\'s job', () => {
  const state = slotted()
  assert.deepEqual(idsUnder(moveNode(state, 'A', 'p'), 'p'), ['B', 'C', 'A'])
  assert.deepEqual(idsUnder(insertNodeBefore(state, 'C', 'p', 'B'), 'p'), ['A', 'C', 'B'])
})

