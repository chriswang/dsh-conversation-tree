/**
 * Browser storage resolvers for the plugin's two memories.
 *
 * The map document and the view document live in local storage; the
 * browsing-context marker lives in session storage. Both accesses can be denied
 * (sandboxed frames, hardened profiles), so each resolver falls back to a plain
 * in-memory map: the plugin then behaves as if nothing was remembered instead
 * of failing to render.
 */
import type { KeyValueStore } from '../shared/persistence.js'

/** In-memory fallback for every storage call a browser refuses. */
const memoryFallback = new Map<string, string>()

/**
 * Resolve one Web Storage area, falling back to memory.
 * @param pick - reads the area off the global scope, possibly throwing.
 * @returns the key/value surface to use.
 */
function storageOrMemory(pick: () => Storage | undefined): KeyValueStore {
  try {
    const area = pick()
    if (area !== null && area !== undefined) return area
  } catch (_denied) {
    // Storage access can throw under a hardened frame; fall through.
  }
  return {
    getItem: key => memoryFallback.get(key) ?? null,
    setItem: (key, value) => { memoryFallback.set(key, value) },
    removeItem: key => { memoryFallback.delete(key) },
  }
}

/**
 * The document store: local storage, or the in-memory fallback.
 * @returns the key/value surface for durable documents.
 */
export function browserStorage(): KeyValueStore {
  return storageOrMemory(() => globalThis.localStorage)
}

/**
 * The browsing-context store: session storage, or the in-memory fallback.
 * @returns the key/value surface for this page's lifetime marker.
 */
export function browserSessionStorage(): KeyValueStore {
  return storageOrMemory(() => globalThis.sessionStorage)
}
