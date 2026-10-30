import type { view as zh } from '../zh/view.js'

/** view domain copy (English; must mirror the zh key set). */
export const view: Record<keyof typeof zh, string> = {
  'view.expand': 'Expand conversation tree',
  'view.collapseName': 'Collapse the conversation tree and give the conversation full width',
  'view.expandName': 'Expand the conversation tree column',
}
