/// <reference types="node" />
/**
 * Plain message text extracted from the Host's persisted Session logs.
 *
 * The Host's conversation-body search indexes the *messages a person and the
 * assistant actually wrote*, not the transport around them. A Session is
 * persisted as an append-only JSONL log (`session.v<version>.jsonl`, optionally
 * `.zstd`-compressed). The compressed variant is a concatenation of independent
 * Zstandard frames — one frame per durable batch — so a single
 * `zstdDecompressSync` call only ever returns the first frame; the frame
 * boundaries have to be located structurally first, and a torn final frame has
 * to be dropped rather than allowed to fail the whole read.
 *
 * This module owns exactly that format knowledge: bytes in, message strings
 * out. It has no index, cache, budget, or RPC, which is what lets the search
 * index be exercised over a temporary sessions root in unit tests.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

/** Longest single message kept; a runaway paste must not dominate the index. */
export const MAX_MESSAGE_CHARS = 20_000

/** Most messages kept per Session; the tail of a very long conversation is dropped. */
export const MAX_MESSAGES_PER_SESSION = 5_000

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  /** Complete frames in file order. */
  frames: ZstdFrameRange[]
  /** Start of an incomplete or unreadable final frame, when EOF interrupts one. */
  tornStart?: number
}

/** Zstandard frame magic number (little-endian bytes `28 B5 2F FD`). */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * The zstd decompressor this Node runtime exposes.
 *
 * The project typechecks against an older `@types/node` that predates the zstd
 * APIs, so the function is looked up through a narrow cast instead of importing
 * a declaration that does not exist yet. A runtime without zstd simply yields
 * no text for compressed logs instead of crashing the Host.
 */
const zstdDecompress: ((input: Buffer) => Buffer) | undefined =
  (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync

/**
 * Locate the complete Zstandard frames in a concatenated stream.
 *
 * The walk is structural only — frame header, block headers, optional checksum —
 * so it costs a scan of the bytes and no decompression. It is deliberately
 * tolerant: persistence appends frame by frame, so an interrupted write leaves
 * a torn final frame, and a corrupt byte anywhere truncates the readable tail.
 * Both cases return the frames that were complete before the damage instead of
 * throwing, because a partially readable conversation is still worth indexing.
 * @param buffer - the bytes currently present in the session artifact.
 * @returns complete frame ranges plus the start of an unreadable final frame.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    // A frame starts with the 4-byte magic; anything shorter is a torn tail.
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4

    // Frame header descriptor: content-size flag, single-segment flag, checksum
    // flag, and dictionary id width. Bits 3 and 4 are reserved and must be zero.
    if (buffer.length - offset < 1) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return { frames, tornStart: start }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    // Window descriptor (only when not single-segment), then dictionary id, then
    // content size. Skipped without interpretation: only their length matters.
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      // Each block header is 3 bytes little-endian: last-block bit, 2-bit type,
      // 21-bit size. Frame content ends with the last block (plus optional
      // 4-byte checksum).
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return { frames, tornStart: start }
      // A raw block carries its size verbatim; an RLE block carries one byte.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return { frames }
}

/** One Session log file name split into its generation and encoding. */
interface SessionLogName {
  /** Format generation (`v<version>`; the unversioned original is generation 0). */
  version: number
  /** Whether the artifact is Zstandard-compressed. */
  zstd: boolean
  /** File name as found in the Session directory. */
  name: string
}

/** Canonical Session log file name; temporary and noncanonical names never match. */
const SESSION_LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * Read one Session log file name, when it is a canonical generation.
 * @param name - one directory entry name.
 * @returns its generation and encoding, or undefined for anything else.
 */
function sessionLogName(name: string): SessionLogName | undefined {
  const match = SESSION_LOG_NAME.exec(name)
  if (match === null) return undefined
  return {
    version: match[1] === undefined ? 0 : Number(match[1]),
    zstd: match[2] !== undefined,
    name,
  }
}

/**
 * Select the newest readable log artifact inside one Session directory.
 *
 * The persistence backend keeps historical generations side by side; the
 * highest version is the current log, and at equal version the compressed copy
 * wins because that is the configured encoding. Unreadable directories yield
 * undefined rather than throwing — a Session directory can disappear between
 * listing and reading.
 * @param directory - one Session directory (holding `session.v*.jsonl[.zstd]`).
 * @returns the absolute file path to read, or undefined when none exists.
 */
export function selectSessionLogFile(directory: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return undefined
  }
  let best: SessionLogName | undefined
  for (const name of names) {
    const candidate = sessionLogName(name)
    if (candidate === undefined) continue
    if (
      best === undefined
      || candidate.version > best.version
      || (candidate.version === best.version && candidate.zstd && !best.zstd)
    ) {
      best = candidate
    }
  }
  return best === undefined ? undefined : join(directory, best.name)
}

/** A JSON object read from one log line, treated as untrusted bytes. */
type JsonRecord = Record<string, unknown>

/** Narrow one parsed JSON value to a record. */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined
}

/**
 * Collect the human-visible text of one persisted message record.
 *
 * Two record types carry conversation text: `user/message` (whose `data.content`
 * holds the typed parts and whose `data.source.kind` says who said it) and
 * `assistant/message` (whose text sits in `data.message.content`, the same shape
 * the model API returns). Everything else in the log — system and developer
 * prompts, tool calls and results, titles, compaction bookkeeping — is
 * transport, not conversation, and is skipped here. The source-kind filter is
 * the important one: DSH injects time-context, skill catalogs, runtime context,
 * and subagent notices through `user/message` records too, and none of them are
 * words the person wrote.
 * @param value - one parsed log line.
 * @returns the joined text parts, or undefined when the record is not a message.
 */
function messageRecordText(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const type = record.type
  if (type !== 'user/message' && type !== 'assistant/message') return undefined
  const data = asRecord(record.data)
  if (data === undefined) return undefined
  // Only real user input: injected context shares this record type but not the kind.
  if (type === 'user/message') {
    const source = asRecord(data.source)
    if (source?.kind !== 'user') return undefined
  }
  // Log versions differ on where the model message lives: the current v4 format
  // nests it under `data.message`, while an earlier plain shape keeps `content`
  // directly on `data`. Accept both so an old log still contributes its text.
  const nestedMessage = asRecord(data.message)
  const content = type === 'assistant/message'
    ? (nestedMessage?.content ?? data.content)
    : data.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const candidate = asRecord(part)
    if (candidate?.type !== 'text') continue
    if (typeof candidate.text !== 'string') continue
    parts.push(candidate.text)
  }
  const joined = parts.join('\n').trim()
  if (joined === '') return undefined
  return joined.slice(0, MAX_MESSAGE_CHARS)
}

/**
 * Append the messages of one plaintext chunk, respecting the per-Session cap.
 * @param text - decoded JSONL bytes (one record per line, trailing newline allowed).
 * @param messages - collector, appended in log order.
 */
function appendJsonlMessages(text: string, messages: string[]): void {
  for (const line of text.split('\n')) {
    if (messages.length >= MAX_MESSAGES_PER_SESSION) return
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A torn or corrupt line is exactly the case this reader must survive.
      continue
    }
    const message = messageRecordText(parsed)
    if (message !== undefined) messages.push(message)
  }
}

/**
 * Parse the plaintext of one Zstandard stream into its messages.
 *
 * Each frame is decoded independently and its bytes are fed through a small
 * carry buffer, because a batch boundary is only line-aligned by convention —
 * a frame that ends mid-line must not split a JSON record. Frames that fail to
 * decode are skipped individually.
 * @param buffer - the concatenated frame stream.
 * @returns the extracted message texts, in log order.
 */
function zstdMessages(buffer: Buffer): string[] {
  const messages: string[] = []
  let carry: Buffer = Buffer.alloc(0)
  for (const frame of scanZstdFrames(buffer).frames) {
    if (messages.length >= MAX_MESSAGES_PER_SESSION) break
    if (zstdDecompress === undefined) break
    let plain: Buffer
    try {
      plain = zstdDecompress(buffer.subarray(frame.start, frame.end))
    } catch {
      continue
    }
    const combined = carry.length === 0 ? plain : Buffer.concat([carry, plain])
    // 0x0A can never appear inside a multi-byte UTF-8 sequence, so splitting on
    // the last newline byte is safe without decoding the carry yet.
    const lastBreak = combined.lastIndexOf(0x0a)
    if (lastBreak === -1) {
      carry = combined
      continue
    }
    appendJsonlMessages(combined.subarray(0, lastBreak + 1).toString('utf8'), messages)
    carry = combined.subarray(lastBreak + 1)
  }
  if (carry.length > 0 && messages.length < MAX_MESSAGES_PER_SESSION) {
    appendJsonlMessages(carry.toString('utf8'), messages)
  }
  return messages
}

/**
 * Parse a plaintext JSONL session log into its messages.
 * @param buffer - the uncompressed log bytes.
 * @returns the extracted message texts, in log order.
 */
function plaintextMessages(buffer: Buffer): string[] {
  const messages: string[] = []
  appendJsonlMessages(buffer.toString('utf8'), messages)
  return messages
}

/**
 * Extract the conversation text of one persisted Session log.
 *
 * The suffix decides the physical encoding; the caller (the search index) has
 * already selected the current generation of the file.
 * @param buffer - the complete bytes of one log artifact.
 * @param fileName - the artifact's file name (or path); its suffix picks the decoder.
 * @returns the message texts a person and the assistant wrote, in log order.
 */
export function sessionMessagesFromBuffer(buffer: Buffer, fileName: string): string[] {
  return fileName.toLowerCase().endsWith('.zstd') ? zstdMessages(buffer) : plaintextMessages(buffer)
}

/**
 * Read and extract one Session log file from disk.
 *
 * Reading errors are the caller's to handle: the search index records a missing
 * or unreadable log as an empty conversation rather than retrying it.
 * @param filePath - the log artifact selected by {@link selectSessionLogFile}.
 * @returns the message texts a person and the assistant wrote, in log order.
 */
export function sessionMessagesFromFile(filePath: string): string[] {
  return sessionMessagesFromBuffer(readFileSync(filePath), filePath)
}
