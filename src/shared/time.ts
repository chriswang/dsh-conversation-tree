/**
 * Relative-time labels for conversation rows.
 *
 * The application's own session rows show a compact relative age, so the plugin
 * speaks the same language instead of printing absolute timestamps.
 *
 * This module stays copy-free: {@link relativeTime} returns a structured age
 * bucket (`now`, `minute`, `hour`, …), and the render site formats it through
 * its own {@link Translate}. The bucket vocabulary matches DSH's own compact
 * relative time, so the English/Chinese wording stays one dictionary away.
 */
import type { Translate } from './copy.js'

/** One day in seconds; the unit boundary the buckets switch on. */
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** The compact age buckets a conversation row can report. */
export type RelativeUnit = 'now' | 'minute' | 'hour' | 'day' | 'month' | 'year'

/** One structured relative age: the bucket plus its count (absent for `now`). */
export interface RelativeAge {
  unit: RelativeUnit
  /** Rounded count for every unit but `now`. */
  n?: number
}

/**
 * Bucket how long ago a timestamp was.
 * @param iso - an ISO timestamp, or an empty string when unknown.
 * @param now - the current time in milliseconds.
 * @returns the structured age, or `null` when the stamp is missing/unparsable.
 */
export function relativeTime(iso: string, now: number): RelativeAge | null {
  if (iso === '') return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const seconds = (now - at) / 1000
  if (seconds < 45) return { unit: 'now' }
  if (seconds < HOUR) return { unit: 'minute', n: Math.round(seconds / MINUTE) }
  if (seconds < DAY) return { unit: 'hour', n: Math.round(seconds / HOUR) }
  if (seconds < MONTH) return { unit: 'day', n: Math.round(seconds / DAY) }
  if (seconds < YEAR) return { unit: 'month', n: Math.round(seconds / MONTH) }
  return { unit: 'year', n: Math.round(seconds / YEAR) }
}

/**
 * Format one bucket through the caller's dictionary.
 * @param t - the active translator (namespace `conversation-map`).
 * @param age - the structured age.
 * @returns a compact label such as `刚刚`, `3分钟`, `2天`, `just now`, or `3min`.
 */
export function formatRelativeAge(t: Translate, age: RelativeAge): string {
  return age.unit === 'now' ? t('time.now') : t(`time.${age.unit}`, { n: age.n ?? 0 })
}

/**
 * Describe how long ago a timestamp was, already localized.
 * @param t - the active translator.
 * @param iso - an ISO timestamp, or an empty string when unknown.
 * @param now - the current time in milliseconds.
 * @returns the compact localized label, or an empty string when unknown.
 */
export function relativeTimeLabel(t: Translate, iso: string, now: number): string {
  const age = relativeTime(iso, now)
  return age === null ? '' : formatRelativeAge(t, age)
}

/**
 * Format one ISO stamp as a local calendar date (`2026-09-28`).
 *
 * The bar uses this for a node's creation date, where a relative label ("2
 * months ago") would be less useful than the day it was created. Empty or
 * unparsable stamps render nothing, like {@link relativeTime}.
 * @param iso - an ISO timestamp, or an empty string when unknown.
 * @returns `YYYY-MM-DD`, or an empty string.
 */
export function calendarDate(iso: string): string {
  if (iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
