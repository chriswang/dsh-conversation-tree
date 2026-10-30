import type { search as zh } from '../zh/search.js'

/** `search` domain: context-line labels (English). */
export const search: Record<keyof typeof zh, string> = {
  'search.ungrouped': 'Ungrouped',
  'search.untitled': 'Untitled conversation',
  'search.workspaceFallback': 'Workspace',
}
