// Prior-state lookup for the incremental ADO revisions sweep.
//
// An incremental sweep only receives revisions changed AFTER its watermark, so
// for an item whose earlier history is outside the window the builder has no
// idea what state it was already in. Left unseeded it would report the first
// in-window change as a creation (`from_state: ''`, `time_in_prev_state_s: 0`),
// silently zeroing the dwell time the timesheet bills against.
//
// The states we need are already in ClickHouse: every transition written by a
// previous sweep. Reading them back costs one CH query per project instead of
// re-fetching history from Azure DevOps, which is the whole point of the
// watermark.
import type { AdoPriorState } from '@deckgauge/shared';

export interface ChQueryClient {
  queryRows<T>(sql: string): Promise<T[]>;
}

/**
 * Max work-item ids per `IN (...)` clause. Keeps a single statement from
 * growing unbounded on a project with a large changed set.
 */
export const PRIOR_ID_BATCH_SIZE = 5_000;

interface PriorRow {
  work_item_id: number;
  state: string;
  /**
   * Deliberately NOT aliased `changed_at`. Aliasing the aggregate to the same
   * name as the column it reads makes ClickHouse resolve `argMax`'s second
   * argument to the alias instead of the column, and the query dies with
   * ILLEGAL_AGGREGATION ("Aggregate function max(changed_at) AS changed_at is
   * found inside another aggregate function").
   */
  last_changed_at: string;
}

function quote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Parse a ClickHouse `DateTime` ('YYYY-MM-DD HH:MM:SS', always UTC) to a Date.
 * Returns null when the value is not a usable timestamp.
 */
function parseChDateTime(value: string): Date | null {
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Look up the most recent known state per work item, keyed
 * `${project}#${workItemId}` for `buildAdoTransitions`'s `priorStates`.
 *
 * `argMax`/`GROUP BY` rather than `FINAL`: it collapses the ReplacingMergeTree
 * duplicates we care about and is cheaper than forcing a merge.
 */
export async function fetchAdoPriorStates(
  ch: ChQueryClient,
  project: string,
  workItemIds: ReadonlyArray<number>,
): Promise<Map<string, AdoPriorState>> {
  const priors = new Map<string, AdoPriorState>();
  if (workItemIds.length === 0) return priors;

  const bad = workItemIds.find((id) => !Number.isInteger(id));
  if (bad !== undefined) {
    throw new Error(`fetchAdoPriorStates: work item ids must be integers, got ${String(bad)}`);
  }

  for (let i = 0; i < workItemIds.length; i += PRIOR_ID_BATCH_SIZE) {
    const batch = workItemIds.slice(i, i + PRIOR_ID_BATCH_SIZE);
    const sql = `SELECT work_item_id,
       argMax(to_state, changed_at) AS state,
       max(changed_at) AS last_changed_at
FROM ado_transitions
WHERE project = '${quote(project)}' AND work_item_id IN (${batch.join(',')})
GROUP BY work_item_id`;

    const rows = await ch.queryRows<PriorRow>(sql);
    for (const row of rows) {
      const changedAt = parseChDateTime(String(row.last_changed_at));
      if (!changedAt || !row.state) continue;
      priors.set(`${project}#${row.work_item_id}`, { state: row.state, changedAt });
    }
  }

  return priors;
}
