/**
 * Behavior tests for the band-collapse memory.
 *
 * The store decides one thing: whether the reader collapsed the band. A first
 * application starts collapsed; afterwards the reader's choice is restored. The
 * removed on/off mode key is read once for migration and never written again.
 * Storage denial degrades to "nothing remembered".
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  BAND_COLLAPSED_KEY, HINT_KEY, MODE_KEY,
  openBandCollapseMemory, openFirstRunHint,
} from '../lib/mode-memory.js'

/** A key/value store backed by a plain Map. */
function store(initial = []) {
  const backing = new Map(initial)
  return {
    backing,
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
  }
}

test('a first application starts collapsed', () => {
  const storage = store()
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), true)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'collapsed', 'the default is written once')
})

test('expanding is remembered for the next application', () => {
  const storage = store()
  openBandCollapseMemory(storage).set(false)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'expanded')
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), false)
})

test('collapsing is remembered too, and is not undone', () => {
  const storage = store()
  const first = openBandCollapseMemory(storage)
  first.set(false)
  first.set(true)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'collapsed')
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), true)
})

test('a legacy on/off mode migrates once and is never written again', () => {
  const storage = store([[MODE_KEY, 'on']])
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), false, 'a legacy on means expanded')
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'expanded', 'the new key is written')
  const legacy = storage.backing.get(MODE_KEY)
  openBandCollapseMemory(storage).set(true)
  assert.equal(storage.backing.get(MODE_KEY), legacy, 'the removed key is only read')
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'collapsed')
})

test('a legacy off mode migrates to collapsed', () => {
  const storage = store([[MODE_KEY, 'off']])
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), true)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'collapsed')
})

test('the new key wins over a stale legacy value', () => {
  const storage = store([[MODE_KEY, 'on'], [BAND_COLLAPSED_KEY, 'collapsed']])
  assert.equal(openBandCollapseMemory(storage).getSnapshot(), true)
})

test('toggle flips and persists in one step', () => {
  const storage = store()
  const collapse = openBandCollapseMemory(storage)
  collapse.toggle()
  assert.equal(collapse.getSnapshot(), false)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'expanded')
  collapse.toggle()
  assert.equal(collapse.getSnapshot(), true)
  assert.equal(storage.backing.get(BAND_COLLAPSED_KEY), 'collapsed')
})

test('setting the same value does not notify', () => {
  const collapse = openBandCollapseMemory(store())
  let notifications = 0
  const stop = collapse.subscribe(() => { notifications += 1 })
  collapse.set(true)
  assert.equal(notifications, 0)
  collapse.set(false)
  collapse.set(false)
  assert.equal(notifications, 1)
  stop()
  collapse.set(true)
  assert.equal(notifications, 1)
})

test('a denied store degrades to one-page memory instead of throwing', () => {
  const denied = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  const collapse = openBandCollapseMemory(denied)
  assert.equal(collapse.getSnapshot(), true)
  collapse.set(false)
  assert.equal(collapse.getSnapshot(), false)
  assert.equal(openBandCollapseMemory(denied).getSnapshot(), true)
})

test('the one-time hint is pending once, then never again', () => {
  const storage = store()
  assert.equal(openFirstRunHint(storage).getSnapshot(), true)
  const hint = openFirstRunHint(storage)
  let notifications = 0
  const stop = hint.subscribe(() => { notifications += 1 })
  hint.dismiss()
  hint.dismiss()
  assert.equal(hint.getSnapshot(), false)
  assert.equal(notifications, 1, 'dismissing twice notifies once')
  stop()
  assert.equal(storage.backing.get(HINT_KEY), 'seen')
  assert.equal(openFirstRunHint(storage).getSnapshot(), false)
})

test('a denied store never shows the hint', () => {
  const denied = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  const hint = openFirstRunHint(denied)
  assert.equal(hint.getSnapshot(), false, 'nagging on every start would be worse than no hint')
  assert.doesNotThrow(() => { hint.dismiss() })
})
