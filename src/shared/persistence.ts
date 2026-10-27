/**
 * Persistence for the conversation map.
 *
 * The backing store is injected as a minimal key/value surface, so the browser
 * half can pass `window.localStorage` while tests pass a plain object. Swapping
 * the backing to a host-provided store later changes only the caller.
 */
import { emptyMap, parseMapState, type MapState } from './model.js'

/** The minimal storage surface this module needs. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  /**
   * Optional removal used by the Host migration to retire the local document
   * after its content has been copied to the Host. Plain test doubles without
   * this method keep working (they only ever read/write).
   */
  removeItem?(key: string): void
}

/** Key holding the whole map document. */
export const STORAGE_KEY = 'dsh.conversation-map.v1'

/**
 * Read the persisted map, falling back to an empty one.
 * @param store - backing key/value store.
 * @returns the stored map, or a fresh empty map.
 */
export function loadMap(store: KeyValueStore): MapState {
  try {
    return parseMapState(store.getItem(STORAGE_KEY)) ?? emptyMap()
  } catch (_unreadable) {
    return emptyMap()
  }
}

/**
 * Write the map.
 * @param store - backing key/value store.
 * @param state - the map to persist.
 */
export function saveMap(store: KeyValueStore, state: MapState): void {
  store.setItem(STORAGE_KEY, JSON.stringify(state))
}
