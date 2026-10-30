import type { time as zh } from '../zh/time.js'

/** `time` domain: compact relative-time units (English; compact like DSH's rows). */
export const time: Record<keyof typeof zh, string> = {
  'time.now': 'now',
  'time.minute': '{n}min',
  'time.hour': '{n}h',
  'time.day': '{n}d',
  'time.month': '{n}mo',
  'time.year': '{n}y',
}
