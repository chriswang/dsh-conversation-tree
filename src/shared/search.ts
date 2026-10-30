/**
 * Search presentation model, shared by the browser half and the Host half.
 *
 * The model's `searchMap` answers *what matched* (nodes and conversation
 * titles). The Host's conversation index answers *which conversation bodies
 * matched* (`ContentSearchReply`). This module turns both into the flat item
 * list the 「搜索结果」 column draws: ranked hits, the context line that says
 * where a hit lives, and the snippet that says why it matched.
 *
 * Everything here is pure: no store, no DOM, no Node builtins. The Host half
 * imports only the types and the text helpers, so the two halves agree on the
 * snippet shape without sharing a runtime.
 */
import { findTextMatch, nodePath, type MapNode, type MapState, type SearchResults, type ThreadRef } from './model.js'

/** One plain-text span with the matched run isolated, ready for `<mark>`. */
export interface SearchSnippet {
  /** Text before the match; may start with an ellipsis when trimmed. */
  before: string
  /** The matched run, already case-preserving. */
  match: string
  /** Text after the match; may end with an ellipsis when trimmed. */
  after: string
}

/** One conversation whose **message bodies** matched, as the Host index reports it. */
export interface ContentSearchHit {
  sessionId: string
  /** How many messages matched (capped by the Host). */
  messages: number
  /** First match, already trimmed into a snippet; `null` when the hit is stale. */
  snippet: SearchSnippet | null
}

/** One progressive reply from the Host conversation-body index. */
export interface ContentSearchReply {
  /** Conversations with at least one body match, best first. */
  hits: ContentSearchHit[]
  /** Candidate conversations the index has covered so far. */
  scanned: number
  /** Candidate conversations the caller asked about. */
  total: number
  /**
   * Whether every candidate has been indexed. While `false` the browser keeps
   * polling, so a large session store fills in progressively instead of
   * blocking the first keystroke.
   */
  done: boolean
}

/** What the browser asks the Host to look for in conversation bodies. */
export interface ContentSearchRequest {
  /** Raw user input; shorter than two characters searches nothing. */
  query: string
  /** Conversations to search (the map's own index, already space-scoped). */
  sessionIds: string[]
  /** Test-only override for the per-call indexing budget, in milliseconds. */
  budgetMs?: number
}

/** How many characters of context are kept on each side of a match. */
export const SNIPPET_RADIUS = 42

/** Collapse whitespace so a snippet stays one readable line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Isolate one matched run plus a little readable context around it.
 * @param text - the source text (description or message body).
 * @param start - match start in `text`.
 * @param end - match end in `text`.
 * @param radius - characters kept on each side.
 * @returns the three-piece snippet.
 */
export function snippetAround(
  text: string,
  start: number,
  end: number,
  radius = SNIPPET_RADIUS,
): SearchSnippet {
  const from = Math.max(0, start - radius)
  const to = Math.min(text.length, end + radius)
  return {
    before: `${from > 0 ? '…' : ''}${collapse(text.slice(from, start))}`,
    match: collapse(text.slice(start, end)),
    after: `${collapse(text.slice(end, to))}${to < text.length ? '…' : ''}`,
  }
}

/** One node hit, already ranked and annotated for the result column. */
export interface SearchNodeItem {
  kind: 'node'
  /** Stable key for keyboard navigation and React lists. */
  key: string
  node: MapNode
  title: string
  /** Where the node lives: `工作区 / 上级 / …`. */
  context: string
  /** Why it matched, when the description carried the hit. */
  snippet: SearchSnippet | null
  /** Whether the node's title carried the query (ranks above description hits). */
  titleMatch: boolean
}

/** One conversation hit, already ranked and annotated. */
export interface SearchThreadItem {
  kind: 'thread'
  key: string
  thread: ThreadRef
  title: string
  /** Where the conversation lives: `工作区 / 节点路径` or the ungrouped label. */
  context: string
  /** Why it matched: a message-body snippet, or `null` for title hits. */
  snippet: SearchSnippet | null
  /** Whether the conversation title matched. */
  titleMatch: boolean
  /** Whether one of its messages matched. */
  bodyMatch: boolean
}

/** The flat result view: nodes first, then conversations, in navigation order. */
export interface SearchView {
  nodes: SearchNodeItem[]
  threads: SearchThreadItem[]
  /** `[...nodes, ...threads]`, the order ↑/↓ walks and Enter activates. */
  items: Array<SearchNodeItem | SearchThreadItem>
  /** Whether nothing matched at all. */
  empty: boolean
}

/** Localized context labels the search view composes its lines from. */
export interface SearchContextLabels {
  /** Label for conversations and topics that belong to no Workspace. */
  ungrouped: string
  /** Label used when a hit's conversation has no usable title. */
  untitled: string
  /** Fallback when a Workspace title is missing from the input map. */
  workspaceFallback: string
}

/** Injectable context the search view needs from the panel. */
export interface SearchViewInput {
  /** The map document (for node paths and conversation homes). */
  state: MapState
  /** The plain `searchMap` result for this query and space. */
  results: SearchResults
  /** Every indexed conversation in the searched space (resolves body hits). */
  candidateThreads: readonly ThreadRef[]
  /** Workspace id → display title, for the context line. */
  workspaceTitles: Readonly<Record<string, string>>
  /** Body hits by session id, when the Host index has answered. */
  contentHits?: ReadonlyMap<string, ContentSearchHit>
  /** Localized labels for the context lines; the render site owns the dictionary. */
  labels: SearchContextLabels
}

/** Newest activity first, for equal-rank hits. */
function byActivity(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

/** Build the `工作区 / 上级 / …` line for one node hit. */
function nodeContext(
  state: MapState,
  node: MapNode,
  workspaceTitles: Readonly<Record<string, string>>,
  labels: SearchContextLabels,
): string {
  const workspace = node.workspaceId === null || node.workspaceId === undefined
    ? labels.ungrouped
    : workspaceTitles[node.workspaceId] ?? labels.workspaceFallback
  const ancestors = nodePath(state, node.id).slice(0, -1).map(pathNode => pathNode.title)
  return ancestors.length === 0 ? workspace : `${workspace} / ${ancestors.join(' / ')}`
}

/** Build the `工作区 / 节点路径` line for one conversation hit. */
function threadContext(
  state: MapState,
  thread: ThreadRef,
  workspaceTitles: Readonly<Record<string, string>>,
  labels: SearchContextLabels,
): string {
  const workspace = thread.workspaceId === null || thread.workspaceId === undefined
    ? labels.ungrouped
    : workspaceTitles[thread.workspaceId] ?? labels.workspaceFallback
  if (thread.nodeId === null) return workspace
  const path = nodePath(state, thread.nodeId).map(pathNode => pathNode.title)
  return path.length === 0 ? workspace : `${workspace} / ${path.join(' / ')}`
}

/**
 * Turn the model's matches and the Host's body hits into the result column's
 * ranked item list.
 *
 * Ranking is deliberately simple and stable: title hits before description or
 * body hits, then newest activity first. A body hit that already appears under
 * a matched node row (same node) is dropped from the flat list, exactly like
 * the title-only behaviour it replaces.
 * @param input - the map, the model's matches, and the Host's body hits.
 * @returns the ranked nodes, ranked conversations, and their navigation order.
 */
export function buildSearchView(input: SearchViewInput): SearchView {
  const { state, results, candidateThreads, workspaceTitles, labels } = input
  const contentHits = input.contentHits ?? new Map<string, ContentSearchHit>()

  const nodes: SearchNodeItem[] = results.nodes.map((hit): SearchNodeItem => ({
    kind: 'node',
    key: hit.node.id,
    node: hit.node,
    title: hit.node.title,
    context: nodeContext(state, hit.node, workspaceTitles, labels),
    snippet: hit.descriptionMatch === null
      ? null
      : snippetAround(hit.node.description, hit.descriptionMatch.start, hit.descriptionMatch.end),
    titleMatch: hit.titleMatch,
  })).sort((left, right) => {
    if (left.titleMatch !== right.titleMatch) return left.titleMatch ? -1 : 1
    return byActivity(left.node, right.node) || left.node.title.localeCompare(right.node.title)
  })

  const matchedNodeIds = new Set(nodes.map(item => item.node.id))
  const titleMatchedThreads = new Map<string, ThreadRef>()
  for (const hit of results.threads) {
    titleMatchedThreads.set(hit.thread.sessionId, hit.thread)
  }

  const candidates = new Map(candidateThreads.map(thread => [thread.sessionId, thread]))
  const threads: SearchThreadItem[] = []
  const seen = new Set<string>()

  /** One conversation row, assembled from whichever source matched it. */
  const threadItem = (thread: ThreadRef, titleMatch: boolean, body: ContentSearchHit | undefined): SearchThreadItem => ({
    kind: 'thread',
    key: thread.sessionId,
    thread,
    title: thread.title.trim() === '' ? labels.untitled : thread.title,
    context: threadContext(state, thread, workspaceTitles, labels),
    snippet: body?.snippet ?? null,
    titleMatch,
    bodyMatch: body !== undefined,
  })

  for (const thread of titleMatchedThreads.values()) {
    // A conversation already shown underneath its matched node row would only
    // repeat itself here.
    if (thread.nodeId !== null && matchedNodeIds.has(thread.nodeId)) continue
    seen.add(thread.sessionId)
    threads.push(threadItem(thread, true, contentHits.get(thread.sessionId)))
  }
  for (const hit of contentHits.values()) {
    if (seen.has(hit.sessionId)) continue
    const thread = candidates.get(hit.sessionId)
    if (thread === undefined) continue
    if (thread.nodeId !== null && matchedNodeIds.has(thread.nodeId)) continue
    seen.add(hit.sessionId)
    threads.push(threadItem(thread, false, hit))
  }
  threads.sort((left, right) => {
    if (left.titleMatch !== right.titleMatch) return left.titleMatch ? -1 : 1
    return byActivity(left.thread, right.thread) || left.title.localeCompare(right.title)
  })

  const items: Array<SearchNodeItem | SearchThreadItem> = [...nodes, ...threads]
  return { nodes, threads, items, empty: items.length === 0 }
}

/**
 * The first case-insensitive occurrence of a snippet's match in a title.
 *
 * Titles are short; this reuses {@link findTextMatch} so highlighting and
 * ranking agree.
 * @param text - title text.
 * @param query - raw query.
 * @returns the match range, or `null`.
 */
export function titleMatchRange(text: string, query: string): { start: number; end: number } | null {
  return findTextMatch(text, query)
}

/** Re-export so both halves build snippets from the same helper. */
export { snippetAround as buildSnippet }

/** Re-export so callers can locate a match without importing the model twice. */
export { findTextMatch }
