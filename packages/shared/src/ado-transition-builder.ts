import type { AdoWorkItemRevision } from './ado-work-item-revision';

/**
 * A row matching the `cockpit.ado_transitions` table (synced_at is CH-defaulted).
 *
 * Declared as a `type` (not `interface`) so it satisfies the
 * `Record<string, unknown>` row shape `writeAdoBasicToClickHouse` expects —
 * TS gives object-literal type aliases an implicit index signature, but not
 * interfaces.
 */
export type AdoTransitionRow = {
  id: string;
  work_item_id: number;
  project: string;
  work_item_type: string;
  assigned_to: string | null;
  from_state: string;
  to_state: string;
  changed_by: string | null;
  changed_at: string;
  time_in_prev_state_s: number;
};

// ClickHouse DateTime input wants 'YYYY-MM-DD HH:MM:SS' (no ms, no trailing Z).
function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The state a work item was already in before the revisions being built.
 *
 * Keyed `${project}#${workItemId}`. Supplied on an incremental sweep so the
 * first in-window change still reports the true `from_state` and dwell time.
 */
export type AdoPriorState = { state: string; changedAt: Date };

/**
 * Build `ado_transitions` rows from a flat list of work-item revisions.
 *
 * Groups by work item, sorts each group by `changedAt`, and emits one row per
 * `state` change — including the first revision (creation), so the time before
 * the first change is counted. `time_in_prev_state_s` is the full time spent in
 * the previous state, spanning intervening same-state revisions. Mirrors how
 * Jira transitions feed `reconstructIntervals`. Input is not mutated.
 *
 * `priorStates` seeds an item's state from BEFORE this batch. A full sweep
 * passes nothing and the first revision reads as a creation (`from_state: ''`).
 * An incremental sweep — which only receives revisions after its watermark —
 * passes the last known state per item so a change at the window boundary is
 * not misreported as a creation with zero time in the previous state.
 */
export function buildAdoTransitions(
  revisions: AdoWorkItemRevision[],
  priorStates?: ReadonlyMap<string, AdoPriorState>,
): AdoTransitionRow[] {
  const byItem = new Map<string, AdoWorkItemRevision[]>();
  for (const r of revisions) {
    const key = `${r.project}#${r.workItemId}`;
    const list = byItem.get(key);
    if (list) list.push(r);
    else byItem.set(key, [r]);
  }

  const out: AdoTransitionRow[] = [];
  for (const [key, list] of byItem) {
    const sorted = [...list].sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
    const { workItemId } = sorted[0]!;
    const prior = priorStates?.get(key);
    let prevState: string | null = prior?.state ?? null;
    let prevChangedMs: number | null = prior?.changedAt.getTime() ?? null;

    for (const r of sorted) {
      if (prevState !== null && r.state === prevState) continue; // no state change
      const changedMs = r.changedAt.getTime();
      const timeInPrev =
        prevChangedMs !== null ? Math.max(0, Math.floor((changedMs - prevChangedMs) / 1000)) : 0;
      out.push({
        id: `${r.project}#${workItemId}#${Math.floor(changedMs / 1000)}`,
        work_item_id: workItemId,
        project: r.project,
        work_item_type: r.workItemType,
        assigned_to: r.assignedTo,
        from_state: prevState ?? '',
        to_state: r.state,
        changed_by: r.changedBy,
        changed_at: fmt(r.changedAt),
        time_in_prev_state_s: timeInPrev,
      });
      prevState = r.state;
      prevChangedMs = changedMs;
    }
  }
  return out;
}
