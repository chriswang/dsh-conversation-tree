import type { columns as zh } from '../zh/columns.js'

/** columns domain copy (English; must mirror the zh key set). */
export const columns: Record<keyof typeof zh, string> = {
  'columns.expandThreads': 'Expand conversations',
  'columns.collapseThreads': 'Collapse conversations',
  'columns.childCount': '{n} child nodes',
  'columns.newThreadInNode': 'Start a new conversation under this node',
  'columns.newThreadInUngrouped': 'Start a conversation in Ungrouped',
  'columns.newThreadInWorkspace': 'Start a new conversation in this workspace',
}
