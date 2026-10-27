/**
 * Unit tests for the relative-age labels on conversation rows.
 *
 * The formatter takes `now` explicitly, so these stay deterministic.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { calendarDate, relativeTime } from '../lib/time.js'

/** A fixed reference instant. */
const NOW = Date.parse('2026-10-16T12:00:00.000Z')

/**
 * Format an age.
 * @param seconds - how long before {@link NOW}.
 * @returns the label.
 */
function ago(seconds) {
  return relativeTime(new Date(NOW - seconds * 1000).toISOString(), NOW)
}

test('a fresh conversation reads as just now', () => {
  assert.equal(ago(0), '刚刚')
  assert.equal(ago(44), '刚刚')
})

test('minutes, hours, days, months, and years each get their own unit', () => {
  assert.equal(ago(60), '1分钟')
  assert.equal(ago(45 * 60), '45分钟')
  assert.equal(ago(2 * 3600), '2小时')
  assert.equal(ago(3 * 86400), '3天')
  assert.equal(ago(60 * 86400), '2个月')
  assert.equal(ago(800 * 86400), '2年')
})

test('an unknown or unparsable stamp renders nothing', () => {
  assert.equal(relativeTime('', NOW), '')
  assert.equal(relativeTime('not a date', NOW), '')
})

test('a future stamp does not read as negative', () => {
  assert.equal(relativeTime(new Date(NOW + 60000).toISOString(), NOW), '刚刚')
})

test('a creation date formats as a local calendar day', () => {
  assert.equal(calendarDate(new Date(2026, 8, 28, 12, 0, 0).toISOString()), '2026-09-28')
  assert.equal(calendarDate(''), '')
  assert.equal(calendarDate('not a date'), '')
})
