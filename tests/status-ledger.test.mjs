/**
 * Unit tests for the in-memory status observation.
 *
 * The ledger never owns a product status: it mirrors the live snapshot for
 * transition timestamps and overlays forwarded error events. These tests pin
 * the precedence, the baseline (no halo on first observation), the clearing
 * rules, and pruning.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { categoryOf, createStatusLedger } from '../lib/status-ledger.js'

/** A controllable clock. */
function clock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance: ms => { value += ms },
  }
}

test('pending outranks running and unread completion', () => {
  assert.equal(categoryOf({ pendingInteraction: { kind: 'approval' }, running: true, completionUnread: true }, undefined, true), 'pending')
  assert.equal(categoryOf({ pendingInteraction: { kind: 'question' }, running: false, completionUnread: true }, undefined, false), 'pending')
})

test('running outranks an unread completion and an old error', () => {
  assert.equal(categoryOf({ running: true, completionUnread: true }, 123, true), 'running')
  assert.equal(categoryOf({ running: false, completionUnread: true }, undefined, false), 'done')
})

test('an error is only a category while the session is not running', () => {
  assert.equal(categoryOf({}, 123, true), 'running')
  assert.equal(categoryOf({}, 123, false), 'error')
  assert.equal(categoryOf({ running: true }, 123, true), 'running')
})

test('an idle session is not counted and an unread completion is', () => {
  assert.equal(categoryOf(undefined, undefined, false), undefined)
  assert.equal(categoryOf({ completionUnread: true }, undefined, false), 'done')
})

test('the first observation is a baseline, not a transition', () => {
  const time = clock()
  const ledger = createStatusLedger({ now: time.now })
  ledger.observe(new Map([['s1', { pendingInteraction: { kind: 'approval' } }]]), ['s1'])
  const entry = ledger.getSnapshot().get('s1')
  assert.equal(entry.category, 'pending')
  assert.equal(entry.changedAt, 0, 'no halo for conversations that were already pending at mount')
})

test('a later category change records the transition time', () => {
  const time = clock()
  const ledger = createStatusLedger({ now: time.now })
  ledger.observe(new Map([['s1', {}]]), ['s1'])
  assert.equal(ledger.getSnapshot().get('s1'), undefined)
  time.advance(500)
  ledger.observe(new Map([['s1', { completionUnread: true }]]), ['s1'])
  assert.equal(ledger.getSnapshot().get('s1').category, 'done')
  assert.equal(ledger.getSnapshot().get('s1').changedAt, time.now())
})

test('an error event marks the session until it runs or is acknowledged', () => {
  const time = clock()
  const ledger = createStatusLedger({ now: time.now })
  ledger.observe(new Map([['s1', {}]]), ['s1'])
  time.advance(100)
  ledger.observeError('s1')
  assert.equal(ledger.getSnapshot().get('s1').category, 'error')
  assert.ok(ledger.getErrors().has('s1'))

  ledger.observeRunning('s1')
  assert.equal(ledger.getErrors().has('s1'), false)
  assert.equal(ledger.getSnapshot().get('s1'), undefined)

  ledger.observeError('s1')
  ledger.acknowledge('s1')
  assert.equal(ledger.getErrors().has('s1'), false)
  assert.equal(ledger.getSnapshot().get('s1'), undefined)
})

test('a running session clears an earlier error on the next observation', () => {
  const time = clock()
  const ledger = createStatusLedger({ now: time.now })
  ledger.observeError('s1')
  assert.equal(ledger.getSnapshot().get('s1').category, 'error')
  ledger.observe(new Map([['s1', { running: true }]]), ['s1'])
  assert.equal(ledger.getSnapshot().get('s1').category, 'running')
  assert.equal(ledger.getErrors().has('s1'), false)
})

test('pruning drops sessions the map no longer indexes', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.observe(new Map([
    ['s1', { completionUnread: true }],
    ['s2', { pendingInteraction: { kind: 'question' } }],
  ]), ['s1', 's2'])
  ledger.prune(new Set(['s1']))
  assert.deepEqual([...ledger.getSnapshot().keys()], ['s1'])
  ledger.dispose()
})

test('subscribers hear about transitions and can unsubscribe', () => {
  const time = clock()
  const ledger = createStatusLedger({ now: time.now })
  let calls = 0
  const stop = ledger.subscribe(() => { calls += 1 })
  ledger.observe(new Map([['s1', { completionUnread: true }]]), ['s1'])
  assert.equal(calls, 1)
  stop()
  ledger.observe(new Map([['s1', {}]]), ['s1'])
  assert.equal(calls, 1)
})

/*
 * The held completion is the third observation: the product never marks its main
 * view unread, so the sidebar row stores a stop it saw behind a covering panel
 * here. The tree and the sidebar both read it, so these tests pin how it is
 * stored, when it is replaced, and every way it is cleared.
 */

test('held completions are stored, replaced, and published once per change', () => {
  const ledger = createStatusLedger()
  let calls = 0
  const stop = ledger.subscribe(() => { calls += 1 })
  ledger.setCompletions(new Map([['s1', 120]]))
  assert.deepEqual([...ledger.getCompletions()], [['s1', 120]])
  assert.equal(calls, 1, 'the two surfaces are told to re-read')
  ledger.setCompletions(new Map([['s1', 120]]))
  assert.equal(calls, 1, 'an identical map is not a change')
  ledger.setCompletions(new Map())
  assert.equal(ledger.getCompletions().size, 0)
  assert.equal(calls, 2)
  stop()
})

test('a new turn or the product unread flag clears the held completion', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.setCompletions(new Map([['s1', 10], ['s2', 10]]))
  ledger.observe(new Map([
    ['s1', { running: true }],
    ['s2', { completionUnread: true }],
  ]), ['s1', 's2'])
  assert.equal(ledger.getCompletions().size, 0, 'the normal observation owns both cases again')
})

test('opening the conversation acknowledges its held completion', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.setCompletions(new Map([['s1', 10]]))
  ledger.acknowledge('s1')
  assert.equal(ledger.getCompletions().size, 0)
})

test('a session running again clears its held completion', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.setCompletions(new Map([['s1', 10]]))
  ledger.observeRunning('s1')
  assert.equal(ledger.getCompletions().size, 0)
})

test('pruning drops held completions for sessions that left the index', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.setCompletions(new Map([['s1', 10], ['s2', 10]]))
  ledger.prune(new Set(['s1']))
  assert.deepEqual([...ledger.getCompletions().keys()], ['s1'])
})

test('disposing drops held completions', () => {
  const ledger = createStatusLedger({ now: () => 5 })
  ledger.setCompletions(new Map([['s1', 10]]))
  ledger.dispose()
  assert.equal(ledger.getCompletions().size, 0)
})
