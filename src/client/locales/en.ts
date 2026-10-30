/**
 * Merged English dictionary for the conversation-map namespace.
 *
 * Typed against {@link zh}, so a missing or extra key is a compile error.
 */
import { columns } from './en/columns.js'
import { common } from './en/common.js'
import { drag } from './en/drag.js'
import { entries } from './en/entries.js'
import { model } from './en/model.js'
import { panel } from './en/panel.js'
import { search } from './en/search.js'
import { status } from './en/status.js'
import { store } from './en/store.js'
import { time } from './en/time.js'
import { view } from './en/view.js'
import type { zh } from './zh.js'

export const en: Record<keyof typeof zh, string> = {
  ...columns,
  ...common,
  ...drag,
  ...entries,
  ...model,
  ...panel,
  ...search,
  ...status,
  ...store,
  ...time,
  ...view,
}
