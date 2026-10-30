import type { drag as zh } from '../zh/drag.js'

/** `drag` domain: pointer label for every drop outcome (English). */
export const drag: Record<keyof typeof zh, string> = {
  'drag.unchanged': 'No change',
  'drag.workspace': 'Move under the Workspace',
  'drag.under': 'Move under "{title}"',
  'drag.before': 'Insert before "{title}"',
  'drag.after': 'Insert after "{title}"',
  'drag.unorderedSuffix': ' (conversations are not ordered)',
  'drag.issue.NOT_FOUND': 'The target topic no longer exists',
  'drag.issue.WORKSPACE': 'Cannot move to another Workspace',
  'drag.issue.CYCLE': 'Cannot move under its own child',
  'drag.issue.DEPTH': 'Exceeds {max} levels',
  'drag.issue.SPACE': 'Only topics in the default space',
  'drag.issue.SUBAGENT': 'Subagent conversations cannot move',
  'drag.issue.ANCHOR': 'The anchor is not under the target',
  'drag.issue.NO_THREAD': 'The conversation no longer exists',
  'drag.issue.NONE': 'Cannot drop here',
  'drag.issue.UNGROUPED': 'Ungrouped items do not drag',
}
