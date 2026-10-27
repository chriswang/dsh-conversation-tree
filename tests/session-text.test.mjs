/**
 * Behavior tests for reading one persisted Session log as plain message text.
 *
 * The reader owns the on-disk format boundary: a concatenated Zstandard frame
 * stream (or a plaintext JSONL variant), torn tails, and the record types that
 * are conversation versus transport. Every fixture below is written into a
 * temporary directory, so the tests never depend on a real session store.
 */
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES_PER_SESSION,
  scanZstdFrames,
  selectSessionLogFile,
  sessionMessagesFromBuffer,
  sessionMessagesFromFile,
} from '../lib/host-session-text.js'

/** The persisted Session header (not a message). */
const HEADER = {
  type: 'session',
  version: 4,
  id: 'session-11111111-2222-3333-4444-555555555555',
  createdAt: 1_700_000_000_000,
  isSeeded: false,
  delegationDepth: 0,
}

/** One real user message with the given text parts. */
function userRecord(parts) {
  return {
    type: 'user/message',
    seq: 1,
    time: 1_700_000_000_001,
    data: {
      role: 'user',
      id: 'message-user',
      content: parts.map(part => (typeof part === 'string' ? { type: 'text', text: part } : part)),
      source: { kind: 'user', rpcId: 'rpc', clientTimeZone: 'Asia/Shanghai' },
    },
  }
}

/** One injected `user/message` that is not something the person typed. */
function injectedRecord(kind, text) {
  return {
    type: 'user/message',
    seq: 2,
    time: 1_700_000_000_002,
    data: { content: [{ type: 'text', text }], source: { kind } },
  }
}

/** One assistant message in the current v4 shape (`data.message.content`). */
function assistantRecord(content) {
  return {
    type: 'assistant/message',
    seq: 3,
    time: 1_700_000_000_003,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content },
      usage: {},
      stream: false,
    },
  }
}

/** One assistant message in an earlier shape (`data.content` directly). */
function legacyAssistantRecord(text) {
  return {
    type: 'assistant/message',
    seq: 4,
    time: 1_700_000_000_004,
    data: { content: [{ type: 'text', text }] },
  }
}

/** One non-conversation record family that must never contribute text. */
const TRANSPORT_RECORDS = [
  { type: 'system/message', seq: 5, data: { message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] } } },
  { type: 'developer/message', seq: 6, data: { message: { role: 'developer', content: [{ type: 'text', text: 'DEVELOPER NOTE' }] } } },
  { type: 'tool/call', seq: 7, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: { command: 'ls' } } },
  { type: 'tool/result', seq: 8, data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'TOOL OUTPUT' }] } } },
  { type: 'session/title', seq: 9, data: { title: 'TITLE TEXT', messageSeqs: [1] } },
]

/** The fixture log used by most cases, in durable append order. */
const FIXTURE_RECORDS = [
  HEADER,
  userRecord([' 你好，帮我整理任务 \n']),
  injectedRecord('time-context', 'TIME CONTEXT 2026-01-01'),
  injectedRecord('runtime-context', 'RUNTIME CONTEXT'),
  injectedRecord('skill-catalog', 'SKILL CATALOG'),
  ...TRANSPORT_RECORDS,
  assistantRecord([
    { type: 'reasoning', text: 'INTERNAL REASONING' },
    { type: 'tool-call', callId: 'call-1', name: 'bash', arguments: {} },
    { type: 'text', text: '收到，我来整理。' },
  ]),
  legacyAssistantRecord('旧的助手格式'),
  userRecord(['第一段', { type: 'image', data: 'base64' }, '第二段']),
]

/** The messages the fixture should yield, in order. */
const FIXTURE_MESSAGES = [
  '你好，帮我整理任务',
  '收到，我来整理。',
  '旧的助手格式',
  '第一段\n第二段',
]

/**
 * Compress each record into its own Zstandard frame and concatenate them, the
 * way the persistence backend appends durable batches.
 * @param {ReadonlyArray<unknown>} records - records in append order.
 * @returns {Buffer} the concatenated frame stream.
 */
function frameStream(records) {
  const frames = records.map(record => zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`)))
  return Buffer.concat(frames)
}

/** Encode records as a plaintext JSONL log. */
function plaintextLog(records) {
  return Buffer.from(records.map(record => `${JSON.stringify(record)}\n`).join(''))
}

/** Run one body inside an isolated temporary directory. */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-map-session-text-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a concatenated zstd log yields only real user and assistant text', () => {
  const messages = sessionMessagesFromBuffer(frameStream(FIXTURE_RECORDS), 'session.v4.jsonl.zstd')
  assert.deepEqual(messages, FIXTURE_MESSAGES)
})

test('a plaintext jsonl log yields the same messages', () => {
  const messages = sessionMessagesFromBuffer(plaintextLog(FIXTURE_RECORDS), 'session.v4.jsonl')
  assert.deepEqual(messages, FIXTURE_MESSAGES)
})

test('sessionMessagesFromFile reads the selected artifact from disk', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, frameStream(FIXTURE_RECORDS))
    assert.deepEqual(sessionMessagesFromFile(file), FIXTURE_MESSAGES)
  })
})

test('a torn final frame is dropped without losing the complete frames', () => {
  const complete = frameStream(FIXTURE_RECORDS.slice(0, 2))
  const third = frameStream([FIXTURE_RECORDS[2]])
  // Cut the last frame in half: the bytes no longer describe a complete frame.
  const torn = Buffer.concat([complete, third.subarray(0, Math.floor(third.length / 2))])

  const scan = scanZstdFrames(torn)
  assert.equal(scan.frames.length, 2)
  assert.equal(typeof scan.tornStart, 'number')
  assert.deepEqual(sessionMessagesFromBuffer(torn, 'session.v4.jsonl.zstd'), [FIXTURE_MESSAGES[0]])

  // Trailing garbage (not even a frame magic) must not throw either.
  const garbage = Buffer.concat([complete, Buffer.from([0x00, 0x01, 0x02])])
  assert.deepEqual(sessionMessagesFromBuffer(garbage, 'session.jsonl.zstd'), [FIXTURE_MESSAGES[0]])
})

test('an empty or unparseable artifact yields no messages', () => {
  assert.deepEqual(sessionMessagesFromBuffer(Buffer.alloc(0), 'session.v4.jsonl.zstd'), [])
  assert.deepEqual(sessionMessagesFromBuffer(Buffer.from('not json\n{broken\n'), 'session.v4.jsonl'), [])
  assert.deepEqual(sessionMessagesFromBuffer(Buffer.from('{"type":"session"}\n'), 'session.v4.jsonl'), [])
})

test('one message is capped and a Session stops at the message cap', () => {
  const long = sessionMessagesFromBuffer(
    plaintextLog([userRecord(['x'.repeat(MAX_MESSAGE_CHARS + 5_000)])]),
    'session.v4.jsonl',
  )
  assert.equal(long.length, 1)
  assert.equal(long[0].length, MAX_MESSAGE_CHARS)

  const many = Array.from({ length: MAX_MESSAGES_PER_SESSION + 3 }, (_, index) => userRecord([`消息 ${index}`]))
  const capped = sessionMessagesFromBuffer(plaintextLog(many), 'session.v4.jsonl')
  assert.equal(capped.length, MAX_MESSAGES_PER_SESSION)
  assert.equal(capped[0], '消息 0')
})

test('the newest generation wins and zstd wins at equal version', async () => {
  await withTempDir(async (dir) => {
    assert.equal(selectSessionLogFile(dir), undefined)
    assert.equal(selectSessionLogFile(join(dir, 'missing')), undefined)

    await writeFile(join(dir, 'session.v2.jsonl.zstd'), frameStream([FIXTURE_RECORDS[0]]))
    await writeFile(join(dir, 'session.v3.jsonl'), plaintextLog(FIXTURE_RECORDS))
    assert.equal(selectSessionLogFile(dir), join(dir, 'session.v3.jsonl'))

    await writeFile(join(dir, 'session.v3.jsonl.zstd'), frameStream([FIXTURE_RECORDS[0]]))
    assert.equal(selectSessionLogFile(dir), join(dir, 'session.v3.jsonl.zstd'))

    // A noncanonical or temporary name is not a committed generation.
    await writeFile(join(dir, 'session.v9.jsonl.tmp'), plaintextLog(FIXTURE_RECORDS))
    await writeFile(join(dir, 'Session.v9.jsonl'), plaintextLog(FIXTURE_RECORDS))
    assert.equal(selectSessionLogFile(dir), join(dir, 'session.v3.jsonl.zstd'))
  })
})

test('the unversioned original generation is still recognized', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl.zstd'), frameStream([HEADER, userRecord(['最早的一代'])]))
    assert.equal(selectSessionLogFile(dir), join(dir, 'session.jsonl.zstd'))
    assert.deepEqual(sessionMessagesFromFile(join(dir, 'session.jsonl.zstd')), ['最早的一代'])
  })
})
