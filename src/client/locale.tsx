/**
 * Client-side locale layer: one React context that carries the namespace
 * translator, and the boundary that binds it to the DSH locale service.
 *
 * The plugin owns no language preference of its own — the active language is
 * the DSH client locale service's, and switching it must re-render the map
 * without a reload. {@link LocaleBoundary} subscribes to the service's
 * `getSnapshot`/`subscribe` pair (the `LocaleFace` contract) and re-binds the
 * namespace translator on every revision; nested components read the result
 * through {@link useT}.
 *
 * The context default is the Simplified Chinese translator, so components that
 * render without a boundary (the Node render tests) keep their historical
 * Chinese output; a boundary with no service behaves the same way. Nothing here
 * writes a language preference — `setLocale` stays the settings UI's call.
 */
import {
  createContext, useCallback, useContext, useSyncExternalStore, type ReactNode,
} from 'react'

import { createTranslator, NS, zh, type Translate } from './locales/index.js'

/** One immutable locale reading, the part of the service snapshot this layer needs. */
export interface LocaleSnapshotLike {
  /** Active BCP 47-style locale id. */
  active: string
  /** Monotonic change counter (locale switch or dictionary registration). */
  revision: number
}

/**
 * The narrow face of `ctx.locale` this plugin uses.
 *
 * Mirrors the public DSH client locale service: `getSnapshot`/`subscribe` are
 * the `LocaleFace` pair, `bind` returns the namespace translator following the
 * active language's fallback chain, and `register` installs the dictionaries.
 */
export interface LocaleService {
  getSnapshot(): LocaleSnapshotLike
  subscribe(listener: () => void): () => void
  bind(ns: string): Translate
  register(ns: string, dicts: Readonly<Record<string, Readonly<Record<string, string>>>>): () => void
}

/** Stable snapshot used when no service is mounted (tests, partial profiles). */
const NO_SERVICE_SNAPSHOT: LocaleSnapshotLike = { active: 'zh', revision: 0 }

/** Stable translate function used when no service is mounted. */
export const FALLBACK_TRANSLATOR: Translate = createTranslator(zh)

/** The translator context; defaults to Simplified Chinese. */
const LocaleContext = createContext<Translate>(FALLBACK_TRANSLATOR)

/**
 * Read the active translator from the render tree.
 * @returns the namespace translator for the active language.
 */
export function useT(): Translate {
  return useContext(LocaleContext)
}

/**
 * Provide one translator to a subtree (tests and advanced wiring).
 * @param props - translator and children.
 * @returns the provider element.
 */
export function LocaleProvider({
  translator = FALLBACK_TRANSLATOR, children,
}: {
  translator?: Translate | undefined
  children?: ReactNode
}): ReactNode {
  return <LocaleContext.Provider value={translator}>{children}</LocaleContext.Provider>
}

/**
 * Subscribe one component directly to the DSH locale service.
 *
 * Root components (the slot entries) receive the service as a prop and call
 * this instead of relying on an ancestor boundary: the hook re-renders them on
 * every locale revision and returns the namespace translator. A component
 * mounted without a service (the Node render tests) keeps the fallback
 * Simplified Chinese translator.
 * @param locale - the DSH locale service, when this profile provides one.
 * @returns the namespace translator for the active language.
 */
export function useLocaleT(locale?: LocaleService | undefined): Translate {
  const subscribe = useCallback(
    (notify: () => void): (() => void) => (locale === undefined ? () => {} : locale.subscribe(notify)),
    [locale],
  )
  const getSnapshot = useCallback(
    (): LocaleSnapshotLike => (locale === undefined ? NO_SERVICE_SNAPSHOT : locale.getSnapshot()),
    [locale],
  )
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return locale === undefined ? FALLBACK_TRANSLATOR : locale.bind(NS)
}

/**
 * Bind the subtree to the DSH locale service.
 *
 * Re-renders on every locale revision (a language switch or a dictionary
 * registration) and provides the namespace translator. Without a service the
 * subtree keeps the fallback (Simplified Chinese) translator, so a render test
 * can mount a component directly.
 * @param props - locale service (when the profile provides one) and children.
 * @returns the provider element.
 */
export function LocaleBoundary({
  locale, children,
}: {
  locale?: LocaleService | undefined
  children?: ReactNode
}): ReactNode {
  const translator = useLocaleT(locale)
  return <LocaleContext.Provider value={translator}>{children}</LocaleContext.Provider>
}
