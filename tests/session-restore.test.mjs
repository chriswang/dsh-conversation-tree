/**
 * Behavior tests for the remembered-conversation restore on band entry.
 *
 * 会话跟界面走：entering the map switches the Conversation column back to the
 * conversation the map remembers. The rules are deliberately conservative —
 * nothing remembered, or a remembered id that left the Workspace catalog, keeps
 * the current conversation, because the product exposes no "no current session"
 * state to fall back to.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { sessionToRestore } from '../lib/session-restore.js'

/** A catalog that knows two conversations. */
const live = new Set(['s1', 's2'])

test('switches to the remembered conversation when another one is current', () => {
  assert.equal(sessionToRestore({ remembered: 's1', current: 's2', live }), 's1')
})

test('restores even when the current binding cannot be read', () => {
  assert.equal(sessionToRestore({ remembered: 's1', current: null, live }), 's1')
})

test('keeps the current conversation when it is already the remembered one', () => {
  assert.equal(sessionToRestore({ remembered: 's1', current: 's1', live }), null)
})

test('keeps the current conversation when nothing is remembered', () => {
  assert.equal(sessionToRestore({ remembered: null, current: 's2', live }), null)
})

test('keeps the current conversation when the remembered id left the catalog', () => {
  assert.equal(sessionToRestore({ remembered: 's9', current: 's2', live }), null)
})

test('treats an empty remembered id as nothing remembered', () => {
  assert.equal(sessionToRestore({ remembered: '', current: 's2', live }), null)
})
