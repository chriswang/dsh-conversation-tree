/**
 * Transition rules of the covered-completion watch.
 *
 * The product never marks its main view unread, so a turn that stops while a
 * global panel covers the Conversation has no product status to carry it. The
 * sidebar row holds that stop itself; these tests pin when the hold starts and
 * when it is released, without a DOM.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { nextCoveredCompletions } from '../lib/completion-watch.js'

/** Run one observation with defaults for the parts a test does not care about. */
function observe({
  held = new Map(),
  previous = null,
  running = new Map(),
  unread = new Set(),
  mainSessionId = 's1',
  covered = true,
  now = 1000,
} = {}) {
  return nextCoveredCompletions({ held, previous, running, unread, mainSessionId, covered, now })
}

test('the first observation is a baseline, never a completion', () => {
  const next = observe({ previous: null, running: new Map([['s1', false]]) })
  assert.equal(next.size, 0, 'a session that was already stopped is history, not news')
})

test('the main session stopping behind a covering panel is held', () => {
  const next = observe({ previous: new Map([['s1', true]]), running: new Map([['s1', false]]), now: 1234 })
  assert.deepEqual([...next], [['s1', 1234]], 'the stop is held with its observation time')
})

test('a stop while the conversation is in front is not a reminder', () => {
  const next = observe({
    previous: new Map([['s1', true]]),
    running: new Map([['s1', false]]),
    covered: false,
  })
  assert.equal(next.size, 0, 'the reader saw the turn finish; the product treats it as read')
})

test('a session that is not main is left to the product flag', () => {
  const next = observe({
    previous: new Map([['s1', true], ['s2', true]]),
    running: new Map([['s1', false], ['s2', false]]),
    mainSessionId: 's1',
  })
  assert.deepEqual([...next], [['s1', 1000]], 'only the main view needs the plugin-side hold')
})

test('a held completion is released once the product marks it unread', () => {
  const next = observe({
    held: new Map([['s1', 10]]),
    running: new Map([['s1', false]]),
    unread: new Set(['s1']),
  })
  assert.equal(next.size, 0, 'the normal rollup owns it then, so holding it too would double count')
})

test('a new turn releases the held completion', () => {
  const next = observe({ held: new Map([['s1', 10]]), running: new Map([['s1', true]]) })
  assert.equal(next.size, 0, 'the old stop is no longer the latest thing that happened')
})

test('coming back in front releases the held completion', () => {
  const next = observe({ held: new Map([['s1', 10]]), running: new Map([['s1', false]]), covered: false })
  assert.equal(next.size, 0, 'the reader can see the conversation now')
})

test('a conversation that left the catalog releases the held completion', () => {
  const next = observe({ held: new Map([['s1', 10]]), running: new Map() })
  assert.equal(next.size, 0, 'a deleted conversation cannot be opened, so it must not stay counted')
})

test('the held map keeps its identity when nothing moves', () => {
  const held = new Map([['s1', 10]])
  const next = observe({
    held,
    previous: new Map([['s1', false]]),
    running: new Map([['s1', false]]),
  })
  assert.equal(next, held, 'React can bail out of the state update')
})

test('a held completion survives a return that lands on another conversation', () => {
  // The reader closed the panel by opening another session: the completed
  // conversation was never in front, so it stays unread until it is opened.
  const held = new Map([['s1', 10]])
  const next = observe({
    held,
    running: new Map([['s1', false], ['s2', false]]),
    mainSessionId: 's2',
    covered: false,
  })
  assert.deepEqual([...next], [['s1', 10]], 'only its own conversation clears it')
})

test('a held completion survives the reader opening another session behind the panel', () => {
  const held = new Map([['s1', 10]])
  const next = observe({
    held,
    running: new Map([['s1', false], ['s2', false]]),
    mainSessionId: 's2',
  })
  assert.deepEqual([...next], [['s1', 10]], 'the completed conversation is still unread, so the hold stays')
})
