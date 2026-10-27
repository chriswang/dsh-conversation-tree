/**
 * The map mark's own contract.
 *
 * The mark is drawn three times from one geometry: the sidebar panel row
 * (`sidebar.panellist`, 16px wide / 18px rail), the 「对话树」 pill in the
 * Conversation header (14px), and the package artwork `icon.svg` (64px). The
 * first two share {@link MapGlyph}; the package file is a separate artifact, so
 * this test pins both the product icon grammar the client mark must keep
 * (16 viewBox, 1px stroke, three equal nodes in a top-down tree) and the 4×
 * relation between the sidebar geometry and `icon.svg`. Without that, the two
 * marks drift apart again (the state before this test: a 24-viewBox share-like
 * glyph in the client vs. a tree-list package icon).
 *
 * Render assertions go through the real entry component (`MapPanelIcon`) so the
 * outline/filled readings are tested where they are produced. `icon.svg` is read
 * straight off disk — it is not part of the client bundle.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MapPanelIcon } from '../lib/entries.js'

/** A collapse store whose value the test sets directly. */
function collapse(collapsed = true) {
  let value = collapsed
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
    set: next => { value = next },
    toggle: () => { value = !value },
  }
}

/** A panel-info observable whose selection the test sets directly. */
function panelInfo(activePanelId = null) {
  return {
    getSnapshot: () => ({ activePanelId }),
    subscribe: () => () => {},
  }
}

/** The mark's one path: root stem then the level bar with both descents. */
const TREE_PATH = 'M8 5.45V8M3.9 10.5V8h8.2v2.5'

test('the sidebar mark is drawn on the product icon grammar', () => {
  const markup = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
  }))
  assert.ok(markup.includes('viewBox="0 0 16 16"'), '16 viewBox, like every product icon')
  assert.ok(markup.includes('stroke-width="1"'), '1px stroke, like every product icon')
  assert.ok(markup.includes('stroke-linecap="round"'), 'round caps')
  assert.ok(!markup.includes('0 0 24 24'), 'the old 24-viewBox share geometry is gone')
  assert.ok(!markup.includes('stroke-width="1.7"'), 'the old heavier stroke is gone')
})

test('the sidebar mark is a top-down tree of three equal nodes', () => {
  const outline = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(true),
    panelInfo: panelInfo(null),
    size: 16,
  }))
  assert.ok(outline.includes('cx="8" cy="3.7" r="1.75"'), 'one root above')
  assert.ok(outline.includes('cx="3.9" cy="12.25" r="1.75"'), 'left child below')
  assert.ok(outline.includes('cx="12.1" cy="12.25" r="1.75"'), 'right child below')
  assert.ok(outline.includes(TREE_PATH), 'one stem and one level-bar path')
  assert.equal((outline.match(/<circle /g) ?? []).length, 3, 'three nodes, not four')
})

test('the on-screen reading fills the same three nodes', () => {
  const filled = renderToStaticMarkup(createElement(MapPanelIcon, {
    collapsed: collapse(false),
    panelInfo: panelInfo(null),
    size: 16,
  }))
  assert.ok(filled.includes('data-in-use="true"'), 'the band is on screen')
  assert.equal((filled.match(/fill="currentColor"/g) ?? []).length, 3, 'every node filled')
  assert.ok(filled.includes(TREE_PATH), 'the branches do not change between readings')
})

test('the package mark is the sidebar mark at 4×', () => {
  const artwork = readFileSync(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.ok(artwork.includes('viewBox="0 0 64 64"'), '64 viewBox for the package card')
  assert.ok(artwork.includes('stroke-width="4"'), '1px at 16 = 4px at 64')
  // One root above, two children below: (8, 3.7) (3.9, 12.25) (12.1, 12.25) × 4.
  assert.ok(artwork.includes('cx="32" cy="14.8" r="7"'), 'root at 4×')
  assert.ok(artwork.includes('cx="15.6" cy="49" r="7"'), 'left child at 4×')
  assert.ok(artwork.includes('cx="48.4" cy="49" r="7"'), 'right child at 4×')
  assert.ok(artwork.includes('d="M32 21.8V32M15.6 42V32h32.8v10"'), 'branches at 4×')
})
