import type { Provider, RawTransition } from '@deckgauge/shared';
import type { ChQueryClient } from './timesheet-fetch.js';

/**
 * ISSUE-SCOPED reads for the timesheet ticket drawer.
 *
 * Every query here carries an equality predicate on the issue's own identity,
 * and that is the whole design constraint. The sibling `fetchIssueMeta` in
 * `timesheet-fetch.ts` scans `jira_issues` + `ado_work_items` whole, which is
 * affordable exactly once per cached engine run and is NOT affordable per
 * drawer open — see the OOM note at the top of that file. So the drawer gets
 * its own narrow reads instead of widening the shared ones, and the cached
 * grid path is left untouched.
 *
 * The key is also the router: `project#123` is an ADO work item, anything else
 * is a Jira key. Only the matching provider's table is ever queried, so a Jira
 * drawer never touches ADO and vice versa.
 */

/** `project#123` → ADO; anything else → Jira. */
function parseKey(
  issueKey: string,
): { provider: 'jira'; key: string } | { provider: 'ado'; project: string; adoId: number } | null {
  const hash = issueKey.lastIndexOf('#');
  if (hash === -1) return { provider: 'jira', key: issueKey };
  const project = issueKey.slice(0, hash);
  const raw = issueKey.slice(hash + 1);
  // A non-numeric suffix is not an ADO id. Returning null (rather than coercing
  // to NaN and querying anyway) is what keeps a malformed key from becoming an
  // unfiltered scan.
  if (project === '' || !/^\d+$/.test(raw)) return null;
  return { provider: 'ado', project, adoId: Number(raw) };
}

function stripTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

function jiraBrowseUrl(instanceUrl: string, key: string): string | null {
  return instanceUrl ? `${stripTrailingSlash(instanceUrl)}/browse/${key}` : null;
}

function adoEditUrl(orgUrl: string, project: string, adoId: number): string | null {
  return orgUrl
    ? `${stripTrailingSlash(orgUrl)}/${encodeURIComponent(project)}/_workitems/edit/${adoId}`
    : null;
}

/** Seconds → ms, treating 0/null/undefined as "not set". */
function toMs(seconds: number | null | undefined): number | null {
  return seconds == null || seconds === 0 ? null : seconds * 1000;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value == null || value === '' ? null : value;
}

export interface IssueEpic {
  key: string;
  title: string | null;
  url: string | null;
}

export interface IssueDetail {
  provider: Provider;
  title: string | null;
  url: string | null;
  issueType: string | null;
  reporter: string | null;
  assignee: string | null;
  priority: string | null;
  storyPoints: number | null;
  sprint: string | null;
  epic: IssueEpic | null;
  openedAtMs: number | null;
  resolvedAtMs: number | null;
  currentStatus: string | null;
}

const JIRA_DETAIL_QUERY = `
  SELECT issue_type, summary, reporter, assignee, priority, status,
         story_points, sprint_name,
         coalesce(nullIf(parent_key, ''), nullIf(epic_key, '')) AS epic_key,
         epic_summary, instance_url,
         toUnixTimestamp(created_at) AS created_s,
         toUnixTimestamp(coalesce(resolved_at, toDateTime(0))) AS resolved_s
  FROM cockpit.jira_issues FINAL
  WHERE key = {key:String}
  LIMIT 1
`;

const ADO_DETAIL_QUERY = `
  SELECT work_item_type, title, created_by, assigned_to, priority, state,
         story_points, sprint_name, parent_ado_id, org_url,
         toUnixTimestamp(created_at) AS created_s,
         toUnixTimestamp(coalesce(closed_at, toDateTime(0))) AS closed_s
  FROM cockpit.ado_work_items FINAL
  WHERE project = {project:String} AND ado_id = {adoId:UInt32}
  LIMIT 1
`;

interface JiraDetailRow {
  issue_type: string;
  summary: string;
  reporter: string | null;
  assignee: string | null;
  priority: string;
  status: string;
  story_points: number | null;
  sprint_name: string | null;
  epic_key: string | null;
  epic_summary: string | null;
  instance_url: string;
  created_s: number;
  resolved_s: number | null;
}

interface AdoDetailRow {
  work_item_type: string;
  title: string;
  created_by: string | null;
  assigned_to: string | null;
  priority: number | null;
  state: string;
  story_points: number | null;
  sprint_name: string | null;
  parent_ado_id: number | null;
  org_url: string;
  created_s: number;
  closed_s: number | null;
}

/** One issue's descriptive fields, or null when the warehouse has no such row. */
export async function fetchIssueDetail(
  client: ChQueryClient,
  issueKey: string,
): Promise<IssueDetail | null> {
  const parsed = parseKey(issueKey);
  if (parsed === null) return null;

  if (parsed.provider === 'jira') {
    const res = await client.query({
      query: JIRA_DETAIL_QUERY,
      query_params: { key: parsed.key },
      format: 'JSONEachRow',
    });
    const row = ((await res.json()) as JiraDetailRow[])[0];
    if (!row) return null;
    const epicKey = nonEmpty(row.epic_key);
    return {
      provider: 'jira',
      title: nonEmpty(row.summary),
      url: jiraBrowseUrl(row.instance_url, parsed.key),
      issueType: nonEmpty(row.issue_type),
      reporter: nonEmpty(row.reporter),
      assignee: nonEmpty(row.assignee),
      priority: nonEmpty(row.priority),
      storyPoints: row.story_points ?? null,
      sprint: nonEmpty(row.sprint_name),
      epic: epicKey
        ? {
            key: epicKey,
            title: nonEmpty(row.epic_summary),
            url: jiraBrowseUrl(row.instance_url, epicKey),
          }
        : null,
      openedAtMs: toMs(row.created_s),
      resolvedAtMs: toMs(row.resolved_s),
      currentStatus: nonEmpty(row.status),
    };
  }

  const res = await client.query({
    query: ADO_DETAIL_QUERY,
    query_params: { project: parsed.project, adoId: parsed.adoId },
    format: 'JSONEachRow',
  });
  const row = ((await res.json()) as AdoDetailRow[])[0];
  if (!row) return null;
  const parentId = row.parent_ado_id;
  return {
    provider: 'ado',
    title: nonEmpty(row.title),
    url: adoEditUrl(row.org_url, parsed.project, parsed.adoId),
    issueType: nonEmpty(row.work_item_type),
    reporter: nonEmpty(row.created_by),
    assignee: nonEmpty(row.assigned_to),
    // ADO priority is numeric (1..4); the drawer renders whatever string it gets.
    priority: row.priority == null ? null : String(row.priority),
    storyPoints: row.story_points ?? null,
    sprint: nonEmpty(row.sprint_name),
    epic:
      parentId == null
        ? null
        : {
            key: `${parsed.project}#${parentId}`,
            // ADO carries no parent title on the child row; one extra read for a
            // chip label is not worth it, so the UI falls back to the key.
            title: null,
            url: adoEditUrl(row.org_url, parsed.project, parentId),
          },
    openedAtMs: toMs(row.created_s),
    resolvedAtMs: toMs(row.closed_s),
    currentStatus: nonEmpty(row.state),
  };
}

const JIRA_TIMELINE_QUERY = `
  SELECT assignee, to_status, to_category, toUnixTimestamp(transitioned_at) AS ts_s
  FROM cockpit.jira_transitions FINAL
  WHERE issue_key = {key:String}
  ORDER BY transitioned_at ASC
`;

const ADO_TIMELINE_QUERY = `
  SELECT assigned_to, to_state, toUnixTimestamp(changed_at) AS ts_s
  FROM cockpit.ado_transitions FINAL
  WHERE project = {project:String} AND work_item_id = {adoId:UInt32}
  ORDER BY changed_at ASC
`;

interface JiraTimelineRow {
  assignee: string | null;
  to_status: string;
  to_category: string;
  ts_s: number;
}

interface AdoTimelineRow {
  assigned_to: string | null;
  to_state: string;
  ts_s: number;
}

/**
 * One issue's FULL transition history, oldest first.
 *
 * Unbounded in time on purpose — that is the point of it. The windowed
 * `fetchTransitions` cannot answer "when did this ticket open" for a ticket
 * created before the period on screen, and widening its window would restore
 * the all-history scan across every issue. Scoped to one issue, all of history
 * is a handful of rows.
 */
export async function fetchIssueTimeline(
  client: ChQueryClient,
  issueKey: string,
): Promise<RawTransition[]> {
  const parsed = parseKey(issueKey);
  if (parsed === null) return [];

  if (parsed.provider === 'jira') {
    const res = await client.query({
      query: JIRA_TIMELINE_QUERY,
      query_params: { key: parsed.key },
      format: 'JSONEachRow',
    });
    const rows = (await res.json()) as JiraTimelineRow[];
    return byTime(
      rows.map((r) => ({
        issueKey,
        provider: 'jira' as Provider,
        assignee: r.assignee,
        status: r.to_status,
        category: r.to_category,
        transitionedAtMs: r.ts_s * 1000,
      })),
    );
  }

  const res = await client.query({
    query: ADO_TIMELINE_QUERY,
    query_params: { project: parsed.project, adoId: parsed.adoId },
    format: 'JSONEachRow',
  });
  const rows = (await res.json()) as AdoTimelineRow[];
  return byTime(
    rows.map((r) => ({
      issueKey,
      provider: 'ado' as Provider,
      assignee: r.assigned_to,
      status: r.to_state,
      category: null,
      transitionedAtMs: r.ts_s * 1000,
    })),
  );
}

/**
 * The queries above already `ORDER BY`, so this normally sorts a sorted list.
 * It is here because "oldest first" is this function's stated contract and a
 * caller should not have to know whether the server or the client guarantees
 * it — `UNION ALL` or a distributed table could return rows in any order.
 */
function byTime(rows: RawTransition[]): RawTransition[] {
  return rows.sort((a, b) => a.transitionedAtMs - b.transitionedAtMs);
}
