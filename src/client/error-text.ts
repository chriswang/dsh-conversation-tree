/**
 * Turn a thrown value into display copy.
 *
 * The model's `MapError` carries a stable code; the client owns the wording for
 * every code it ships, through its locale dictionary. Anything else is external
 * data (a Host wire message, a provider error, a programming failure) and renders
 * verbatim, following DSH's rule that authored data is never translated.
 *
 * `MapError` messages stay English because they are also the model-facing error
 * text for the map tools; the UI never shows them when the code is known.
 */
import type { Translate } from '../shared/copy.js'
import { MapError } from '../shared/model.js'

/**
 * Error codes whose wording the client dictionary owns.
 *
 * Keep in sync with the `model.error.*` keys; a code missing here falls back to
 * the (English) model message, so a future error never renders a bare key.
 */
const TRANSLATED_ERROR_CODES = new Set([
  // shared model mutations
  'NOT_FOUND',
  'SPACE_TITLE_EMPTY',
  'SPACE_TITLE_LONG',
  'SPACE_TITLE_DUP',
  'SPACE_NOT_FOUND',
  'SPACE_LIMIT',
  'DEFAULT_SPACE',
  'TITLE_EMPTY',
  'TITLE_LONG',
  'DESCRIPTION_LONG',
  'WORKSPACE',
  'LIMIT',
  'DEPTH',
  'ANCHOR',
  'HAS_CHILDREN',
  'SUBAGENT',
  'SPACE',
  // client-side failures raised by the entry/store
  'STORE_LOADING',
  'PICKER_MACOS',
  'PICKER_MISSING',
  'NAV_MISSING',
])

/**
 * Describe one thrown value for display.
 * @param t - the active translator (namespace `conversation-map`).
 * @param error - the thrown value.
 * @returns localized copy for a known model code, otherwise the verbatim message.
 */
export function describeError(t: Translate, error: unknown): string {
  if (error instanceof MapError && TRANSLATED_ERROR_CODES.has(error.code)) {
    return t(`model.error.${error.code}`, error.params)
  }
  if (error instanceof Error) return error.message
  return String(error)
}
