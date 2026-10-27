/**
 * Narrow Host-side context and service surfaces the plugin consumes.
 *
 * The plugin deliberately carries no runtime dependency on DSH packages: the
 * Loader hands it a Cordis context, and the few services it uses are reached by
 * their stable keys through hand-written shapes. Type-only imports are erased,
 * so `lib/index.js` imports nothing but Node builtins and this project's own
 * modules — which keeps the profile installer's peer-compatibility check and
 * the local linked-checkout resolution trivially satisfied.
 */

/** One model-facing tool definition position (structurally `ToolDefinition`). */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ReadonlyArray<Record<string, unknown>>
  }
  readonly isConcurrencySafe?: (args: unknown) => boolean
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>
}

/** The agent identity a tool execution runs for (subset used here). */
export interface ToolExecLike {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session?: {
      readonly id?: string
      readonly header?: { readonly cwd?: string }
    }
  }
}

/** `ctx.tools` subset. */
export interface ToolsServiceLike {
  register(definition: ToolDefinitionLike): () => void
}

/** `ctx.systemPrompt` subset. */
export interface SystemPromptLike {
  section(section: { name: string; order: number; text: string }): () => void
}

/** One Workspace row as the registry reports it. */
export interface WorkspaceLike {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** `ctx.workspaceRegistry` subset (feature-probed, may be absent). */
export interface WorkspaceRegistryLike {
  list?(): WorkspaceLike[]
  get?(id: string): WorkspaceLike | undefined
  resolveByPath?(path: string): WorkspaceLike | undefined
}

/** One logical RPC handler result (the Connection result envelope). */
export type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: object } }

/** One exact Fetch route in the Connection registry. */
export interface ConnectionFetchRouteLike {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response>
}

/** `ctx.connection.fetch` subset. */
export interface ConnectionFetchLike {
  register(route: ConnectionFetchRouteLike): () => void
}

/** `ctx.connection` subset. */
export interface ConnectionLike {
  readonly fetch?: ConnectionFetchLike
}

/** Host context shape this plugin relies on. */
export interface HostContextLike {
  /** The model-facing tool registry (injected, so always present here). */
  readonly tools: ToolsServiceLike
  get(name: string): unknown
  inject(deps: readonly string[], callback: (ctx: HostContextLike) => void): unknown
}
