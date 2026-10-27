/**
 * The single control shared by both presentations of a conversation.
 *
 * The two occurrences do not say the same *kind* of thing, because the two
 * directions are not symmetric:
 *
 * - while the shipped Conversation is on screen the band is genuinely absent, so
 *   the button names where the click goes — 「对话树」;
 * - while the band is on screen the shipped Conversation keeps rendering to the
 *   band's right (it is only shifted by the band's own width), so a destination
 *   label would point at a column the reader is already looking at. There the
 *   button names what the click *does* to the band — 「收起」, i.e. remove the
 *   band and give the Conversation the centre back.
 *
 * Both occurrences render this one component at the leading edge of the content
 * header, and each is named for what its own click does:
 *
 * - `conversation.header.leading` while the shipped Conversation is on screen;
 * - the map band's own top bar while the map is on screen.
 *
 * They now differ in *form* as well as in wording, because the two occurrences
 * do different jobs:
 *
 * - the band's occurrence is an icon-only 28×28 box (`compact`), one of the row
 *   of chrome controls that open the band's first row; the reader has just opened
 *   the band and is looking at it, so the box only has to be findable, line up
 *   with the shell's own buttons beside it, and give its width back to the row;
 * - the Conversation header's occurrence keeps its two-character label: that box
 *   is the mode's *discovery* entry, the one visible way in for a reader who has
 *   never met 对话树模式, and an unlabelled glyph there would bury the mode.
 *
 * The map band is positioned exactly over the content edge, so the control's left
 * edge keeps its screen position when the view flips; the visible label is the
 * one deliberate difference between the two boxes.
 *
 * `data-target` deliberately keeps its `conversation` value: it is the internal
 * id of the band-side occurrence (the seat that leads back to the Conversation),
 * and the out-of-band UI harness selects on it.
 */
import type { ReactNode } from 'react'

import { CollapseGlyph, MapGlyph } from './Glyph.js'

/** The presentation the click switches to, or the band it collapses. */
export type ViewTarget = 'map' | 'expand' | 'conversation'

/** Props the button composes. */
export interface ViewToggleProps {
  /** The presentation the click switches to (or the band it collapses). */
  readonly target: ViewTarget
  /** Invoked when the reader picks the target presentation. */
  readonly onSelect: () => void
  /**
   * Render as the band's icon-only 28×28 box instead of the labelled pill.
   *
   * The accessible name, title, `data-target` and click are unchanged: only the
   * visible copy is dropped (and the glyph steps up to 16px). Defaults to false,
   * i.e. the Conversation header's labelled form.
   */
  readonly compact?: boolean
}

/**
 * Render the single control.
 *
 * The accessible name states the action; the visible copy stays short (the
 * destination's name in the Conversation, the action's name in the band).
 * `compact` drops the visible copy entirely while keeping title/aria-label, so
 * the icon-only box is still named for assistive technology and on hover. The
 * button is not a toggle: it carries no pressed state, because the current
 * presentation has no "off" meaning to report.
 * @param props - destination/action, the selection callback, and whether to
 *   render the band's icon-only box.
 * @returns the shared control.
 */
export function ViewToggle({ target, onSelect, compact = false }: ViewToggleProps): ReactNode {
  const isMap = target !== 'conversation'
  const label = target === 'conversation' ? '收起' : target === 'expand' ? '展开对话树' : '对话树'
  const name = target === 'conversation' ? '收起对话树栏，会话恢复整宽' : target === 'expand' ? '展开对话树' : '展开对话树栏'
  const glyphSize = compact ? 16 : 14
  return (
    <button
      type="button"
      className={compact ? 'cm-view-toggle cm-view-toggle--icon' : 'cm-view-toggle'}
      data-target={isMap ? 'map' : 'conversation'}
      title={name}
      aria-label={name}
      onClick={onSelect}
    >
      <span className="cm-view-toggle-glyph" aria-hidden="true">
        {isMap ? <MapGlyph size={glyphSize} /> : <CollapseGlyph size={glyphSize} />}
      </span>
      {compact ? null : <span className="cm-view-toggle-label">{label}</span>}
    </button>
  )
}
