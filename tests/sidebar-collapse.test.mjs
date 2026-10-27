/**
 * Unit tests for the 「enter map mode ⇒ collapse the product's left column」
 * controller.
 *
 * The shell only exposes a toggle, so every decision here is taken from a state
 * read the test drives by hand: mount/absent (`null`), expanded, collapsed. The
 * assertions are about the exact toggle sequence the controller produces, since
 * an extra toggle is exactly the bug this state machine exists to prevent.
 * Entering always collapses an expanded column: there is no remembered preference,
 * so every entry starts from the same rule.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createSidebarCollapse, readShellSidebarCollapse } from '../lib/sidebar-collapse.js'

/** A layout double recording every toggle call, optionally throwing. */
function layout({ throws = false } = {}) {
  const calls = []
  return {
    calls,
    toggleSidebar() {
      calls.push('toggle')
      if (throws) throw new Error('layout unavailable')
    },
  }
}

/**
 * A shell state double: the mutable collapsed flag plus a mount counter, so a
 * boot can be "frame not mounted yet for N reads".
 * @param initial - current collapsed state; null models an unmounted frame.
 * @param mounts - how many reads answer null before the state is returned.
 */
function shell(initial = false, mounts = 0) {
  let attempts = 0
  return {
    value: initial,
    /** Reader handed to the controller. */
    read() {
      if (attempts < mounts) {
        attempts += 1
        return null
      }
      return this.value
    },
    /** Land the shell's own state change after a toggle. */
    set(next) { this.value = next },
  }
}

/** A scheduler that queues callbacks for the test to drain explicitly. */
function scheduler() {
  const queue = []
  return {
    queue,
    schedule(run) { queue.push(run) },
    /** Run every queued attempt (including the ones they schedule) to exhaustion. */
    drain() {
      while (queue.length > 0) {
        const next = queue.shift()
        next()
      }
    },
  }
}

/** Build one controller over the doubles. */
function controller({ panel, state, schedule = () => {}, retries } = {}) {
  return createSidebarCollapse({
    layout: panel,
    read: () => state.read(),
    schedule,
    ...(retries === undefined ? {} : { retries }),
  })
}

test('entering collapses an expanded column and leaving expands it back', () => {
  const panel = layout()
  const state = shell(false)
  const collapse = controller({ panel, state })

  collapse.enter()
  assert.deepEqual(panel.calls, ['toggle'], 'an expanded column is collapsed once on entry')
  // The shell writes its marker asynchronously; model that before leaving.
  state.set(true)
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle', 'toggle'], 'leaving restores the column this session collapsed')
})

test('entering a column the shell already collapsed does not toggle it', () => {
  const panel = layout()
  // Narrow frames auto-collapse the column before the plugin can act; a blind
  // toggle there would *expand* it, which is the failure this read protects.
  const state = shell(true)
  const collapse = controller({ panel, state })

  collapse.enter()
  assert.deepEqual(panel.calls, [], 'an already collapsed column is left alone')
  collapse.exit()
  assert.deepEqual(panel.calls, [], 'and leaving does not claim/pop it back')
})

test('a column the reader expands while in map mode is not stolen back on exit', () => {
  const panel = layout()
  const state = shell(false)
  const collapse = controller({ panel, state })

  collapse.enter()
  state.set(true)
  // The reader presses the shell's own toggle (⌘B, the icon rail, or the macOS
  // window chrome) to expand.
  state.set(false)
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle'], 'only the entry collapse is recorded; the reader keeps the expansion')
})

test('a manual expand followed by a manual collapse is restored on exit', () => {
  const panel = layout()
  const state = shell(false)
  const collapse = controller({ panel, state })

  collapse.enter()
  state.set(true)
  state.set(false) // reader expands
  state.set(true) // reader collapses again
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle', 'toggle'], 'exit restores the expanded state the reader entered with')
})

test('a competing restore in the same click is settled on the next frame', () => {
  const panel = layout()
  // Entering from a sibling's full-width page: that page already collapsed the
  // column, so the immediate read says "collapsed" and the entry skips a toggle.
  const state = shell(true)
  const queue = scheduler()
  const collapse = controller({ panel, state, schedule: queue.schedule })

  collapse.enter()
  assert.deepEqual(panel.calls, [], 'the stale read does not toggle blind')
  // The sibling's exit restores the column after that read, before the next frame.
  state.set(false)
  queue.drain()
  assert.deepEqual(panel.calls, ['toggle'], 'the next frame settles the column back to collapsed')
  state.set(true)
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle', 'toggle'], 'the settled collapse is owned, so leaving restores it')
})

test('settling does not chase a reader who expands on a later frame', () => {
  const panel = layout()
  const state = shell(false)
  const queue = scheduler()
  const collapse = controller({ panel, state, schedule: queue.schedule })

  collapse.enter()
  state.set(true) // the shell writes the collapse marker
  queue.drain() // the settle read sees a collapsed column and leaves it alone
  state.set(false) // the reader expands by hand afterwards
  assert.deepEqual(panel.calls, ['toggle'], 'only the entry collapse ran')
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle'], 'the reader keeps the expansion they chose')
})

test('a boot waits for the shell frame, then collapses once it is readable', () => {
  const panel = layout()
  const state = shell(false, 3)
  const queue = scheduler()
  const collapse = controller({ panel, state, schedule: queue.schedule })

  collapse.enter()
  assert.deepEqual(panel.calls, [], 'no read during the first frame: nothing is toggled blind')
  assert.equal(queue.queue.length, 1, 'one retry is queued while the frame mounts')

  queue.drain()
  assert.deepEqual(panel.calls, ['toggle'], 'the mounted frame is collapsed exactly once')
})

test('the retry budget is finite and expires without acting', () => {
  const panel = layout()
  const queue = scheduler()
  const collapse = createSidebarCollapse({
    layout: panel,
    read: () => null,
    schedule: queue.schedule,
    retries: 2,
  })

  collapse.enter()
  queue.drain()
  assert.deepEqual(panel.calls, [], 'an unmounted shell never produces a blind toggle')
  assert.equal(queue.queue.length, 0, 'the retries stop at the budget')
})

test('leaving before the shell mounts cancels the pending boot collapse', () => {
  const panel = layout()
  const state = shell(false, 99)
  const queue = scheduler()
  const collapse = controller({ panel, state, schedule: queue.schedule })

  collapse.enter()
  collapse.exit()
  queue.drain()
  assert.deepEqual(panel.calls, [], 'a stale boot attempt after exit must not collapse the column')
  assert.equal(state.value, false, 'the shell state is untouched')
})

test('a frame that vanished does not make exit toggle anything', () => {
  const panel = layout()
  const state = shell(false)
  const collapse = controller({ panel, state })

  collapse.enter()
  state.set(true)
  // The frame unmounts (reload/teardown) before the mode turns off.
  state.set(null)
  collapse.exit()
  assert.deepEqual(panel.calls, ['toggle'], 'no state read, no toggle')
})

test('dispose restores a collapse it owns, exactly once', () => {
  const panel = layout()
  const state = shell(false)
  const collapse = controller({ panel, state })

  collapse.enter()
  state.set(true)
  collapse.dispose()
  assert.deepEqual(panel.calls, ['toggle', 'toggle'], 'plugin teardown hands the column back')
  collapse.dispose()
  assert.deepEqual(panel.calls, ['toggle', 'toggle'], 'dispose is idempotent')
})

test('a throwing layout never breaks the mode or leaks the ownership flag', () => {
  const panel = layout({ throws: true })
  const state = shell(false)
  const collapse = controller({ panel, state })
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args) }
  try {
    assert.doesNotThrow(() => { collapse.enter() })
    state.set(true)
    assert.doesNotThrow(() => { collapse.exit() })
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 2, 'both failed toggles are reported once')
})

test('the DOM reader distinguishes unmounted, expanded, and collapsed', () => {
  const query = markers => ({
    querySelector(selector) {
      return markers.includes(selector) ? {} : null
    },
  })
  const frame = '[data-rightbar-col], [data-shell-overlay]'
  const collapsed = '[data-sidebar-collapsed]'

  assert.equal(readShellSidebarCollapse(query([])), null, 'no frame marker means the shell has not mounted')
  assert.equal(readShellSidebarCollapse(query([frame])), false, 'a mounted frame without the marker is expanded')
  assert.equal(readShellSidebarCollapse(query([frame, collapsed])), true, 'the marker means collapsed')
  assert.equal(readShellSidebarCollapse(), null, 'a non-browser context reads as unknown')
})
