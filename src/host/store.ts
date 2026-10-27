/// <reference types="node" />
/**
 * Authoritative Host-side map document with atomic, checksum-free file storage.
 *
 * The document lives in one JSON file (see `paths.ts`). Every committed write is
 * serialized through one in-process queue: previous file → backup, temp file →
 * rename (atomic within the directory), then the in-memory snapshot advances.
 * Readers therefore always see a complete document, and a crash mid-write leaves
 * either the previous file or the new one, never a torn one.
 *
 * Two revision counters exist: the envelope `revision` (Host commit sequence,
 * the CAS token the browser commits against) and `MapState.revision` inside the
 * document (the shared model's own mutation counter, not used for concurrency).
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import {
  ensureDefaultSpace, isMapState, emptyMap, parseMapState, type MapState,
} from '../shared/model.js'
import { MapStoreError } from './errors.js'
import { backupFilePath, ENVELOPE_FORMAT, MAX_DOC_BYTES } from './paths.js'

/** One in-memory view of the authoritative document. */
export interface MapStoreSnapshot {
  /** Host commit sequence; `0` before the first persisted write. */
  revision: number
  /** Time of the last persisted write; empty before the first. */
  updatedAt: string
  /** Sanitized map document; always usable. */
  doc: MapState
}

/** Options for {@link createMapFileStore}. */
export interface MapFileStoreOptions {
  readonly filePath: string
  readonly maxDocBytes?: number
}

/** Host store surface consumed by the RPC channel and the model tools. */
export interface MapFileStore {
  /** Read the document once; `corrupt` reports a lost document recovered as empty. */
  load(): Promise<{ corrupt: boolean }>
  /** Idempotent readiness barrier; `load()` is the same promise. */
  ready(): Promise<void>
  /** Current snapshot. */
  snapshot(): MapStoreSnapshot
  /** Whether the document could not be read at startup and was reset. */
  corrupt(): boolean
  /** Absolute directory holding the document. */
  dataDir(): string
  /** Replace the whole document against a base revision (CAS). */
  commit(doc: MapState, baseRevision: number, writer: string): Promise<{ revision: number; doc: MapState }>
  /** Atomic read-modify-write used by the model tools; one persist per call. */
  apply<T>(
    mutate: (doc: MapState) => { doc: MapState; value: T },
    writer: string,
  ): Promise<{ revision: number; value: T; doc: MapState }>
}

/** One persisted envelope. */
interface MapEnvelope {
  readonly format: number
  readonly revision: number
  readonly updatedAt: string
  readonly writer: string
  readonly doc: unknown
}

/** Shape check that separates "a map document" from "garbage". */
function isDocumentLike(value: unknown): value is MapState {
  return isMapState(value)
    && typeof (value as { revision?: unknown }).revision === 'number'
}

/**
 * Validate and sanitize one document value coming from disk or the wire.
 * @param value - untrusted document value.
 * @param origin - diagnostic origin used in the error message.
 * @returns the normalized document (default space guaranteed).
 * @throws MapStoreError `INVALID` when the value is not a map document.
 */
export function normalizeDocument(value: unknown, origin: string): MapState {
  if (!isDocumentLike(value)) {
    throw new MapStoreError('INVALID', `${origin} is not a conversation-map document`)
  }
  const parsed = parseMapState(JSON.stringify(value))
  // `parseMapState` silently falls back to an empty map; treat a document that
  // declared rows but parsed to nothing as invalid instead of wiping the tree.
  const nodes = (value as { nodes?: unknown }).nodes
  if (Array.isArray(nodes) && nodes.length > 0 && parsed.nodes.length === 0) {
    throw new MapStoreError('INVALID', `${origin} lost its node rows during validation`)
  }
  return ensureDefaultSpace(parsed)
}

/**
 * Parse one stored envelope.
 * @param text - raw file content.
 * @returns the validated envelope with a normalized document.
 * @throws MapStoreError when the content is not a valid envelope.
 */
function parseEnvelope(text: string): MapEnvelope {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MapStoreError('INVALID', 'map document envelope is not an object')
  }
  const candidate = parsed as Partial<MapEnvelope>
  if (candidate.format !== ENVELOPE_FORMAT) {
    throw new MapStoreError('INVALID', `unsupported map document format ${String(candidate.format)}`)
  }
  if (typeof candidate.revision !== 'number' || !Number.isInteger(candidate.revision) || candidate.revision < 0) {
    throw new MapStoreError('INVALID', 'map document revision is not a non-negative integer')
  }
  if (typeof candidate.updatedAt !== 'string' || typeof candidate.writer !== 'string') {
    throw new MapStoreError('INVALID', 'map document metadata is malformed')
  }
  return {
    format: candidate.format,
    revision: candidate.revision,
    updatedAt: candidate.updatedAt,
    writer: candidate.writer,
    doc: normalizeDocument(candidate.doc, 'stored map document'),
  }
}

/**
 * Create one authoritative map store bound to a file path.
 * @param options - document path and size ceiling.
 * @returns the store surface.
 */
export function createMapFileStore(options: MapFileStoreOptions): MapFileStore {
  const filePath = options.filePath
  const maxDocBytes = options.maxDocBytes ?? MAX_DOC_BYTES
  const backupPath = backupFilePath(filePath)

  let state: MapStoreSnapshot = {
    revision: 0,
    updatedAt: '',
    doc: ensureDefaultSpace(emptyMap()),
  }
  let corrupt = false
  let tail: Promise<unknown> = Promise.resolve()
  let loaded: Promise<{ corrupt: boolean }> | undefined

  /** Serialize one task behind every previously queued task. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Read and validate one file. */
  async function readEnvelope(path: string): Promise<MapEnvelope> {
    const text = await readFile(path, 'utf8')
    return parseEnvelope(text)
  }

  /** Persist one already-normalized document; callers hold the write queue. */
  async function persist(doc: MapState, writer: string): Promise<number> {
    const revision = state.revision + 1
    const envelope: MapEnvelope = {
      format: ENVELOPE_FORMAT,
      revision,
      updatedAt: new Date().toISOString(),
      writer,
      doc,
    }
    const text = JSON.stringify(envelope)
    if (Buffer.byteLength(text, 'utf8') > maxDocBytes) {
      throw new MapStoreError('TOO_LARGE', `map document exceeds ${maxDocBytes} bytes`)
    }
    try {
      await mkdir(dirname(filePath), { recursive: true })
      // Keep the previous success as the backup. Missing previous file (first
      // write) is expected; any other copy failure must not lose the new write.
      await copyFile(filePath, backupPath).catch(() => undefined)
      const temporary = `${filePath}.tmp-${randomUUID()}`
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, filePath)
    } catch (error) {
      throw new MapStoreError('IO', `could not persist the map document: ${error instanceof Error ? error.message : String(error)}`)
    }
    state = { revision, updatedAt: envelope.updatedAt, doc }
    return revision
  }

  /** Whether a filesystem error means "this file does not exist yet". */
  function isMissing(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  }

  async function loadOnce(): Promise<{ corrupt: boolean }> {
    let primaryError: unknown
    try {
      const envelope = await readEnvelope(filePath)
      state = { revision: envelope.revision, updatedAt: envelope.updatedAt, doc: envelope.doc as MapState }
      return { corrupt: false }
    } catch (error) {
      primaryError = error
    }
    try {
      const envelope = await readEnvelope(backupPath)
      state = { revision: envelope.revision, updatedAt: envelope.updatedAt, doc: envelope.doc as MapState }
      corrupt = true
      // Keep the unreadable live file out of the way so the next commit does
      // not copy it over the good backup.
      await rename(filePath, `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        .catch(() => undefined)
      return { corrupt: true }
    } catch (backupError) {
      // A missing live file with no backup is simply a first run, not corruption.
      if (isMissing(primaryError) && isMissing(backupError)) return { corrupt: false }
      // Preserve the unreadable file for inspection instead of overwriting it.
      await rename(filePath, `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        .catch(() => undefined)
      console.error('conversation-map: could not read the Host map document', primaryError)
      state = { revision: 0, updatedAt: '', doc: ensureDefaultSpace(emptyMap()) }
      corrupt = true
      return { corrupt: true }
    }
  }

  return {
    load(): Promise<{ corrupt: boolean }> {
      loaded ??= loadOnce()
      return loaded
    },
    async ready(): Promise<void> {
      await (loaded ??= loadOnce())
    },
    snapshot(): MapStoreSnapshot {
      return state
    },
    corrupt(): boolean {
      return corrupt
    },
    dataDir(): string {
      return dirname(filePath)
    },
    async commit(doc: MapState, baseRevision: number, writer: string): Promise<{ revision: number; doc: MapState }> {
      await (loaded ??= loadOnce())
      const normalized = normalizeDocument(doc, 'submitted map document')
      return enqueue(async () => {
        if (baseRevision !== state.revision) {
          throw new MapStoreError('CONFLICT', `map document revision ${state.revision} does not match ${baseRevision}`, {
            revision: state.revision,
          })
        }
        const revision = await persist(normalized, writer)
        return { revision, doc: normalized }
      })
    },
    async apply<T>(
      mutate: (doc: MapState) => { doc: MapState; value: T },
      writer: string,
    ): Promise<{ revision: number; value: T; doc: MapState }> {
      await (loaded ??= loadOnce())
      return enqueue(async () => {
        const outcome = mutate(state.doc)
        const normalized = normalizeDocument(outcome.doc, 'mutated map document')
        const revision = await persist(normalized, writer)
        return { revision, value: outcome.value, doc: normalized }
      })
    },
  }
}
