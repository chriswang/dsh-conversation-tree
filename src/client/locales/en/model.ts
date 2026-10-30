import type { model as zh } from '../zh/model.js'

/** `model` domain: shared-model error copy, keyed by the stable MapError code. */
export const model: Record<keyof typeof zh, string> = {
  'model.error.NOT_FOUND': 'That target no longer exists; refresh and try again.',
  'model.error.SPACE_TITLE_EMPTY': 'A space name is required.',
  'model.error.SPACE_TITLE_LONG': 'A space name is limited to {max} characters.',
  'model.error.SPACE_TITLE_DUP': 'A space with that name already exists; choose another name.',
  'model.error.SPACE_NOT_FOUND': 'That space no longer exists; refresh and try again.',
  'model.error.SPACE_LIMIT': 'At most {max} spaces are supported.',
  'model.error.DEFAULT_SPACE': 'The default space cannot be deleted; rename it instead.',
  'model.error.TITLE_EMPTY': 'A topic name is required.',
  'model.error.TITLE_LONG': 'A topic name is limited to {max} characters.',
  'model.error.DESCRIPTION_LONG': 'A description is limited to {max} characters.',
  'model.error.WORKSPACE': 'That operation requires the target to be in the same Workspace.',
  'model.error.LIMIT': 'At most {max} nodes are supported.',
  'model.error.DEPTH': 'At most {max} levels are supported.',
  'model.error.ANCHOR': 'The anchor node is not under the target parent.',
  'model.error.HAS_CHILDREN': 'Move or delete the child topics first.',
  'model.error.SUBAGENT': 'A subagent conversation cannot be filed under a topic.',
  'model.error.SPACE': 'Only ungrouped conversations in the default space can be filed under the ungrouped topic.',
  'model.error.STORE_LOADING': 'The conversation tree is still loading; try again shortly.',
  'model.error.PICKER_MACOS': 'The Host-spawned directory picker cannot take clicks on macOS.',
  'model.error.PICKER_MISSING': 'The current client provides no directory picker.',
  'model.error.NAV_MISSING': 'The current client provides no Session navigation (uiWorkspace.openSession).',
}
