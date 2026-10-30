/**
 * Display helpers for model values whose stored form is a stable marker rather
 * than user wording.
 *
 * The map document keeps its default space title as a fixed marker
 * ({@link DEFAULT_SPACE_TITLE}) so a document written in one language reads the
 * same in the other; the label shown for it is dictionary copy. A space the user
 * renamed is data and renders verbatim, exactly like every other stored title.
 */
import type { Translate } from '../shared/copy.js'
import { DEFAULT_SPACE_TITLE, type MapState } from '../shared/model.js'

/** The parts of a space row the label needs. */
export interface SpaceTitleLike {
  readonly id: string
  readonly title: string
}

/**
 * The label one space renders under.
 * @param t - the active translator.
 * @param space - the space row.
 * @param state - the map, read for its current default-space identity.
 * @returns localized copy for the default space, otherwise the stored title.
 */
export function displaySpaceTitle(t: Translate, space: SpaceTitleLike, state: Pick<MapState, 'defaultSpaceId'>): string {
  if (space.id === state.defaultSpaceId && space.title === DEFAULT_SPACE_TITLE) {
    return t('common.defaultSpace')
  }
  return space.title
}

/**
 * Localized fallbacks for {@link workspaceDisplayTitle}.
 * @param t - the active translator.
 * @returns the two labels the Workspace title helper needs.
 */
export function workspaceTitleLabels(t: Translate): { defaultWorkspace: string; workspaceFallback: string } {
  return {
    defaultWorkspace: t('common.defaultWorkspace'),
    workspaceFallback: t('common.workspace'),
  }
}
