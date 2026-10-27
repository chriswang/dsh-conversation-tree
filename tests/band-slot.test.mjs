/**
 * The band-slot observable: who owns the frame's single left band edge.
 *
 * The Conversation header's expand seat belongs to the *free* slot. Two band
 * plugins take turns on that edge (`band-owner.ts`), and the seat must retreat
 * while any of them owns it — otherwise the map's icon floats beside another
 * plugin's band and reads as that band's control. The protocol's source of truth
 * is one attribute on `<html>`, so the store is a thin, testable read of it.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { BAND_EVENT, BAND_OWNER_ATTR } from '../lib/band-owner.js'
import { openBandSlot } from '../lib/band-slot.js'

/**
 * A page face whose attribute the test writes directly.
 *
 * `watch` mirrors the shipped one: one subscription that fires on every
 * candidate change, so the store's own normalization and de-duplication are what
 * the assertions exercise.
 */
function page(initial = null) {
  let value = initial
  const listeners = new Set()
  return {
    read: () => value,
    watch(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    get watchers() {
      return listeners.size
    },
  }
}

test('a free slot reads as no owner', () => {
  const store = openBandSlot(page(null))
  assert.equal(store.getSnapshot(), null, 'the slot starts free')
  store.dispose()
})

test('a peer band owns the slot, and its id is reported verbatim', () => {
  const store = openBandSlot(page('project-chief'))
  assert.equal(store.getSnapshot(), 'project-chief', 'the peer is what the seam expresses')
  store.dispose()
})

test('the owner change is published once per value', () => {
  const face = page(null)
  const store = openBandSlot(face)
  let calls = 0
  const stop = store.subscribe(() => { calls += 1 })
  face.set('project-chief')
  assert.equal(calls, 1, 'a claim reaches the seat')
  assert.equal(store.getSnapshot(), 'project-chief')
  face.set('project-chief')
  assert.equal(calls, 1, 'a repeated write of the same owner is not a change')
  face.set(null)
  assert.equal(calls, 2, 'a release reaches the seat')
  assert.equal(store.getSnapshot(), null)
  stop()
  face.set('project-chief')
  assert.equal(calls, 2, 'an unsubscribed listener stops hearing about it')
  store.dispose()
})

test('a blank attribute is a free slot, not an owner named ""', () => {
  const store = openBandSlot(page('   '))
  assert.equal(store.getSnapshot(), null, 'whitespace is the attribute cleared by hand')
  store.dispose()
})

test('an unknown owner id still counts as occupied', () => {
  const store = openBandSlot(page('some-future-band'))
  assert.equal(store.getSnapshot(), 'some-future-band', 'the seat only needs "not free", not a known peer')
  store.dispose()
})

test('dispose stops watching the page', () => {
  const face = page(null)
  const store = openBandSlot(face)
  assert.equal(face.watchers, 1, 'the store is connected')
  store.dispose()
  assert.equal(face.watchers, 0, 'and disconnects when the client half is disposed')
})

test('the shipped page face reads the protocol attribute on <html>', () => {
  const attribute = { value: null }
  const observers = []
  const windowListeners = new Map()
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
  }
  class FakeObserver {
    constructor(callback) { this.callback = callback }
    observe() { observers.push(this) }
    disconnect() { observers.splice(observers.indexOf(this), 1) }
  }
  globalThis.document = {
    documentElement: {
      getAttribute: name => (name === BAND_OWNER_ATTR ? attribute.value : null),
    },
  }
  globalThis.window = {
    addEventListener: (type, listener) => { windowListeners.set(type, listener) },
    removeEventListener: type => { windowListeners.delete(type) },
  }
  globalThis.MutationObserver = FakeObserver
  try {
    const store = openBandSlot()
    assert.equal(store.getSnapshot(), null, 'no attribute means the slot is free')
    assert.equal(observers.length, 1, 'the store watches the attribute')

    attribute.value = 'project-chief'
    observers[0].callback()
    assert.equal(store.getSnapshot(), 'project-chief', 'the attribute is the source of truth')

    attribute.value = null
    windowListeners.get(BAND_EVENT)({})
    assert.equal(store.getSnapshot(), null, 'the protocol event also refreshes the read')

    store.dispose()
    assert.equal(observers.length, 0, 'dispose disconnects the observer')
    assert.equal(windowListeners.size, 0, 'and the protocol listener')
  } finally {
    globalThis.document = previous.document
    globalThis.window = previous.window
    globalThis.MutationObserver = previous.MutationObserver
  }
})
