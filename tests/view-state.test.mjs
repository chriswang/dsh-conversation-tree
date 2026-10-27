/**
 * Behavior tests for recoverable view state.
 *
 * View state is presentation memory: it must survive a reload, and it must
 * never come back pointing at a node, Workspace, or conversation that no longer
 * exists.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { UNGROUPED_ID } from '../lib/model.js'
import {
  DEFAULT_MAP_WIDTH,
  GUTTER_WIDTH,
  MAX_MAP_WIDTH,
  MIN_CENTRE_FOR_BAND,
  MIN_MAP_WIDTH,
  clampColumnWidth,
  clampMapWidth,
  maxMapWidth,
  selectionAfterDelete,
  VIEW_STORAGE_KEY, emptyView, loadView, parseViewState, reconcileView, saveView,
  scrollOf, withScroll,
} from '../lib/view-state.js'

/** A key/value store backed by a plain Map. */
function store() {
  const backing = new Map()
  return {
    backing,
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
}

test('a fresh view is unfolded, empty, and remembers nothing', () => {
  const view = emptyView()
  assert.equal(view.selectedNodeId, null)
  assert.equal(view.navCollapsed, false)
  assert.deepEqual(view.collapsedIds, [])
  assert.equal(scrollOf(view, 'anything'), 0)
})

test('the view round-trips through storage under its own key', () => {
  const backing = store()
  const view = { ...emptyView(), selectedNodeId: 'a1', collapsedIds: ['a'], navCollapsed: true, openSessionId: 's1' }
  saveView(backing, view)
  assert.equal(backing.backing.has(VIEW_STORAGE_KEY), true)
  assert.deepEqual(loadView(backing), view)
})

test('a view document that still carries the removed info-bar flag reads cleanly', () => {
  const legacy = JSON.stringify({ version: 1, selectedNodeId: 'a', collapsedIds: [], navCollapsed: false, openSessionId: null, scroll: [], infoBarOpen: true })
  const view = loadView({ getItem: () => legacy, setItem: () => {} })
  assert.equal(view.selectedNodeId, 'a', 'the rest of the document still loads')
  assert.equal('infoBarOpen' in view, false, 'the removed presentation field is not resurrected')
})

test('unreadable view content falls back to a fresh view', () => {
  assert.deepEqual(parseViewState('{ not json'), emptyView())
  assert.deepEqual(parseViewState(JSON.stringify({ version: 2 })), emptyView())
  assert.deepEqual(loadView({ getItem: () => { throw new Error('denied') }, setItem: () => {} }), emptyView())
})

test('reconciling drops nodes and conversations that are gone', () => {
  const view = { ...emptyView(), selectedNodeId: 'gone', collapsedIds: ['a', 'gone'], openSessionId: 'gone' }
  const reconciled = reconcileView(view, new Set(['a']), new Set(['s1']))
  assert.equal(reconciled.selectedNodeId, null)
  assert.equal(reconciled.openSessionId, null)
  assert.deepEqual(reconciled.collapsedIds, ['a'])
})

test('reconciling keeps a still-valid view identical', () => {
  const view = { ...emptyView(), selectedNodeId: 'a', collapsedIds: ['a'], openSessionId: 's1' }
  assert.equal(reconcileView(view, new Set(['a', 'b']), new Set(['s1'])), view)
})

test('scroll offsets are remembered per node and replace the previous one', () => {
  let view = withScroll(emptyView(), 'a', 120)
  view = withScroll(view, 'b', 40)
  view = withScroll(view, 'a', 260)
  assert.equal(scrollOf(view, 'a'), 260)
  assert.equal(scrollOf(view, 'b'), 40)
  assert.equal(view.scroll.length, 2)
})

test('reconciling also drops scroll memory for removed nodes', () => {
  const view = withScroll(emptyView(), 'gone', 12)
  assert.deepEqual(reconcileView(view, new Set(['a']), new Set()).scroll, [])
})

test('column widths are clamped to a usable band', () => {
  assert.equal(clampColumnWidth(300), 300)
  assert.equal(clampColumnWidth(10), 150)
  assert.equal(clampColumnWidth(5000), 720)
  assert.equal(clampColumnWidth(Number.NaN), 150)
})

test('a stored document from before collapsing existed still loads', () => {
  const legacy = JSON.stringify({ version: 1, selectedNodeId: 'a', expandedIds: ['a'], navCollapsed: false, openSessionId: null, scroll: [] })
  const view = loadView({ getItem: () => legacy, setItem: () => {} })
  assert.equal(view.selectedNodeId, 'a')
  assert.deepEqual(view.collapsedIds, [])
})

test('a stored document from before column widths existed still loads', () => {
  const backing = new Map([[VIEW_STORAGE_KEY, JSON.stringify({ version: 1, selectedNodeId: 'a', collapsedIds: [], navCollapsed: false, openSessionId: null, scroll: [] })]])
  const view = loadView({ getItem: key => backing.get(key) ?? null, setItem: () => {} })
  assert.equal(view.selectedNodeId, 'a')
  assert.deepEqual(view.columnWidths, [])
  assert.ok(view.nodePanelWidth > 0)
  assert.ok(view.mapWidth > 0)
})

test('the old inbox sentinel reads as the ungrouped bucket', () => {
  const view = loadView({ getItem: () => JSON.stringify({ ...emptyView(), selectedNodeId: '@inbox' }), setItem: () => {} })
  assert.equal(view.selectedNodeId, UNGROUPED_ID)
})

test('a fresh view has no active space so the panel can pick the default one', () => {
  assert.equal(emptyView().activeSpace, '')
})

test('the active space is presentation memory and survives a reload', () => {
  const backing = store()
  const view = { ...emptyView(), activeSpace: 'space-1' }
  saveView(backing, view)
  assert.equal(loadView(backing).activeSpace, 'space-1')
})

test('a view document from before spaces existed reads with no active space', () => {
  const legacy = JSON.stringify({ version: 1, selectedNodeId: 'a', collapsedIds: [], navCollapsed: false, openSessionId: null, scroll: [] })
  const view = loadView({ getItem: () => legacy, setItem: () => {} })
  assert.equal(view.activeSpace, '')
})

test('a Workspace selection survives reconciliation while the Workspace is listed', () => {
  const view = { ...emptyView(), selectedNodeId: '@ws:w1', collapsedIds: ['@ws:w1'] }
  const live = new Set(['@ws:w1', UNGROUPED_ID])
  assert.equal(reconcileView(view, new Set(), new Set(), live), view)
})

test('a selection pointing at a removed Workspace is dropped', () => {
  const view = { ...emptyView(), selectedNodeId: '@ws:gone', collapsedIds: ['@ws:gone'] }
  const reconciled = reconcileView(view, new Set(), new Set(), new Set([UNGROUPED_ID]))
  assert.equal(reconciled.selectedNodeId, null)
  assert.deepEqual(reconciled.collapsedIds, [])
})

test('the ungrouped bucket selection is always a valid destination', () => {
  const view = { ...emptyView(), selectedNodeId: UNGROUPED_ID }
  assert.equal(reconcileView(view, new Set(), new Set(), new Set([UNGROUPED_ID])).selectedNodeId, UNGROUPED_ID)
})

test('deleting the selected node lands the reader on its parent', () => {
  const view = { ...emptyView(), selectedNodeId: 'child' }
  assert.equal(selectionAfterDelete(view, 'child', 'parent').selectedNodeId, 'parent')
})

test('deleting a selected node can land the reader on its Workspace', () => {
  const view = { ...emptyView(), selectedNodeId: 'root' }
  assert.equal(selectionAfterDelete(view, 'root', '@ws:w1').selectedNodeId, '@ws:w1')
})

test('deleting another node leaves the selection alone', () => {
  const view = { ...emptyView(), selectedNodeId: 'kept' }
  assert.equal(selectionAfterDelete(view, 'other', 'parent').selectedNodeId, 'kept')
})

test('the map band ceiling reserves the shipped Conversation minimum', () => {
  const ceiling = maxMapWidth(1320, 420)
  assert.equal(ceiling, 1320 - 420 - GUTTER_WIDTH)
  assert.ok(ceiling > 0 && ceiling < 1320)
})

test('the band minimum wins over the Conversation reservation', () => {
  // 824 - 420 - 6: the ceiling the right Sidebar's own drag left behind.
  assert.equal(maxMapWidth(824), 824 - 420 - GUTTER_WIDTH)
  // Below that the ceiling holds the band's own floor and the Conversation
  // column takes what is left: geometry never squeezes the band away.
  assert.equal(maxMapWidth(664), MIN_MAP_WIDTH)
  assert.equal(maxMapWidth(600), MIN_MAP_WIDTH)
  assert.equal(MIN_CENTRE_FOR_BAND, MIN_MAP_WIDTH + GUTTER_WIDTH)
})

test('a cramped centre keeps the band at its floor instead of removing it', () => {
  // The product lets the centre shrink to 400px. The band keeps its functional
  // minimum there; the reader — not geometry — decides whether it goes away.
  assert.equal(maxMapWidth(400), MIN_MAP_WIDTH)
  assert.equal(maxMapWidth(MIN_CENTRE_FOR_BAND), MIN_MAP_WIDTH)
})

test('an unmeasured centre leaves the safety ceiling alone', () => {
  assert.equal(maxMapWidth(0, 420), MAX_MAP_WIDTH)
  assert.equal(maxMapWidth(Number.NaN, 420), MAX_MAP_WIDTH)
})

test('a map width is clamped into its usable band', () => {
  assert.equal(clampMapWidth(100), MIN_MAP_WIDTH)
  assert.equal(clampMapWidth(600, 500), 500)
  assert.equal(clampMapWidth(Number.NaN), DEFAULT_MAP_WIDTH)
  // The live ceiling never falls below the band's floor, so the narrowest
  // reachable width is MIN_MAP_WIDTH — never a sliver.
  assert.equal(clampMapWidth(560, MIN_MAP_WIDTH), MIN_MAP_WIDTH)
})

test('a drag is clamped to the ceiling it was given', () => {
  assert.equal(clampColumnWidth(2000, 1088), 1088)
  assert.equal(clampColumnWidth(2000), 720)
  assert.equal(clampColumnWidth(10, 1088), 150)
})
