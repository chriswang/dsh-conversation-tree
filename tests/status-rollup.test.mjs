/**
 * Unit tests for the pure status-rollup pass.
 *
 * The panel only renders what this module returns, so the guarantees are
 * asserted here: subtree aggregation, Workspace/ungrouped scoping, the
 * open-conversation rule, optional running counts, and the two-minute halo
 * stamp. No React or DOM is involved.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  FRESH_MS, attentionTotal, emptyStatusCounts, emptyStatusRollup, rollupStatuses, rollupStatusesBySpace,
} from '../lib/status-rollup.js'

/** A fixed clock keeps the halo assertions deterministic. */
const NOW = 1_000_000_000

/** One node in the fixture tree. */
const node = (id, parentId = null, workspaceId = 'w1') => ({ id, parentId, workspaceId })

/** One indexed conversation. */
const thread = (sessionId, nodeId, workspaceId = 'w1') => ({ sessionId, nodeId, workspaceId })

/** One observed category. */
const observed = (category, changedAt = 0) => ({ category, changedAt })

/** A small tree: n1 → n2 → n3, one conversation at each level plus loose rows. */
const NODES = [node('n1'), node('n2', 'n1'), node('n3', 'n2')]
const THREADS = [
  thread('s1', 'n2'),
  thread('s2', 'n2'),
  thread('s3', 'n3'),
  thread('s4', null, 'w1'),
  thread('s5', null, null),
]

test('an empty map has zeroed rollups everywhere', () => {
  const result = rollupStatuses({ nodes: [], threads: [], statuses: new Map(), now: NOW })
  assert.deepEqual(result.nodes.size, 0)
  assert.deepEqual(result.workspaces.size, 0)
  assert.deepEqual(result.ungrouped.counts, emptyStatusCounts())
  assert.equal(result.ungrouped.total, 0)
  assert.equal(attentionTotal(result), 0)
})

test('every node counts its direct conversations plus every descendant', () => {
  const result = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([
      ['s1', observed('pending')],
      ['s2', observed('done')],
      ['s3', observed('running')],
    ]),
    now: NOW,
  })
  assert.deepEqual(result.nodes.get('n2').counts, { pending: 1, error: 0, done: 1, running: 1 })
  assert.deepEqual(result.nodes.get('n2').direct, { pending: 1, error: 0, done: 1, running: 0 })
  // n1 has no direct conversation of its own but still carries its subtree.
  assert.deepEqual(result.nodes.get('n1').counts, { pending: 1, error: 0, done: 1, running: 1 })
  assert.equal(result.nodes.get('n1').attention, 2, 'attention is pending + error + done')
  assert.equal(result.nodes.get('n1').total, 3, 'total includes running')
  assert.deepEqual(result.nodes.get('n3').counts, { pending: 0, error: 0, done: 0, running: 1 })
})

test('Workspace rows cover every topic in the Workspace plus its direct conversations', () => {
  const result = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([
      ['s1', observed('pending')],
      ['s2', observed('done')],
      ['s4', observed('done')],
      ['s5', observed('done')],
    ]),
    now: NOW,
  })
  assert.deepEqual(result.workspaces.get('w1').counts, { pending: 1, error: 0, done: 2, running: 0 })
  assert.deepEqual(result.ungrouped.counts, { pending: 0, error: 0, done: 1, running: 0 })
  assert.equal(attentionTotal(result), 4, 'pending 1 + done 2 + ungrouped done 1')
})

test('the open conversation is not counted as attention, but its running state still is', () => {
  const result = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([
      ['s1', observed('pending')],
      ['s2', observed('done')],
      ['s3', observed('running')],
    ]),
    openSessionId: 's1',
    now: NOW,
  })
  // Only s1 itself is skipped; s2's completion must still roll up.
  assert.deepEqual(result.nodes.get('n2').counts, { pending: 0, error: 0, done: 1, running: 1 })
  assert.deepEqual(result.nodes.get('n3').counts, { pending: 0, error: 0, done: 0, running: 1 })
})

test('running can be switched off without changing the attention total', () => {
  const result = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([
      ['s1', observed('pending')],
      ['s3', observed('running')],
    ]),
    showRunning: false,
    now: NOW,
  })
  assert.deepEqual(result.nodes.get('n1').counts, { pending: 1, error: 0, done: 0, running: 0 })
  assert.equal(result.nodes.get('n1').total, 1)
})

test('a two-minute change lights the row and its ancestors; older changes do not', () => {
  const fresh = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([
      ['s1', observed('pending', NOW - 1000)],
      ['s2', observed('done', NOW - FRESH_MS - 1000)],
    ]),
    now: NOW,
  })
  assert.equal(fresh.nodes.get('n2').fresh, 'pending')
  assert.equal(fresh.nodes.get('n1').fresh, 'pending', 'the halo propagates to ancestors')
  assert.equal(fresh.ungrouped.fresh, undefined)

  const stale = rollupStatuses({
    nodes: NODES,
    threads: THREADS,
    statuses: new Map([['s1', observed('pending', 0)]]),
    now: NOW,
  })
  assert.equal(stale.nodes.get('n2').fresh, undefined)
})

test('a parent loop stays bounded instead of recursing forever', () => {
  const result = rollupStatuses({
    nodes: [node('a', 'b'), node('b', 'a')],
    threads: [thread('s', 'a')],
    statuses: new Map([['s', observed('done')]]),
    now: NOW,
  })
  assert.ok(result.nodes.get('a').counts.done >= 1)
  assert.ok(result.nodes.get('b').counts.done >= 1)
  assert.ok(result.nodes.get('a').total <= 2, 'the cycle does not multiply the conversation')
})

test('the zero rollup used for rows without conversations is inert', () => {
  const zero = emptyStatusRollup()
  assert.equal(zero.total, 0)
  assert.equal(zero.attention, 0)
  assert.deepEqual(zero.counts, emptyStatusCounts())
})


test('per-space rollups count each conversation once and include empty spaces', () => {
  const result = rollupStatusesBySpace({
    spaces: ['sp1', 'sp2', 'sp3'],
    threads: [
      { sessionId: 'a', nodeId: null, spaceId: 'sp1' },
      { sessionId: 'b', nodeId: 'n1', spaceId: 'sp1' },
      { sessionId: 'c', nodeId: null, spaceId: 'sp2' },
    ],
    statuses: new Map([
      ['a', observed('pending')],
      ['b', observed('running')],
      ['c', observed('done')],
    ]),
    now: NOW,
  })
  assert.equal(result.size, 3)
  assert.deepEqual(result.get('sp1').counts, { pending: 1, error: 0, done: 0, running: 1 })
  assert.equal(result.get('sp1').total, 2)
  assert.equal(result.get('sp1').attention, 1)
  assert.deepEqual(result.get('sp1').direct, result.get('sp1').counts, 'a space is a flat bucket')
  assert.deepEqual(result.get('sp2').counts, { pending: 0, error: 0, done: 1, running: 0 })
  assert.equal(result.get('sp3').total, 0, 'a space without conversations still gets a zero rollup')
})

test('the per-space open-conversation rule matches the node rows', () => {
  const threads = [
    { sessionId: 'open', nodeId: null, spaceId: 'sp1' },
    { sessionId: 'other', nodeId: null, spaceId: 'sp1' },
  ]
  const statuses = new Map([
    ['open', observed('pending')],
    ['other', observed('done')],
  ])
  const result = rollupStatusesBySpace({ spaces: ['sp1'], threads, statuses, openSessionId: 'open', now: NOW })
  assert.equal(result.get('sp1').counts.pending, 0, 'the conversation in front is already seen')
  assert.equal(result.get('sp1').counts.done, 1, 'other conversations keep their status')

  const running = rollupStatusesBySpace({
    spaces: ['sp1'],
    threads: [{ sessionId: 'open', nodeId: null, spaceId: 'sp1' }],
    statuses: new Map([['open', observed('running', NOW)]]),
    openSessionId: 'open',
    now: NOW,
  })
  assert.equal(running.get('sp1').counts.running, 1, 'running stays as live context')
})

test('a space keeps its fresh halo from its own newest change', () => {
  const result = rollupStatusesBySpace({
    spaces: ['sp1', 'sp2'],
    threads: [
      { sessionId: 'a', nodeId: null, spaceId: 'sp1' },
      { sessionId: 'b', nodeId: null, spaceId: 'sp2' },
    ],
    statuses: new Map([
      ['a', observed('pending', NOW - 1000)],
      ['b', observed('done', NOW - FRESH_MS - 1000)],
    ]),
    now: NOW,
  })
  assert.equal(result.get('sp1').fresh, 'pending')
  assert.equal(result.get('sp2').fresh, undefined, 'an old change does not light the space')
})

test('running-only counters can be switched off per space', () => {
  const result = rollupStatusesBySpace({
    spaces: ['sp1'],
    threads: [{ sessionId: 'a', nodeId: null, spaceId: 'sp1' }],
    statuses: new Map([['a', observed('running')]]),
    showRunning: false,
    now: NOW,
  })
  assert.equal(result.get('sp1').total, 0)
})

test('a conversation repeated across space rows is counted once', () => {
  const result = rollupStatusesBySpace({
    spaces: ['sp1', 'sp2'],
    threads: [
      { sessionId: 'a', nodeId: null, spaceId: 'sp1' },
      { sessionId: 'a', nodeId: null, spaceId: 'sp2' },
    ],
    statuses: new Map([['a', observed('pending')]]),
    now: NOW,
  })
  assert.equal(result.get('sp1').counts.pending, 1, 'the first space owns the conversation')
  assert.equal(result.get('sp2').counts.pending, 0, 'a duplicated row must not double count')
})


test('1500 nodes and 3000 conversations stay a linear single pass', () => {
  const nodes = Array.from({ length: 1500 }, (_, index) => node(`n${String(index)}`, index === 0 ? null : `n${String(index - 1)}`))
  const threads = Array.from({ length: 3000 }, (_, index) => thread(`s${String(index)}`, `n${String(index % 1500)}`))
  const statuses = new Map(threads.map((entry, index) => [entry.sessionId, observed(
    index % 3 === 0 ? 'pending' : index % 3 === 1 ? 'done' : 'running',
    NOW - 1000,
  )]))
  const started = performance.now()
  const result = rollupStatuses({ nodes, threads, statuses, now: NOW })
  const elapsed = performance.now() - started
  assert.equal(result.nodes.size, 1500)
  assert.equal(result.nodes.get('n0').counts.pending + result.nodes.get('n0').counts.done + result.nodes.get('n0').counts.running, 3000)
  assert.ok(elapsed < 100, `the rollup should stay well under a frame for the 1500-node ceiling (took ${elapsed.toFixed(1)}ms)`)
})
