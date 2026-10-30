/**
 * Geometry of the split between the map band and the shipped Conversation
 * column.
 *
 * The plugin does not replace the Conversation shell: the shipped column stays
 * in the centre, and the map is a frame-wide overlay band drawn over the
 * column's left edge. The only layout change applied to the product is a
 * `padding-left` on the Conversation root (in the plugin stylesheet, scoped by
 * `html[data-conversation-map-split]`), so everything the band needs to know is
 * measured from the live DOM:
 *
 * - where the centre column's box starts, in the overlay layer's coordinates;
 * - how wide the centre column currently is (a right Sidebar, a window resize,
 *   and the left column's collapse all change it);
 * - how tall the shipped Conversation header is (40px blank / 76px with a
 *   Session) and where its leading row sits, so the band's top bar lines up
 *   with it;
 * - how much room the shell's macOS window-chrome seat needs, and how wide that
 *   seat actually measures — the second number is what tells the band whether
 *   the shell's second seat button is still mounted (styles.ts hides it while
 *   the band occupies that edge).
 *
 * The overlay layer spans the frame's border box, while the frame itself can be
 * padded: the Windows desktop shell keeps its caption row in that padding, so
 * the Conversation column's top edge sits below the overlay's top edge. Both
 * offsets the band consumes (`left` and `top`) are therefore measured against
 * the same layer, never against each other's element — the band is the
 * Conversation column's box on every platform.
 *
 * The hook re-measures from a `ResizeObserver` on the Conversation root, on
 * window resize, and on the caller's revision (main-panel selection). A missing
 * Conversation column (another main panel is in front, or the frame has not
 * mounted yet) reports `ready: false`; the page hides the band then.
 */
import { useLayoutEffect, useState } from 'react'

/** One measurement of the band's containing centre column. */
export interface BandFrame {
  /** False until the Conversation column and the overlay layer are measurable. */
  ready: boolean
  /** Band left edge, relative to the frame-wide overlay layer. */
  left: number
  /** Band top edge, relative to the frame-wide overlay layer. */
  top: number
  /** Width of the product's centre column (band + shipped Conversation). */
  centerWidth: number
  /** Height of the shipped Conversation header. */
  headerHeight: number
  /** Offset of the header's leading row from the conversation top. */
  headTop: number
  /** Height of the header's leading row. */
  headHeight: number
  /** Left inset the band's first control leaves for window chrome. */
  inset: number
  /**
   * Measured width of the shell's `[data-shell-leading]` seat, in CSS px; 0
   * while that seat is not mounted.
   *
   * The published clearance above is a hardcoded constant, so it cannot say
   * whether a button inside the seat is currently hidden; this measured width
   * can. The band only draws its own 新建会话 when this is narrow.
   */
  seatWidth: number
}

/** A sane stand-in used for server rendering and the first browser frame. */
export const FALLBACK_FRAME: BandFrame = {
  ready: false,
  left: 0,
  top: 0,
  centerWidth: 0,
  headerHeight: 76,
  headTop: 10,
  headHeight: 30,
  inset: 20,
  seatWidth: 0,
}

/** Parse a CSS pixel value, falling back when it is absent or malformed. */
function px(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * The shell's window-chrome seat, measured.
 *
 * The frame has exactly one handle on that seat, `[data-shell-leading]`; both
 * numbers are 0 while it is not mounted (another profile, or the sidebar
 * expanded), which is also what "there is no seat to clear" means.
 * @returns the seat's rounded width and right edge, in CSS px.
 */
function leadingSeat(): { width: number; right: number } {
  const seat = document.querySelector('[data-shell-leading]') as HTMLElement | null
  const seatRect = seat?.getBoundingClientRect()
  if (seatRect === undefined || seatRect.width === 0) return { width: 0, right: 0 }
  return { width: Math.round(seatRect.width), right: Math.round(seatRect.right) }
}

/**
 * Read the shell's window-chrome band, in CSS pixels.
 *
 * The frame publishes `--dsh-frame-leading-clearance` while the macOS
 * `shell.leading` seat is mounted (160px windowed / 84px fullscreen, covering
 * traffic lights plus the reopen controls). That number is a hardcoded constant
 * (`88 + (28+8+28) + 8 = 160`, `84` fullscreen), so it does NOT shrink when a
 * button inside the seat is hidden — only the seat's measured right edge can
 * say that. The plugin therefore takes the smaller of "published" and "measured
 * seat right + 8":
 *
 * - seat intact: `min(160, 152+8) = 160` — pixel-identical to today;
 * - the shell's second button hidden (styles.ts): `min(160, 116+8) = 124`
 *   (fullscreen `min(84, 48) = 48`), so the band's controls start where the
 *   remaining shell button ends plus the seat's own 8px air.
 *
 * The `+8` is that air, and it is what the shell's own constant is built from
 * (160 − 152); the earlier fallback's `+10` was a 2px-off estimate for the case
 * where the seat had not mounted yet. Profiles without the seat, and frames
 * whose seat is unmeasurable, keep the conversation's own 20px header inset.
 * @param frameElement - the frame element the overlay layer lives in.
 * @param seatRight - the measured right edge of the seat, 0 when unmounted.
 * @returns the inline inset the band's first control must leave free.
 */
function leadingInset(frameElement: HTMLElement | null, seatRight: number): number {
  const published = frameElement === null
    ? 0
    : Math.round(px(getComputedStyle(frameElement).getPropertyValue('--dsh-frame-leading-clearance'), 0))
  const chosen = published > 0
    ? Math.min(published, Math.round(seatRight + 8))
    : (seatRight > 0 ? Math.round(seatRight + 8) : 20)
  return Math.max(20, chosen)
}

/**
 * The Conversation column's box in the overlay layer's own coordinates.
 *
 * The overlay layer covers the frame's border box while the frame can be padded
 * (the Windows desktop shell keeps its caption row in that padding), so an
 * element measured against the conversation and one measured against the layer
 * would disagree by the padding. Returning both numbers here keeps the band on
 * top of the Conversation column on every platform: `top` is 0 on macOS/Web and
 * the caption-row height on Windows desktop.
 * @param layer - the frame-wide overlay layer's rect.
 * @param target - the Conversation column root's rect.
 * @returns the rounded box, relative to the overlay layer.
 */
export function overlayOffset(
  layer: Pick<DOMRect, 'left' | 'top'>,
  target: Pick<DOMRect, 'left' | 'top'>,
): { left: number; top: number } {
  return { left: Math.round(target.left - layer.left), top: Math.round(target.top - layer.top) }
}

/** Measure the live frame; returns the fallback when the column is not mounted. */
function measureFrame(): BandFrame {
  if (typeof document === 'undefined') return FALLBACK_FRAME
  const layer = document.querySelector('[data-shell-overlay]') as HTMLElement | null
  const conversation = document.querySelector('[data-slot="main.conversation"] > div') as HTMLElement | null
  if (layer === null || conversation === null) return FALLBACK_FRAME
  const layerRect = layer.getBoundingClientRect()
  const conversationRect = conversation.getBoundingClientRect()
  if (conversationRect.width <= 0 || conversationRect.height <= 0) return FALLBACK_FRAME
  const offset = overlayOffset(layerRect, conversationRect)
  const leading = conversation.querySelector('[data-conversation-header-leading]') as HTMLElement | null
  const header = (leading?.closest('header') ?? conversation.querySelector('header')) as HTMLElement | null
  const leadingRect = leading?.getBoundingClientRect()
  const headerHeight = header?.getBoundingClientRect().height ?? 76
  const seat = leadingSeat()
  return {
    ready: true,
    left: offset.left,
    top: offset.top,
    centerWidth: Math.round(conversationRect.width),
    headerHeight: Math.round(headerHeight),
    headTop: leadingRect === undefined ? 10 : Math.round(leadingRect.top - conversationRect.top),
    headHeight: leadingRect === undefined || leadingRect.height === 0 ? 30 : Math.round(leadingRect.height),
    inset: leadingInset(layer.parentElement as HTMLElement | null, seat.right),
    seatWidth: seat.width,
  }
}

/** Whether two measurements are the same, so a render can be skipped. */
function sameFrame(left: BandFrame, right: BandFrame): boolean {
  return left.ready === right.ready
    && left.left === right.left
    && left.top === right.top
    && left.centerWidth === right.centerWidth
    && left.headerHeight === right.headerHeight
    && left.headTop === right.headTop
    && left.headHeight === right.headHeight
    && left.inset === right.inset
    && left.seatWidth === right.seatWidth
}

/**
 * Follow the live geometry of the shipped Conversation column.
 *
 * @param revision - a value that changes when the surface may remount (the
 *   selected main panel id); the hook re-measures when it does.
 * @returns the latest measurement, or a not-ready fallback.
 */
export function useBandFrame(revision: unknown): BandFrame {
  const [frame, setFrame] = useState<BandFrame>(FALLBACK_FRAME)
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined
    let stopped = false
    let frameAnimation = 0
    let retryTimer: number | undefined
    let intervalTimer: number | undefined
    let observed: HTMLElement[] = []
    let observer: ResizeObserver | null = null
    let retryAttempts = 0

    const schedule = (): void => {
      if (stopped || frameAnimation !== 0) return
      frameAnimation = requestAnimationFrame(() => {
        frameAnimation = 0
        read()
      })
    }

    const observe = (nodes: readonly (HTMLElement | null)[]): void => {
      const next = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement)
      const unchanged = next.length === observed.length && next.every((node, index) => node === observed[index])
      if (unchanged) return
      observer?.disconnect()
      observer = null
      observed = next
      if (next.length > 0 && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule)
        for (const node of next) observer.observe(node)
      }
    }

    const read = (): void => {
      if (stopped) return
      const next = measureFrame()
      setFrame(current => (sameFrame(current, next) ? current : next))
      const conversation = document.querySelector('[data-slot="main.conversation"] > div') as HTMLElement | null
      const leading = conversation?.querySelector('[data-conversation-header-leading]') as HTMLElement | null
      const header = (leading?.closest('header') ?? conversation?.querySelector('header')) as HTMLElement | null
      // The seat is watched too: the plugin's own stylesheet hides the shell's
      // second seat button while the band owns that edge, and that is exactly
      // the moment `seatWidth` (and with it the band's 新建会话 decision) has to
      // change. Watching it makes the measurement land on the same frame as the
      // hide instead of waiting for the heartbeat below.
      const seat = document.querySelector('[data-shell-leading]') as HTMLElement | null
      observe([conversation, header, seat])
      if (next.ready) {
        retryAttempts = 0
        if (retryTimer !== undefined) {
          window.clearTimeout(retryTimer)
          retryTimer = undefined
        }
        return
      }
      // A main-panel switch unmounts the Conversation; the caller's revision
      // re-runs this effect when it returns. Retry briefly for the startup case
      // where the frame and the Conversation are still mounting.
      if (retryTimer === undefined && retryAttempts < 80) {
        retryAttempts += 1
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          schedule()
        }, 75)
      }
    }

    read()
    window.addEventListener('resize', schedule)
    // A Session switch can replace the Conversation subtree in place without the
    // centre column changing size, and a blank Session's header is shorter than
    // a started one's. The ResizeObserver covers both when the nodes exist; this
    // cheap heartbeat keeps the measurement honest if a node is swapped between
    // observations.
    intervalTimer = window.setInterval(schedule, 1000)

    return () => {
      stopped = true
      window.removeEventListener('resize', schedule)
      if (frameAnimation !== 0) cancelAnimationFrame(frameAnimation)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      if (intervalTimer !== undefined) window.clearInterval(intervalTimer)
      observer?.disconnect()
    }
  }, [revision])
  return frame
}
