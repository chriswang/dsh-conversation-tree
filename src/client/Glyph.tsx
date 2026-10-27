/**
 * The map's glyph, shared by the page brand and both entry seats.
 *
 * Kept in its own module so the entry bundle does not pull the whole page in.
 */
import type { ReactNode } from 'react'

/**
 * The conversation-map mark: one conversation at the root, two branches below.
 *
 * The old mark was a single node on the left feeding three nodes on the right —
 * the *share* glyph's arrangement. At 16px readers read it as "分发/分享" and the
 * four nodes + three elbows made it the heaviest mark in the sidebar's panel
 * list, whose neighbours (pinwheel, clock, diamond) are one thin contour each.
 * This mark turns the same three-face tree top-down: a root above, a level bar,
 * two children below. That is the one 16px arrangement whose silhouette tells a
 * tree rather than a fan-out, and it uses three nodes instead of four.
 *
 * Geometry is drawn on the product's own icon grammar rather than the plugin's
 * earlier 24-viewBox/1.7 one (see `leading-controls-and-new-session-proposal.md`
 * §2.4): 16 viewBox, 1px stroke, round caps/joins, content box 11.7×12.05 with
 * ~2px margins, so it sits at the same optical weight as the shell's icons and
 * scales with them to 18 (rail) and 14 (the 「对话树」 pill). The nodes are equal
 * circles: a larger root reads as a "person" at 16px, so hierarchy is left to
 * the position, not to size. Stems are balanced (2.55 up, 2.5 down) around the
 * level bar at y=8.
 *
 * The footer/panel entry reads the band's on-screen state from the fill rather
 * than from a second glyph: one shape, two readings (outline = the band is not
 * on screen, filled = it is). Filling all three nodes keeps the silhouette and
 * turns the mark into a solid canopy, so the state reads as one colour change
 * at a glance.
 * @param props - square edge in pixels, and whether the band is on screen.
 * @returns the glyph.
 */
export function MapGlyph({ size = 18, filled = false }: { size?: number; filled?: boolean }): ReactNode {
  const node = filled ? 'currentColor' : 'none'
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="3.7" r="1.75" fill={node} />
      <path d="M8 5.45V8M3.9 10.5V8h8.2v2.5" />
      <circle cx="3.9" cy="12.25" r="1.75" fill={node} />
      <circle cx="12.1" cy="12.25" r="1.75" fill={node} />
    </svg>
  )
}

/**
 * The magnifier that opens the band's on-demand search.
 *
 * The band keeps no search box on screen: the header's second row is reserved
 * for the shipped header's own tab row, so search arrives only when asked for.
 * @param props - square edge in pixels.
 * @returns the glyph.
 */
export function SearchGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3 3" />
    </svg>
  )
}

/**
 * The product's own conversation mark: a speech bubble with two text lines.
 *
 * The application already uses this geometry for a Session (`ChatLines` in its
 * icon set), so the view switch can say "会话" with the same symbol a reader
 * meets everywhere else.
 * @param props - square edge in pixels.
 * @returns the glyph.
 */
export function SessionGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
      <path d="M5 6.75H11" />
      <path d="M5 9H8" />
      <path d="M2.37 11.25C1.59 9.89 1.32 8.3 1.62 6.76C1.92 5.22 2.76 3.84 4 2.88C5.23 1.91 6.77 1.43 8.34 1.51C9.9 1.59 11.39 2.24 12.51 3.32C13.64 4.41 14.34 5.87 14.48 7.43C14.61 8.99 14.18 10.55 13.26 11.82C12.34 13.09 10.99 13.98 9.46 14.33C8.19 14.63 6.86 14.53 5.65 14.06C5.17 13.87 4.77 13.49 4.27 13.4C3.67 13.28 2.95 13.56 2.04 14.33" />
    </svg>
  )
}

/**
 * The band's own mark: fold the column back to the left edge.
 *
 * The band is a column of the centre that the shipped Conversation keeps
 * rendering beside (it is only shifted by the band's width), so the control that
 * removes it says what the click *does*: the band folds back to the frame's left
 * edge and the conversation takes the full width again — the wording that goes
 * with this glyph is 「收起」 (see ViewToggle.tsx). Lucide
 * `arrow-left-to-line` (⇤) is the one candidate whose shape and result point the
 * same way: a bar at the left edge with an arrow moving into it.
 *
 * The emitted bar-plus-arrow shape is deliberately NOT a panel glyph: the
 * shell's own 打开侧边栏 button draws the bare panel mark 8px to this button's
 * left, so a second panel-like outline here would read as one switch with two
 * states. The bar is the only thing that separates the two marks.
 *
 * Provenance + licence: Lucide `arrow-left-to-line`,
 * https://unpkg.com/lucide-static@1.59.0/icons/arrow-left-to-line.svg —
 * ISC License (not this project's MIT): the path data is kept verbatim, so the
 * notice travels with it. The upstream 24 viewBox is kept as-is so the paths can
 * be compared with the source character by character; at 16px the rendered
 * stroke is 1.5 × (16/24) = 1.0px, i.e. the product's own 1px icon grammar.
 * @param props - square edge in pixels.
 * @returns the glyph.
 */
export function CollapseGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 19V5" />
      <path d="m13 6-6 6 6 6" />
      <path d="M7 12h14" />
    </svg>
  )
}

/**
 * The shell's own new-conversation artwork: a speech bubble around a plus.
 *
 * The band draws its own context-aware 「新建会话」 in the shell's leading seat
 * while the shell's second seat button is hidden (the hide rule in styles.ts
 * explains that coupling), so this glyph is the shell's own icon, copied rather
 * than redrawn: `NewChatOutlineArtwork` in
 * packages/client/ui-primitives/src/icons/shared-artwork.tsx:12-18, carrying the
 * product's grammar verbatim (16 viewBox, stroke 1). A plugin-styled variant
 * would sit heavier than the button it replaces and read as a different control.
 *
 * Provenance: the three paths are copied character for character from that
 * source file; the artwork belongs to the product's icon set, this copy only
 * lets the plugin render the same mark from outside the shell.
 * @param props - square edge in pixels.
 * @returns the glyph.
 */
export function NewChatGlyph({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" aria-hidden="true">
      <path d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337" stroke="currentColor" />
      <path d="M8 5V11" stroke="currentColor" />
      <path d="M5 8H11" stroke="currentColor" />
    </svg>
  )
}
