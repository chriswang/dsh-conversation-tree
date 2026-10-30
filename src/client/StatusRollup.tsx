/**
 * One node row's status rollup: the only status surface the map adds.
 *
 * The badge is deliberately inert — a row's status counts answer "is there
 * anything here?" and the conversations beneath the row answer "what is it?".
 * There is no popover, no click target, and no hover card; the mark is read, not
 * operated.
 *
 * Two densities ship:
 *
 * - `cluster` draws one dot plus count per non-empty category, the default;
 * - `dots` drops the counts when the column is narrow, so the row keeps its
 *   title. The switch is width-driven (see `NODE_COLUMN_WIDTH` usage in
 *   `Columns.tsx`) and never changes the underlying counts.
 *
 * All colors come from the theme's state tokens, so the badge follows light and
 * dark mode like the shipped rows.
 */
import type { ReactNode } from 'react'

import {
  STATUS_CATEGORIES,
  type StatusCategory,
  type StatusRollup,
} from '../shared/status-rollup.js'
import { useT } from './locale.js'

/**
 * Dictionary keys naming each category in the badge's accessible label.
 *
 * The mapping is keys rather than wording, so the label the reader hears
 * follows the language DSH is in; the badge resolves them through {@link useT}.
 */
const CATEGORY_KEY: Record<StatusCategory, string> = {
  pending: 'status.pending',
  error: 'status.error',
  done: 'status.done',
  running: 'status.running',
}

/** Props of one rollup badge. */
export interface StatusRollupProps {
  /** The row's counts, or undefined when the row has nothing to show. */
  rollup?: StatusRollup | undefined
  /** How much room the column has for counts. */
  density: 'cluster' | 'dots'
  /**
   * What the counts aggregate, named in the accessible label.
   *
   * Node rows aggregate their subtree; the sidebar row aggregates every
   * conversation the map indexes, so it passes its own scope instead of the
   * default (the dictionary's `status.defaultScope`). Kept out of the visible
   * mark on purpose: the row already names itself, and the count is the thing to
   * read.
   */
  scope?: string | undefined
}

/**
 * The counts one row should actually draw, in display order.
 * @param rollup - the row's counts.
 * @returns non-empty categories in the fixed order.
 */
function visibleCategories(rollup: StatusRollup): StatusCategory[] {
  return STATUS_CATEGORIES.filter(category => rollup.counts[category] > 0)
}

/**
 * Render one row's status rollup.
 * @param props - the counts, density, and the aggregation scope named to readers.
 * @returns the badge, or null when the row has no status to report.
 */
export function StatusRollupBadge({ rollup, density, scope }: StatusRollupProps): ReactNode {
  const t = useT()
  if (rollup === undefined || rollup.total === 0) return null
  const categories = visibleCategories(rollup)
  const parts = categories.map(category => t('status.count', {
    n: rollup.counts[category],
    label: t(CATEGORY_KEY[category]),
  }))
  const label = t('status.label', {
    parts: parts.join(t('status.separator')),
    scope: scope ?? t('status.defaultScope'),
  })
  const fresh = rollup.fresh
  const common = {
    className: `cm-rollup${density === 'dots' ? ' cm-rollup-dots' : ''}`,
    role: 'img' as const,
    'aria-label': label,
    ...(fresh === undefined ? {} : { 'data-fresh': fresh }),
  }

  if (density === 'dots') {
    return (
      <span {...common}>
        {categories.map(category => (
          <span
            key={category}
            className={category === 'running' ? 'cm-rollup-ring' : 'cm-rollup-dot'}
            data-cat={category}
            aria-hidden="true"
          />
        ))}
      </span>
    )
  }

  return (
    <span {...common}>
      {categories.map(category => (
        <span key={category} className="cm-rollup-stat" data-cat={category}>
          <span
            className={category === 'running' ? 'cm-rollup-ring' : 'cm-rollup-dot'}
            data-cat={category}
            aria-hidden="true"
          />
          <b className="cm-rollup-count">{rollup.counts[category] > 99 ? '99+' : String(rollup.counts[category])}</b>
        </span>
      ))}
    </span>
  )
}
