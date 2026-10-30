/**
 * Stylesheet invariants the band's interaction with the shell depends on.
 *
 * The plugin's sheet is a template string in `src/client/styles.ts`; the only
 * place it becomes a shipped artifact is the browser bundle, so these tests
 * assert against `lib/client.js` exactly as the client receives it. Most are
 * deliberately about *contracts with the shell* — the z-index the band's host
 * layer publishes, and the scope a rule is allowed to leak into. One is about a
 * contract with the reader instead: every dialog has to wear the product's scrim
 * and its prominent elevation, so a dialog can no longer be a white card on a
 * white page. That test still names no colour: it pins that the plugin asks the
 * design system for its mask and its lift rather than inventing a private one.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Escape a literal selector for use inside a RegExp. */
function escape(selector) {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The declarations of one rule, by its exact selector, or null when absent. */
function declarations(selector) {
  const match = new RegExp(`${escape(selector)}\\{([^}]*)\\}`).exec(bundle)
  return match === null ? null : match[1]
}

/** Every declaration block carrying this exact selector, in sheet order. */
function allDeclarations(selector) {
  return [...bundle.matchAll(new RegExp(`${escape(selector)}\\{([^}]*)\\}`, 'g'))].map(match => match[1])
}

/**
 * The shell stacks the macOS window-chrome seat at z-index 15 and the frame
 * overlay layer — the band's host — at 20 (`AppFrame.module.css`). A seat
 * *below* that layer cannot show its own design-system tooltip: the bubble's
 * `z-index:100` is trapped inside the seat's stacking context, so the band's
 * pills paint over it and the reader sees a black box cut in slices.
 */
test('the window-chrome seat is lifted above the frame overlay layer in map mode', () => {
  const rule = declarations('html[data-conversation-map-split] [data-shell-leading]')
  assert.notEqual(rule, null, 'the seat rule is missing from the shipped sheet')
  const lifted = Number.parseInt(/z-index:\s*(-?\d+)/.exec(rule)?.[1] ?? '', 10)
  assert.ok(Number.isInteger(lifted), `the seat rule must state a z-index: ${rule}`)
  assert.ok(lifted > 20, `the seat must outrank the overlay layer (20): ${String(lifted)}`)
  /* The lift is one step, and its price is explicit: every child of the overlay
     layer loses to the seat whatever its own z-index says. Portaled surfaces
     (the design-system Modal, 1000) must stay on top — the seat is window
     chrome, not a modal. */
  assert.ok(lifted < 1000, `the seat must stay under the portaled layer (1000): ${String(lifted)}`)
})

/** A rule about the shell's chrome must not apply outside the mode that needs it. */
test('the seat rule is scoped to map mode', () => {
  const unscoped = new RegExp(`(^|[^\\w\\]\\s])${escape('[data-shell-leading]')}\\{`, 'm').test(bundle)
  assert.equal(unscoped, false, 'a bare [data-shell-leading] rule would apply in every mode')
})

/**
 * A bubble that is whole but lies across the band's own chips still reads as
 * "the tip covers my buttons". While the shell's chrome tooltip exists, the
 * row steps aside: `:has()` sees the [role="tooltip"] the design system renders
 * inside the seat, so no shell DOM is touched and no script runs. Engines
 * without :has() keep the row — the lift above already keeps the bubble whole,
 * so the adaptation degrades instead of breaking.
 */
test('the band steps aside while the shell shows its window-chrome tooltip', () => {
  const selector = 'html[data-conversation-map-split]:has([data-shell-leading] [role="tooltip"]) .cm-band-head-row > *'
  const rule = declarations(selector)
  assert.notEqual(rule, null, 'the step-aside rule is missing from the shipped sheet')
  assert.match(rule, /opacity:\s*0/, `the chips must step aside: ${rule}`)
  assert.match(rule, /pointer-events:\s*none/, `an invisible chip must not swallow clicks: ${rule}`)
})

/**
 * The shell's clearance is measured from the frame's left edge, but the strip
 * above pushes the Conversation past the band — so the title row's fixed inset
 * (`max(0px, calc(clearance - 20px))`, ui-conversation) becomes dead space the
 * moment the band covers the chrome it dodges. Map mode therefore re-reads the
 * shell's number on the Conversation, folded by the width already reserved, and
 * the fold has to land on the very element that carries the strip.
 */
test('the conversation folds the shell clearance by the reserved width', () => {
  const anchor = 'html[data-conversation-map-split] [data-slot="main.conversation"]'
  const read = declarations(anchor)
  assert.notEqual(read, null, 'the clearance readout rule is missing from the shipped sheet')
  assert.match(
    read,
    /--cm-chrome-reserve:\s*var\(--dsh-frame-leading-clearance\s*,/,
    `the readout must capture the shell's own variable before it is overridden: ${read}`,
  )

  const fold = allDeclarations(`${anchor} > div`)
  assert.ok(fold.length >= 2, `the strip and the fold share one selector: ${JSON.stringify(fold)}`)
  assert.ok(
    fold.some(block => /padding-left:\s*var\(--cm-map-width/.test(block)),
    `the strip rule is missing: ${JSON.stringify(fold)}`,
  )
  const folded = fold.find(block => /--dsh-frame-leading-clearance/.test(block))
  assert.notEqual(folded, undefined, `no fold shares the strip's selector: ${JSON.stringify(fold)}`)
  assert.match(
    folded,
    /--dsh-frame-leading-clearance:\s*max\(0px,\s*calc\(var\(--cm-chrome-reserve[^)]*\)\s*-\s*var\(--cm-map-width/,
    `the fold must subtract the reserved width and never go below zero: ${folded}`,
  )
})

/** Both halves are map-mode-only: any other scope would move the product's title. */
test('the clearance fold is scoped to map mode', () => {
  const bare = /(^|[^\w\]\s])\[data-slot="main\.conversation"\][^{]*\{[^}]*--dsh-frame-leading-clearance/m.test(bundle)
  assert.equal(bare, false, 'a rule without the map-mode gate would move the title outside map mode')
})

/**
 * The space switcher leads the band's second row, on the node list's own rail.
 *
 * Pinned here because the earlier layout hid it across the whole narrow band
 * (`@container (max-width:480px)`), and because what keeps it from reading as a
 * tab glued to the column head below is arithmetic between rules that live far
 * apart in the sheet: the row's inset, the pill's inset and the first column's
 * indent all add up to the same 14px rail, and the row's 28px minus the pill's
 * 24px is the 4px of air above the seam.
 */
test('the space switcher leads the band second row, on the node list rail', () => {
  assert.equal(
    /\.cm-band-space\{display:none\}/.test(bundle),
    false,
    'nothing may hide the space switcher: the band stays visible down to MIN_MAP_WIDTH (320px), so no width is safe to take from it',
  )
  assert.equal(
    /max-width:\s*480px/.test(bundle),
    false,
    'the 480px container query that hid the switcher is gone',
  )

  const row2 = declarations('.cm-band-row2')
  assert.notEqual(row2, null, 'the second row is named for what it is, not for the search box it once held')
  assert.match(row2, /align-items:flex-start/, `28px row, 24px contents, top-aligned: the 4px above the seam is what stops the tab reading: ${row2}`)
  assert.match(row2, /padding-left:calc\(var\(--cm-band-rail,14px\) - 8px\)/, `no window-chrome clearance on this row: ${row2}`)
  assert.match(row2, /overflow:clip/, `clip rather than hidden: a scroll container slides its content when a child takes focus: ${row2}`)
  assert.match(
    declarations('.cm-band-row2>.cm-band-search'),
    /height:24px;box-sizing:border-box/,
    'the search field shares the row 24px, border-box so its 1px underline does not eat one of the four pixels of air',
  )

  const pill = declarations('.cm-band-row2 .cm-space-btn')
  assert.notEqual(pill, null, 'the pill takes the second row rhythm')
  assert.match(pill, /height:24px/)
  assert.match(pill, /min-width:58px/, `the row-2 pill rule keeps its historical floor; the breadcrumb bar overrides it with min-width:0 and is pinned by its own test: ${pill}`)
  assert.match(pill, /padding:0 calc\(var\(--cm-band-rail,14px\) - 7px\)/)
  assert.match(pill, /background:transparent/, `the pill rests as a ghost, not as a solid block on the head: ${pill}`)
  assert.match(
    bundle,
    /\.cm-band-row2 \.cm-space-btn:hover,\s*\.cm-band-row2 \.cm-space-btn\[aria-expanded="true"\]\{background:var\(--dsw-alias-interactive-bg-hover[^}]*border-color:var\(--dsw-alias-border-l1/,
    'the fill comes back on hover and while the space menu is open — and it is the interactive state colour, not the opaque resting surface token that made the hover invisible on a white header',
  )

  // rail = row inset 6 + 1px border + pill padding 7 = col-scroll 6 + node-row 8
  assert.ok(
    allDeclarations('.cm-band').some(block => block.includes('--cm-band-rail:14px')),
    'the rail is one named number, not three coincidences',
  )
  assert.match(declarations('.cm-col-scroll'), /padding:0 6px/)
  assert.match(declarations('.cm-node-row'), /padding:0 8px/)
})

/**
 * The band owns the shell's second seat button by hiding it — and only it.
 *
 * The band draws its own 「新建会话」 in the slot the shell vacates, so the rule
 * must match the *second* button inside the shell's seat and only while the
 * band occupies that edge. The selector is structural, so the rule keeps working
 * if the button's name or language changes; the first button (「打开侧边栏」) is
 * never in the selector, which is the decision that the shell always draws it.
 * It is also deliberately sibling-agnostic: the design system clones a bubble
 * `<span role="tooltip">` in *between* the two buttons while either seat tooltip
 * is open, so the adjacent-sibling form (`button + button`) stopped matching for
 * exactly that frame and the shell's 新建会话 flashed back (seat 28 → 64).
 * `:not(:first-of-type)` survives the interleaved bubble and still matches
 * nothing when a one-button seat leaves no second button to hide. Map mode is
 * the gate rather than a nicety: every state that gives the band's edge back
 * removes `data-conversation-map-split` (band yields, band not visible, mode
 * off), and the shell's button returns with it. If the shell ever changes that
 * markup the rule stops matching, and the band's own button stays unrendered
 * because it waits on the measured seat width (MapPanel.tsx) — today's layout,
 * never two new-session buttons.
 */
test('the band hides exactly the shell second seat button, only in map mode', () => {
  const selector = 'html[data-conversation-map-split] [data-shell-leading] button:not(:first-of-type)'
  const rule = declarations(selector)
  assert.notEqual(rule, null, 'the hide rule is missing from the shipped sheet')
  assert.match(rule, /display:\s*none/, `the shell's 新建会话 must be hidden: ${rule}`)
  const bare = /(^|[^\w\]\s])\[data-shell-leading\] button:not\(:first-of-type\)\{/m.test(bundle)
  assert.equal(bare, false, 'outside map mode the shell keeps both of its seat buttons')
  const generic = /(^|[^\w\]\s])button\s*\+\s*button\{/m.test(bundle)
  assert.equal(generic, false, 'no bare sibling selector may hide a button anywhere else on the page')
  assert.equal(
    /\[data-shell-leading\] button\s*\+\s*button\{/.test(bundle),
    false,
    'the adjacent-sibling form drops out while a seat tooltip sits between the buttons: use :not(:first-of-type)',
  )
})

/**
 * The shell's collapsed left column must not raise tooltips in map mode.
 *
 * On macOS the shell keeps the whole sidebar subtree mounted inside a zero-width
 * `overflow:hidden` track, so the sidebar's own 「打开侧边栏」 toggle stays in the
 * DOM at a fully clipped rect and remains the document's first tab stop. A
 * keyboard focus on it makes the design system render its tooltip from that
 * clipped rect; being `position:fixed`, the bubble escapes the clip and paints
 * over the window's top-left corner — the "打开侧边栏 ⌘B" bubble that appears
 * from nowhere. The seat already draws the same controls in this state, so the
 * clipped column is taken out of the tab order for as long as map mode keeps it
 * fully hidden. `visibility` (not `display`) keeps the geometry the shell
 * measures; the descendant `*` is required because sibling plugins re-state
 * `visibility:visible` on their own rows. Every selector must stay behind the
 * darwin + map-mode + collapsed gates: Windows desktop also collapses to zero
 * width, but keeps its reopen controls visible as fixed caption-row buttons
 * inside the same sidebar slot (hiding them would remove the only visible way
 * back), Web keeps a 56px interactive rail, and outside map mode a manual
 * collapse is the shell's own behaviour.
 */
test('the collapsed shell sidebar is silenced in map mode only', () => {
  const silence = 'html[data-platform="darwin"][data-conversation-map-split] [data-sidebar-collapsed] [data-slot="sidebar"] *'
  const rule = declarations(silence)
  assert.notEqual(rule, null, 'the keyboard-quiet rule is missing from the shipped sheet')
  assert.match(rule, /visibility:\s*hidden/, `the clipped sidebar must leave the tab order: ${rule}`)
  /* The same selector must not exist in any ungated form: strip the gated one and
     no `[data-slot="sidebar"] … visibility:hidden` may remain (a rule without the
     darwin + map-mode + collapsed gates would hide a real, interactive rail). */
  const rest = bundle.split(silence).join('')
  assert.equal(
    /\[data-slot="sidebar"\][^{}]*\{[^}]*visibility:\s*hidden/m.test(rest),
    false,
    'the sidebar may only be silenced behind the darwin + map-mode + collapsed gates',
  )
  const tip = declarations('html[data-platform="darwin"][data-conversation-map-split] [data-sidebar-collapsed] [data-slot="sidebar"] [role="tooltip"]')
  assert.notEqual(tip, null, 'a bubble already up carries inline visibility:visible and must be dropped outright')
  assert.match(tip, /display:\s*none/, `the stray-bubble belt is missing: ${tip}`)
  assert.equal(
    /\[data-sidebar-collapsed\] \[role="tooltip"\]\{[^}]*display:\s*none/m.test(
      bundle.replace('html[data-platform="darwin"][data-conversation-map-split] [data-sidebar-collapsed] [data-slot="sidebar"] [role="tooltip"]', ''),
    ),
    false,
    'the stray-bubble belt must keep the darwin + map-mode gates too',
  )
})

/**
 * The band's two chrome controls take the shell seat's own box geometry.
 *
 * Both boxes sit in the row the shell's seat buttons lead (28×28, radius-sm, no
 * frame, secondary ink), so the band's controls read as the same family instead
 * of as two plugin pills: the icon-only collapse box (`ViewToggle` `compact`)
 * and its own 新建会话. The Conversation header keeps the labelled pill
 * (`.cm-view-toggle` with `min-width:70px`) — that is the deliberate difference
 * between the two occurrences, not an oversight. Hover has to fill in both
 * icon-only boxes: with the visible copy gone, the fill is the only feedback
 * that the glyph is a button.
 */
test('the band draws its two seat controls as 28x28 icon boxes', () => {
  const conversationBox = declarations('.cm-view-toggle')
  assert.notEqual(conversationBox, null, 'the shared control is missing from the shipped sheet')
  assert.match(conversationBox, /min-width:70px/, `the Conversation header keeps its labelled pill: ${conversationBox}`)

  const collapseBox = declarations('.cm-view-toggle--icon')
  assert.notEqual(collapseBox, null, 'the band occurrence needs its own box rule')
  assert.match(collapseBox, /(^|;)min-width:0;/, `the pill floor is dropped for the icon box: ${collapseBox}`)
  assert.match(collapseBox, /width:28px;height:28px/, `the band box is the seat's 28x28: ${collapseBox}`)
  assert.match(collapseBox, /(^|;)border:0;/, `the band box drops the pill frame: ${collapseBox}`)
  assert.match(collapseBox, /border-radius:var\(--dsw-radius-sm/, `radius-sm, the shell seat's radius: ${collapseBox}`)

  const newSessionBox = declarations('.cm-lead-icon')
  assert.notEqual(newSessionBox, null, 'the band 新建会话 needs its own box rule')
  assert.match(newSessionBox, /width:28px;height:28px/, `the band 新建会话 is the seat's 28x28: ${newSessionBox}`)
  assert.match(newSessionBox, /(^|;)border:0;/, `it is a bare icon box, not a pill: ${newSessionBox}`)
  assert.match(newSessionBox, /border-radius:var\(--dsw-radius-sm/, `radius-sm, the shell seat's radius: ${newSessionBox}`)

  for (const hover of ['.cm-lead-icon:hover', '.cm-view-toggle--icon:hover']) {
    const rule = declarations(hover)
    assert.notEqual(rule, null, `an icon-only box needs a hover fill: ${hover}`)
    assert.match(
      rule,
      /background:var\(--dsw-alias-interactive-bg-hover/,
      `with no label left, the hover fill is the only feedback that this is a button: ${rule}`,
    )
  }
})

/**
 * Hysteresis has to look provisional, not committed.
 *
 * While the pointer is off every row the candidate is kept (`data-drop="held"`)
 * instead of vanishing, so the reader can see what releasing would still do. It
 * is drawn dashed — the same mark the sheet uses for "not settled yet" — and the
 * insertion line it carries fades, because the line is exactly what the held
 * state has *not* decided. Both marks are scoped to the plugin's two row classes,
 * so no other surface that happens to carry `data-drop` inherits them.
 */
test('a held drop candidate stays marked, dashed, and dims its insertion line', () => {
  const held = declarations('.cm-thread-row[data-drop="held"]')
  assert.notEqual(held, null, 'the held state is missing from the shipped sheet')
  assert.match(held, /outline:1px dashed var\(--dsw-alias-border-l2/, `held reads as provisional: ${held}`)
  assert.match(held, /outline-offset:-1px/, `the dashed frame sits inside the row's own box: ${held}`)
  assert.ok(
    bundle.includes('.cm-node-row[data-drop="held"],.cm-thread-row[data-drop="held"]{'),
    'both row kinds wear the same held mark, in one rule',
  )

  const line = declarations('.cm-thread-row[data-drop="held"] [data-insert]')
  assert.notEqual(line, null, 'the insertion line must fade with the row it belongs to')
  assert.match(line, /opacity:\.55/, `a held row has not decided where the line goes: ${line}`)

  assert.equal(
    /(^|[^\w\]-])\[data-drop="held"\]\{/m.test(bundle),
    false,
    'a bare [data-drop] rule would mark rows the plugin does not own',
  )
})

/**
 * Every dialog wears the product scrim and the prominent elevation.
 *
 * The audit measured the shipped card as a white sheet on a white page: no
 * shadow ring, a 1.09:1 border, and a fully transparent capture layer behind it —
 * the plugin had its own idea of a raised surface instead of the shell's. The
 * shell's Modal recipe is now the only one: the product's own mask step behind
 * the card, `--dsw-elevation-prominent` (whose 0.5px stroke ring is why the card
 * carries `border:0`), and the layer-2 fill the shell's modal sits on. The scrim
 * hangs off a modifier, because the capture layer is shared with the three
 * menus: a popover is not a modal state, so their layer must stay invisible.
 *
 * The cap and the scroll belong to the card, not to the dialog around it. A
 * scroll container clips the ink of its descendants at its own edge — stroke
 * ring and glow included — and the card fills the dialog exactly, so a scrolling
 * dialog would erase the elevation it was just given. No box is clipped by its
 * own overflow, so the card can be the scroller and keep its shadow.
 */
test('every dialog wears the product scrim and the prominent elevation', () => {
  const scrim = declarations('.cm-backdrop--dialog')
  assert.notEqual(scrim, null, 'the dialog needs its own scrim rule: the shared capture layer stays blank')
  assert.match(
    scrim,
    /background:var\(--dsw-alias-bg-mask-1/,
    `the mask is the product's own step, not a mix of the plugin's ink: ${scrim}`,
  )

  const capture = declarations('.cm-backdrop')
  assert.notEqual(capture, null, 'the capture layer is missing from the shipped sheet')
  assert.equal(
    /background/.test(capture),
    false,
    `a menu's capture layer is a hit target, not a modal state: it must paint nothing: ${capture}`,
  )

  const card = declarations('.cm-card')
  assert.notEqual(card, null, 'the shared card is missing from the shipped sheet')
  assert.match(card, /box-shadow:var\(--dsw-elevation-prominent/, `the lift is the product's: ${card}`)
  assert.match(card, /border:0/, `the stroke lives inside that elevation; a border would double it: ${card}`)
  assert.match(card, /border-radius:var\(--dsw-radius-md/, `the corner is the shell's panel radius: ${card}`)
  assert.match(card, /max-height:min\(86vh,640px\)/, `a long form is capped: ${card}`)
  assert.match(card, /overflow:auto/, `and scrolls inside the card, not off the window: ${card}`)

  const title = declarations('.cm-card h3')
  assert.notEqual(title, null, 'the dialog title is missing from the shipped sheet')
  assert.match(title, /font-size:15px/, `the title leads the form: ${title}`)
  assert.match(title, /font-weight:650/, `and outranks body copy: ${title}`)

  // `.cm-dialog` is named by an earlier combined rule too (the pointer-events
  // opt-in), so its geometry has to be looked for across every block that uses it.
  const dialogs = allDeclarations('.cm-dialog')
  assert.ok(
    dialogs.some(block => /width:min\(420px,88vw\)/.test(block)),
    `the plain dialog keeps its width: ${JSON.stringify(dialogs)}`,
  )
  assert.ok(
    dialogs.some(
      block => /top:50%/.test(block) && /translate\(-50%,-50%\)/.test(block) && /max-height:min\(86vh,640px\)/.test(block),
    ),
    `the dialog is centred in the window and capped: ${JSON.stringify(dialogs)}`,
  )
  const clipping = dialogs.filter(block => /overflow(-[xy])?:/.test(block))
  assert.deepEqual(
    clipping,
    [],
    `the dialog must not scroll: a clip container would cut the card's ring and glow at its own edge: ${JSON.stringify(clipping)}`,
  )
})

/**
 * An open menu must be dismissible by a click on the band's blank chrome.
 *
 * The band's top bar is the shell's window-drag row, and Electron hands the
 * marked boxes to the native window: a press inside one is a title-bar press,
 * and no mouse event reaches the page. So the capture layer's onClick can only
 * run where that layer has subtracted itself from the drag box underneath —
 * Electron composes app-regions in document order with the last box winning,
 * and the layer renders after the top bar and after the Conversation header
 * (`shell.overlay` comes after the centre column).
 *
 * Measured failure (`.probe/click-dismiss/`, the reader's screenshot state):
 * with the space menu open, the composed box at the top bar's blank run was
 * `drag` on `header.cm-band-topbar` while the DOM hit test already found this
 * layer; on macOS desktop the click was consumed as a window drag and the list
 * stayed open. In a browser the same click closed it, which is why only this
 * declaration and not the layer's onClick can regress silently. It is the same
 * construction as the band gutter's declared no-drag, and it lasts exactly as
 * long as the layer — window dragging is untouched while no surface is open.
 */
test('the capture layer subtracts the window-drag strip only while it is mounted', () => {
  const capture = declarations('.cm-backdrop')
  assert.notEqual(capture, null, 'the capture layer is missing from the shipped sheet')
  assert.match(capture, /position:fixed/, `the layer must cover the viewport, not just the band: ${capture}`)
  assert.match(capture, /inset:0/, `and its box must reach every drag row's strip: ${capture}`)
  assert.match(
    capture,
    /-webkit-app-region:no-drag/,
    `without no-drag the window-drag top bar swallows the click that dismisses a menu: ${capture}`,
  )
})

/**
 * The move dialog is wider, not heavier.
 *
 * Its tree is the one body that needs the extra room — 480px, with a floor the
 * deepest indent step can live in — and that is now all the modifier does. The
 * card skin it used to carry (a stronger border, its own shadow, and the spread
 * ring that dimmed the strip behind it) is gone: two scrims would stack to
 * roughly 30% dimming, darker than any mask step the product ships, and the rest
 * of that skin is what every dialog wears today.
 */
test('the move dialog is wider, not heavier', () => {
  const box = declarations('.cm-dialog.cm-dialog--move')
  assert.notEqual(box, null, 'the move dialog needs its own width')
  assert.match(box, /width:min\(480px,92vw\)/, `wider than the 420px form: ${box}`)
  assert.match(box, /min-width:min\(420px,92vw\)/, `with a floor the tree can indent inside: ${box}`)

  assert.equal(bundle.includes('100vmax'), false, '遮罩由 .cm-backdrop--dialog 承担')
  assert.equal(bundle.includes('.cm-card.cm-dialog--move'), false, '移动弹窗不再自带一套卡片皮肤')
})

/**
 * The tree picker indents by the depth each row carries.
 *
 * The sheet must not know how deep a Workspace's topics go: every row publishes
 * its depth as `--cm-move-depth`, and one `padding-left` turns it into the 14px
 * step that makes a parent/child pair readable. The box scrolls rather than
 * growing the dialog, hover and selection are the sheet's usual fills, and a
 * refused destination keeps its row — dimmed and unclickable — so the reader can
 * see *why* it is not offered.
 */
test('the move tree indents by depth and scrolls inside the dialog', () => {
  const tree = declarations('.cm-move-tree')
  assert.notEqual(tree, null, 'the tree container is missing from the shipped sheet')
  assert.match(tree, /max-height:min\(46vh,320px\)/, `the tree scrolls instead of growing the dialog: ${tree}`)
  assert.match(tree, /overflow-y:auto/, `long Workspaces need their own scroller: ${tree}`)
  assert.match(tree, /border:1px solid var\(--dsw-alias-border-l1/, `the box reads as one field: ${tree}`)
  assert.match(tree, /border-radius:8px/, `matching the inputs it replaces: ${tree}`)

  const row = declarations('.cm-move-tree-row')
  assert.notEqual(row, null, 'the tree rows are missing from the shipped sheet')
  assert.match(
    row,
    /padding-left:calc\(8px \+ var\(--cm-move-depth, 0\) \* 14px\)/,
    `depth becomes a 14px step, without the sheet knowing the tree: ${row}`,
  )
  assert.match(row, /cursor:pointer/, `a row is a destination: ${row}`)

  assert.match(
    declarations('.cm-move-tree-row:hover'),
    /background:var\(--dsw-alias-interactive-bg-hover/,
    'hover uses the sheet\'s one interactive fill',
  )
  const selected = declarations('.cm-move-tree-row[data-selected="true"]')
  assert.match(selected, /background:color-mix\(in srgb,var\(--dsw-alias-brand-primary/, `the current destination is tinted: ${selected}`)
  assert.match(selected, /font-weight:500/, `and stated, not only coloured: ${selected}`)
  const disabled = declarations('.cm-move-tree-row[data-disabled="true"]')
  assert.match(disabled, /opacity:\.45/, `a refused destination stays visible, dimmed: ${disabled}`)
  assert.match(disabled, /cursor:not-allowed/, `and says why it cannot be picked: ${disabled}`)
  assert.ok(
    bundle.includes('.cm-move-tree-row[aria-disabled="true"],.cm-move-tree-row[data-disabled="true"]{'),
    'the refusal is keyed on the accessible attribute first, with the data one alongside',
  )
})

/** The fold arrow is the only affordance saying a subtree is open. */
test('the tree fold arrow rotates with its expanded state', () => {
  const toggle = declarations('.cm-move-tree-toggle')
  assert.notEqual(toggle, null, 'the fold arrow is missing from the shipped sheet')
  assert.match(toggle, /width:16px;height:16px/, `the arrow takes the row's leading slot: ${toggle}`)
  assert.match(toggle, /transform:rotate\(0deg\)/, `folded is the resting orientation: ${toggle}`)
  assert.match(toggle, /transition:transform/, `the rotation is the feedback: ${toggle}`)
  const open = declarations('.cm-move-tree-toggle[data-expanded="true"]')
  assert.match(open, /transform:rotate\(90deg\)/, `expanded points the arrow down: ${open}`)

  const label = declarations('.cm-move-tree-label')
  assert.notEqual(label, null, 'the label is missing from the shipped sheet')
  assert.match(label, /overflow:hidden/, `a long breadcrumb must not widen the dialog: ${label}`)
  assert.match(label, /text-overflow:ellipsis/, `${label}`)
  assert.match(label, /white-space:nowrap/, `${label}`)
})

/**
 * The keyboard cursor and the chosen destination are two different facts.
 *
 * ↑/↓ move a cursor over rows that are not (yet) selected, so the row under it
 * wears `data-active` — and it has to be visible, because the arrow keys are the
 * only thing telling the reader where they are. It must not borrow the selection
 * fill either: selection is "this is the destination", the cursor is "this is
 * where the keyboard is", and a reader stepping through on the way to a
 * different row needs to see both at once. Hence a light interactive fill plus a
 * 2px brand bar on the leading edge, with the row left in its normal ink.
 */
test('the tree keyboard cursor is visible and reads apart from the selection', () => {
  const cursor = declarations('.cm-move-tree-row[data-active="true"]')
  assert.notEqual(cursor, null, 'the cursor row has no style: ↑/↓ would move an invisible caret')
  assert.match(
    cursor,
    /background:var\(--dsw-alias-interactive-bg-hover/,
    `the cursor is a light fill, not the selection tint: ${cursor}`,
  )
  assert.match(
    cursor,
    /box-shadow:inset 2px 0 0 var\(--dsw-alias-brand-primary/,
    `a 2px brand bar on the leading edge is what makes the caret findable: ${cursor}`,
  )
  assert.equal(
    /color:var\(--dsw-alias-brand-primary/.test(cursor),
    false,
    'the cursor row keeps its normal ink: only the selection is stated in the brand colour',
  )
  const selected = declarations('.cm-move-tree-row[data-selected="true"]')
  assert.notEqual(selected, cursor, 'the two states must not collapse into one rule')
})

/**
 * The selected row's lineage wears the same quieter mark as the row itself.
 *
 * When the selection is deep, the columns above it are open *because* it lives
 * under them, and the reader has to be able to see which upper level's domain
 * they are adding into. So the Workspace row and every ancestor topic carry the
 * selected node's own secondary mark — not a third, invented tint that would
 * read as another state — and hover leaves those rows alone, exactly as it
 * leaves the selected row alone.
 */
test('the selected lineage wears the selected node mark, and hover leaves it alone', () => {
  // Both states share one rule, so the assertion reads the rule body from the
  // shipped sheet rather than a single selector: the two marks must not drift
  // into two tints, which would read as a third, invented selection state.
  const sharedSelector = '.cm-node-row[data-selected="true"],.cm-node-row[data-path-selected="true"]{'
  const sharedStart = bundle.indexOf(sharedSelector)
  assert.ok(sharedStart >= 0, 'the path rows must share the selected node rule instead of inventing a second tint')
  const shared = bundle.slice(sharedStart, bundle.indexOf('}', sharedStart))
  assert.match(shared, /background:color-mix\(in srgb,var\(--dsw-alias-brand-primary/, `the lineage is tinted: ${shared}`)
  assert.match(shared, /color:var\(--dsw-alias-brand-primary/, `and stated in brand ink: ${shared}`)
  assert.match(shared, /font-weight:500/, `and carries the selected weight: ${shared}`)

  const hoverSelector = '.cm-node-row:hover:not([data-selected="true"]):not([data-path-selected="true"])'
  const hoverStart = bundle.indexOf(hoverSelector)
  assert.ok(hoverStart >= 0, 'hover must still be scoped to rows that are neither selected nor on the path')
  const hover = bundle.slice(hoverStart, bundle.indexOf('}', hoverStart))
  assert.match(hover, /background:var\(--dsw-alias-interactive-bg-hover/, `the hover fill is the interactive token: ${hover}`)
})

/**
 * The seam is draggable for the band's whole height — including the header.
 *
 * The line and the gesture have to be one element. When the handle lived inside
 * `.cm-band-body` it started at the shipped Conversation header's foot (40px
 * blank / 76px with a Session), so the top of the seam was a painted hairline
 * with no hit area behind it: a press there resized nothing, and on macOS it
 * moved the window, because the band's top bar is the shell's window-drag row
 * and the strip sat under it. Measured before the fix: drag at y=20 left the
 * band at 560px; drag at y=78 moved it to 620px.
 *
 * Two declarations carry the contract, and both are load-bearing:
 *   1. the handle spans the band, so the hit area starts where the line does;
 *   2. it subtracts itself from the window-drag row with `no-drag`, because
 *      Electron composes app-regions in document order and the top bar — which
 *      comes first — would otherwise keep dragging the window.
 */
test('the resize handle spans the band, header included, and is not a window-drag strip', () => {
  const handle = declarations('.cm-band-gutter')
  assert.notEqual(handle, null, 'the band handle rule is missing from the shipped sheet')
  assert.match(handle, /position:absolute/, `the handle rides the band edge: ${handle}`)
  assert.match(handle, /top:0/, `the handle starts at the band's top, not at the body's: ${handle}`)
  assert.match(handle, /bottom:0/, `and runs to the bottom: ${handle}`)
  assert.match(handle, /right:0/, `on the band's right edge: ${handle}`)
  assert.match(handle, /cursor:col-resize/, `the cursor carries the affordance: ${handle}`)
  assert.match(handle, /pointer-events:auto/, `the strip must take the pointer: ${handle}`)
  assert.match(
    handle,
    /-webkit-app-region:no-drag/,
    `without no-drag the window-drag top bar swallows the header half of the seam: ${handle}`,
  )

  /* One element draws the line for the whole height, so the header must not
     paint a second copy of it: a leftover ::after would be a hairline with no
     gesture behind it again, and the two constructions could drift apart. */
  assert.equal(
    declarations('.cm-band-topbar::after'),
    null,
    'the header must not paint its own seam copy: the handle owns the whole line',
  )
  const line = declarations('.cm-band-gutter::before')
  assert.notEqual(line, null, 'the handle draws the seam')
  assert.match(line, /top:0;bottom:0/, `the hairline covers the band's whole height: ${line}`)
  assert.match(line, /right:calc\(var\(--cm-band-gutter-width,8px\) \/ 2 - \.5px\)/, `right-anchored so the seam keeps one x: ${line}`)
})

/**
 * The sidebar row's status cluster is taken out of the 16px glyph cell.
 *
 * The shell hands the plugin a 16px glyph cell in the wide sidebar (18px in the
 * rail — `SidebarRoot.tsx` passes `size: wide ? 16 : 18`) and the plugin only
 * renders inside it, but the cluster the reader asked for is a node row's mark:
 * one dot plus count per category. That does not fit on a 16px icon (the earlier
 * corner badge started at x=4 of the glyph and read as a green speech bubble),
 * so while the cluster is present the shell row becomes the containing block and
 * the glyph cell goes static. Without `:has()` the cluster stays hidden instead
 * of widening the cell and pushing the label.
 */
test('the sidebar status cluster is anchored to the row, not to the glyph cell', () => {
  const row = declarations('button:has(.cm-panel-glyph > .cm-rollup)')
  assert.notEqual(row, null, 'the row must become the containing block while the cluster is present')
  assert.match(row, /position:relative/, `the row carries the cluster: ${row}`)

  const cell = declarations('.cm-panel-glyph:has(> .cm-rollup)')
  assert.notEqual(cell, null, 'the glyph cell must leave the containing-block chain')
  assert.match(cell, /position:static/, `otherwise the cluster would sit on the 16px mark: ${cell}`)

  const cluster = allDeclarations('.cm-panel-glyph > .cm-rollup')
  assert.ok(cluster.some(block => /display:none/.test(block)), 'without :has() the cluster hides instead of misplacing the label')
  assert.ok(
    cluster.some(block => /position:absolute/.test(block) && /right:8px/.test(block) && /top:50%/.test(block)),
    `the wide row draws the cluster on its trailing edge: ${JSON.stringify(cluster)}`,
  )

  const rail = declarations('.cm-panel-glyph[data-seat="rail"] > .cm-rollup')
  assert.notEqual(rail, null, 'the 56px rail needs its own seat for the dots')
  assert.match(rail, /right:0;top:0;transform:none/, `the rail cluster rides the row corner: ${rail}`)

  /* The corner badge is gone: the cluster replaced it, and a leftover pill rule
     would still paint over the mark. */
  assert.equal(declarations('.cm-panel-badge'), null, 'the old corner badge rule must not survive')
})

/**
 * The space entry's status cluster is the active space's count, compared by the
 * reader against the sidebar row's whole-map count. It must not squeeze the
 * chrome controls in the two states where row space is scarce.
 */
test('the space entry gives its cluster up in the compact and search states', () => {
  const compact = declarations('.cm-band[data-compact] .cm-space-btn .cm-rollup')
  assert.notEqual(compact, null, 'the compact header hides the counts instead of squeezing the controls')
  assert.match(compact, /display:none/, `the compact rule removes the cluster: ${compact}`)

  const searching = declarations('.cm-band-row2:has(.cm-search) .cm-crumb .cm-rollup')
  assert.notEqual(searching, null, 'opening the search field on row two hides the counts too')
  assert.match(searching, /display:none/, `the search rule removes the cluster: ${searching}`)
})

/**
 * The space entry is one breadcrumb control: the whole bar is a single button, so
 * every segment (including the whole-map count) opens the space menu. Only the
 * current space's name shrinks; the root label, the separator and both clusters
 * stay whole. The row-2 pill box supplies height/padding, and the direct-child
 * rule lifts the pill's 180px ceiling off the bar.
 */
test('the space breadcrumb is one control with a static root and a shrinkable current name', () => {
  const crumbRules = allDeclarations('.cm-crumb')
  const crumb = crumbRules.find(rule => /display:flex/.test(rule)) ?? null
  assert.notEqual(crumb, null, 'the breadcrumb has its own container rule')
  assert.match(crumb, /min-width:0/, `the row may shrink the breadcrumb: ${crumb}`)

  const rowRule = declarations('.cm-band-row2>.cm-crumb')
  assert.notEqual(rowRule, null, 'the breadcrumb is the row-2 pill seat')
  assert.match(rowRule, /max-width:100%/, `the bar may use the row's width: ${rowRule}`)

  const root = declarations('.cm-crumb-root')
  assert.notEqual(root, null, 'the root segment has its own box')
  assert.match(root, /flex:none/, `the root never participates in shrinking: ${root}`)

  const separator = declarations('.cm-crumb-sep')
  assert.notEqual(separator, null, 'the separator is its own element')
  assert.match(separator, /flex:none/, `the separator never shrinks: ${separator}`)

  const current = declarations('.cm-crumb-current')
  assert.notEqual(current, null, 'the current segment has its own box')
  assert.match(current, /flex:0 1 auto/, `only the current segment may shrink: ${current}`)
  assert.match(current, /min-width:0/, `the current name may ellipsize: ${current}`)
  assert.match(current, /font-weight:600/, `the current space reads as the active level: ${current}`)

  const currentName = declarations('.cm-crumb-current .cm-space-name')
  assert.notEqual(currentName, null, 'the current name owns the ellipsis')
  assert.match(currentName, /text-overflow:ellipsis/, `a long space name truncates: ${currentName}`)
})

/**
 * The search result column's own contracts: a hit may carry a second line, the
 * keyboard cursor must not repaint a row's selected mark, and the matched run is
 * isolated with the theme's brand tint instead of a hardcoded colour.
 */
test('search result rows reserve a second line and keep the cursor separate from selection', () => {
  const note = declarations('.cm-row-note')
  assert.notEqual(note, null, 'the search view needs a note rule')
  assert.match(note, /text-overflow:ellipsis/, `a narrow column must truncate the note: ${note}`)

  const labels = declarations('.cm-row-labels')
  assert.notEqual(labels, null, 'the title and its note share a column')
  assert.match(labels, /flex-direction:column/, `the two lines stack: ${labels}`)

  const active = declarations('.cm-node-row[data-search-active="true"],.cm-thread-row[data-search-active="true"]')
  assert.notEqual(active, null, 'the keyboard cursor needs its own mark')
  assert.match(active, /outline:/, `the cursor is a ring, not the selected background: ${active}`)
  assert.ok(!/font-weight:500/.test(active), 'the cursor never claims the selected row weight')

  const mark = declarations('.cm-search-mark')
  assert.notEqual(mark, null, 'a matched run must be visible inside a snippet')
  assert.match(mark, /var\(--dsw-alias-brand-primary/, `the highlight asks the theme for its brand tint: ${mark}`)
})

/**
 * A group row (「未分组」 without legacy topics) is a conversation list, not a
 * node: it has no click action at all. It used to inherit the node row's pointer
 * cursor and hover wash, so pressing it looked like a broken button. The sheet
 * has to hand that affordance back only to rows that can actually be selected.
 */
test('a row that cannot be selected does not borrow the button affordance', () => {
  const rule = declarations('.cm-node-row[data-selectable="false"]')
  assert.notEqual(rule, null, 'the non-selectable row rule is missing from the shipped sheet')
  assert.match(rule, /cursor:\s*default/, `it must not invite a click: ${rule}`)
  assert.match(
    bundle,
    /\.cm-node-row:hover[^{]*:not\(\[data-selectable="false"\]\)[^{]*\{/,
    'the hover wash must skip rows that have no action',
  )
})
