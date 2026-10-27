/**
 * Error vocabulary of the Host map store and the model tools.
 *
 * The store raises {@link MapStoreError} for transport-level failures (CAS
 * conflict, invalid payload, oversized document, I/O). The tools raise
 * {@link MapToolError} for tool-level failures the model should read (missing
 * workspace, too many nodes). The shared model raises its own `MapError`.
 */

/** Transport-level failure codes of the Host store. */
export type MapStoreErrorCode = 'CONFLICT' | 'INVALID' | 'TOO_LARGE' | 'IO'

/** One Host-store failure, carrying the current revision on a conflict. */
export class MapStoreError extends Error {
  constructor(
    readonly code: MapStoreErrorCode,
    message: string,
    readonly details?: { readonly revision?: number },
  ) {
    super(message)
    this.name = 'MapStoreError'
  }
}

/** One tool-level failure addressed to the model. */
export class MapToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MapToolError'
  }
}

/**
 * Reduce an unknown failure to the tool result contract.
 * @param error - the thrown value.
 * @returns a canonical failure value for the model.
 */
export function mapToolFailure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof MapToolError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof MapStoreError) {
    const code = error.code === 'TOO_LARGE'
      ? 'TOO_LARGE'
      : error.code === 'IO' ? 'INTERNAL' : 'INTERNAL'
    return { ok: false, code, message: error.message }
  }
  // The shared model raises MapError, whose `code` is the stable vocabulary the
  // Web UI already displays; keep it verbatim for the model.
  const candidate = error as { readonly code?: unknown; readonly message?: unknown }
  if (typeof candidate.code === 'string' && candidate.code !== '') {
    return { ok: false, code: candidate.code, message: typeof candidate.message === 'string' ? candidate.message : candidate.code }
  }
  return { ok: false, code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}
