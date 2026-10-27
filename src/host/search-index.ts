/// <reference types="node" />
/**
 * Conversation-body search over the Host's persisted Session logs.
 *
 * The map's own search answers *what matched* in node titles and conversation
 * titles. This index answers the other half of the question: *which conversations
 * said it*. It walks the session store once to learn where each Session's log
 * lives, extracts its human-visible message text (see `session-text.ts`), and
 * matches the query against those messages.
 *
 * A full user store is far too large to read on one keystroke — the verification
 * run on a real store measured ~136 MB of compressed logs across 121 candidates,
 * about 8 s of decompression — so the index is progressive and budgeted: every
 * call spends at most `budgetMs` reading not-yet-covered conversations, reports
 * how much of the candidate set is covered, and the browser keeps polling until
 * `done`. The same cache makes a repeat query cheap, because only a Session whose
 * size or mtime moved is read again.
 *
 * Everything here is synchronous: the Host RPC dispatcher already runs on its own
 * turn, and a bounded synchronous pass keeps the progress accounting simple.
 */
import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { findTextMatch } from '../shared/model.js'
import {
  snippetAround,
  type ContentSearchHit,
  type ContentSearchReply,
  type ContentSearchRequest,
} from '../shared/search.js'
import { selectSessionLogFile, sessionMessagesFromFile } from './session-text.js'

/** Default per-call indexing budget. */
export const DEFAULT_SEARCH_BUDGET_MS = 250

/** Upper bound on the per-call indexing budget, whatever a caller asks for. */
export const MAX_SEARCH_BUDGET_MS = 2_000

/** Most candidates one request may name; the browser sends its whole index. */
export const MAX_CONTENT_CANDIDATES = 500

/** Most conversation hits one reply may carry. */
export const MAX_CONTENT_HITS = 40

/** How many matching messages a hit reports at most. */
export const MAX_MATCHED_MESSAGES = 99

/** How long the Session-id → log-path listing is reused before it is rebuilt. */
export const SESSION_FILE_INDEX_TTL_MS = 10_000

/** Hooks a caller (or a test) can inject. */
export interface ContentSearchIndexOptions {
  /** Directory holding `<project>/<session-id>/session.v*.jsonl[.zstd]`. */
  sessionsRoot: string
  /** Default per-call indexing budget; a request may override it. */
  budgetMs?: number
  /** Clock override, so tests can drive the budget without waiting. */
  now?: () => number
}

/** The progressive conversation-body index. */
export interface ContentSearchIndex {
  /**
   * Index what the budget allows, then answer the query over everything indexed
   * so far — including conversations covered by earlier calls.
   * @param request - query, candidate conversations, optional budget override.
   * @returns matching conversations plus coverage progress.
   */
  search(request: ContentSearchRequest): ContentSearchReply
}

/** One indexed message: original text plus its pre-folded form for matching. */
interface IndexedMessage {
  text: string
  lower: string
}

/** One cached Session body. */
interface SessionTextEntry {
  /** Log path the entry was built from; undefined means "no log found". */
  path: string | undefined
  /** Log size in bytes at read time. */
  size: number
  /** Log mtime in milliseconds at read time. */
  mtimeMs: number
  /** Extracted message bodies in log order. */
  messages: IndexedMessage[]
  /** File-index build stamp the entry's path lookup belongs to. */
  lookupAt: number
}

/** The cached Session-id → log-path listing. */
interface SessionFileIndex {
  byId: Map<string, string>
  builtAt: number
}

/** One Session that phase A found stale and phase B should read. */
interface PendingSession {
  id: string
  path: string
  size: number
  mtimeMs: number
}

/**
 * Build the Session-id → log-path listing for one sessions root.
 *
 * The layout is `<root>/<project-key>/<session-id>/session.v<version>.jsonl[.zstd]`,
 * so one level of project directories and one level of Session directories is
 * enough; the log file itself is picked by generation inside the Session
 * directory. Any unreadable directory is skipped: the listing is an optimisation,
 * and a Session the listing misses is simply reported as having no log.
 * @param root - the sessions root (`$DSH_HOME/sessions`).
 * @returns Session id to absolute log path.
 */
function listSessionLogs(root: string): Map<string, string> {
  const byId = new Map<string, string>()
  let projects: Dirent[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return byId
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let sessions: Dirent[]
    try {
      sessions = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = selectSessionLogFile(join(projectPath, session.name))
      if (file !== undefined) byId.set(session.name, file)
    }
  }
  return byId
}

/** Bound one budget value to the supported range. */
function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SEARCH_BUDGET_MS
  return Math.min(Math.max(0, Math.trunc(value)), MAX_SEARCH_BUDGET_MS)
}

/**
 * Deduplicate, filter, and cap the candidate conversation ids.
 * @param sessionIds - ids as the caller sent them (untrusted at the RPC edge).
 * @returns candidate ids in caller order, at most {@link MAX_CONTENT_CANDIDATES}.
 */
function candidateIds(sessionIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of sessionIds) {
    if (typeof id !== 'string' || id === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_CONTENT_CANDIDATES) break
  }
  return ids
}

/**
 * Create one conversation-body index over a sessions root.
 *
 * The returned index is stateful and meant to be shared for the life of the Host
 * process: its caches are what make progressive search and re-querying cheap.
 * @param options - sessions root, default budget, and optional clock.
 * @returns the index facade with one synchronous `search` entry point.
 */
export function createContentSearchIndex(options: ContentSearchIndexOptions): ContentSearchIndex {
  const root = options.sessionsRoot
  const defaultBudget = clampBudget(options.budgetMs ?? DEFAULT_SEARCH_BUDGET_MS)
  const now = options.now ?? (() => Date.now())

  /** Session body cache, keyed by session id. */
  const sessions = new Map<string, SessionTextEntry>()
  /** Listing of the sessions root; rebuilt when older than the TTL. */
  let listing: SessionFileIndex | undefined

  /** Current listing, rebuilding it when the TTL expired. */
  function fileIndex(at: number): SessionFileIndex {
    if (listing !== undefined && at - listing.builtAt <= SESSION_FILE_INDEX_TTL_MS) return listing
    listing = { byId: listSessionLogs(root), builtAt: at }
    return listing
  }

  /** Record one Session as having no readable log. */
  function emptyEntry(index: SessionFileIndex): SessionTextEntry {
    return { path: undefined, size: -1, mtimeMs: -1, messages: [], lookupAt: index.builtAt }
  }

  /**
   * Resolve one candidate id to its log path.
   *
   * Newer Session directories carry the catalog's `session-` prefix, but older
   * logs in the same store use the bare id, and a catalog id always carries the
   * prefix. Try the exact name first, then both normalisations, so a body hit is
   * never lost to a naming difference between two generations of the store.
   * @param index - the current listing.
   * @param id - candidate conversation id.
   * @returns the absolute log path, when the store holds one.
   */
  function resolvePath(index: SessionFileIndex, id: string): string | undefined {
    const direct = index.byId.get(id)
    if (direct !== undefined) return direct
    const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id
    const prefixed = stripped === id ? `session-${id}` : stripped
    return index.byId.get(prefixed) ?? index.byId.get(stripped)
  }

  /**
   * Phase A: decide whether one candidate is already covered or must be read.
   *
   * A candidate is covered when the cache entry was built from the current path
   * and the log's size and mtime are unchanged. A missing log is cached as empty
   * and is only looked up again after the listing itself was rebuilt, so a
   * session that never persists cannot cause a retry on every keystroke.
   * @returns true when the candidate is covered, false when it was queued.
   */
  function probe(id: string, index: SessionFileIndex, pending: PendingSession[]): boolean {
    const cached = sessions.get(id)
    const path = resolvePath(index, id)
    if (path === undefined) {
      if (cached === undefined || cached.path !== undefined || cached.lookupAt !== index.builtAt) {
        sessions.set(id, emptyEntry(index))
      }
      return true
    }
    let size: number
    let mtimeMs: number
    try {
      const stat = statSync(path)
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      sessions.set(id, emptyEntry(index))
      return true
    }
    if (cached !== undefined && cached.path === path && cached.size === size && cached.mtimeMs === mtimeMs) {
      return true
    }
    pending.push({ id, path, size, mtimeMs })
    return false
  }

  /**
   * Phase B: read one queued Session and cache its message bodies.
   *
   * A log that vanishes or fails to decode is cached as an empty conversation:
   * the alternative is re-reading the same broken file on every poll.
   */
  function read(candidate: PendingSession, index: SessionFileIndex): void {
    let messages: IndexedMessage[] = []
    try {
      messages = sessionMessagesFromFile(candidate.path).map(text => ({
        text,
        lower: text.toLocaleLowerCase(),
      }))
    } catch {
      messages = []
    }
    sessions.set(candidate.id, {
      path: candidate.path,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      messages,
      lookupAt: index.builtAt,
    })
  }

  /**
   * Match the query against every covered candidate, best first.
   *
   * Matching is the same case-insensitive substring rule the map's own search
   * uses (`findTextMatch`), and the snippet is built by the shared
   * `snippetAround`, so a body hit highlights exactly like a description hit.
   * @param ids - candidate ids in caller order.
   * @param query - the trimmed query, at least two characters.
   * @returns hits ranked by matched-message count, then session id.
   */
  function collectHits(ids: readonly string[], query: string): ContentSearchHit[] {
    const needle = query.toLocaleLowerCase()
    const hits: ContentSearchHit[] = []
    for (const id of ids) {
      const entry = sessions.get(id)
      if (entry === undefined) continue
      let matched = 0
      let first: IndexedMessage | undefined
      for (const message of entry.messages) {
        if (!message.lower.includes(needle)) continue
        matched += 1
        if (first === undefined) first = message
      }
      if (matched === 0 || first === undefined) continue
      const range = findTextMatch(first.text, query)
      hits.push({
        sessionId: id,
        messages: Math.min(matched, MAX_MATCHED_MESSAGES),
        snippet: range === null ? null : snippetAround(first.text, range.start, range.end),
      })
    }
    hits.sort((left, right) => {
      if (left.messages !== right.messages) return right.messages - left.messages
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    })
    return hits.slice(0, MAX_CONTENT_HITS)
  }

  /** One budgeted pass: cover what fits, then answer over everything covered. */
  function search(request: ContentSearchRequest): ContentSearchReply {
    const startedAt = now()
    const index = fileIndex(startedAt)
    const ids = candidateIds(request.sessionIds)
    const budget = request.budgetMs === undefined ? defaultBudget : clampBudget(request.budgetMs)
    const deadline = startedAt + budget

    const pending: PendingSession[] = []
    let covered = 0
    for (const id of ids) {
      if (probe(id, index, pending)) covered += 1
    }

    // Always read at least one queued Session: a zero budget must still make
    // progress between polls, or `done` could never become true.
    let processed = 0
    for (const candidate of pending) {
      if (processed > 0 && now() >= deadline) break
      read(candidate, index)
      processed += 1
    }

    const scanned = covered + processed
    const query = request.query.trim()
    return {
      hits: query.length < 2 ? [] : collectHits(ids, query),
      scanned,
      total: ids.length,
      done: scanned === ids.length,
    }
  }

  return { search }
}
