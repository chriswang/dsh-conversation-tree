/**
 * Copy utilities shared by the pure modules and the client locale layer.
 *
 * A dictionary is a flat `{key: template}` map; `{name}` placeholders are filled
 * from the params object. Modules that must stay React-free (time, drag, store,
 * search) take a {@link Translate} and stay free of any dictionary import, so a
 * render site decides which language it speaks.
 */

/** Translate one dictionary key, filling `{name}` placeholders. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Matches one `{name}` placeholder in a copy template. */
const PLACEHOLDER = /\{(\w+)\}/gu

/**
 * Fill the `{name}` placeholders of one template.
 * @param template - the copy template.
 * @param params - placeholder values; a missing value keeps the placeholder.
 * @returns the filled string.
 */
export function formatCopy(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Build a translate function over one dictionary.
 *
 * The optional fallback dictionary is consulted only when the primary one lacks
 * the key; a key missing from both surfaces as the key itself, the same
 * behaviour the DSH locale service has.
 * @param dict - the primary dictionary.
 * @param fallback - the dictionary consulted for missing keys.
 * @returns the translate function.
 */
export function createTranslator(
  dict: Readonly<Record<string, string>>,
  fallback?: Readonly<Record<string, string>>,
): Translate {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dict[key] ?? fallback?.[key]
    return template === undefined ? key : formatCopy(template, params)
  }
}
