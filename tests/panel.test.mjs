/**
 * Render tests for the conversation-management page.
 *
 * The plugin's real panel is rendered outside the browser through
 * `react-dom/server`, with the slot props the framework would inject stubbed
 * and a plain object standing in for the backing store. Effects do not run under
 * this renderer, so what is asserted here is the structure the user sees before
 * any conversation binds.
 *
 * The first level is the Host's Workspace list, so the stubbed Workspaces
 * service is a real part of every fixture.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_PX, DragLabel, MapPanel, MoveThreadField, NodeColumnView,
  NodePositionField, SPRING_LOAD_MS, applyDragPlan, autoScrollStep, candidateFromRow, commitsOnEnter,
  consumeOneShot, dialogClass, dragLabelStyle, edgeOfRow, enterCommits, followAfterMove,
  followNativeNavigation, heldOverlay, insertionLineStyle, moveFailureMessage, moveTreeRows,
  planFromDecision, showsStatusRollup, siblingTargets, springLoadTarget, threadMenuModel, threadMoveChange,
  threadMoveDefault, threadMoveIsNoop, threadMoveOptions, treeStep, visibleTreeRows, SpaceMenuTrailing,
} from '../lib/panel.js'
import { MapError } from '../lib/model.js'
import { ensureDefaultSpace, parseMapState, syncCatalog } from '../lib/model.js'
import { createStatusLedger } from '../lib/status-ledger.js'

/** Two hours ago, as an ISO stamp. */
function ago(hours) {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

/** The catalog the stubbed `useSessions` answers from. */
const CATALOG = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { displayTitle: '第一条对话' },
    s2: { displayTitle: '散落对话' },
    s3: { displayTitle: '第三条对话' },
  },
}

/** The Host Workspace list: alpha owns s1, beta owns s3, s2 floats ungrouped. */
const WORKSPACES = {
  phase: 'ready',
  items: [
    { workspaceId: 'w1', path: '/tmp/alpha', title: 'alpha', sessionIds: ['s1'] },
    { workspaceId: 'w2', path: '/tmp/beta', title: 'beta', sessionIds: ['s3'] },
  ],
}

/**
 * Stub the application's status hook.
 * @param entries - per-session status values.
 * @returns a `useSessionStatus`-shaped function.
 */
function useStatus(entries) {
  const snapshot = new Map(Object.entries(entries))
  return selector => selector(snapshot)
}

/** A session whose own subagents are still working. */
const SUBAGENT_CATALOG = {
  ...CATALOG,
  byId: { ...CATALOG.byId, child: { displayTitle: '子智能体' } },
  projectionsBySession: { s1: { values: { subagentCatalog: [{ id: 'child' }] } } },
}

/** Two subagent children of s1, as the catalog reports them: parented, not rows. */
const SUBAGENT_CHILDREN = {
  ids: [...CATALOG.ids, 'child1', 'child2'],
  byId: {
    ...CATALOG.byId,
    child1: { displayTitle: '子智能体一', origin: 'subagent', parentId: 's1' },
    child2: { displayTitle: '子智能体二', origin: 'subagent', parentId: 's1' },
  },
}

/** A topic tree inside Workspace alpha, plus one ungrouped conversation. */
const MAP = {
  version: 2,
  revision: 1,
  nodes: [
    { id: 'n1', parentId: null, workspaceId: 'w1', title: '外贸探索', description: '从零起步', position: 1, updatedAt: '' },
    { id: 'n2', parentId: 'n1', workspaceId: 'w1', title: '获客方式', description: '先看低成本渠道', position: 1, updatedAt: '' },
  ],
  threads: [
    { sessionId: 's1', nodeId: 'n1', workspaceId: 'w1', title: '第一条对话', updatedAt: ago(2), importedAt: '' },
    { sessionId: 's2', nodeId: null, workspaceId: null, title: '散落对话', updatedAt: ago(2), importedAt: '' },
    { sessionId: 's3', nodeId: null, workspaceId: 'w2', title: '第三条对话', updatedAt: ago(1), importedAt: '' },
  ],
}

/** An index written before the rule: the two children were conversations of their own. */
const PRE_RULE_MAP = {
  ...MAP,
  threads: [
    ...MAP.threads,
    { sessionId: 'child1', nodeId: null, workspaceId: null, title: '子智能体一', updatedAt: ago(1), importedAt: '' },
    { sessionId: 'child2', nodeId: null, workspaceId: null, title: '子智能体二', updatedAt: ago(1), importedAt: '' },
  ],
}

/** One node holding more conversations than the preview shows. */
const BUSY_MAP = {
  version: 2,
  revision: 1,
  nodes: [
    { id: 'n1', parentId: null, workspaceId: 'w1', title: '外贸探索', description: '', position: 1, updatedAt: '' },
  ],
  threads: Array.from({ length: 7 }, (_, index) => ({
    sessionId: `b${String(index)}`,
    nodeId: 'n1',
    workspaceId: 'w1',
    title: `对话 ${String(index)}`,
    updatedAt: ago(2),
    importedAt: '',
  })),
}

/** The same node, with two of its conversations owning subagent children. */
const BUSY_WITH_CHILDREN = {
  ...BUSY_MAP,
  threads: [
    ...BUSY_MAP.threads,
    { sessionId: 'child1', nodeId: 'n1', workspaceId: 'w1', title: '子智能体一', updatedAt: ago(1), importedAt: '' },
    { sessionId: 'child2', nodeId: 'n1', workspaceId: 'w1', title: '子智能体二', updatedAt: ago(1), importedAt: '' },
  ],
}

/** The catalog of {@link BUSY_WITH_CHILDREN}: seven rows and two subagent children. */
const BUSY_WITH_CHILDREN_CATALOG = {
  ids: [...BUSY_MAP.threads.map(thread => thread.sessionId), 'child1', 'child2'],
  byId: {
    ...Object.fromEntries(BUSY_MAP.threads.map(thread => [thread.sessionId, { displayTitle: thread.title }])),
    child1: { displayTitle: '子智能体一', origin: 'subagent', parentId: 'b0' },
    child2: { displayTitle: '子智能体二', origin: 'subagent', parentId: 'b1' },
  },
}

/** A Workspace holding direct conversations whose stored order is oldest-first. */
const DIRECT_ORDER_MAP = {
  version: 2,
  revision: 1,
  nodes: [],
  threads: [
    { sessionId: 'old', nodeId: null, workspaceId: 'w1', title: '更早的一轮', updatedAt: '2024-01-01T00:00:00.000Z', importedAt: '' },
    { sessionId: 'newest', nodeId: null, workspaceId: 'w1', title: '最近的一轮', updatedAt: '2024-12-01T00:00:00.000Z', importedAt: '' },
  ],
}

/** A complete stored view document. */
function view(patch = {}) {
  return {
    version: 1,
    selectedNodeId: null,
    collapsedIds: [],
    navCollapsed: false,
    openSessionId: null,
    scroll: [],
    columnWidths: [],
    nodePanelWidth: 300,
    mapWidth: 560,
    ...patch,
  }
}

/**
 * Build the backing store the panel reads.
 * @param map - conversation-map document, or undefined for none.
 * @param stored - view document, or undefined for none.
 * @returns the injected store.
 */
function store(map, stored) {
  const backing = new Map()
  if (map !== undefined) backing.set('dsh.conversation-map.v1', JSON.stringify(map))
  if (stored !== undefined) backing.set('dsh.conversation-map.view.v1', JSON.stringify(stored))
  return {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
}

/**
 * Apply the index pass the panel's catalog effect runs.
 *
 * Effects do not run under `renderToStaticMarkup`, so a fixture that wants to
 * show what a catalog sync produces runs the same pure passes itself. The order
 * matters and mirrors `MapPanel`: the WHOLE catalog goes to `syncThreads` (it
 * applies visibility itself and records subagent children in the ledger), while
 * the filtered rows are only the prune target.
 * @param map - the stored conversation-map document.
 * @param catalog - the catalog fixture the stubbed hook answers from.
 * @param openSessionId - the conversation currently open, if any.
 * @returns the synced document.
 */
function synced(map, catalog, openSessionId = null) {
  const document = ensureDefaultSpace(parseMapState(JSON.stringify(map)))
  const rows = catalog.ids.map(id => ({
    id,
    displayTitle: catalog.byId[id]?.displayTitle ?? catalog.byId[id]?.title ?? id,
    updatedAt: catalog.byId[id]?.updatedAt,
    blank: catalog.byId[id]?.blank,
    origin: catalog.byId[id]?.origin,
    parentId: catalog.byId[id]?.parentId,
  }))
  // The panel and this helper share one entry point, so the pass order cannot
  // drift between them: `syncCatalog` takes the whole catalog and reports the
  // visible rows itself.
  return syncCatalog(document, rows, { openSessionId }).state
}

/**
 * Stub the Workspace Controller.
 * @param snapshot - the snapshot the panel reads; defaults to the fixture.
 * @returns a service-shaped object.
 */
function workspaces(snapshot = WORKSPACES) {
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    create: async input => ({ workspaceId: 'w9', path: input.path, title: '新工作区', sessionIds: [] }),
    rename: async (workspaceId, title) => ({ workspaceId, path: '/tmp/x', title, sessionIds: [] }),
    delete: async () => {},
  }
}

/**
 * A ready, in-memory map store over the same backing storage the view uses.
 *
 * Production reads the Host; the render tests only need the page's read model,
 * so the fake applies mutations synchronously to the parsed document.
 * @param backing - the injected view/business storage.
 * @returns a `MapStore`-shaped object.
 */
function fakeStore(backing) {
  let snapshot = {
    phase: 'ready',
    doc: ensureDefaultSpace(parseMapState(backing.getItem('dsh.conversation-map.v1'))),
    revision: 0,
    pending: 0,
  }
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(change) {
      snapshot = { ...snapshot, doc: change(snapshot.doc) }
      for (const listener of [...listeners]) listener()
      return { ok: true }
    },
    refresh: async () => {},
    load: async () => {},
    dispose() {},
  }
}

/**
 * Render the panel with framework-shaped stubs.
 * @param storage - the backing store to inject.
 * @param overrides - props to replace.
 * @returns the static markup.
 */
function render(storage, overrides = {}) {
  const services = {
    sessions: { retain: id => ({ sessionId: id, release() {} }) },
    workspaces: workspaces(),
    store: fakeStore(storage),
    ...overrides.services,
  }
  return renderToStaticMarkup(createElement(MapPanel, {
    storage,
    useSessions: selector => selector(CATALOG),
    ...overrides,
    services,
  }))
}

/** Count rendered node columns. */
function columnCount(markup) {
  return markup.split('class="cm-node-col"').length - 1
}

test('an empty map still renders the band, node area, and Workspace list', () => {
  const markup = render(store(undefined, undefined))
  assert.ok(markup.includes('cm-band'))
  assert.ok(markup.includes('cm-node-area'))
  assert.ok(markup.includes('cm-node-col'))
  assert.ok(markup.includes('alpha'), 'the first Workspace is listed')
  assert.ok(markup.includes('beta'), 'the second Workspace is listed')
  assert.ok(markup.includes('class="cm-col-title" title="L1"'), 'the level column carries its number')
  assert.ok(!markup.includes('cm-chat'), 'the map no longer embeds a Conversation occurrence')
})

test('first-level nodes are the Host Workspaces, in Host order', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(markup.includes('data-kind="workspace"'), 'Workspace rows carry their own kind')
  assert.equal((markup.match(/data-kind="workspace"/g) ?? []).length, 2, 'one row per Workspace')
  assert.ok(markup.indexOf('alpha') < markup.indexOf('beta'), 'the Host order is kept')
})

test('the ungrouped bucket trails the Workspaces and holds conversations outside every Workspace', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(markup.includes('未分组'))
  assert.ok(markup.indexOf('beta') < markup.indexOf('未分组'), 'the bucket trails the Workspaces')
  const ungrouped = markup.indexOf('未分组')
  assert.ok(ungrouped < markup.indexOf('散落对话'), 'the unowned conversation sits under the bucket')
})

test('a Workspace shows the conversations the Host accounts to it directly', () => {
  const markup = render(store(MAP, undefined))
  const beta = markup.indexOf('beta')
  const direct = markup.indexOf('第三条对话')
  assert.ok(beta < direct, 'the direct conversation follows its Workspace row')
})

test('selecting a Workspace opens its topic column, labelled by level', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ws:w1' })))
  assert.equal(columnCount(markup), 2, 'the Workspace column plus the open Workspace topic column')
  assert.ok(markup.includes('外贸探索'), 'the top-level topic is listed')
  const titles = [...markup.matchAll(/class="cm-col-title" title="([^"]*)"/g)].map(match => match[1])
  assert.deepEqual(titles, ['L1', 'L2'])
})

test('an empty Workspace opens no topic column', () => {
  const empty = { phase: 'ready', items: [{ workspaceId: 'w1', path: '/tmp/empty', title: '空的', sessionIds: [] }] }
  const markup = render(store(undefined, view({ selectedNodeId: '@ws:w1' })), {
    services: { sessions: { retain: id => ({ sessionId: id, release() {} }) }, workspaces: workspaces(empty) },
  })
  assert.equal(columnCount(markup), 1, 'an empty column beside the tree is dead space, so it is not drawn')
  assert.ok(!markup.includes('aria-label="新增节点"'), 'the first topic is created from the Workspace row menu instead')
})

test('selecting a node or a Workspace no longer renders the removed information bar', () => {
  for (const selection of ['n1', '@ws:w1']) {
    const markup = render(store(MAP, view({ selectedNodeId: selection })))
    assert.ok(!markup.includes('class="cm-info"'), 'the bottom information bar is gone')
    assert.ok(!markup.includes('详情'), 'its 详情 affordance is gone too')
    assert.ok(!markup.includes('aria-controls="cm-info-body"'), 'no panel body is left behind')
  }
})

test('selecting a topic opens every level beneath it', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.equal(columnCount(markup), 3, 'Workspaces, its topics, and the selected topic children')
  assert.ok(markup.includes('获客方式'), 'the child is listed')
  const titles = [...markup.matchAll(/class="cm-col-title" title="([^"]*)"/g)].map(match => match[1])
  assert.deepEqual(titles, ['L1', 'L2', 'L3'])
})

test('every deeper column keeps counting levels instead of naming a kind', () => {
  // A five-deep chain: selecting the middle node opens L1 through L5, so the
  // fifth level reads "L5" rather than a semantic label that stops at four.
  const deep = {
    version: 2,
    revision: 1,
    nodes: [1, 2, 3, 4, 5].map(step => ({
      id: `d${String(step)}`,
      parentId: step === 1 ? null : `d${String(step - 1)}`,
      workspaceId: 'w1',
      title: `第 ${String(step)} 层`,
      description: '',
      position: 1,
      updatedAt: '',
    })),
    threads: [],
  }
  const markup = render(store(deep, view({ selectedNodeId: 'd3' })))
  const titles = [...markup.matchAll(/class="cm-col-title" title="([^"]*)"/g)].map(match => match[1])
  assert.deepEqual(titles, ['L1', 'L2', 'L3', 'L4', 'L5'])
})

test('a topic conversation list is nested under its row', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  const topic = markup.indexOf('外贸探索')
  const owned = markup.indexOf('第一条对话')
  assert.ok(topic < owned, 'the filed conversation sits under its topic')
})

test('only a selected row adds a deeper column', () => {
  const markup = render(store(MAP, view({ selectedNodeId: null })))
  assert.equal(columnCount(markup), 1, 'nothing is selected, so only the Workspace column exists')
})

test('a selected leaf adds no empty trailing column', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n2' })))
  assert.equal(columnCount(markup), 3, 'Workspaces, the topic column, and the column the leaf sits in')
})

test('the Workspace column offers adopting a Workspace, topic columns offer adding topics', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ws:w1' })))
  assert.ok(markup.includes('aria-label="新增工作区"'), 'the first level adds Workspaces')
  assert.ok(markup.includes('aria-label="新增节点"'), 'the second level adds topics')
  assert.equal((markup.match(/class="cm-col-actions"/g) ?? []).length, columnCount(markup), 'one add button per column')
})

test('a Workspace draws its conversations newest activity first', () => {
  const markup = render(store(DIRECT_ORDER_MAP, undefined))
  const newest = markup.indexOf('最近的一轮')
  const oldest = markup.indexOf('更早的一轮')
  assert.ok(newest !== -1 && oldest !== -1, 'both rows are drawn')
  assert.ok(newest < oldest, 'the newest conversation sits above the older one')
})

test('a node draws its conversations newest activity first', () => {
  const ordered = {
    version: 2,
    revision: 1,
    nodes: [
      { id: 'n1', parentId: null, workspaceId: 'w1', title: '外贸探索', description: '', position: 1, updatedAt: '' },
    ],
    threads: [
      { sessionId: 'a', nodeId: 'n1', workspaceId: 'w1', title: '更早的一轮', updatedAt: '2024-01-01T00:00:00.000Z', importedAt: '' },
      { sessionId: 'b', nodeId: 'n1', workspaceId: 'w1', title: '最新的一轮', updatedAt: '2024-12-01T00:00:00.000Z', importedAt: '' },
    ],
  }
  const markup = render(store(ordered, view({ selectedNodeId: 'n1' })))
  const newest = markup.indexOf('最新的一轮')
  const oldest = markup.indexOf('更早的一轮')
  assert.ok(newest !== -1 && oldest !== -1, 'both rows are drawn')
  assert.ok(newest < oldest, 'the newest conversation sits above the older one')
})

test('a Workspace folds its conversation list away', () => {
  const open = render(store(MAP, undefined))
  assert.ok(open.includes('第三条对话'), 'the list is shown by default')
  const folded = render(store(MAP, view({ collapsedIds: ['@ws:w2'] })))
  assert.ok(!folded.includes('第三条对话'), 'folding hides that Workspace conversations')
  assert.ok(folded.includes('beta'), 'the Workspace row itself stays')
})

test('no conversation row shows an id or an open button', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(!markup.includes('cm-id'), 'ids are gone from the list')
  assert.ok(!markup.includes('>打开<'), 'opening is the row click, not a button')
})

test('every node row carries the two per-row actions', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(markup.includes('cm-node-row'), 'node rows are rendered')
  assert.ok(markup.includes('aria-label="发起对话"'), 'a row offers starting a conversation')
  assert.ok(markup.includes('aria-label="更多"'), 'a row offers a more menu')
})

test('a Workspace row starts conversations in its own Workspace', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(markup.includes('title="在该工作区发起新对话"'), 'the row says where the conversation will live')
})

test('a conversation row carries its age behind the hover actions', () => {
  const markup = render(store(MAP, undefined))
  assert.match(markup, /<span class="cm-time">[^<]+<\/span>/, 'the age is rendered')
  assert.ok(markup.includes('cm-row-actions'), 'the actions sit in the trailing cell')
  assert.ok(markup.indexOf('cm-time') < markup.indexOf('cm-row-actions', markup.indexOf('cm-thread-row')), 'the actions follow the age')
})

test('an ordinary conversation row keeps its single line, whatever its position', () => {
  // Regression: `threads.map(threadRowOf)` once handed the array index to the
  // row builder's optional `note`, so every ordinary row grew a second line with
  // its own 0-based position ("0", "1", …). The note belongs to the search view.
  const markup = render(store(BUSY_MAP, view({ selectedNodeId: 'n1' })))
  assert.ok(markup.includes('cm-thread-row'), 'the fixture still draws conversation rows')
  assert.ok(!markup.includes('class="cm-row-note"'), 'no ordinary row draws a second line')
  assert.ok(!markup.includes('data-note="true"'), 'no ordinary row advertises a note')
})

test('the ungrouped bucket shows unassigned conversations', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ungrouped' })))
  assert.ok(markup.includes('未分组'))
  assert.ok(markup.includes('散落对话'))
})

test('a node with more conversations than the preview folds them', () => {
  const markup = render(store(BUSY_MAP, view({ selectedNodeId: 'n1' })))
  const shown = (markup.match(/class="cm-thread-row"/g) ?? []).length
  assert.equal(shown, 5, 'only the preview is drawn')
  assert.ok(markup.includes('显示更多（还有 2 条）'), 'the rest wait behind a reveal row')
})

test('a node within the preview shows no reveal row', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.ok(!markup.includes('显示更多'), 'a single conversation needs no reveal row')
})

test('a view pointing at a deleted node falls back without crashing', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'gone', openSessionId: 'gone' })))
  assert.equal(columnCount(markup), 1)
  assert.ok(markup.includes('alpha'))
})

test('a view pointing at a removed Workspace falls back to no selection', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ws:gone' })))
  assert.equal(columnCount(markup), 1)
  assert.ok(!markup.includes('title="L2"'), 'no topic column for a Workspace that is gone')
})

test('the open conversation is marked current and its owning node stays selected', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })))
  assert.equal((markup.match(/data-selected="true"/g) ?? []).length, 2, 'one node and one conversation are marked')
  assert.match(markup, /class="cm-thread-row"[^>]*aria-current="page"[^>]*title="第一条对话"/)
  assert.match(markup, /class="cm-node-row"[^>]*data-selected="true"[^>]*title="外贸探索"/)
})

test('a closed conversation is not marked current', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.equal((markup.match(/data-selected="true"/g) ?? []).length, 1, 'only the selected node is marked')
  assert.ok(!markup.includes('aria-current="page"'), 'no conversation claims to be the one being read')
})

test('a deep selection marks its whole lineage, Workspace row included', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n2' })))
  assert.match(markup, /class="cm-node-row"[^>]*data-selected="true"[^>]*title="获客方式"/, 'the selected leaf keeps the selection mark')
  assert.match(markup, /class="cm-node-row"[^>]*data-path-selected="true"[^>]*title="外贸探索"/, 'the parent row marks the path')
  assert.match(markup, /data-kind="workspace"[^>]*data-path-selected="true"[^>]*title="alpha"/, 'the owning Workspace row marks the path')
  assert.equal((markup.match(/data-path-selected="true"/g) ?? []).length, 2, 'one mark per level above the selection, no more')
})

test('rows off the lineage stay unmarked', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n2' })))
  assert.match(markup, /data-kind="workspace"[^>]*data-path-selected="false"[^>]*title="beta"/, 'a sibling Workspace is not on the path')
  assert.match(markup, /data-kind="ungrouped"[^>]*data-path-selected="false"[^>]*title="未分组"/, 'the ungrouped bucket is not on the path')
})

test('an open conversation marks its owning node and the lineage above it', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })))
  assert.equal((markup.match(/data-selected="true"/g) ?? []).length, 2, 'the conversation and its owning node keep the selection marks')
  assert.equal((markup.match(/data-path-selected="true"/g) ?? []).length, 1, 'only the Workspace row is above the owning node')
  assert.match(markup, /data-kind="workspace"[^>]*data-path-selected="true"[^>]*title="alpha"/)
})

test('a Workspace selection has no lineage above it', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ws:w1' })))
  assert.equal((markup.match(/data-path-selected="true"/g) ?? []).length, 0, 'the first level is the top of the chain')
  assert.match(markup, /class="cm-node-row"[^>]*data-selected="true"[^>]*title="alpha"/)
})

test('every level above a deep selection marks the path, not just the parent', () => {
  const deep = {
    version: 2,
    revision: 1,
    nodes: [1, 2, 3, 4, 5].map(step => ({
      id: `d${String(step)}`,
      parentId: step === 1 ? null : `d${String(step - 1)}`,
      workspaceId: 'w1',
      title: `第 ${String(step)} 层`,
      description: '',
      position: 1,
      updatedAt: '',
    })),
    threads: [],
  }
  const markup = render(store(deep, view({ selectedNodeId: 'd3' })))
  const marked = [...markup.matchAll(/class="cm-node-row"[^>]*data-path-selected="true"[^>]*title="([^"]*)"/g)]
    .map(match => match[1])
  assert.deepEqual(marked, ['alpha', '第 1 层', '第 2 层'], 'Workspace, then each ancestor from the root down')
})

test('a missing session service does not break the render', () => {
  const markup = render(store(MAP, undefined), { useSessions: undefined })
  assert.ok(markup.includes('cm-band'))
})

test('a still-arriving Workspace list says so instead of showing an empty level', () => {
  const pending = render(store(MAP, undefined), {
    services: {
      sessions: { retain: id => ({ sessionId: id, release() {} }) },
      workspaces: workspaces({ phase: 'pending', items: [] }),
    },
  })
  assert.ok(pending.includes('正在同步工作区…'))
  assert.ok(!pending.includes('散落对话'), 'nothing is filed into a Workspace before the list arrives')
})

test('a running conversation shows the application spinner, not a dot', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), { useSessionStatus: useStatus({ s1: { running: true } }) })
  assert.ok(markup.includes('class="cm-ring"'), 'the spinning ring marks a running conversation')
  assert.ok(markup.includes('cm-ring-track') && markup.includes('cm-ring-arc'), 'the ring draws track and arc')
  assert.ok(!markup.includes('cm-state-dot'), 'no solid dot for a running conversation')
})

test('an idle conversation shows no mark at all', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), { useSessionStatus: useStatus({ s1: { running: false } }) })
  assert.ok(!markup.includes('cm-ring'), 'nothing spins')
  assert.ok(!markup.includes('cm-state-dot'), 'an idle row is blank, exactly like the shipped list')
})

test('a pending approval warns and states itself instead of the age', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'approval' } } }),
  })
  assert.ok(markup.includes('data-state="warning"'), 'a warning mark is drawn')
  assert.ok(markup.includes('>待审批<'), 'the compact wording takes the age cell')
})

test('plan review and question requests use their own wording', () => {
  const review = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'plan-review' } } }),
  })
  assert.ok(review.includes('>计划待审<'))
  const question = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'question' } } }),
  })
  assert.ok(question.includes('>待回答<'))
})

test('a pending request outranks live activity', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { running: true, pendingInteraction: { kind: 'approval' } } }),
  })
  assert.ok(markup.includes('data-state="warning"'), 'the warning wins')
  assert.ok(!markup.includes('cm-ring'), 'the ring gives way to the pending request')
})

test('an unread completion draws the done mark', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { completionUnread: true } }),
  })
  assert.ok(markup.includes('data-state="done"'), 'a done mark is drawn')
})

test('a session whose subagents are still working reads as ongoing', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessions: selector => selector(SUBAGENT_CATALOG),
    useSessionStatus: useStatus({ child: { running: true } }),
  })
  assert.ok(markup.includes('class="cm-ring"'), 'live subagents keep the row spinning')
})

test('a catalog holding subagent children renders no row for them', () => {
  const markup = render(store(synced(PRE_RULE_MAP, SUBAGENT_CHILDREN), view({ selectedNodeId: '@ungrouped' })))
  assert.ok(!markup.includes('子智能体'), 'no row names a subagent child')
  assert.ok(markup.includes('散落对话'), 'ordinary conversations stay listed')
})

test('a catalog sync records each subagent child in the ledger as well as hiding it', () => {
  // Pins the pass order the panel uses: the whole catalog reaches syncThreads,
  // so the child is recorded before it is dropped. A caller that pre-filtered
  // its rows would render identically and still empty the ledger — the exact
  // regression this assertion exists to catch.
  const document = synced(PRE_RULE_MAP, SUBAGENT_CHILDREN)
  assert.deepEqual(document.subagentSessionIds?.slice().sort(), ['child1', 'child2'], 'each child is recorded')
  assert.ok(
    !document.threads.some(thread => thread.sessionId === 'child1' || thread.sessionId === 'child2'),
    'and none of them holds a row',
  )
  assert.ok(document.threads.some(thread => thread.sessionId === 's1'), 'ordinary conversations are still indexed')
})

test('the reveal count measures conversations, not subagent children', () => {
  const markup = render(store(synced(BUSY_WITH_CHILDREN, BUSY_WITH_CHILDREN_CATALOG), view({ selectedNodeId: 'n1' })))
  assert.equal((markup.match(/class="cm-thread-row"/g) ?? []).length, 5, 'only the preview is drawn')
  assert.ok(markup.includes('显示更多（还有 2 条）'), 'the two subagent children are not counted')
  assert.ok(!markup.includes('子智能体'), 'and they draw no row of their own')
})

test('an unknown interaction kind draws nothing', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'something-new' } } }),
  })
  assert.ok(!markup.includes('cm-state-dot'), 'only the shipped kinds are drawn')
})

test('only nodes carry a glyph', () => {
  const markup = render(store(MAP, undefined))
  assert.ok(markup.includes('M1.6 4.3'), 'a folder glyph marks a node')
  assert.ok(!markup.includes('M2.1 3.6'), 'a conversation carries no glyph of its own')
})

/* ── spaces ─────────────────────────────────────────────────────────────── */

/**
 * Two Workspaces filed into two spaces, one loose conversation in the work
 * space, one legacy rootless topic in the default space, and one empty space.
 */
const SPACES_MAP = {
  version: 2,
  revision: 1,
  nodes: [
    { id: 'n1', parentId: null, workspaceId: 'w1', title: '外贸探索', description: '', position: 1, updatedAt: '' },
    { id: 'u1', parentId: null, workspaceId: null, title: '历史无主主题', description: '', position: 1, updatedAt: '' },
  ],
  threads: [
    { sessionId: 's1', nodeId: 'n1', workspaceId: 'w1', title: '第一条对话', updatedAt: ago(2), importedAt: '' },
    { sessionId: 's2', nodeId: null, workspaceId: null, spaceId: 'sp-work', title: '散落对话', updatedAt: ago(2), importedAt: '' },
    { sessionId: 's3', nodeId: null, workspaceId: 'w2', title: '第三条对话', updatedAt: ago(1), importedAt: '' },
  ],
  spaces: [
    { id: 'sp-default', title: '默认空间', position: 1, createdAt: '' },
    { id: 'sp-work', title: '工作空间', position: 2, createdAt: '' },
    { id: 'sp-family', title: '家庭空间', position: 3, createdAt: '' },
    { id: 'sp-empty', title: '空的空间', position: 4, createdAt: '' },
  ],
  defaultSpaceId: 'sp-default',
  spaceOf: { w1: 'sp-work', w2: 'sp-family' },
}

/** The markup of one rendered node row, up to its first conversation row. */
function rowMarkup(markup, kind) {
  const start = markup.indexOf(`data-kind="${kind}"`)
  assert.ok(start !== -1, `the ${kind} row is rendered`)
  const threadStart = markup.indexOf('cm-thread-row', start)
  return markup.slice(start, threadStart === -1 ? start + 1500 : threadStart)
}

test('the very first render bootstraps one default space and shows it in the second row', () => {
  const markup = render(store(undefined, undefined))
  assert.ok(markup.includes('默认空间'), 'the switcher names the default space')
  const viewToggle = markup.indexOf('cm-view-toggle')
  const spaceSwitcher = markup.indexOf('cm-space-btn')
  const searchToggle = markup.indexOf('cm-band-search-toggle')
  assert.ok(viewToggle !== -1 && spaceSwitcher !== -1 && searchToggle !== -1)
  const row2 = markup.indexOf('cm-band-row2')
  assert.ok(row2 !== -1 && row2 < spaceSwitcher, 'the space switcher leads the second row, on the node list rail')
  assert.ok(viewToggle < searchToggle, 'the single view button leads the head row, then the search action')
  assert.ok(!markup.includes('cm-brand'), 'the band carries no brand of its own')
})

test('search is on demand: the resting header keeps the row but shows no input', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.ok(markup.includes('cm-band-row2'), 'the second row stays, so the band keeps the shipped tab row height')
  assert.ok(!markup.includes('aria-label="搜索节点或对话"'), 'no search box on screen until it is asked for')
  assert.match(markup, /class="cm-btn cm-band-search-toggle"[^>]*aria-label="搜索"[^>]*aria-expanded="false"/)
})

/**
 * The band's top bar is a window-chrome row, so it claims the shell's drag mark.
 *
 * macOS desktop dragging is opt-in per row: the shell's base.css declares the
 * one darwin drag rule for `[data-window-drag]` (plus the global no-drag list
 * that keeps controls clickable), and every chrome row marks itself — the
 * sidebar's top strip and logo row, and the Conversation header. Map mode
 * collapses the product's left column, so the sidebar's two rows leave with it,
 * and the plugin's reservation shifts the Conversation header one band-width
 * right. This top bar is the row left over that strip, and the drag geometry is
 * not inherited from the neighbouring header: without the mark the window
 * cannot be dragged from the band's blank runs at all.
 */
test('the band top bar claims the shell window drag row', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })))
  const topbar = markup.match(/<header[^>]*cm-band-topbar[^>]*>/)?.[0] ?? ''
  assert.notEqual(topbar, '', 'the band renders its top bar')
  assert.match(topbar, /data-window-drag/, 'the top bar is the map surface\'s window drag row')
})

/**
 * The resize handle is the band's child, not the body's — so its hit area starts
 * at y=0 and covers the seam's header portion too.
 *
 * The handle draws the whole seam line, and the header no longer paints a copy
 * of it. Rendering it inside `.cm-band-body` left the top 40/76px of the line as
 * decoration: a press there resized nothing (and on macOS dragged the window,
 * since the top bar above owns the drag region). The structural half is pinned
 * here; `tests/styles.test.mjs` pins the declarations that make it work.
 */
test('the resize handle is a child of the band, after the body, so the header seam is draggable', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })))
  const handle = markup.indexOf('cm-band-gutter')
  const body = markup.indexOf('cm-band-body')
  const topbar = markup.indexOf('cm-band-topbar')
  assert.notEqual(handle, -1, 'the band renders its resize handle')
  assert.notEqual(body, -1, 'the band renders its body')
  assert.ok(topbar !== -1 && topbar < body, 'the header precedes the body')
  assert.ok(
    handle > body,
    'the handle must not be nested inside the body: a body child starts at the shipped header\'s foot',
  )

  /* It has to follow the body in document order: Electron composes app-regions
     with the last matching box winning, so the handle's `no-drag` only overrides
     the top bar's `drag` while it comes after it. */
  const afterBody = markup.slice(body)
  const bodyEnd = afterBody.indexOf('</div></div>')
  assert.ok(
    bodyEnd === -1 || handle > body + bodyEnd,
    'the handle sits after the body\'s closing tag, not inside it',
  )
  assert.match(
    markup.slice(handle - 200, handle + 40),
    /role="separator"/,
    'and it stays the separator assistive technology reads',
  )
})

test('a document with spaces shows the remembered space in the switcher', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-work' })))
  const switcher = markup.slice(markup.indexOf('cm-space-btn'), markup.indexOf('cm-space-btn') + 500)
  assert.ok(switcher.includes('工作空间'), 'the active space is named on the button')
})

test('the space entry carries the active space’s status, for comparing with the sidebar total', () => {
  // The sidebar cluster is the whole-map count; this button is the active space's.
  // A category missing from the button therefore belongs to another space, which
  // is the comparison the reader asked for. The two must use one counting rule.
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-work' })), {
    useSessionStatus: useStatus({
      s1: { pendingInteraction: { kind: 'approval' } },
      s2: { running: true },
      s3: { completionUnread: true },
    }),
  })
  const start = markup.indexOf('cm-space-btn')
  const switcher = markup.slice(start, start + 900)
  assert.ok(switcher.includes('cm-rollup'), 'the entry carries the same cluster as the rows')
  assert.ok(
    switcher.includes('aria-label="会话状态：1 条待响应，1 条运行中（当前空间全部会话）"'),
    'only the active space’s conversations are counted',
  )
  assert.ok(!switcher.includes('条已完成'), 'a conversation in another space is not on this button')
})

test('an idle active space leaves the space entry quiet', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-empty' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'approval' } } }),
  })
  const start = markup.indexOf('cm-space-btn')
  const switcher = markup.slice(start, start + 700)
  assert.ok(!switcher.includes('cm-rollup'), 'nothing in this space needs a look, so nothing is added')
})

test('the target column only lists the Workspaces of the active space, in Host order', () => {
  const work = render(store(SPACES_MAP, view({ activeSpace: 'sp-work' })))
  assert.ok(work.includes('alpha'))
  assert.ok(!work.includes('beta'), 'a Workspace of another space stays out')
  const family = render(store(SPACES_MAP, view({ activeSpace: 'sp-family' })))
  assert.ok(family.includes('beta'))
  assert.ok(!family.includes('alpha'))
  assert.ok(family.indexOf('beta') < family.indexOf('第三条对话') || family.includes('第三条对话'))
})

test('each space lists only its own ungrouped conversations', () => {
  const work = render(store(SPACES_MAP, view({ activeSpace: 'sp-work' })))
  assert.ok(work.includes('散落对话'), 'the loose conversation filed into this space is listed')
  const family = render(store(SPACES_MAP, view({ activeSpace: 'sp-family' })))
  assert.ok(!family.includes('散落对话'), 'another space never borrows it')
  assert.equal((family.match(/data-kind="ungrouped"/g) ?? []).length, 1, 'every space keeps its own ungrouped row')
})

test('every space keeps an ungrouped row so a goal-less conversation can start anywhere', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-empty' })))
  const row = rowMarkup(markup, 'ungrouped')
  assert.ok(row.includes('在未分组发起对话'), 'the empty space still offers the start action')
  assert.ok(row.includes('data-selectable="true"'), 'it can be selected like any other row')
})


test('the ungrouped row can be selected, but it is not a container', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-work' })))
  const row = rowMarkup(markup, 'ungrouped')
  assert.ok(row.includes('data-selectable="true"'), 'the reader can select the row')
  assert.ok(row.includes('在未分组发起对话'), 'it starts a conversation without a Workspace')
  assert.ok(!row.includes('aria-label="更多"'), 'it has nothing to rename or delete')
  assert.ok(!row.includes('aria-label="新增节点"'), 'no child node can be created under it')
})

test('selecting the ungrouped row marks it without opening a column', () => {
  const markup = render(store(MAP, view({ selectedNodeId: '@ungrouped' })))
  const row = rowMarkup(markup, 'ungrouped')
  assert.ok(row.includes('data-selected="true"'), 'the row carries the selected state')
  assert.equal(columnCount(markup), 1, 'it opens no topic column of its own')
})

test('a legacy rootless topic still opens a read-only column in the default space', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-default', selectedNodeId: '@ungrouped' })))
  assert.equal(columnCount(markup), 2, 'the default space opens the legacy topic column')
  assert.ok(markup.includes('历史无主主题'))
  assert.ok(!markup.includes('aria-label="新增节点"'), 'legacy topics can no longer grow')
})

test('a default space without legacy topics opens no column for the ungrouped row', () => {
  const markup = render(store(MAP, view({ activeSpace: 'sp-default', selectedNodeId: '@ungrouped' })))
  assert.equal(columnCount(markup), 1, 'the ungrouped row is a list, not a container')
})

test('an empty space says how to fill it instead of rendering a blank column', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-empty' })))
  assert.ok(markup.includes('还没有工作区'), 'the empty state is explained')
  assert.ok(markup.includes('cm-hint-row'), 'the placeholder is a non-interactive hint row')
})

test('a selected Workspace without topics opens no topic column', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-family', selectedNodeId: '@ws:w2' })))
  assert.equal(columnCount(markup), 1, 'an empty column is dead space, so it is not drawn at all')
  assert.ok(!markup.includes('还没有主题'), 'no placeholder stands in for the column either')
})

test('a Workspace with topics still opens its topic column', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-work', selectedNodeId: '@ws:w1' })))
  assert.equal(columnCount(markup), 2, 'a populated Workspace lists its topics')
  assert.ok(markup.includes('外贸探索'))
})

test('a selected Workspace of another space opens nothing', () => {
  const markup = render(store(SPACES_MAP, view({ activeSpace: 'sp-work', selectedNodeId: '@ws:w2' })))
  assert.equal(columnCount(markup), 1, 'out-of-scope selection is inert')
})

/*
 * 对话树模式: the band's top bar carries the single view button at the content
 * header's leading edge. The shipped Conversation header keeps its own controls
 * (right Sidebar toggle, tabs, utilities) because the shell is not replaced, so
 * the map must not draw second copies of them.
 */
test('an open conversation offers the single view button and no product-header substitutes', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })), {
    services: {
      sessions: {},
      workspaces: workspaces(),
      exit() {},
    },
  })
  assert.ok(!markup.includes('aria-label="左栏"'), 'the map leaves the product left column to the shell')
  assert.ok(!markup.includes('aria-label="右栏"'), 'the shipped Conversation header keeps the right-column toggle')
  assert.ok(!markup.includes('aria-label="视图切换"'), 'the two-segment switch is gone')
  assert.ok(markup.includes('data-target="conversation"'), 'the single button points back to the Conversation')
  assert.ok(markup.includes('aria-label="收起对话树栏，会话恢复整宽"'), 'the accessible name states the action')
  assert.ok(markup.includes('title="收起对话树栏，会话恢复整宽"'), 'the hover title keeps exactly the same wording')
  /* The band's occurrence is the icon-only box the band's chrome row asks for
     (`ViewToggle` 的 `compact` 形态，见 src/client/ViewToggle.tsx 顶部说明)：可见
     文案让位给那个 28×28 的座位，动作名仍留在 aria-label/title 上。带内其它地方不会
     出现 `>收起</span>`——「显示更多／收起」是按钮文案（`>收起</button>`），所以下面
     那条负断言仍然有效。 */
  assert.ok(markup.includes('class="cm-view-toggle cm-view-toggle--icon"'), 'the band renders the icon-only variant of the one shared control')
  assert.ok(!markup.includes('cm-view-toggle-label'), 'the band box draws no label span at all')
  assert.ok(!markup.includes('>收起</span>'), 'the band box drops the visible copy it no longer needs')
  assert.ok(!markup.includes('>会话</span>'), 'the band no longer names a destination that is already on screen')
  assert.match(
    markup,
    /class="cm-band-head-row"><button type="button" class="cm-view-toggle cm-view-toggle--icon"/,
    'the collapse control is the head row\'s first control while the shell seat is not narrowed',
  )
  assert.ok(markup.indexOf('cm-view-toggle') < markup.indexOf('cm-space-btn'), 'the view button leads the band head')
  assert.ok(!markup.includes('aria-label="返回会话"'), 'leaving is the same button, not a separate exit control')
})

test('the catalog pull is demoted into the top-bar overflow menu', () => {
  const withRefresh = render(store(MAP, view({ openSessionId: 's1' })), {
    services: {
      sessions: { refresh() {} },
      workspaces: workspaces(),
    },
  })
  assert.ok(withRefresh.includes('aria-label="更多操作"'), 'the top bar offers its overflow entry')
  assert.ok(!withRefresh.includes('aria-label="同步会话"'), 'the maintenance action no longer takes a first-level seat')
  assert.ok(!withRefresh.includes('>刷新会话列表<'), 'the action stays inside the closed menu')
  const withoutRefresh = render(store(MAP, view({ openSessionId: 's1' })))
  assert.ok(!withoutRefresh.includes('aria-label="更多操作"'), 'no empty overflow without a catalog to pull')
})

test('without an open conversation the band keeps only the single view button', () => {
  const markup = render(store(MAP, view({ openSessionId: null })))
  assert.ok(!markup.includes('aria-label="左栏"'), 'the band never draws a left-column control')
  assert.ok(!markup.includes('aria-label="右栏"'), 'the shipped Conversation header owns the right-column toggle')
  assert.ok(markup.includes('aria-label="收起对话树栏，会话恢复整宽"'), 'the view button is the way back in every state')
  assert.ok(markup.includes('data-target="conversation"'), 'the band button points at the Conversation')
  assert.ok(!markup.includes('aria-label="返回会话"'), 'leaving through a separate exit button is gone')
})

/**
 * With the fallback frame the shell still owns the only new-session button.
 *
 * `renderToStaticMarkup` never runs layout effects, so every render here sees
 * the hook's fallback frame (`seatWidth: 0`, see `split-frame.ts`). That is
 * exactly the state the guard in `MapPanel` protects: the band may draw its own
 * 「新建会话」 only after *measuring* that the shell's second seat button is
 * really gone, because the shell's published clearance is a hardcoded constant
 * and mounting the seat + hiding its button are two independent facts. The
 * negative case is the one worth pinning — the screen must never carry two
 * new-session buttons — so the band markup carries none and the shell's is the
 * one left on screen.
 *
 * The positive branch (a measured seat of 28px, i.e. `0 < seatWidth <= 32`)
 * cannot be reached from this harness: the hook is imported by `MapPanel`
 * itself rather than injected through props, and a static render has no DOM for
 * it to measure. The boxes that branch draws are pinned in `styles.test.mjs`.
 */
test('without a measured narrowed seat the band draws no new-session button', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })))
  assert.ok(!markup.includes('cm-lead-icon'), 'the band does not claim the shell seat before measuring it')
  assert.ok(!markup.includes('aria-label="新建会话"'), 'the shell keeps the only 新建会话 while its seat is unmeasured')
  assert.equal(
    (markup.match(/新建会话/g) ?? []).length,
    0,
    'the band adds no second new-session entry: the screen shows exactly the shell\'s one',
  )
})

/**
 * An unmeasured frame starts the band at the Conversation header's own inset.
 *
 * This is the reachable one of `split-frame.ts`'s three inset cases: nothing is
 * published (`--dsh-frame-leading-clearance` is unreadable before layout) and no
 * seat is measured, so `leadingInset` returns its 20px floor, which the panel
 * hands to CSS as `--cm-band-inset`. The seat-intact case (160) and the
 * narrowed-seat case (124 = seat right 116 + 8) both need a live
 * `getComputedStyle` against a mounted `[data-shell-leading]`, which a static
 * render cannot provide.
 *
 * They are NOT covered by any automation today. `scripts/uitest.mjs` predates
 * this round and asserts none of `--cm-band-inset`, `cm-lead-icon` or the seat
 * width, so nothing fails if either number drifts. A real-machine pass (map
 * band on screen, macOS desktop branch so the seat is mounted) should add:
 * (1) `--cm-band-inset` is 160px while the seat is intact; (2) once the hide
 * rule lands and the seat measures 28px, `--cm-band-inset` is 124px,
 * `.cm-lead-icon` is visible, and `[data-shell-leading]` holds exactly one
 * button; (3) the band's collapse control keeps the same anchored x in both.
 */
test('an unmeasured frame starts the band at the conversation inset floor', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })))
  assert.match(markup, /style="[^"]*--cm-band-inset:20px/, 'the fallback frame leaves the Conversation header\'s own inset')
  assert.ok(!markup.includes('--cm-band-inset:160px'), 'the published clearance is not assumed when it cannot be read')
  assert.ok(!markup.includes('--cm-band-inset:124px'), 'and the narrowed-seat inset is never assumed before measurement')
})

/* ── subagent navigation ────────────────────────────────────────────────── */

/** The lineage of a subagent child of s1, as the catalog reports it. */
const SUBAGENT_LINEAGE = {
  s1: { displayTitle: '第一条对话' },
  child: { displayTitle: '子智能体', origin: 'subagent', parentId: 's1' },
}

/** The Host accounting of the spaces fixture, as the panel reads it. */
const SPACES_OWNERS = new Map([['s1', 'w1'], ['s3', 'w2']])

test('opening a subagent lands on its parent row without leaving the space', () => {
  const landed = followNativeNavigation(
    SPACES_MAP, SUBAGENT_LINEAGE, SPACES_OWNERS, 'child', 'sp-work',
    view({ activeSpace: 'sp-work', selectedNodeId: '@ws:w1' }),
  )
  assert.equal(landed.openSessionId, 'child', 'the pane still names the conversation being read')
  assert.equal(landed.activeSpace, 'sp-work', 'the space does not move')
  assert.equal(landed.selectedNodeId, 'n1', 'the highlight is the parent topic')
  const markup = render(store(SPACES_MAP, landed))
  assert.match(markup, /class="cm-node-row"[^>]*data-selected="true"[^>]*title="外贸探索"/)
  assert.ok(!markup.includes('子智能体'), 'no row is invented for the child')
})

test('a subagent never pulls the reader into another space', () => {
  const landed = followNativeNavigation(
    SPACES_MAP, SUBAGENT_LINEAGE, SPACES_OWNERS, 'child', 'sp-family',
    view({ activeSpace: 'sp-family', selectedNodeId: '@ws:w2' }),
  )
  assert.equal(landed.activeSpace, 'sp-family', 'the reader keeps the space they chose')
  assert.equal(landed.selectedNodeId, 'n1', 'the parent row is still the destination')
  const markup = render(store(SPACES_MAP, landed))
  assert.ok(markup.includes('家庭空间'), 'the band still names the space the reader chose')
})

test('a loose parent takes its own space along', () => {
  const lineage = {
    s2: { displayTitle: '散落对话' },
    child: { displayTitle: '子智能体', origin: 'subagent', parentId: 's2' },
  }
  const landed = followNativeNavigation(
    SPACES_MAP, lineage, SPACES_OWNERS, 'child', 'sp-family',
    view({ activeSpace: 'sp-family', selectedNodeId: '@ws:w2' }),
  )
  assert.equal(landed.activeSpace, 'sp-work', 'an ungrouped parent is followed to its own space')
  assert.equal(landed.selectedNodeId, '@loose:sp-work', 'and to its ungrouped row')
  assert.equal(landed.openSessionId, 'child')
})

test('a subagent whose parent the catalog cannot name holds the reader place', () => {
  const start = view({ activeSpace: 'sp-family', selectedNodeId: '@ws:w2' })
  const landed = followNativeNavigation(
    SPACES_MAP,
    { orphan: { displayTitle: '子智能体', origin: 'subagent', parentId: 'gone' } },
    new Map(), 'orphan', 'sp-family', start,
  )
  assert.equal(landed.activeSpace, 'sp-family')
  assert.equal(landed.selectedNodeId, '@ws:w2')
  assert.equal(landed.openSessionId, 'orphan', 'only the open conversation follows')
})

test('a cyclic parent chain cannot move the map either', () => {
  const lineage = {
    a: { displayTitle: '子智能体甲', origin: 'subagent', parentId: 'b' },
    b: { displayTitle: '子智能体乙', origin: 'subagent', parentId: 'a' },
  }
  const landed = followNativeNavigation(
    SPACES_MAP, lineage, new Map(), 'a', 'sp-work',
    view({ activeSpace: 'sp-work', selectedNodeId: '@ws:w1' }),
  )
  assert.equal(landed.activeSpace, 'sp-work')
  assert.equal(landed.selectedNodeId, '@ws:w1')
  assert.equal(landed.openSessionId, 'a')
})

test('an ordinary conversation still takes the map to its own space', () => {
  const landed = followNativeNavigation(
    SPACES_MAP, { s3: { displayTitle: '第三条对话' } }, SPACES_OWNERS, 's3', 'sp-work',
    view({ activeSpace: 'sp-work', selectedNodeId: 'n1' }),
  )
  assert.equal(landed.activeSpace, 'sp-family', 'a filed conversation switches the space')
  assert.equal(landed.selectedNodeId, '@ws:w2')
  assert.equal(landed.openSessionId, 's3')
})

/* ── moving a conversation to another node (「移动到…」) ───────────────────── */

/** Parse one fixture into the document the pure helpers read. */
function doc(map) {
  return ensureDefaultSpace(parseMapState(JSON.stringify(map)))
}

/** The conversation row of one fixture. */
function threadOf(map, sessionId) {
  const found = doc(map).threads.find(thread => thread.sessionId === sessionId)
  assert.notEqual(found, undefined, `the ${sessionId} conversation is in the fixture`)
  return found
}

/** The node of one fixture. */
function nodeOf(map, nodeId) {
  const found = doc(map).nodes.find(node => node.id === nodeId)
  assert.notEqual(found, undefined, `the ${nodeId} node is in the fixture`)
  return found
}

/** The topics fixture with its direct conversation accounted to the same Workspace. */
const SHORTCUT_MAP = {
  ...MAP,
  threads: MAP.threads.map(thread =>
    thread.sessionId === 's3' ? { ...thread, workspaceId: 'w1' } : thread),
}

/** A conversation row the map refuses to move: a recorded subagent child. */
const SUBAGENT_THREAD_MAP = {
  ...MAP,
  subagentSessionIds: ['child'],
  threads: [
    ...MAP.threads,
    {
      sessionId: 'child', nodeId: null, workspaceId: 'w1', origin: 'subagent',
      title: '子智能体', updatedAt: ago(1), importedAt: '',
    },
  ],
}

/*
 * The `⋯` menu is state-driven, so `renderToStaticMarkup` can never open it.
 * What the menu *decides* is therefore a pure function on purpose, and that is
 * what these cases pin: which entries exist and which note replaces a shortcut.
 */

test('a conversation menu offers the one-step move and nothing that depends on the selection', () => {
  const state = doc(SHORTCUT_MAP)
  assert.deepEqual(
    threadMenuModel(state, threadOf(SHORTCUT_MAP, 's1')),
    { move: true, notice: null },
    'a filed conversation offers the picker and nothing else (BL-1: its Workspace row is in the picker)',
  )
  for (const gone of ['quickTarget', 'unassign']) {
    assert.ok(
      !(gone in threadMenuModel(state, threadOf(SHORTCUT_MAP, 's1'))),
      `the ${gone} entry is gone from the model, so no render path can reach it`,
    )
  }
  assert.deepEqual(
    threadMenuModel(state, threadOf(SHORTCUT_MAP, 's3')),
    { move: true, notice: null },
    'an unfiled conversation is offered the same single entry, with nothing to explain',
  )
})

test('the resting band offers no shortcut or unfile entry at all', () => {
  const markup = render(store(SHORTCUT_MAP, view({ selectedNodeId: 'n2', openSessionId: 's3' })))
  assert.ok(!markup.includes('关联到'), 'the shortcut is gone from the panel, not merely hidden by a state')
  assert.ok(!markup.includes('移出节点'), 'and so is the unfile entry, which the picker now covers (BL-1)')
})

test('a subagent row offers no move of its own and says why', () => {
  const state = doc(SUBAGENT_THREAD_MAP)
  const recorded = threadMenuModel(state, threadOf(SUBAGENT_THREAD_MAP, 'child'))
  assert.deepEqual(recorded, { move: false, notice: '子智能体会话由它的父对话带出来，不能单独移动。' })

  const byOrigin = { ...state, subagentSessionIds: [] }
  assert.equal(
    threadMenuModel(byOrigin, threadOf(SUBAGENT_THREAD_MAP, 'child')).move,
    false,
    'the catalog origin alone is enough while the ledger is not written yet',
  )

  const filedChild = { ...state, threads: state.threads.map(thread => thread.sessionId === 'child' ? { ...thread, nodeId: 'n1' } : thread) }
  const filed = threadMenuModel(filedChild, filedChild.threads.find(thread => thread.sessionId === 'child'))
  assert.equal(filed.move, false, 'a filed subagent row is offered nothing either — the model refuses that write')
  assert.match(filed.notice, /子智能体/, 'and it still says what it is')
})

/** Two Workspaces with one topic each: a selection that must not travel. */
const TWO_WORKSPACE_MAP = {
  version: 2,
  revision: 1,
  nodes: [
    { id: 'a1', parentId: null, workspaceId: 'w1', title: '甲的节点', description: '', position: 1, updatedAt: '' },
    { id: 'b1', parentId: null, workspaceId: 'w2', title: '乙的节点', description: '', position: 1, updatedAt: '' },
  ],
  threads: [
    { sessionId: 'sa', nodeId: 'a1', workspaceId: 'w1', title: '甲的对话', updatedAt: ago(1), importedAt: '' },
    { sessionId: 'sb', nodeId: null, workspaceId: 'w2', title: '乙的散落对话', updatedAt: ago(1), importedAt: '' },
    { sessionId: 'sc', nodeId: 'b1', workspaceId: 'w2', title: '乙的对话', updatedAt: ago(2), importedAt: '' },
  ],
}

test('the picker starts on the selected topic, then on the conversation own home', () => {
  const state = doc(TWO_WORKSPACE_MAP)
  assert.equal(
    threadMoveDefault(state, threadOf(TWO_WORKSPACE_MAP, 'sb'), nodeOf(TWO_WORKSPACE_MAP, 'b1')),
    'b1',
    'a selected topic of its own Workspace is the default — the old shortcut, now visible in the picker',
  )
  assert.equal(
    threadMoveDefault(state, threadOf(TWO_WORKSPACE_MAP, 'sc'), nodeOf(TWO_WORKSPACE_MAP, 'a1')),
    'b1',
    'a topic of another Workspace is ignored: the conversation starts on its own node',
  )
  assert.equal(
    threadMoveDefault(state, threadOf(TWO_WORKSPACE_MAP, 'sb'), undefined),
    '',
    'with nothing selected an unfiled conversation starts on the Workspace row',
  )
  assert.equal(
    threadMoveDefault(state, threadOf(TWO_WORKSPACE_MAP, 'sa'), undefined),
    'a1',
    'and a filed one starts on its own node',
  )
})

test('a destination the model refuses is never the default', () => {
  assert.equal(
    threadMoveDefault(doc(SPACES_MAP), threadOf(SPACES_MAP, 's2'), nodeOf(SPACES_MAP, 'u1')),
    '',
    'the legacy rootless topic of another space is skipped, so the picker never opens on a disabled option',
  )
})

test('the move picker lists the Workspace row first, then every node of that Workspace', () => {
  assert.deepEqual(threadMoveOptions(doc(MAP), 's1', 'w1'), [
    { value: '', label: '（工作区顶层）', disabled: false },
    { value: 'n1', label: '外贸探索', disabled: false },
    { value: 'n2', label: '外贸探索 / 获客方式', disabled: false },
  ], 'the Workspace row leads, and every destination carries its full path')
})

test('a Workspace with no nodes still offers the Workspace row', () => {
  const empty = { version: 2, revision: 1, nodes: [], threads: [] }
  assert.deepEqual(threadMoveOptions(doc(empty), 's1', 'w1'), [
    { value: '', label: '（工作区顶层）', disabled: false },
  ], 'a conversation can always be left directly under its Workspace')
})

test('the picker offers only the conversation own Workspace, and disables what the model would refuse', () => {
  const options = threadMoveOptions(doc(SPACES_MAP), 's2', null)
  assert.deepEqual(options.map(option => option.value), ['', 'u1'], 'the ungrouped bucket lists only its own legacy topics')
  assert.ok(!options.some(option => option.value === 'n1'), 'another Workspace node is never offered')
  assert.equal(options[1].disabled, true, 'a loose conversation of another space cannot file itself in a default-space topic')
})

test('the move picker renders the destinations as a foldable tree, on the current home', () => {
  const markup = renderToStaticMarkup(createElement(MoveThreadField, {
    state: doc(MAP), sessionId: 's1', workspaceId: 'w1', value: 'n2', onChange: () => {},
  }))
  assert.match(markup, /class="cm-move-tree"/, 'the picker is the tree the sheet styles')
  assert.match(markup, /role="tree"/, 'and it announces itself as one')
  assert.match(markup, /id="cm-move-thread-target"[^>]*aria-labelledby="cm-move-thread-label"/, 'named by its own label')
  assert.match(markup, /class="cm-move-tree-row"[^>]*role="treeitem"[^>]*data-depth="0"/, 'the Workspace row leads at depth 0')
  assert.match(markup, /data-depth="2"[^>]*data-selected="true"/, 'and the conversation current home is the selected row')
  assert.match(markup, /data-depth="0"[^>]*data-selected="false"/, 'the Workspace row is not selected while the conversation sits deeper')
  assert.match(markup, /--cm-move-depth/, 'each row carries its own depth for the sheet to indent by')
  assert.ok(markup.includes('（工作区顶层）'), 'the Workspace row is always offered')
  assert.ok(markup.includes('外贸探索'), 'along with the Workspace topics')

  const deep = renderToStaticMarkup(createElement(MoveThreadField, {
    state: doc(MAP), sessionId: 's1', workspaceId: 'w1', value: 'n1', onChange: () => {},
  }))
  assert.match(deep, /data-depth="1"[^>]*data-selected="true"/, 'a top-level topic sits at depth 1 and is selected when it is the home')
  assert.match(deep, /data-depth="2"[^>]*>[\s\S]{0,220}?获客方式/, 'its child sits one level deeper')
  assert.match(deep, /class="cm-move-tree-toggle"[^>]*data-expanded="true"/, 'a row with children offers a toggle, expanded by default')
})

test('a destination the model refuses is rendered unselectable', () => {
  const markup = renderToStaticMarkup(createElement(MoveThreadField, {
    state: doc(SPACES_MAP), sessionId: 's2', workspaceId: null, value: '', onChange: () => {},
  }))
  assert.match(markup, /data-depth="1"[^>]*aria-disabled="true"[^>]*data-disabled="true"/, 'the refused target says so to CSS and to assistive tech')
  assert.ok(markup.includes('历史无主主题'), 'and stays visible, so the limit can be seen')
  assert.match(markup, /data-depth="0"[^>]*data-selected="true"/, 'the Workspace row stays selectable')
})

test('confirming the home a conversation already has changes nothing, and any other value commits it', () => {
  const state = doc(MAP)
  assert.equal(threadMoveIsNoop(state, 's1', 'n1'), true, 'n1 is where s1 already sits')
  assert.equal(threadMoveIsNoop(state, 's1', ''), false, 'the Workspace row is a real destination for a filed conversation')
  assert.equal(threadMoveIsNoop(state, 's3', ''), true, 'an unfiled conversation already sits on its Workspace row')
  assert.equal(threadMoveIsNoop(state, 'gone', ''), false, 'an unknown conversation is not silently "already there"')
})

test('the confirmed move writes the new node and leaves the conversation itself alone', () => {
  const state = doc(MAP)
  const before = threadOf(MAP, 's1')
  const moved = threadMoveChange('s1', 'n2')(state)
  const after = moved.threads.find(thread => thread.sessionId === 's1')
  assert.equal(after.nodeId, 'n2', 'the conversation moves to the chosen node')
  assert.equal(after.updatedAt, before.updatedAt, 'moving does not restamp the conversation')
  assert.equal(moved.threads.find(thread => thread.sessionId === 's2').nodeId, null, 'other conversations stay put')
  assert.equal(
    threadMoveChange('s1', '')(state).threads.find(thread => thread.sessionId === 's1').nodeId,
    null,
    'the picker empty value is the Workspace row',
  )
})

test('the move dialog is not part of the resting band', () => {
  const markup = render(store(MAP, view({ openSessionId: 's1' })))
  assert.ok(!markup.includes('cm-move-thread-target'), 'the picker is state-driven, not always mounted')
  assert.ok(!markup.includes('移动对话'), 'and its title only exists while it is open')
})

/* ── pointer drag: identities, decisions, and the visuals they carry ─────── */

test('every draggable row carries the identity the hit test reads', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.ok(markup.includes('data-node-id="n1"'), 'a topic row names itself')
  assert.ok(markup.includes('data-node-workspace-id="w1"'), 'and the Workspace it belongs to')
  assert.ok(markup.includes('data-row-key="@ws:w1"'), 'a Workspace row answers to its selection key')
  assert.ok(markup.includes('data-session-id="s1"'), 'a conversation row names its session')
  assert.ok(markup.includes('data-parent-node-id="n1"'), 'and the topic it is filed under')
  assert.ok(markup.includes('data-dragging="false"'), 'no row is dragged at rest')
  assert.ok(markup.includes('data-drop="none"'), 'and no row is a drop target at rest')
  assert.ok(markup.includes('data-parent-workspace-id="w2"'), 'a Workspace-level conversation names its Workspace')
})

test('a row under the pointer becomes the candidate the model judges', () => {
  assert.deepEqual(
    candidateFromRow({ nodeId: 'n2', nodeWorkspaceId: 'w1' }, 'into'),
    { row: { kind: 'node', nodeId: 'n2', workspaceId: 'w1' }, edge: 'into' },
    'a topic row is its own target',
  )
  assert.deepEqual(
    candidateFromRow({ parentNodeId: 'n2', parentWorkspaceId: 'w1' }, 'after'),
    { row: { kind: 'node', nodeId: 'n2', workspaceId: 'w1' }, edge: 'after' },
    'a conversation row targets the topic it is filed under',
  )
  assert.deepEqual(
    candidateFromRow({ parentWorkspaceId: 'w2' }, 'into'),
    { row: { kind: 'workspace', workspaceId: 'w2' }, edge: 'into' },
    'a Workspace-level conversation targets its Workspace row',
  )
  assert.deepEqual(
    candidateFromRow({ rowKey: '@ws:w1' }, 'into'),
    { row: { kind: 'workspace', workspaceId: 'w1' }, edge: 'into' },
    'a Workspace row is a target for its own Workspace',
  )
  assert.deepEqual(
    candidateFromRow({ nodeId: 'u1', nodeWorkspaceId: '' }, 'into'),
    { row: { kind: 'node', nodeId: 'u1', workspaceId: null }, edge: 'into' },
    'a legacy rootless topic is still named, so the model can refuse it',
  )
  for (const identity of [{ rowKey: '@ungrouped' }, { rowKey: '@loose:sp-work' }, {}]) {
    assert.deepEqual(
      candidateFromRow(identity, 'into'),
      { row: { kind: 'none' }, edge: 'into' },
      "the ungrouped bucket and the band's blank edges take no drop",
    )
  }
})

test('a row offers its edge bands by a quarter of its height, with an 8px floor', () => {
  assert.equal(edgeOfRow(102, 100, 34), 'before', 'the top eighth of a topic row is its before-edge')
  assert.equal(edgeOfRow(117, 100, 34), 'into', 'the middle files under the row')
  assert.equal(edgeOfRow(132, 100, 34), 'after', 'the bottom eighth is its after-edge')
  assert.equal(edgeOfRow(104, 100, 20), 'before', 'a short row keeps an 8px edge instead of a 5px one')
  assert.equal(edgeOfRow(112, 100, 20), 'into', 'and its middle still means "under it"')
  assert.equal(edgeOfRow(114, 100, 20), 'after')
})

test('only a decision with a real move becomes a plan', () => {
  const state = doc(MAP)
  assert.deepEqual(
    planFromDecision({ action: { kind: 'thread', sessionId: 's1', nodeId: 'n2' }, issue: null, noop: false, label: 'x' }),
    { kind: 'thread', sessionId: 's1', nodeId: 'n2' },
  )
  assert.equal(planFromDecision({ action: null, issue: null, noop: true, label: '位置不变' }), null, 'a no-op commits nothing')
  assert.equal(
    planFromDecision({ action: null, issue: { code: 'WORKSPACE', message: '不' }, noop: false, label: '不' }),
    null,
    'a refused drop commits nothing — the label is the whole feedback',
  )
  const moved = applyDragPlan(state, { kind: 'thread', sessionId: 's1', nodeId: 'n2' })
  assert.equal(moved.threads.find(thread => thread.sessionId === 's1').nodeId, 'n2', 'a conversation plan files it')
  const slotted = applyDragPlan(state, { kind: 'node', nodeId: 'n2', parentId: null, beforeNodeId: null })
  assert.equal(slotted.nodes.find(node => node.id === 'n2').parentId, null, 'a topic plan re-parents it')
})

test('a one-shot flag is taken exactly once', () => {
  const flag = { pending: false }
  assert.equal(consumeOneShot(flag), false, 'nothing to consume while it is clear')
  flag.pending = true
  assert.equal(consumeOneShot(flag), true, 'the click that follows the drag is eaten')
  assert.equal(consumeOneShot(flag), false, 'and no later click is')
})

/** One fabricated column: a topic with a conversation under it. */
const DRAG_COLUMN = {
  key: 'L2',
  title: 'L2',
  rows: [{
    id: 'n1', title: '外贸探索', kind: 'node', childCount: 0, tools: true, collapsed: false,
    workspaceId: 'w1',
    threads: [{ sessionId: 's1', title: '第一条对话', time: '2 小时', workspaceId: 'w1' }],
  }],
}

/** The view props one fabricated column needs. */
function columnProps(extra = {}) {
  return {
    column: DRAG_COLUMN,
    width: 220,
    selectedNodeId: null,
    openSessionId: null,
    menuRowId: null,
    onSelectNode: () => {},
    onOpenThread: () => {},
    onNewThread: () => {},
    onToggleNode: () => {},
    onMenu: () => {},
    ...extra,
  }
}

test('a drop on a row edge draws the 2px insertion line inside that row', () => {
  const before = renderToStaticMarkup(createElement(NodeColumnView, columnProps({
    dropKey: 'n1', dropState: 'valid', insertEdge: 'before',
  })))
  assert.match(before, /data-insert="before"/, 'the line is drawn on the edge the pointer chose')
  assert.match(before, /data-drop="valid"/, 'and the target row is lit')
  assert.match(before, /height:2px/, 'two pixels, as designed')
  assert.match(before, /position:absolute/, 'inside the row, so it spans the row width')
  assert.match(before, /pointer-events:none/, 'the line never takes the pointer it reports')
  assert.match(before, /color-mix\(in srgb, var\(--dsw-alias-brand-primary/, 'the row itself is tinted, with the theme token')
  assert.match(before, /data-dragging="false"/, 'the row is not the one being dragged')

  const after = renderToStaticMarkup(createElement(NodeColumnView, columnProps({
    dropKey: 'n1', dropState: 'invalid', insertEdge: 'after',
  })))
  assert.match(after, /data-insert="after"/, 'the other edge draws its own line')
  assert.match(after, /data-drop="invalid"/, 'a refused target says so on its own row')
  assert.match(after, /cursor:no-drop/, 'with the cursor, not a grey wash (U3)')
  assert.ok(!after.includes('background:color-mix'), 'a refused row is not tinted')

  const noLine = renderToStaticMarkup(createElement(NodeColumnView, columnProps({ dropKey: 'n1', dropState: 'valid' })))
  assert.ok(!noLine.includes('data-insert'), 'a conversation payload draws no line: conversations are not sorted by hand')
})

test('a dragged row reports itself, and the panel marks the source', () => {
  const markup = renderToStaticMarkup(createElement(NodeColumnView, columnProps({ draggingKey: 's1' })))
  assert.match(markup, /data-session-id="s1"[^>]*data-dragging="true"/, 'the conversation row is the source')
  assert.match(markup, /data-node-id="n1"[^>]*data-dragging="false"/, 'and its topic row is not')
  assert.match(markup, /data-dragging="true"[^>]*opacity:0.45/, 'the source row steps back while its copy follows the pointer')
})

test('the pointer label says what a release would do, in the decisions own tone', () => {
  const valid = renderToStaticMarkup(createElement(DragLabel, { label: '移到「获客方式」下', tone: 'valid' }))
  assert.match(valid, /data-drag-label="valid"/)
  assert.ok(valid.includes('移到「获客方式」下'), 'the label carries the decision wording')
  assert.match(valid, /pointer-events:none/, 'the label follows the pointer without taking it')
  assert.match(valid, /position:fixed/)
  const invalid = renderToStaticMarkup(createElement(DragLabel, { label: '不能移到别的工作区', tone: 'invalid' }))
  assert.match(invalid, /data-drag-label="invalid"/)
  assert.match(dragLabelStyle('invalid').color, /error/, 'a refused drop reads as a warning')
  assert.match(dragLabelStyle('noop').color, /label-secondary/, 'an unchanged one stays quiet')
  assert.match(dragLabelStyle('valid').color, /brand-primary/, 'a real move reads as the action it is')
})

/* ── P2: hysteresis, auto scroll, spring loading, view follow, wording ───── */

test('a pointer that leaves every row keeps the last candidate, held', () => {
  assert.equal(heldOverlay(null), null, 'nothing to hold before a row was ever reached')
  const live = { label: '移到「获客方式」下', tone: 'valid', dropKey: 'n2', insertEdge: null, held: false }
  assert.deepEqual(heldOverlay(live), { ...live, held: true }, 'the candidate stays, marked as held')
  const held = heldOverlay(live)
  assert.equal(heldOverlay(held), held, 'holding an already held candidate writes nothing new, so no frame re-renders')
})

test('a held target is drawn as a hint, and its insertion line stays', () => {
  const markup = renderToStaticMarkup(createElement(NodeColumnView, columnProps({
    dropKey: 'n1', dropState: 'held', insertEdge: 'before',
  })))
  assert.match(markup, /data-drop="held"/, 'the row is still the candidate (U3)')
  assert.match(markup, /outline:1px dashed/, 'drawn as a hint rather than a live target')
  assert.match(markup, /data-insert="before"/, 'and the line it was showing stays where it was')
})

test('auto scroll ramps in from the edge and only inside the dead zone', () => {
  assert.equal(autoScrollStep(500, 100, 900), 0, 'the middle of a strip never scrolls itself')
  assert.ok(autoScrollStep(105, 100, 900) < 0, 'the leading edge scrolls back')
  assert.ok(autoScrollStep(895, 100, 900) > 0, 'the trailing edge scrolls on')
  assert.equal(AUTO_SCROLL_EDGE_PX, 18, 'the dead zone the reader aims into')
  const shallow = Math.abs(autoScrollStep(100 + AUTO_SCROLL_EDGE_PX - 2, 100, 900))
  const deep = Math.abs(autoScrollStep(101, 100, 900))
  assert.ok(deep > shallow, 'the deeper into the zone, the faster the scroll')
  assert.equal(deep, AUTO_SCROLL_MAX_PX, 'a pointer pressed against the edge scrolls fastest')
  assert.equal(autoScrollStep(150, 100, 110), 0, 'a strip narrower than its two dead zones cannot be aimed at')
})

test('only a topic whose next column is missing springs open', () => {
  const state = doc(MAP)
  assert.equal(springLoadTarget(state, 'n1', false), true, 'n1 has a child and no column of its own yet')
  assert.equal(springLoadTarget(state, 'n1', true), false, 'its child column is already on screen')
  assert.equal(springLoadTarget(state, 'n2', false), false, 'a leaf has nothing to open')
  assert.equal(SPRING_LOAD_MS, 600, 'the rest the pointer must hold first')
})

test('a landed move brings its row, its column and the highlight along', () => {
  const state = doc(MAP)
  assert.deepEqual(
    followAfterMove(state, { kind: 'thread', sessionId: 's1', nodeId: 'n2' }, { openSessionId: 's1' }),
    { focusKey: 's1', expandKey: 'n2', selectedNodeId: 'n2' },
    'the conversation that was being read keeps naming itself in the highlight',
  )
  assert.deepEqual(
    followAfterMove(state, { kind: 'thread', sessionId: 's1', nodeId: 'n2' }, { openSessionId: 's3' }),
    { focusKey: 's1', expandKey: 'n2', selectedNodeId: null },
    'moving a conversation the reader is not reading leaves the selection alone',
  )
  assert.deepEqual(
    followAfterMove(state, { kind: 'thread', sessionId: 's1', nodeId: null }, { openSessionId: 's1' }),
    { focusKey: 's1', expandKey: '@ws:w1', selectedNodeId: '@ws:w1' },
    'filing one under its Workspace row unfolds and selects that row',
  )
  assert.deepEqual(
    followAfterMove(state, { kind: 'node', nodeId: 'n2', parentId: null, beforeNodeId: null }, { openSessionId: null }),
    { focusKey: 'n2', expandKey: null, selectedNodeId: null },
    'a moved topic needs its new parent unfolded, and nobody else moves',
  )
})

test('a refused move is restated in the reader own vocabulary', () => {
  assert.equal(
    moveFailureMessage(new MapError('NOT_FOUND', '节点已不存在，请刷新。')),
    '目标节点已不存在，本次移动没有生效。',
  )
  assert.equal(moveFailureMessage(new MapError('DEPTH', '最多支持 12 层。')), '这次移动会让层级超过 12 层。')
  assert.equal(moveFailureMessage(new MapError('ANCHOR', '锚点不在目标位置下')), '插入位置已失效，请重试。')
  assert.equal(moveFailureMessage(new MapError('WORKSPACE', '不能把节点移动到其他工作区的节点下。')), '不能移到别的工作区。')
  assert.equal(moveFailureMessage(new MapError('CYCLE', '不能移到自己下面。')), '不能移到自己下面。', 'an unmapped refusal keeps the model wording')
  assert.equal(moveFailureMessage(new Error('boom')), 'boom', 'a transport failure is not flattened into a move message')
})

/* ── D9: where a node lands among its siblings ──────────────────────────── */

test('the position picker lists the siblings a node can go in front of', () => {
  const state = doc(MAP)
  assert.deepEqual(
    siblingTargets(state, null, 'w1', 'n1').map(node => node.id),
    [],
    'a node is never offered as its own anchor',
  )
  const siblings = siblingTargets(doc(SHORTCUT_MAP), null, 'w1', 'n1')
  assert.ok(siblings.every(node => workspaceOfNode(node) === 'w1' || node.workspaceId === 'w1'), 'only its own Workspace')
  const markup = renderToStaticMarkup(createElement(NodePositionField, {
    state: doc(MAP), parentId: null, workspaceId: 'w1', selfId: 'n1', value: '', onChange: () => {},
  }))
  assert.match(markup, /id="cm-node-position"[^>]*class="cm-select"|class="cm-select"[^>]*id="cm-node-position"/, 'the shipped select style is reused')
  assert.match(markup, /<option value=""[^>]*>放到最后<\/option>/, 'the default anchor is the end of the list')
  assert.ok(!markup.includes('放到「外贸探索」之前'), 'the node itself is not a candidate')
  const twoSiblings = {
    ...MAP,
    nodes: [
      ...MAP.nodes,
      { id: 'n3', parentId: null, workspaceId: 'w1', title: '第二个顶层节点', description: '', position: 2, updatedAt: '' },
    ],
  }
  const withSiblings = renderToStaticMarkup(createElement(NodePositionField, {
    state: doc(twoSiblings), parentId: null, workspaceId: 'w1', selfId: 'n1', value: '', onChange: () => {},
  }))
  assert.ok(withSiblings.includes('放到「第二个顶层节点」之前'), 'a sibling is offered as an anchor')
})

/* ── BL-2/BL-3: the tree, as data and as markup ─────────────────────────── */

test('the move tree keeps the document shape: the Workspace row, then topics by depth', () => {
  const rows = moveTreeRows(doc(MAP), 's1', 'w1')
  assert.deepEqual(
    rows.map(row => [row.key, row.depth, row.hasChildren]),
    [['', 0, false], ['n1', 1, true], ['n2', 2, false]],
    'the Workspace row leads at depth 0, and each topic follows its parent',
  )
  assert.equal(rows[0].label, '（工作区顶层）', 'the root row is named by the model')
  assert.equal(rows[0].nodeId, null)
  assert.ok(rows.every(row => row.disabled === false), 'every destination of its own Workspace is available')

  const refused = moveTreeRows(doc(SPACES_MAP), 's2', null)
  assert.deepEqual(refused.map(row => [row.key, row.depth, row.disabled]), [['', 0, false], ['u1', 1, true]])
})

test('folding a branch hides its subtree, and the cursor steps over refusals', () => {
  const rows = moveTreeRows(doc(MAP), 's1', 'w1')
  assert.deepEqual(
    visibleTreeRows(rows, new Set(['n1'])).map(row => row.key),
    ['', 'n1'],
    'folding n1 hides n2 and nothing else',
  )
  assert.deepEqual(visibleTreeRows(rows, new Set()).map(row => row.key), ['', 'n1', 'n2'])
  assert.equal(treeStep(rows, 0, 1), 1, 'down moves one row')
  assert.equal(treeStep(rows, 0, -1), 0, 'up at the top stays put')
  assert.equal(treeStep(rows, 2, 1), 2, 'down at the end stays put')
  const withRefusal = rows.map(row => row.key === 'n1' ? { ...row, disabled: true } : row)
  assert.equal(treeStep(withRefusal, 0, 1), 2, 'a refused row is stepped over, never landed on')
})

test('the move dialog is the marked one', () => {
  assert.equal(dialogClass({ kind: 'move-thread' }), 'cm-dialog cm-dialog--move', 'BL-2: the card says which dialog it is')
  assert.equal(dialogClass({ kind: 'node' }), 'cm-dialog')
  assert.equal(dialogClass({ kind: 'thread-space' }), 'cm-dialog')
})

test('only the five one-line dialogs commit on Enter', () => {
  for (const kind of ['node', 'workspace-create', 'workspace-rename', 'space-create', 'space-rename']) {
    assert.equal(enterCommits(kind), true, `${kind} has a one-line input and commits`)
  }
  // The textarea's dialog keeps Enter for line breaks, the pickers and the move
  // tree consume it natively, and the two delete confirmations hold no input:
  // Enter must never confirm them.
  for (const kind of ['workspace-delete', 'space-delete', 'move-thread', 'workspace-space', 'thread-space']) {
    assert.equal(enterCommits(kind), false, `${kind} must not commit on Enter`)
  }
})

test('an Enter commits unless an IME or Shift owns it', () => {
  assert.equal(commitsOnEnter({ key: 'Enter' }), true, 'a plain Enter commits')
  assert.equal(commitsOnEnter({ key: 'Enter', shiftKey: true }), false, 'Shift+Enter stays a line break')
  assert.equal(
    commitsOnEnter({ key: 'Enter', nativeEvent: { isComposing: true } }),
    false,
    'the IME keeps the Enter that confirms its candidate',
  )
  assert.equal(commitsOnEnter({ key: 'Enter', keyCode: 229 }), false, 'legacy IME reporting is guarded too')
  assert.equal(commitsOnEnter({ key: 'a' }), false)
  assert.equal(commitsOnEnter({ key: 'Escape' }), false)
  assert.equal(
    commitsOnEnter({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false } }),
    true,
    'a finished composition does not block the next Enter',
  )
})


test('a node row rolls up its own conversations and every descendant', () => {
  const ledger = createStatusLedger({ now: () => Date.now() })
  const statuses = { s1: { pendingInteraction: { kind: 'approval' } }, s3: { completionUnread: true } }
  ledger.observe(new Map(Object.entries(statuses)), ['s1', 's2', 's3'])
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus(statuses),
    services: { statusLedger: ledger },
  })
  assert.ok(markup.includes('class="cm-rollup"'), 'the rollup badge is rendered')
  assert.ok(markup.includes('aria-label="会话状态：1 条待响应（含全部下游节点）"'), 'n1 reports the pending conversation')
  assert.ok(markup.includes('aria-label="会话状态：1 条已完成（含全部下游节点）"'), 'beta reports its direct completed conversation')
  assert.ok(markup.includes('data-cat="pending"'), 'the pending dot is present')
  assert.ok(markup.includes('data-cat="done"'), 'the done dot is present')
})

test('the open conversation is not counted in the attention rollup', () => {
  const statuses = { s1: { pendingInteraction: { kind: 'approval' } } }
  const markup = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })), {
    useSessionStatus: useStatus(statuses),
  })
  assert.ok(!markup.includes('cm-rollup'), 'the only conversation is open, so no row needs a badge')
})

test('a narrow column drops the counts and keeps the dots', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1', columnWidths: [180] })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'question' } } }),
  })
  const firstRow = markup.slice(markup.indexOf('data-kind="workspace"'), markup.indexOf('data-kind="node"'))
  assert.ok(firstRow.includes('cm-rollup-dots'), 'the L1 row is narrow and uses the dot-only mark')
  assert.ok(!firstRow.includes('cm-rollup-stat'), 'no counts on the narrow row')
})

test('a row that reports a status gives its trailing slot to the badge, not the count', () => {
  // MAP files s1 under n1, and n1 is the only top-level node of Workspace alpha:
  // both rows roll the conversation up and both have children, so both used to
  // draw "1  ⟳1" — two bare numbers the reader could read as one quantity.
  const running = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { running: true } }),
  })
  assert.ok(running.includes('class="cm-rollup"'), 'the running conversation is reported')
  assert.ok(!running.includes('cm-child-count'), 'the running badge takes the slot from the descendant count')

  const pending = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { pendingInteraction: { kind: 'approval' } } }),
  })
  assert.ok(pending.includes('class="cm-rollup"'), 'a pending conversation is reported too')
  assert.ok(!pending.includes('cm-child-count'), 'any category takes the slot, not only running')
})

test('the badge and the descendant count share one slot, keyed to what is drawn', () => {
  const counts = { pending: 0, error: 0, done: 0, running: 0 }
  const idle = { counts, direct: counts, total: 0, attention: 0 }
  assert.equal(showsStatusRollup(undefined), false, 'no status source draws no badge')
  assert.equal(showsStatusRollup(idle), false, 'a subtree with nothing in flight draws no badge')
  assert.equal(
    showsStatusRollup({ ...idle, counts: { ...counts, running: 1 }, total: 1 }),
    true,
    'one running conversation is enough to draw a badge',
  )
})

test('an idle row keeps the product’s descendant count', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: { running: false } }),
  })
  assert.ok(!markup.includes('cm-rollup'), 'an idle subtree needs no badge')
  assert.ok(markup.includes('class="cm-child-count"'), 'so the descendant count stays exactly as before')
})

test('without a status source the rows stay exactly as before', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })))
  assert.ok(!markup.includes('cm-rollup'), 'no rollup markup is invented without Session status')
  assert.ok(markup.includes('class="cm-child-count"'), 'and the descendant count is still the row’s only number')
})


test('a forwarded error is counted until the conversation is opened', () => {
  const ledger = createStatusLedger({ now: () => Date.now() })
  ledger.observe(new Map([['s1', {}]]), ['s1', 's2', 's3'])
  ledger.observeError('s1')
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: {} }),
    services: { statusLedger: ledger },
  })
  assert.ok(markup.includes('aria-label="会话状态：1 条异常（含全部下游节点）"'), 'the node shows the failed conversation')
  const opened = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })), {
    useSessionStatus: useStatus({ s1: {} }),
    services: { statusLedger: ledger },
  })
  assert.ok(!opened.includes('cm-rollup'), 'opening it clears the attention count')
})


test('a completion the product cannot mark shows on its node row until opened', () => {
  // The product never flags its main view as unread; the sidebar row holds the
  // stop in the shared ledger, and the tree draws it exactly like any other
  // unread completion (completion-watch.ts).
  const ledger = createStatusLedger({ now: () => Date.now() })
  ledger.observe(new Map([['s1', {}]]), ['s1', 's2', 's3'])
  ledger.setCompletions(new Map([['s1', Date.now()]]))
  const markup = render(store(MAP, view({ selectedNodeId: 'n1' })), {
    useSessionStatus: useStatus({ s1: {} }),
    services: { statusLedger: ledger },
  })
  assert.ok(
    markup.includes('aria-label="会话状态：1 条已完成（含全部下游节点）"'),
    'the held completion is a normal done mark on the tree',
  )
  assert.ok(markup.includes('data-cat="done"'), 'with the green dot the rows already use')
  const opened = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })), {
    useSessionStatus: useStatus({ s1: {} }),
    services: { statusLedger: ledger },
  })
  assert.ok(!opened.includes('cm-rollup'), 'opening the conversation clears the mark')
})

test('opening one conversation does not hide other completed conversations', () => {
  const markup = render(store(MAP, view({ selectedNodeId: 'n1', openSessionId: 's1' })), {
    useSessionStatus: useStatus({
      s1: { pendingInteraction: { kind: 'approval' } },
      s3: { completionUnread: true },
    }),
  })
  assert.ok(markup.includes('aria-label="会话状态：1 条已完成（含全部下游节点）"'),
    'beta keeps its completed conversation while another conversation is open')
  assert.ok(!markup.includes('1 条待响应'), 'the open pending conversation stays excluded')
})

test('a space row shows its status badge in place of the workspace count', () => {
  const counts = { pending: 1, error: 0, done: 2, running: 1 }
  const rollup = { counts, direct: { ...counts }, total: 4, attention: 3 }
  const markup = renderToStaticMarkup(createElement(SpaceMenuTrailing, { rollup, workspaceCount: 6 }))
  assert.ok(markup.includes('class="cm-rollup"'), 'the space carries the same status mark as a node row')
  assert.ok(markup.includes('data-cat="pending"') && markup.includes('data-cat="done"'), 'with one dot per category')
  assert.ok(
    markup.includes('aria-label="会话状态：1 条待响应，2 条已完成，1 条运行中（该空间全部会话）"'),
    'the accessible name names the space scope',
  )
  assert.ok(!markup.includes('cm-space-count'), 'the status badge takes the single trailing slot')
})

test('an idle space keeps the product’s workspace count', () => {
  const markup = renderToStaticMarkup(createElement(SpaceMenuTrailing, { workspaceCount: 6 }))
  assert.ok(markup.includes('class="cm-space-count"'), 'no status, so the shipped count stays')
  assert.ok(markup.includes('title="6 个工作区"'), 'with the same tooltip it always had')
  assert.ok(!markup.includes('cm-rollup'), 'and no empty badge is invented')
})

test('a zero rollup from an empty status pass falls back to the workspace count', () => {
  const counts = { pending: 0, error: 0, done: 0, running: 0 }
  const rollup = { counts, direct: { ...counts }, total: 0, attention: 0 }
  const markup = renderToStaticMarkup(createElement(SpaceMenuTrailing, { rollup, workspaceCount: 2 }))
  assert.ok(markup.includes('cm-space-count'), 'the count remains the row’s number')
})

/**
 * The search view's rendering contract: a hit may carry a second line (its
 * context path or a match snippet), the keyboard cursor is drawn on exactly one
 * row, and the synthetic 「匹配的对话」 group is a heading rather than a node.
 */
test('the search column renders hit notes, one cursor row, and a non-selectable group heading', () => {
  const column = {
    key: 'search',
    title: '搜索结果（2）',
    rows: [
      {
        id: 'n1', title: '外贸探索', kind: 'node', childCount: 0, tools: false, collapsed: false,
        workspaceId: 'w1', threads: [], note: '外贸工作区 · 从零起步',
      },
      {
        id: '@matches', title: '匹配的对话', kind: 'node', childCount: 0, tools: false, collapsed: false,
        selectable: false,
        threads: [{ sessionId: 's1', title: '第一条对话', time: '', workspaceId: 'w1', note: '…关键词…' }],
      },
    ],
  }
  const markup = renderToStaticMarkup(createElement(NodeColumnView, columnProps({ column, activeRowKey: 'n1' })))
  assert.match(markup, /data-note="true"/, 'rows carrying a note advertise the second line')
  assert.match(markup, /class="cm-row-note"/, 'the note renders under the title')
  assert.equal(markup.split('data-search-active="true"').length - 1, 1, 'only the cursor row is marked')
  assert.match(markup, /data-node-id="n1"[^>]*data-search-active="true"/, 'the cursor sits on the navigable hit')
  assert.match(markup, /data-node-id="@matches"[^>]*data-selectable="false"/, 'the group heading is not selectable')
  assert.match(markup, /…关键词…/, 'the conversation snippet is rendered too')
})
