/**
 * Unit tests for the shared search presentation model.
 *
 * `buildSearchView` is what both the render tests and the live client consume:
 * it ranks the model's title/description matches, merges the Host's body hits,
 * and labels every row with the context the result column needs. The fixtures
 * are plain map documents, so these tests hold the ranking and the context
 * wording without a browser.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createNode, ensureDefaultSpace, emptyMap, searchMap, syncThreads } from '../lib/model.js'
import { buildSearchView, findTextMatch, snippetAround } from '../lib/search.js'

/** One map with two workspaces, nested nodes, and three conversations. */
function fixture() {
  let state = ensureDefaultSpace(emptyMap())
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '外贸探索', description: '从零起步，先谈定价', id: 'n1' }).state
  state = createNode(state, { parentId: 'n1', workspaceId: 'w1', title: '获客方式', description: '', id: 'n2' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w2', title: '家庭计划', description: '每周复盘一次', id: 'n3' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: '复盘模板', description: '外贸复盘用的模板', id: 'n4' }).state
  state = syncThreads(state, [
    { id: 's1', displayTitle: '外贸对话一' },
    { id: 's2', displayTitle: '定价讨论' },
    { id: 's3', displayTitle: '无关对话' },
  ], null, new Map([['s1', 'w1'], ['s2', 'w1'], ['s3', 'w2']]))
  return state
}

/** Workspace display names used by the context line. */
const TITLES = { w1: '外贸工作区', w2: '家庭工作区' }

/** Build a view for one query over the fixture. */
function view(state, query, contentHits) {
  return buildSearchView({
    state,
    results: searchMap(state, query),
    candidateThreads: state.threads,
    workspaceTitles: TITLES,
    contentHits,
  })
}

test('findTextMatch is case-insensitive and returns the original range', () => {
  assert.deepEqual(findTextMatch('Codex Notes', 'codex'), { start: 0, end: 5 })
  assert.deepEqual(findTextMatch('中文标题里的关键词', '关键词'), { start: 6, end: 9 })
  assert.equal(findTextMatch('abc', 'zzz'), null)
  assert.equal(findTextMatch('abc', '   '), null)
})

test('snippetAround keeps a readable window and marks the match', () => {
  const text = `${'前'.repeat(60)}，关键词出现，${'后'.repeat(60)}。`
  const range = findTextMatch(text, '关键词')
  const snippet = snippetAround(text, range.start, range.end)
  assert.equal(snippet.match, '关键词')
  assert.match(snippet.before, /^…/, 'the trimmed prefix starts with an ellipsis')
  assert.match(snippet.after, /…$/, 'the trimmed suffix ends with an ellipsis')
  assert.ok(snippet.before.endsWith('，'), 'the window ends where the match starts')
  // Whitespace collapses so one row can show it on a single line.
  const collapsed = snippetAround('a\n\nb  KEY  c\n d', 6, 9)
  assert.equal(collapsed.match, 'KEY')
  assert.equal(collapsed.before, 'a b')
  assert.equal(collapsed.after, 'c d')
})

test('a node title hit ranks above a description hit and carries its workspace path', () => {
  const state = fixture()
  const result = view(state, '外贸')
  // `外贸探索` matched in the title, `复盘模板` only in its description.
  assert.deepEqual(result.nodes.map(item => item.key), ['n1', 'n4'])
  assert.equal(result.nodes[0].titleMatch, true)
  assert.equal(result.nodes[1].titleMatch, false)
  assert.equal(result.nodes[1].snippet.match, '外贸')
  assert.equal(result.nodes[0].context, '外贸工作区', 'a top-level node names only its workspace')
})

test('a description hit shows the snippet in place of the context line', () => {
  const state = fixture()
  const result = view(state, '定价')
  const node = result.nodes[0]
  assert.equal(node.key, 'n1')
  assert.equal(node.titleMatch, false)
  assert.equal(node.snippet.match, '定价')
  assert.match(node.snippet.before, /从零起步|先谈/)
})

test('a nested node context lists the workspace and every ancestor', () => {
  const state = fixture()
  const result = view(state, '获客')
  assert.equal(result.nodes[0].key, 'n2')
  assert.equal(result.nodes[0].context, '外贸工作区 / 外贸探索')
})

test('conversation title hits list nodes first, then conversations with their home', () => {
  const state = fixture()
  const result = view(state, '定价')
  assert.deepEqual(result.items.map(item => item.kind), ['node', 'thread'])
  const thread = result.threads[0]
  assert.equal(thread.thread.sessionId, 's2')
  assert.equal(thread.titleMatch, true)
  assert.equal(thread.bodyMatch, false)
  assert.equal(thread.context, '外贸工作区')
})

test('a body hit becomes a conversation row with its snippet, even without a title match', () => {
  const state = fixture()
  const hits = new Map([['s2', {
    sessionId: 's2',
    messages: 3,
    snippet: { before: '讨论中提到的', match: '锚点', after: '概念' },
  }]])
  const result = view(state, '锚点', hits)
  assert.equal(result.nodes.length, 0)
  assert.equal(result.threads.length, 1)
  const thread = result.threads[0]
  assert.equal(thread.thread.sessionId, 's2')
  assert.equal(thread.titleMatch, false)
  assert.equal(thread.bodyMatch, true)
  assert.equal(thread.snippet.match, '锚点')
  assert.deepEqual(result.items.map(item => item.key), ['s2'])
})

test('a body hit already shown under its matched node is not repeated in the flat list', () => {
  let state = fixture()
  state = {
    ...state,
    threads: [
      ...state.threads,
      { sessionId: 's9', nodeId: 'n2', title: '一条无关标题', updatedAt: '', workspaceId: 'w1' },
    ],
  }
  const hits = new Map([['s9', { sessionId: 's9', messages: 1, snippet: { before: '', match: '获客', after: '' } }]])
  const result = view(state, '获客', hits)
  assert.deepEqual(result.nodes.map(item => item.key), ['n2'])
  assert.equal(result.threads.length, 0, 'the conversation lives under the node row instead')
})

test('a stale body hit for a session outside the index is dropped', () => {
  const state = fixture()
  const hits = new Map([['gone', { sessionId: 'gone', messages: 1, snippet: null }]])
  const result = view(state, '锚点', hits)
  assert.equal(result.threads.length, 0)
})

test('an unknown query produces an empty view', () => {
  const state = fixture()
  const result = view(state, '完全不存在')
  assert.equal(result.empty, true)
  assert.deepEqual(result.items, [])
})
