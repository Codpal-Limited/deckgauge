import type { Provider, RawTransition } from '@deckgauge/shared';

export interface ChQueryClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
  }): Promise<{ json(): Promise<unknown> }>;
}

interface JiraRow {
  issue_key: string;
  assignee: string | null;
  to_status: string;
  to_category: string;
  ts_s: number;
}

interface AdoRow {
  project: string;
  work_item_id: number;
  assigned_to: string | null;
  to_state: string;
  ts_s: number;
}

/*
 * WINDOW BOUND — why each query has two arms.
 *
 * These queries used to be bounded only above (`< to`), so every timesheet read
 * dragged the ENTIRE transition history of both providers into the API process
 * before the engine clipped it to the requested window. That is the unbounded
 * half of the API OOM recorded against the `api` memory limit in
 * docker-compose.yml, and under pooled multi-tenant hosting it stops being one
 * tenant's problem (hosted-SaaS program design §4.3).
 *
 * The bound cannot simply be `>= from`. `reconstructIntervals` builds a span
 * from each transition to the NEXT one, so the span covering the start of the
 * window is opened by the last transition BEFORE the window — and an issue that
 * entered a status months ago and never moved has no in-window transition at
 * all. A plain `>= from` would silently zero those hours, which are exactly the
 * long-running-ticket hours the timesheet exists to surface.
 *
 * So each query is: every transition inside the window, UNION ALL the single
 * latest transition per issue from before it (the "carry-in"). That is one extra
 * row per issue instead of its whole history, and it reconstructs the same spans
 * over the window. (Same-second ties between two transitions on one issue
 * collapse arbitrarily, as they did before this change — the previous code sorted
 * by timestamp alone, which is equally nondeterministic for equal timestamps.)
 *
 * ONE TUPLE, NOT SEVERAL argMax CALLS — this is load-bearing, not style.
 * `argMax(col, t)` SKIPS rows whose `col` is NULL. So an issue whose latest
 * pre-window transition left it UNASSIGNED would pair `max(t)` with the
 * *previous* row's assignee, fabricating an owner for the span that covers the
 * window — and `makeAssigneeResolver`'s `if (!assignee) return null` guard could
 * no longer exclude it, so the hours landed on a real engineer's timesheet.
 * Verified against ClickHouse 24.8:
 *   argMax(a, t)          over ('alice',1),(NULL,2) -> 'alice'   WRONG
 *   argMax(tuple(a), t).1 over ('alice',1),(NULL,2) -> NULL      correct
 * A tuple is never NULL, so the whole row moves together. This also removes the
 * risk of independent argMax calls resolving a tie to DIFFERENT rows, which
 * would have stitched one transition's status onto another's assignee.
 *
 * `from = 0` degrades to the old all-history behaviour with no special case: the
 * window arm becomes `>= 1970` (everything) and the carry-in arm `< 1970`
 * (nothing). The org-tree status pool relies on that.
 *
 * RESIDUAL, deliberately not fixed here: this bounds the API's heap, NOT
 * ClickHouse's work. The carry-in arm still scans all pre-window history with
 * FINAL and aggregates it, emitting one row per issue that has ever existed
 * (~76k ADO + ~700 Jira at the time of writing) for ANY window, however narrow.
 * ClickHouse absorbs that far better than Node did — it is a streaming
 * aggregation, not a materialised array in a 1.5 GiB heap — but it is not free,
 * and pooling makes that CPU shared while §3 caps the server at 2.5 GiB. The fix
 * if it bites is a per-issue "current status" projection or an AggregatingMergeTree
 * keyed by issue, which is a schema change and its own slice.
 */

const JIRA_QUERY = `
  SELECT issue_key, assignee, to_status, to_category, toUnixTimestamp(transitioned_at) AS ts_s
  FROM cockpit.jira_transitions FINAL
  WHERE transitioned_at < toDateTime({to:UInt32})
    AND transitioned_at >= toDateTime({from:UInt32})
  UNION ALL
  SELECT issue_key,
         latest.1 AS assignee,
         latest.2 AS to_status,
         latest.3 AS to_category,
         toUnixTimestamp(latest.4) AS ts_s
  FROM (
    SELECT issue_key,
           argMax(tuple(assignee, to_status, to_category, transitioned_at), transitioned_at) AS latest
    FROM cockpit.jira_transitions FINAL
    WHERE transitioned_at < toDateTime({from:UInt32})
    GROUP BY issue_key
  )
`;

const ADO_QUERY = `
  SELECT project, work_item_id, assigned_to, to_state, toUnixTimestamp(changed_at) AS ts_s
  FROM cockpit.ado_transitions FINAL
  WHERE changed_at < toDateTime({to:UInt32})
    AND changed_at >= toDateTime({from:UInt32})
  UNION ALL
  SELECT project,
         work_item_id,
         latest.1 AS assigned_to,
         latest.2 AS to_state,
         toUnixTimestamp(latest.3) AS ts_s
  FROM (
    SELECT project,
           work_item_id,
           argMax(tuple(assigned_to, to_state, changed_at), changed_at) AS latest
    FROM cockpit.ado_transitions FINAL
    WHERE changed_at < toDateTime({from:UInt32})
    GROUP BY project, work_item_id
  )
`;

/**
 * Fetch the Jira + ADO transitions needed to reconstruct spans over
 * `[fromMs, toMs)`, mapped to RawTransition (epoch-ms).
 *
 * @param fromMs Window start. Pass 0 for "all history" (see the note above).
 */
export async function fetchTransitions(
  client: ChQueryClient,
  fromMs: number,
  toMs: number
): Promise<RawTransition[]> {
  const toSeconds = Math.floor(toMs / 1000);
  // Never negative: toDateTime({from:UInt32}) would reject a negative value, and
  // a caller asking for "everything" is what 0 already means.
  const fromSeconds = Math.max(0, Math.floor(fromMs / 1000));
  const params = { from: fromSeconds, to: toSeconds };

  const jiraRes = await client.query({
    query: JIRA_QUERY,
    query_params: params,
    format: 'JSONEachRow',
  });
  const adoRes = await client.query({
    query: ADO_QUERY,
    query_params: params,
    format: 'JSONEachRow',
  });

  const jiraRows = (await jiraRes.json()) as JiraRow[];
  const adoRows = (await adoRes.json()) as AdoRow[];

  const jira: RawTransition[] = jiraRows.map((r) => ({
    issueKey: r.issue_key,
    provider: 'jira' as Provider,
    assignee: r.assignee,
    status: r.to_status,
    category: r.to_category,
    transitionedAtMs: r.ts_s * 1000,
  }));

  const ado: RawTransition[] = adoRows.map((r) => ({
    issueKey: `${r.project}#${r.work_item_id}`,
    provider: 'ado' as Provider,
    assignee: r.assigned_to,
    status: r.to_state,
    category: null,
    transitionedAtMs: r.ts_s * 1000,
  }));

  return [...jira, ...ado];
}

const JIRA_PARENT_QUERY = `
  SELECT key AS child, coalesce(nullIf(parent_key, ''), nullIf(epic_key, '')) AS parent
  FROM cockpit.jira_issues FINAL
  WHERE coalesce(nullIf(parent_key, ''), nullIf(epic_key, '')) != ''
`;

const ADO_PARENT_QUERY = `
  SELECT concat(project, '#', toString(ado_id)) AS child,
         concat(project, '#', toString(parent_ado_id)) AS parent
  FROM cockpit.ado_work_items FINAL
  WHERE parent_ado_id IS NOT NULL
`;

const CLASSIFICATION_QUERY = `
  SELECT issue_key, argMax(classification, synced_at) AS classification
  FROM cockpit.board_item_classification FINAL
  GROUP BY provider, issue_key
`;

interface ParentRow {
  child: string;
  parent: string;
}

/** child issueKey -> parent issueKey, across Jira (parent_key|epic_key) and ADO (parent_ado_id). */
export async function fetchParentLinks(client: ChQueryClient): Promise<Map<string, string>> {
  const jiraRes = await client.query({ query: JIRA_PARENT_QUERY, format: 'JSONEachRow' });
  const adoRes = await client.query({ query: ADO_PARENT_QUERY, format: 'JSONEachRow' });
  const rows = [
    ...((await jiraRes.json()) as ParentRow[]),
    ...((await adoRes.json()) as ParentRow[]),
  ];
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.child && r.parent) map.set(r.child, r.parent);
  }
  return map;
}

interface ClassRow {
  issue_key: string;
  classification: string;
}

/** issueKey -> CAPEX|OPEX from the board_item_classification mirror (latest by synced_at). */
export async function fetchClassificationMap(
  client: ChQueryClient
): Promise<Map<string, 'CAPEX' | 'OPEX'>> {
  const res = await client.query({ query: CLASSIFICATION_QUERY, format: 'JSONEachRow' });
  const rows = (await res.json()) as ClassRow[];
  const map = new Map<string, 'CAPEX' | 'OPEX'>();
  for (const r of rows) {
    if (r.classification === 'CAPEX' || r.classification === 'OPEX') {
      map.set(r.issue_key, r.classification);
    }
  }
  return map;
}

// One scan per source table yields both the human title and the source deep
// link, so the (cached) engine run doesn't pay a second full-table scan just
// for URLs. Raw base URLs are fetched and the link is assembled in TS to mirror
// the JiraKeyBadge / AdoWorkItemBadge shapes exactly (trailing-slash strip +
// encodeURIComponent on the ADO project).
const JIRA_META_QUERY = `
  SELECT key, summary, instance_url
  FROM cockpit.jira_issues FINAL
`;

const ADO_META_QUERY = `
  SELECT project, ado_id, title, org_url
  FROM cockpit.ado_work_items FINAL
`;

interface JiraMetaRow {
  key: string;
  summary: string;
  instance_url: string;
}

interface AdoMetaRow {
  project: string;
  ado_id: number;
  title: string;
  org_url: string;
}

/** An issue's human title and its source deep link (null when the base URL is unknown). */
export interface IssueMeta {
  title: string;
  url: string | null;
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/** issueKey -> { title, url }, across Jira (summary + /browse/) and ADO (title + /_workitems/edit/). */
export async function fetchIssueMeta(client: ChQueryClient): Promise<Map<string, IssueMeta>> {
  const jiraRes = await client.query({ query: JIRA_META_QUERY, format: 'JSONEachRow' });
  const adoRes = await client.query({ query: ADO_META_QUERY, format: 'JSONEachRow' });
  const jiraRows = (await jiraRes.json()) as JiraMetaRow[];
  const adoRows = (await adoRes.json()) as AdoMetaRow[];

  const map = new Map<string, IssueMeta>();
  for (const r of jiraRows) {
    if (!r.key) continue;
    const url = r.instance_url ? `${stripTrailingSlash(r.instance_url)}/browse/${r.key}` : null;
    map.set(r.key, { title: r.summary ?? '', url });
  }
  for (const r of adoRows) {
    const key = `${r.project}#${r.ado_id}`;
    const url = r.org_url
      ? `${stripTrailingSlash(r.org_url)}/${encodeURIComponent(r.project)}/_workitems/edit/${r.ado_id}`
      : null;
    map.set(key, { title: r.title ?? '', url });
  }
  return map;
}
