/**
 * Unit tests for the relative-age buckets and their localized labels.
 *
 * The formatter takes `now` explicitly, so these stay deterministic. The buckets
 * are copy-free; the wording comes from the plugin dictionaries, which are
 * exercised here in both shipped languages.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { calendarDate, formatRelativeAge, relativeTime } from '../lib/time.js'
import { createTranslator, en, zh } from '../lib/locales.js'

/** A fixed reference instant. */
const NOW = Date.parse('2026-10-16T12:00:00.000Z')

/** The Simplified Chinese translator. */
const tZh = createTranslator(zh)

/** The English translator. */
const tEn = createTranslator(en)

/**
 * Bucket an age.
 * @param seconds - how long before {@link NOW}.
 * @returns the structured age.
 */
function ago(seconds) {
  return relativeTime(new Date(NOW - seconds * 1000).toISOString(), NOW)
}

/**
 * Format an age in one language.
 * @param t - the translator.
 * @param seconds - how long before {@link NOW}.
 * @returns the localized label.
 */
function label(t, seconds) {
  return formatRelativeAge(t, ago(seconds))
}

test('a fresh conversation reads as just now', () => {
  assert.deepEqual(ago(0), { unit: 'now' })
  assert.deepEqual(ago(44), { unit: 'now' })
  assert.equal(label(tZh, 0), '刚刚')
  assert.equal(label(tEn, 0), 'now')
})

test('minutes, hours, days, months, and years each get their own unit', () => {
  assert.deepEqual(ago(60), { unit: 'minute', n: 1 })
  assert.deepEqual(ago(45 * 60), { unit: 'minute', n: 45 })
  assert.deepEqual(ago(2 * 3600), { unit: 'hour', n: 2 })
  assert.deepEqual(ago(3 * 86400), { unit: 'day', n: 3 })
  assert.deepEqual(ago(60 * 86400), { unit: 'month', n: 2 })
  assert.deepEqual(ago(800 * 86400), { unit: 'year', n: 2 })
  assert.deepEqual([60, 45 * 60, 2 * 3600, 3 * 86400, 60 * 86400, 800 * 86400].map(seconds => label(tZh, seconds)), [
    '1分钟', '45分钟', '2小时', '3天', '2个月', '2年',
  ])
  assert.deepEqual([60, 45 * 60, 2 * 3600, 3 * 86400, 60 * 86400, 800 * 86400].map(seconds => label(tEn, seconds)), [
    '1min', '45min', '2h', '3d', '2mo', '2y',
  ])
})

test('an unknown or unparsable stamp renders nothing', () => {
  assert.equal(relativeTime('', NOW), null)
  assert.equal(relativeTime('not a date', NOW), null)
})

test('a future stamp does not read as negative', () => {
  assert.deepEqual(relativeTime(new Date(NOW + 60000).toISOString(), NOW), { unit: 'now' })
})

test('every age template fills its count in both languages', () => {
  assert.equal(tZh('time.minute', { n: 5 }), '5分钟')
  assert.equal(tEn('time.minute', { n: 5 }), '5min')
})

test('a creation date formats as a local calendar day', () => {
  assert.equal(calendarDate(new Date(2026, 8, 28, 12, 0, 0).toISOString()), '2026-09-28')
  assert.equal(calendarDate(''), '')
  assert.equal(calendarDate('not a date'), '')
})
