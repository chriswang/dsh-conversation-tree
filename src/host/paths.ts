/// <reference types="node" />
/**
 * Host-side path and constant resolution for the authoritative map store.
 *
 * The conversation map's business document lives on the Host so model tools and
 * every browser window read and write one authoritative copy. Its location is
 * the DSH home directory (`$DSH_HOME`, falling back to `~/.dsh`), beside the
 * other non-session application state.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory (under `$DSH_HOME`) holding the map document. */
export const HOST_DIR_NAME = 'conversation-map'

/** Directory (under `$DSH_HOME`) holding the persisted Session logs. */
export const SESSIONS_DIR_NAME = 'sessions'

/** Document file name. */
export const MAP_FILE_NAME = 'map.json'

/** Host envelope format version; bumped only by a migration. */
export const ENVELOPE_FORMAT = 1

/** Current `MapState` document version (the shared model's version). */
export const DOC_VERSION = 2

/** Maximum serialized document size accepted by the Host. */
export const MAX_DOC_BYTES = 4 * 1024 * 1024

/** Maximum nodes one tool call may create/update/delete. */
export const MAX_BATCH_NODES = 50

/** When set to `local`, the Host half stays inert and the client keeps localStorage. */
export const KILL_SWITCH_ENV = 'DSH_CONVERSATION_MAP_HOST'

/**
 * Resolve the DSH home directory.
 * @returns the configured `DSH_HOME`, or `~/.dsh` when unset.
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** @returns the directory holding the map document. */
export function mapDirectory(): string {
  return join(dshHome(), HOST_DIR_NAME)
}

/**
 * The DSH session store root, where every persisted Session log lives.
 *
 * The Host's conversation-body index reads these logs directly: the catalog
 * knows a Session's title and activity, but only the log carries the messages a
 * person and the assistant actually wrote.
 * @returns the sessions root (`$DSH_HOME/sessions`).
 */
export function sessionsDirectory(): string {
  return join(dshHome(), SESSIONS_DIR_NAME)
}

/** @returns the absolute path of the map document. */
export function mapFilePath(): string {
  return join(mapDirectory(), MAP_FILE_NAME)
}

/**
 * Backup path kept beside the document (previous successfully written version).
 * @param file - document path; defaults to the live map file.
 * @returns the backup path.
 */
export function backupFilePath(file: string = mapFilePath()): string {
  return `${file}.bak`
}

/**
 * Whether the Host half is disabled by the runtime kill switch.
 * @returns whether the operator asked for localStorage-only behavior.
 */
export function hostDisabled(): boolean {
  return process.env[KILL_SWITCH_ENV] === 'local'
}
