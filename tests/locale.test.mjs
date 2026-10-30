/**
 * Locale-contract tests for the conversation-map namespace.
 *
 * The plugin ships exactly two dictionaries (`zh`, `en`). These tests pin the
 * invariants the DSH locale service relies on — identical key sets, matching
 * placeholder names, English copy that actually differs from the key — plus the
 * translator behaviour and the render-tree plumbing (`LocaleProvider`/`useT`).
 * A component render through a marker translator proves the wiring independently
 * of the wording a feature finally chooses.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LocaleProvider } from '../lib/locale.js'
import { createTranslator, en, NS, zh } from '../lib/locales.js'
import { displaySpaceTitle, workspaceTitleLabels } from '../lib/display.js'
import { describeError } from '../lib/error-text.js'
import { formatMapNotice } from '../lib/map-store.js'
import { decideDrop, formatDragLabel } from '../lib/row-drag.js'
import { createNode, DEFAULT_SPACE_TITLE, emptyMap, MapError } from '../lib/model.js'
import { ViewToggle } from '../lib/view.js'

/** The Simplified Chinese translator. */
const tZh = createTranslator(zh)

/** The English translator. */
const tEn = createTranslator(en)

/**
 * The placeholder names of one template.
 * @param template - the dictionary template.
 * @returns the sorted placeholder names.
 */
function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
}

test('both shipped dictionaries declare exactly the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(zh).length > 0, 'the namespace is not empty')
  assert.equal(NS, 'conversation-map')
})

test('every message has real copy in both languages and matching placeholders', () => {
  for (const [key, text] of Object.entries(zh)) {
    assert.notEqual(text, '', `zh ${key} is empty`)
    assert.ok(!Object.is(text, key), `zh ${key} still holds the key`)
    assert.notEqual(en[key], '', `en ${key} is empty`)
    assert.ok(!Object.is(en[key], key), `en ${key} still holds the key`)
    assert.deepEqual(placeholders(text), placeholders(en[key]), `placeholders differ for ${key}`)
  }
})

test('a translator fills placeholders, follows the fallback, and surfaces missing keys', () => {
  assert.equal(createTranslator({ greeting: 'Hello {name}' })('greeting', { name: 'Ada' }), 'Hello Ada')
  assert.equal(createTranslator({}, { greeting: 'Hello' })('greeting'), 'Hello')
  assert.equal(createTranslator({})('missing.key'), 'missing.key')
  assert.equal(createTranslator({ template: 'Hi {who}' })('template'), 'Hi {who}', 'a missing param keeps its placeholder')
})

test('the compact age copy is localized, never a raw key', () => {
  assert.equal(tZh('time.now'), '刚刚')
  assert.equal(tEn('time.now'), 'now')
  assert.equal(tZh('time.minute', { n: 5 }), '5分钟')
  assert.equal(tEn('time.minute', { n: 5 }), '5min')
})

test('the default-space marker renders localized copy, renamed spaces stay verbatim', () => {
  const state = { defaultSpaceId: 'sp-default' }
  assert.equal(displaySpaceTitle(tZh, { id: 'sp-default', title: DEFAULT_SPACE_TITLE }, state), '默认空间')
  assert.equal(displaySpaceTitle(tEn, { id: 'sp-default', title: DEFAULT_SPACE_TITLE }, state), 'Default space')
  assert.equal(displaySpaceTitle(tEn, { id: 'sp-work', title: '工作空间' }, state), '工作空间')
  assert.equal(displaySpaceTitle(tEn, { id: 'sp-other', title: DEFAULT_SPACE_TITLE }, state), DEFAULT_SPACE_TITLE,
    'only the default space reads the marker as copy')
  assert.equal(workspaceTitleLabels(tEn).defaultWorkspace, 'Default workspace')
})

test('known model errors are localized, unknown ones keep their verbatim message', () => {
  assert.equal(
    describeError(tEn, new MapError('SPACE_TITLE_LONG', 'wire text', { max: 40 })),
    'A space name is limited to 40 characters.',
  )
  assert.equal(describeError(tZh, new MapError('DEPTH', 'wire text', { max: 12 })), '最多支持 12 层。')
  assert.equal(describeError(tEn, new MapError('UNMAPPED_CODE', 'wire text')), 'wire text')
  assert.equal(describeError(tEn, new Error('provider said no')), 'provider said no')
  assert.equal(describeError(tEn, 'plain string'), 'plain string')
})

test('structured drag labels are formatted per language', () => {
  let state = emptyMap()
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: 'Growth', id: 'a' }).state
  state = createNode(state, { parentId: null, workspaceId: 'w1', title: 'Product', id: 'b' }).state
  const decision = decideDrop(
    state,
    { kind: 'node', nodeId: 'a', workspaceId: 'w1' },
    { row: { kind: 'node', nodeId: 'b', workspaceId: 'w1' }, edge: 'into' },
  )
  assert.equal(formatDragLabel(tZh, decision.label), '移到「Product」下')
  assert.equal(formatDragLabel(tEn, decision.label), 'Move under "Product"')
})

test('store notices are formatted per language and host errors stay verbatim', () => {
  assert.equal(formatMapNotice(tEn, { kind: 'sync-retry', detail: 'boom' }), 'Sync interrupted; retrying (boom)')
  assert.equal(formatMapNotice(tZh, { kind: 'sync-retry', detail: 'boom' }), '同步中断，重试中（boom）')
  assert.equal(formatMapNotice(tEn, { kind: 'dropped-changes', count: 2 }), '2 change(s) were dropped because topics had changed')
  assert.equal(formatMapNotice(tEn, { kind: 'host-error', message: 'wire says no' }), 'wire says no')
})

test('a component rendered under LocaleProvider receives the injected translator', () => {
  // A marker translator proves the plumbing regardless of the wording a feature
  // chooses: every dictionary lookup through the context comes back tagged.
  const marker = key => `«${key}»`
  const markup = renderToStaticMarkup(createElement(
    LocaleProvider,
    { translator: marker },
    createElement(ViewToggle, { target: 'map', onSelect: () => {} }),
  ))
  assert.match(markup, /«view\./u, 'the component reads its copy through useT')
})

test('a component mounted without a provider falls back to Simplified Chinese', () => {
  const markup = renderToStaticMarkup(createElement(ViewToggle, { target: 'conversation', onSelect: () => {} }))
  assert.match(markup, /收起/u, 'the fallback translator is the shipped Chinese dictionary')
})

test('the English dictionary renders English component copy with no Chinese left', () => {
  const markup = renderToStaticMarkup(createElement(
    LocaleProvider,
    { translator: tEn },
    createElement(ViewToggle, { target: 'map', onSelect: () => {} }),
  ))
  assert.match(markup, /Conversation Tree/u, 'the visible label comes from the English dictionary')
  assert.match(markup, /Expand the conversation tree column/u, 'the accessible name follows the dictionary')
  assert.doesNotMatch(markup, /[\u3400-\u9fff]/u, 'no Chinese copy leaks into the English render')
})
