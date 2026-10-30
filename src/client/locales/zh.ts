/**
 * Merged Simplified Chinese dictionary for the conversation-map namespace.
 *
 * `zh` is the key-set source of truth: every other locale is typed against it,
 * so a key added here without an English counterpart fails the build. Domains
 * are kept in their own files so independent features can own their copy.
 */
import { columns } from './zh/columns.js'
import { common } from './zh/common.js'
import { drag } from './zh/drag.js'
import { entries } from './zh/entries.js'
import { model } from './zh/model.js'
import { panel } from './zh/panel.js'
import { search } from './zh/search.js'
import { status } from './zh/status.js'
import { store } from './zh/store.js'
import { time } from './zh/time.js'
import { view } from './zh/view.js'

export const zh = {
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
