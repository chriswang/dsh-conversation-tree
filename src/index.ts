/**
 * Host half of the conversation-map plugin bundle.
 *
 * The map's business document used to live only in the browser (localStorage),
 * which made it unreachable for model tools and for every other window. This
 * half now owns the authoritative document on disk, registers the model-facing
 * `map_*` tools that create and manage nodes, and exposes a small authenticated
 * RPC channel the browser half reads and writes through.
 *
 * The module deliberately imports only Node builtins and this project's own
 * modules: no DSH package is required at runtime, so the bundle keeps working
 * from a linked local checkout without a registry.
 */
import type { HostContextLike } from './host/context.js'
import { mapFilePath, hostDisabled } from './host/paths.js'
import { registerMapPromptSection } from './host/prompt.js'
import { registerMapRpc } from './host/rpc.js'
import { createMapFileStore } from './host/store.js'
import { registerMapTools } from './host/tools.js'

/** Plugin name as Cordis reports it in diagnostics. */
export const name = 'conversation-map'

/** The tool registry must exist before the model-facing tools are registered. */
export const inject = ['tools']

/**
 * Install the authoritative store, the model tools, the browser RPC channel, and
 * the prompt guidance. The `DSH_CONVERSATION_MAP_HOST=local` kill switch keeps
 * the Host half completely inert for a localStorage-only rollback.
 * @param ctx - Host plugin context the Loader provides.
 */
export function apply(ctx: HostContextLike): void {
  if (hostDisabled()) return
  const store = createMapFileStore({ filePath: mapFilePath() })
  // Warm the document asynchronously; readers await the readiness barrier.
  void store.load().catch((error: unknown) => {
    console.error('conversation-map: could not load the Host map document', error)
  })
  try {
    registerMapTools(ctx, store)
  } catch (error) {
    console.error('conversation-map: tool registration failed', error)
  }
  try {
    registerMapRpc(ctx, store)
  } catch (error) {
    console.error('conversation-map: RPC registration failed', error)
  }
  try {
    registerMapPromptSection(ctx)
  } catch (error) {
    console.error('conversation-map: prompt section registration failed', error)
  }
}
