import { focusTasksUnion } from '../../widgets/unions.js';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveDays } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';

const DEFAULT_DAYS = 90;

/**
 * Which tasks in the window carry which epic key, and which of them exist as a
 * row on this board.
 *
 * Two numbers come out of one query because they are the same question asked
 * from both ends: what did the roadmap receive, and what did the board miss.
 *
 * The board-coverage half is the one that matters most. On the reference window
 * 51 of 105 tasks the team actually worked never appeared on any board, and the
 * report's first finding was that the board does not describe what the team
 * does. A Focus view backed by `Project` rows would have inherited exactly that
 * blind spot; this query is what lets the view report the gap instead of being
 * subject to it.
 *
 * `board_item_classification` is the CAPEX/OPEX mirror, and it exists only for
 * tasks that made it onto a board — which is precisely why its presence is a
 * usable proxy for "this task is on the board".
 */
export function buildFocusCoverageSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const tasks = focusTasksUnion(scope);
  if (tasks.sql === null) return null;

  const days = resolveDays((config as { days?: unknown }).days, DEFAULT_DAYS);
  const { from, to } = resolvePeriod(config, Date.now, days);

  return {
    sql: `
      WITH tasks AS (${tasks.sql})
      SELECT
        t.epic_key                                   AS epic_key,
        t.task_key                                   AS task_key,
        t.provider                                   AS provider,
        if(bic.issue_key = '', 0, 1)                 AS on_board
      FROM tasks AS t
      LEFT JOIN (
        SELECT issue_key FROM cockpit.board_item_classification FINAL
      ) AS bic ON bic.issue_key = t.task_key
      WHERE t.created_at < {to:DateTime}
    `,
    params: { ...tasks.params, from: formatDateTime(from), to: formatDateTime(to) },
  };
}

registerBuilder('FOCUS_EPIC_COVERAGE', buildFocusCoverageSql);
registerBuilder('FOCUS_BOARD_COVERAGE', buildFocusCoverageSql);
