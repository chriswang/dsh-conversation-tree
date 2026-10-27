/**
 * Relative-time labels for conversation rows.
 *
 * The application's own session rows show a compact relative age, so the plugin
 * speaks the same language instead of printing absolute timestamps.
 */

/** One day in seconds; the unit boundary the labels switch on. */
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * Describe how long ago a timestamp was.
 * @param iso - an ISO timestamp, or an empty string when unknown.
 * @param now - the current time in milliseconds.
 * @returns a compact label such as `刚刚`, `3分钟`, `2天`, or an empty string when unknown.
 */
export function relativeTime(iso: string, now: number): string {
  if (iso === '') return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = (now - at) / 1000
  if (seconds < 45) return '刚刚'
  if (seconds < HOUR) return `${String(Math.round(seconds / MINUTE))}分钟`
  if (seconds < DAY) return `${String(Math.round(seconds / HOUR))}小时`
  if (seconds < MONTH) return `${String(Math.round(seconds / DAY))}天`
  if (seconds < YEAR) return `${String(Math.round(seconds / MONTH))}个月`
  return `${String(Math.round(seconds / YEAR))}年`
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
