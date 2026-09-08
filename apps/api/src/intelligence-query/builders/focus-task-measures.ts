import { adoScopeFilter, focusTasksUnion, jiraScopeFilter } from '../../widgets/unions.js';
import { registerBuilder } from './registry.js';
import type { BuilderInputs, BuiltSql } from './types.js';
import { formatDateTime, resolveDays } from '../../widgets/widget-helpers.js';
import { resolvePeriod } from './period.js';

const DEFAULT_DAYS = 90;

/**
 * One row per task in scope: identity, raw state, assignee, epic, origin.
 *
 * Deliberately carries NO derived measure. Attention days and move counts are
 * computed by `attentionDaysInWindow` and `countMovesInWindow` in
 * `@deckgauge/shared`, from the transition rows the companion builder returns.
 *
 * The first version of this computed days in SQL with nested arrays. It was
 * rejected by the row-policy SQL parser, and chasing that was the wrong instinct
 * anyway: the design says SQL returns rows and meaning is applied in shared,
 * precisely so the window-clipping and parked-versus-moved rules are unit-tested
 * against the reference report rather than buried in a query nobody can run
 * locally. Two simple queries and a join in TypeScript is the honest shape.
 *
 * Scoped to tasks TOUCHED in the window (`updated_at >= from`), not created in
 * it. Both bounds are load-bearing and neither is the obvious one:
 *
 * - Without the lower bound this returns the project's entire backlog, which
 *   corrupts every denominator on the page and sends thousands of tasks through
 *   the classifier on first render.
 * - Filtering on `created_at >= from` instead would be worse than no filter: the
 *   reference window's most interesting tasks are 500-900 days old, and a report
 *   about what a team worked on this quarter must include work that started
 *   before it. Mirrors the source spec's own `updated >= WINDOW_START`.
 *
 * Row volume is then bounded by one board's tasks in one window, which on the
 * reference data is ~105 tasks and a few hundred transitions.
 */
export function buildFocusTaskMeasuresSql({ config, scope }: BuilderInputs): BuiltSql | null {
  const tasks = focusTasksUnion(scope);
  if (tasks.sql === null) return null;

  const days = resolveDays((config as { days?: unknown }).days, DEFAULT_DAYS);
  const { from, to } = resolvePeriod(config, Date.now, days);

  return {
    sql: `
      WITH tasks AS (${tasks.sql})
      SELECT
        task_key       AS task_key,
        provider       AS provider,
        title          AS title,
        description    AS description,
        state          AS state,
        assignee       AS assignee,
        epic_key       AS epic_key,
        created_at     AS created_at
      FROM tasks
      WHERE created_at < {to:DateTime}
        AND updated_at >= {from:DateTime}
    `,
    params: { ...tasks.params, from: formatDateTime(from), to: formatDateTime(to) },
  };
}

/**
 * Every state change for the board's tasks, oldest first.
 *
 * Both legs pin FINAL. The tables are ReplacingMergeTree(synced_at), so a
 * re-synced transition is visible twice until a background merge — which
 * inflates the move count and can flip a task from `parked` to `moved`, the
 * exact corruption the parked rule exists to prevent.
 *
 * `ado_transitions` carries no `org_url` column, so its leg filters on project
 * alone. For a two-org install with same-named projects that is a gap in the
 * transition data itself, not something this query can close.
 *
 * Not filtered to the window: `attentionDaysInWindow` needs the transition that
 * put a task into its current state even when that happened before the window
 * opened, or a task worked across the boundary reads as zero days.
 */
export function buildFocusTransitionsSql({ scope }: BuilderInputs): BuiltSql | null {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    legs.push(`SELECT issue_key AS task_key, from_status AS from_state, to_status AS to_state,
      transitioned_at AS at, transitioned_by AS changed_by
      FROM cockpit.jira_transitions FINAL WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}`);
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT concat('ADO-', toString(work_item_id)) AS task_key, from_state AS from_state,
      to_state AS to_state, changed_at AS at, changed_by AS changed_by
      FROM cockpit.ado_transitions FINAL WHERE project IN {adoProjects:Array(String)}`);
    params.adoProjects = Array.from(new Set(scope.adoProjects));
  }

  if (legs.length === 0) return null;

  return { sql: `${legs.join(' UNION ALL ')} ORDER BY task_key, at`, params };
}

/**
 * Which issue each issue hangs under, for the whole board and ALL TIME.
 *
 * Feeds `resolveEpicKey`, which walks this to a root — the FEATURE an issue rolls
 * up to. Two properties, both of which fail silently rather than loudly:
 *
 * **Deliberately unwindowed.** A parent untouched in the window is still the
 * parent. On the reference board 12 of 112 roots are exactly that, and a window
 * predicate here would root their children at themselves and split one feature
 * into several — no error, just a wrong count. `buildFocusTransitionsSql` above
 * is unwindowed for a closely related reason.
 *
 * **`parent_key` only, never `epic_key` first.** Verified on real data:
 * `parent_key = epic_key` for all 919 non-subtask issues on the reference
 * project, so either reaches the epic — but SUB-TASKS carry `parent_key` and no
 * `epic_key` at all. Preferring `epic_key` strands every sub-task as its own
 * root, which is the single most likely way to get this wrong.
 *
 * The ADO leg keys BOTH sides as `ADO-<id>`, matching `task_key` everywhere else
 * in this path; a raw numeric parent id would match no key and quietly disable
 * the rollup for that provider. It also uses `adoScopeFilter` rather than a bare
 * `project IN`, because ADO project names are unique only WITHIN an organisation
 * — `ado_work_items` carries `org_url` and the task union already scopes on it,
 * so scoping this read more loosely would admit another org's rows and could
 * mis-root an in-scope `ADO-<id>`. (`buildFocusTransitionsSql` gets away with
 * the bare form only because `ado_transitions` has no `org_url` column at all.)
 *
 * Rows with no parent are dropped by `IS NOT NULL`, not `!= 0`. The column is
 * `Nullable(UInt32)` and the writer stores `null` (`ado-dual-writer.ts`), so
 * `!= 0` only worked through three-valued logic — right answer, wrong stated
 * reason, and review caught the comment claiming `0` was ADO's "no parent".
 *
 * Row volume is one board's issue keys, so this is cheap.
 */
export function buildFocusParentsSql({ scope }: BuilderInputs): BuiltSql | null {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    legs.push(`SELECT key AS task_key, parent_key AS parent_key
      FROM cockpit.jira_issues FINAL
      WHERE ${jiraScopeFilter(scope, params)} AND parent_key != ''`);
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT concat('ADO-', toString(ado_id)) AS task_key,
      concat('ADO-', toString(parent_ado_id)) AS parent_key
      FROM cockpit.ado_work_items FINAL
      WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })} AND parent_ado_id IS NOT NULL`);
  }

  if (legs.length === 0) return null;

  return { sql: legs.join(' UNION ALL '), params };
}

// One builder, several widget types: each renders a different slice of the same
// per-task rows, and the class join that separates them happens in the service.
//
// Written out rather than looped, because registry.test.ts greps this directory
// for registration calls with a LITERAL type name, to catch builders that exist
// but were never imported. A loop is invisible to that scan, which would leave
// these eight types unguarded — exactly the failure the scan exists to prevent.
// (For the same reason this comment must not spell out the call it describes:
// the scan would read it as a real registration.)
registerBuilder('FOCUS_ROADMAP_SHARE', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_SHIPPED_RATIO', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_NEVER_MOVED', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_ATTENTION_SPLIT', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_DELIVERY_FUNNEL', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_MAP', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_SCORECARD', buildFocusTaskMeasuresSql);
registerBuilder('FOCUS_LEDGER', buildFocusTaskMeasuresSql);
