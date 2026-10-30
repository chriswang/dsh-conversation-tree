/**
 * The conversation-map locale namespace: dictionaries for both shipped locales
 * and the pure helpers that build translators over them.
 *
 * The plugin registers `{ zh, en }` under {@link NS} with the DSH locale
 * service; the client render layer translates through that service's `bind`
 * (which also follows language-pack fallback chains), while tests and simple
 * pure modules can build a translator directly with {@link createTranslator}.
 */
import { zh } from './zh.js'

export { createTranslator, formatCopy, type Translate } from '../../shared/copy.js'
export { zh }
export { en } from './en.js'

/** Dictionary namespace owned by this plugin. */
export const NS = 'conversation-map'

/** Every message key of the namespace (the zh key set). */
export type MessageKey = keyof typeof zh

/** One locale's flat dictionary. */
export type LocaleDict = Record<string, string>

/** Locale ids the plugin ships dictionaries for. */
export const SHIPPED_LOCALES = ['zh', 'en'] as const
