import type { entries as zh } from '../zh/entries.js'

/** entries domain copy (English; must mirror the zh key set). */
export const entries: Record<keyof typeof zh, string> = {
  'entries.titleOnScreen': 'Conversation Tree (open)',
  'entries.titleOnScreenWithStatus': 'Conversation Tree (open): {status}',
  'entries.titleWithStatus': 'Conversation Tree: {status}',
  'entries.pendingCount': '{n} awaiting response',
  'entries.runningCount': '{n} sessions running',
  'entries.scopeAllIndexed': 'All indexed conversations',
}
