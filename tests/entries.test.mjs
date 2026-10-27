/**
 * Render tests for the two entry seats.
 *
 * The band is a column: while it is expanded its own top bar draws the single
 * 「收起」 control; while it is collapsed the Conversation header's leading seat
 * draws the same 28×28 icon box (「展开对话树」 in its name) plus, for a first
 * reader only, one transient hint beside it. The two occurrences never coexist.
 * The persistent entry is the sidebar's `sidebar.panellist` row; the shell draws
 * its button and label, so only the glyph is rendered here. Behavior of the
 * stores lives in `mode-memory.test.mjs`.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MapLauncher, MapPanelIcon, watchRowActivation } from '../lib/entries.js'
import { createStatusLedger } from '../lib/status-ledger.js'

/** A collapse store whose value the test sets directly. */
function collapse(collapsed = true) {
  let value = collapsed
  const listeners = new Set()
  const publish = () => { for (const listener of [...listeners]) listener() }
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      value = next
      publish()
    },
    toggle: () => {
      value = !value
      publish()
    },
  }
}

/** A hint store whose pending flag the test sets directly. */
function hint(pending = true) {
  let value = pending
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dismiss: () => {
      if (!value) return
      value = false
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A band-slot observable whose owner the test sets directly. */
function bandSlot(owner = null) {
  let value = owner
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

test('a collapsed band draws the icon-only expand control', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, { collapsed: collapse(true), hint: hint(false) }))
  assert.ok(markup.includes('cm-view-toggle'), 'the single control is drawn')
  assert.ok(markup.includes('cm-view-toggle--icon'), 'the box is the same icon-only shape as the band side')
  assert.ok(markup.includes('data-target="map"'), 'the control keeps the map seat id')
  assert.ok(markup.includes('aria-label="展开对话树"'), 'the accessible name states the action')
  assert.ok(!markup.includes('cm-view-toggle-label'), 'the button carries no visible copy')
  assert.ok(!markup.includes('cm-hint'), 'a dismissed hint stays gone')
})

test('the first reader sees the one-time hint beside the icon', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, { collapsed: collapse(true), hint: hint(true) }))
  assert.ok(markup.includes('cm-hint'), 'the hint is drawn while it is pending')
  assert.ok(markup.includes('展开对话树'), 'the hint names the affordance')
  assert.ok(markup.includes('aria-hidden="true"'), 'the hint is decorative: the button carries the name')
})

test('an expanded band leaves the header seat empty', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, { collapsed: collapse(false), hint: hint(true) }))
  assert.equal(markup, '', 'the band top bar draws the only visible control while expanded')
})

test('a seat without stores draws nothing', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, {}))
  assert.equal(markup, '', 'without the collapse store there is no band to expand')
})

/*
 * The seat belongs to the free slot. Two band plugins take turns on the frame's
 * left edge, so while any band owns it the seam already expresses that band and
 * the map's contextual entry must retreat — its persistent sidebar row is what
 * the reader switches bands from.
 */
test('a peer band owning the slot hides the header seat', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, {
    collapsed: collapse(true),
    hint: hint(true),
    bandSlot: bandSlot('project-chief'),
  }))
  assert.equal(markup, '', 'another plugin draws this edge; the map entry does not float beside it')
})

test('the seat comes back once the peer releases the slot', () => {
  const slot = bandSlot('project-chief')
  const seat = createElement(MapLauncher, { collapsed: collapse(true), hint: hint(false), bandSlot: slot })
  assert.equal(renderToStaticMarkup(seat), '', 'hidden while the peer owns the edge')
  slot.set(null)
  const markup = renderToStaticMarkup(seat)
  assert.ok(markup.includes('cm-view-toggle'), 'the same seat returns on release')
  assert.ok(markup.includes('aria-label="展开对话树"'), 'with the same action name')
})

test('this band owning the slot draws no header seat either', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, {
    collapsed: collapse(true),
    hint: hint(true),
    bandSlot: bandSlot('conversation-map'),
  }))
  assert.equal(markup, '', 'the band surface itself owns the edge while it is on screen')
})

test('a free slot with an expanded band leaves the seat empty', () => {
  const markup = renderToStaticMarkup(createElement(MapLauncher, {
    collapsed: collapse(false),
    hint: hint(true),
    bandSlot: bandSlot(null),
  }))
  assert.equal(markup, '', 'the band top bar draws the only visible control while expanded')
})

/** A panel-info observable whose selection the test sets directly. */
function panelInfo(activePanelId = null) {
  return {
    getSnapshot: () => ({ activePanelId }),
    subscribe: () => () => {},
  }
}

test('the sidebar panel glyph reads the expanded band as "in use"', () => {
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(false),
    panelInfo: panelInfo(null),
    size: 16,
  }))
  assert.ok(markup.includes('cm-panel-glyph'), 'the row carries the map glyph')
  assert.ok(markup.includes('data-in-use="true"'), 'the expanded band is on screen')
  assert.ok(markup.includes('fill="currentColor"'), 'the glyph is the filled reading')
  assert.ok(!markup.includes('cm-panel-glyph-dot'), 'the filled mark is the only state marker')
  assert.ok(markup.includes('title="对话树（已开启）"'), 'the tooltip names the state')
})

test('a collapsed band leaves the panel glyph in the outline reading', () => {
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
  }))
  assert.ok(markup.includes('data-in-use="false"'))
  assert.ok(!markup.includes('fill="currentColor"'), 'the outline reading stays')
  assert.ok(markup.includes('title="对话树"'), 'the tooltip is the plain name')
})

test('a band expanded behind a global panel is not "in use"', () => {
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(false),
    panelInfo: panelInfo('plugins'),
    size: 16,
  }))
  assert.ok(markup.includes('data-in-use="false"'), 'the Plugins page owns the centre, so the band is not on screen')
  assert.ok(!markup.includes('fill="currentColor"'), 'the outline reading stays')
})

test('the panel glyph falls back to the outline reading without sources', () => {
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, { size: 18 }))
  assert.ok(markup.includes('data-in-use="false"'))
  assert.ok(markup.includes('cm-panel-glyph'))
})


test('a collapsed band carries the status cluster on the sidebar row', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]]), ['s1'])
  const store = {
    getSnapshot: () => ({ phase: 'ready', doc: { threads: [{ sessionId: 's1', nodeId: null, workspaceId: null }] }, revision: 1, pending: 0 }),
    subscribe: () => () => {},
    update: () => ({ ok: true }),
    refresh: async () => {},
    load: async () => {},
    dispose() {},
  }
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store,
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]])),
  }))
  assert.ok(markup.includes('cm-rollup'), 'the collapsed row carries the node-style status cluster')
  assert.ok(markup.includes('data-cat="pending"'), 'a pending request shows its own dot')
  assert.ok(markup.includes('cm-rollup-count'), 'the cluster carries the count, not just a tint')
  assert.ok(
    markup.includes('aria-label="会话状态：1 条待响应（全部已索引会话）"'),
    'the cluster names the counts and their global scope',
  )
  assert.ok(markup.includes('data-seat="wide"'), 'the wide row is the seat that can hold the counts')
  assert.ok(markup.includes('1 条待处理'), 'the tooltip names the attention total')
  assert.ok(!markup.includes('cm-panel-badge'), 'the corner badge is gone')
})

test('an expanded band keeps the map-wide cluster on the sidebar row', () => {
  // The tree in front covers one space; the sidebar row's cluster is the map's
  // whole-scope count, so it stays whether the band is collapsed or expanded.
  // Only opening/answering the conversation itself clears its status.
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]]), ['s1'])
  const store = {
    getSnapshot: () => ({ phase: 'ready', doc: { threads: [{ sessionId: 's1', nodeId: null, workspaceId: null }] }, revision: 1, pending: 0 }),
    subscribe: () => () => {},
    update: () => ({ ok: true }),
    refresh: async () => {},
    load: async () => {},
    dispose() {},
  }
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(false),
    panelInfo: panelInfo(null),
    size: 16,
    store,
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]])),
  }))
  assert.ok(markup.includes('cm-rollup'), 'the row keeps the counts while the space tree is in front')
  assert.ok(markup.includes('data-cat="pending"'), 'with the same mark the node rows draw')
  assert.ok(
    markup.includes('aria-label="会话状态：1 条待响应（全部已索引会话）"'),
    'the badge still names its global scope',
  )
  assert.ok(markup.includes('data-in-use="true"'), 'the in-use marker stays')
  assert.ok(
    markup.includes('对话树（已开启）：1 条待处理'),
    'the tooltip carries both the state and the counts',
  )
})


test('a band behind a global panel still shows the status cluster', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]]), ['s1'])
  const store = {
    getSnapshot: () => ({ phase: 'ready', doc: { threads: [{ sessionId: 's1', nodeId: null, workspaceId: null }] }, revision: 1, pending: 0 }),
    subscribe: () => () => {},
    update: () => ({ ok: true }),
    refresh: async () => {},
    load: async () => {},
    dispose() {},
  }
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(false),
    panelInfo: panelInfo('plugins'),
    size: 16,
    store,
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]])),
  }))
  assert.ok(markup.includes('cm-rollup'), 'the covered band leaves the counts on the sidebar')
})

/** The map store a sidebar render test needs: one indexed conversation. */
function oneThreadStore(threads) {
  return {
    getSnapshot: () => ({ phase: 'ready', doc: { threads }, revision: 1, pending: 0 }),
    subscribe: () => () => {},
    update: () => ({ ok: true }),
    refresh: async () => {},
    load: async () => {},
    dispose() {},
  }
}

test('the 56px rail keeps the cluster as dots, with the counts in the title', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]]), ['s1'])
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 18,
    store: oneThreadStore([{ sessionId: 's1', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]])),
  }))
  assert.ok(markup.includes('data-seat="rail"'), 'the 18px glyph is the rail seat')
  assert.ok(markup.includes('cm-rollup-dots'), 'the rail reads the colours, not the counts')
  assert.ok(!markup.includes('cm-rollup-count'), 'no number fits beside an icon-only row')
  assert.ok(markup.includes('1 条待处理'), 'the numbers stay in the row title')
})

test('the conversation already in front of the reader is left out of the cluster', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  const done = new Map([
    ['open', { completionUnread: true }],
    ['other', { completionUnread: true }],
  ])
  ledger.observe(done, ['open', 'other'])
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store: oneThreadStore([
      { sessionId: 'open', nodeId: null, workspaceId: null },
      { sessionId: 'other', nodeId: null, workspaceId: null },
    ]),
    statusLedger: ledger,
    useSessions: selector => selector({
      ids: ['open', 'other'],
      byId: { open: { retainedBy: { mainView: 1 } }, other: { displayTitle: '另一条' } },
    }),
    useSessionStatus: selector => selector(done),
  }))
  assert.ok(markup.includes('1 条已完成'), 'only the conversation behind the reader is counted')
  assert.ok(!markup.includes('2 条已完成'), 'the open conversation is already read, not a count')
})

test('a running conversation in front still marks the sidebar cluster', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  const live = new Map([['running', { running: true }]])
  ledger.observe(live, ['running'])
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store: oneThreadStore([{ sessionId: 'running', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['running'], byId: { running: { retainedBy: { mainView: 1 } } } }),
    useSessionStatus: selector => selector(live),
  }))
  assert.ok(markup.includes('cm-rollup-ring'), 'the current conversation keeps the running ring its node row draws')
  assert.ok(markup.includes('1 个会话运行中'), 'a lone running session is exactly what the row reports')
  assert.ok(!markup.includes('条待处理'), 'running is context, not a to-do')
})

test('a running conversation reads as the running category, not as attention', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', { running: true }]]), ['s1'])
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store: oneThreadStore([{ sessionId: 's1', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { running: true }]])),
  }))
  assert.ok(markup.includes('cm-rollup-ring'), 'the running category keeps the node row\'s ring mark')
  assert.ok(markup.includes('1 个会话运行中'), 'the title says running, not pending')
  assert.ok(!markup.includes('条待处理'), 'running is context, not a to-do')
})

test('a category that just moved lights the same fresh halo as a node row', () => {
  const ledger = createStatusLedger()
  ledger.observe(new Map([['s1', { running: true }]]), ['s1'])
  ledger.observe(new Map([['s1', { completionUnread: true }]]), ['s1'])
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store: oneThreadStore([{ sessionId: 's1', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { displayTitle: '对话' } } }),
    useSessionStatus: selector => selector(new Map([['s1', { completionUnread: true }]])),
  }))
  assert.ok(markup.includes('data-fresh="done"'), 'a change within the two-minute window is announced')
})

test('a completion the product cannot mark reaches the sidebar cluster', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', {}]]), ['s1'])
  ledger.setCompletions(new Map([['s1', Date.now()]]))
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    // A global panel covers the Conversation; the product keeps calling `s1`
    // current and never marks it unread, so the held completion is the only mark.
    panelInfo: panelInfo('plugins'),
    size: 16,
    store: oneThreadStore([{ sessionId: 's1', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }),
    useSessionStatus: selector => selector(new Map([['s1', {}]])),
  }))
  assert.ok(
    markup.includes('aria-label="会话状态：1 条已完成（全部已索引会话）"'),
    'the held completion is counted as done, exactly like a product unread completion',
  )
  assert.ok(markup.includes('data-cat="done"'), 'with the same green dot a node row draws')
})

test('a held completion is not repeated while its conversation is in front', () => {
  const ledger = createStatusLedger({ now: () => 10 })
  ledger.observe(new Map([['s1', {}]]), ['s1'])
  ledger.setCompletions(new Map([['s1', Date.now()]]))
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
    store: oneThreadStore([{ sessionId: 's1', nodeId: null, workspaceId: null }]),
    statusLedger: ledger,
    useSessions: selector => selector({ ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }),
    useSessionStatus: selector => selector(new Map([['s1', {}]])),
  }))
  assert.ok(!markup.includes('cm-rollup'), 'the reader can see the conversation, so nothing stays unread')
})

/*
 * The row's one action is delivered by watching the shell's own row button: the
 * plugin gets no click callback on `sidebar.panellist`, and the `main` bridge
 * behind the row can be skipped entirely when a sibling plugin navigates the
 * centre back to the Conversation in the same notification.
 */

/** A stand-in for the shell's panel-row button, recording its listeners. */
function fakeRow() {
  const listeners = new Map()
  return {
    row: {
      addEventListener: (type, listener, capture) => {
        listeners.set(`${type}:${String(capture)}`, listener)
      },
      removeEventListener: (type, listener, capture) => {
        const key = `${type}:${String(capture)}`
        if (listeners.get(key) === listener) listeners.delete(key)
      },
    },
    listeners,
    /** Dispatch the click the shell button would deliver. */
    click: () => { listeners.get('click:true')?.({ defaultPrevented: false }) },
  }
}

test('the sidebar glyph watches its own row activation in the capture phase', () => {
  const fake = fakeRow()
  const calls = []
  const stop = watchRowActivation({ closest: selector => selector === 'button' ? fake.row : null }, () => {
    calls.push('activate')
  })
  assert.ok(fake.listeners.has('click:true'), 'the button is watched in the capture phase, before the shell runs selectPanel')
  assert.equal(fake.listeners.size, 1, 'exactly one listener is added')
  fake.click()
  assert.deepEqual(calls, ['activate'], 'one row click runs the one-way action once')
  stop()
  assert.equal(fake.listeners.size, 0, 'unmount detaches the listener')
  fake.click()
  assert.deepEqual(calls, ['activate'], 'a detached row can no longer activate')
})

test('a glyph without a button row leaves the entry to the bridge fallback', () => {
  let calls = 0
  const stop = watchRowActivation({ closest: () => null }, () => { calls += 1 })
  stop()
  assert.equal(calls, 0, 'nothing is observed when the row is not a button')
})

test('a missing glyph is harmless (the bridge still carries the row)', () => {
  let calls = 0
  const stop = watchRowActivation(null, () => { calls += 1 })
  stop()
  assert.equal(calls, 0, 'no glyph before mount means no listener and no activation')
})
