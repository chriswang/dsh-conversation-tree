import type { status as zh } from '../zh/status.js'

/** status domain copy (English; must mirror the zh key set). */
export const status: Record<keyof typeof zh, string> = {
  'status.pending': 'Awaiting response',
  'status.error': 'Error',
  'status.done': 'Done',
  'status.running': 'Running',
  'status.count': '{n} {label}',
  'status.separator': ', ',
  'status.label': 'Conversation status: {parts} ({scope})',
  'status.defaultScope': 'including all descendants',
}
