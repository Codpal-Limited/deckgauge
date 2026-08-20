import type { ClickHouseClient } from '@deckgauge/db';
import { DONE_STATUS_NAMES, toUtcIso } from '@deckgauge/shared';

export interface ActivityIdentityRow {
  provider: 'github' | 'ado' | 'jira';
  login: string | null;
  name: string | null;
  email: string | null;
  kind: 'gh' | 'ado' | 'jira';
  /** The repo / project the activity happened in. Coarse: boards can share one. */
  scopeKey: string;
  /**
   * The specific work item, keyed the way board rows are keyed (Jira issue key,
   * ADO work-item id, GitHub "repo#number"). Set on assignment rows only — code
   * activity belongs to a repo, not to a board row.
   */
  rowKey: string | null;
  /**
   * The assigned item's parent (Jira parent/epic, ADO parent work item), used as a
   * fallback when the item itself is on no board. Boards commonly track Epics only
   * while engineers are assigned the Stories underneath them; without this those
   * engineers would show no chips at all.
   */
  parentKey: string | null;
  /**
   * The epic above the parent, where the hierarchy is deeper than one level. For a Jira
   * sub-task `parent_key` is the Story and `epic_key` the Epic, and it is the Epic that
   * boards usually track — so board resolution falls through row -> parent -> epic.
   */
  epicKey: string | null;
  lastTs: string | null;
  isAssignment: boolean;
  contributedCode: boolean;
}

/**
 * Force a ClickHouse timestamp to explicit UTC, or null for an absent one.
 *
 * ClickHouse stores UTC but its default `toString` renders "YYYY-MM-DD HH:MM:SS" with
 * no zone, and `new Date()` reads that as LOCAL time. West of UTC that makes recent
 * activity look future-dated, and `isWithinActiveWindow`'s `ms >= 0` guard then drops
 * the freshest chips — the exact rows that matter most.
 *
 * Normalised here rather than in SQL on purpose: ClickHouse's `formatDateTime` uses
 * `%M` for the MONTH NAME (minutes are `%i`), so the obvious `'%Y-%m-%dT%H:%M:%SZ'`
 * silently yields "2026-08-14T17:August:16Z" and every timestamp becomes unparseable.
 *
 * The normalisation itself lives in @deckgauge/shared alongside the window check that
 * consumes it — a local copy drifted from that one once already.
 */
function normalizeTs(ts: string | null | undefined): string | null {
  return ts ? toUtcIso(ts) : null;
}

interface Spec {
  sql: string;
  provider: ActivityIdentityRow['provider'];
  kind: ActivityIdentityRow['kind'];
  isAssignment: boolean;
  contributedCode: boolean;
}

const SPECS: Spec[] = [
  {
    provider: 'github',
    kind: 'gh',
    isAssignment: false,
    contributedCode: true,
    sql: `SELECT ifNull(author_login,'') login, author_name name, lower(author_email) email, repo_full_name scopeKey, toString(max(committed_at)) lastTs FROM github_commits GROUP BY 1,2,3,4`,
  },
  {
    provider: 'github',
    kind: 'gh',
    isAssignment: false,
    contributedCode: true,
    // max(updated_at), not created_at: a PR opened weeks ago but pushed to today
    // must count as recent activity, else in-flight work on long-lived PRs reads
    // as stale until merge.
    sql: `SELECT author_login login, ifNull(author_name,'') name, '' email, repo_full_name scopeKey, toString(max(updated_at)) lastTs FROM github_pull_requests GROUP BY 1,2,3,4`,
  },
  {
    provider: 'ado',
    kind: 'ado',
    isAssignment: false,
    contributedCode: true,
    sql: `SELECT '' login, author_name name, lower(author_email) email, project scopeKey, toString(max(committed_at)) lastTs FROM ado_commits GROUP BY 1,2,3,4`,
  },
  {
    provider: 'ado',
    kind: 'ado',
    isAssignment: false,
    contributedCode: true,
    sql: `SELECT created_by_login login, ifNull(created_by_name,'') name, '' email, project scopeKey, toString(max(created_at)) lastTs FROM ado_pull_requests GROUP BY 1,2,3,4`,
  },
  {
    provider: 'jira',
    kind: 'jira',
    isAssignment: true,
    contributedCode: false,
    // Jira `assignee` is a display name (e.g. "Valentin Nagacevschi"), not an email —
    // route it by shape so the name-based matcher can resolve it (an '@'-form assignee
    // still lands in the email slot). ADO's assignment spec already projects to `name`.
    // Reduced to ONE row per issue before the assignee is read. These are
    // ReplacingMergeTrees whose parts are not guaranteed merged, so grouping BY the
    // assignee would emit a row per historical assignee and let someone who has since
    // handed a ticket over keep earning a live chip. argMax(..., updated_at) takes the
    // newest revision's value instead — correct without paying for FINAL.
    //
    // Defensive, not corrective: measured on staging, zero Jira issues and zero
    // (org, project, work-item) triples currently carry more than one assignee. (A
    // count of 3,406 appears if you group ADO by bare `ado_id`, but that is ids
    // colliding ACROSS projects, not stale assignees — see the row key note below.)
    sql: `SELECT '' login, if(assignee LIKE '%@%', '', assignee) name, if(assignee LIKE '%@%', lower(assignee), '') email, rowKey, parentKey, epicKey, scopeKey, lastTs FROM (
      SELECT key rowKey,
             argMax(ifNull(assignee, ''), updated_at) assignee,
             argMax(ifNull(parent_key, ''), updated_at) parentKey,
             argMax(ifNull(epic_key, ''), updated_at) epicKey,
             argMax(project_key, updated_at) scopeKey,
             toString(max(updated_at)) lastTs
      FROM jira_issues GROUP BY key
    ) WHERE assignee != ''`,
  },
  {
    provider: 'ado',
    kind: 'ado',
    isAssignment: true,
    contributedCode: false,
    // Keyed project#id, not the bare id: ADO work-item ids are unique only within a
    // project, so bare ids would let two projects cross-credit each other's boards.
    // `parentKey` must carry the SAME shape — it is looked up in the same map, and a
    // bare id there resolves to nothing at all, silently disabling the parent fallback.
    sql: `SELECT '' login, name, email, rowKey, parentKey, '' epicKey, scopeKey, lastTs FROM (
      SELECT concat(project, '#', toString(ado_id)) rowKey,
             argMax(ifNull(assigned_to, ''), updated_at) name,
             lower(argMax(ifNull(assigned_to_email, ''), updated_at)) email,
             argMax(if(parent_ado_id IS NULL, '', concat(project, '#', toString(parent_ado_id))), updated_at) parentKey,
             argMax(project, updated_at) scopeKey,
             toString(max(updated_at)) lastTs
      FROM ado_work_items GROUP BY org_url, project, ado_id
    ) WHERE name != ''`,
  },
  {
    provider: 'github',
    kind: 'gh',
    isAssignment: true,
    contributedCode: false,
    sql: `SELECT login, name, '' email, rowKey, '' parentKey, '' epicKey, scopeKey, lastTs FROM (
      SELECT concat(repo_full_name, '#', toString(number)) rowKey,
             argMax(ifNull(assignee_login, ''), updated_at) login,
             argMax(ifNull(assignee_name, ''), updated_at) name,
             argMax(repo_full_name, updated_at) scopeKey,
             toString(max(updated_at)) lastTs
      FROM github_issues GROUP BY repo_full_name, number
    ) WHERE login != ''`,
  },
];

/** One (identity, ISO-week) code-commit tally, used to build the sparkbar heat. */
export interface CommitHeatRow {
  provider: 'github' | 'ado';
  login: string | null;
  name: string | null;
  email: string | null;
  weekMonday: string; // 'YYYY-MM-DD' from toMonday(committed_at)
  count: number;
}

// Both commit tables are ReplacingMergeTree keyed by (repo, sha); uniqExact(sha)
// counts distinct commits so un-merged duplicate parts don't inflate the tally.
// Identity projections mirror the code-commit SPECS above so the same matcher
// resolves them to the same employees.
const HEAT_SPECS: Array<{ provider: CommitHeatRow['provider']; sql: (cutoff: string) => string }> = [
  {
    provider: 'github',
    sql: (cutoff) =>
      `SELECT ifNull(author_login,'') login, author_name name, lower(author_email) email, toString(toMonday(committed_at)) weekMonday, toUInt32(uniqExact(sha)) c FROM github_commits WHERE committed_at >= toDateTime('${cutoff} 00:00:00') GROUP BY 1,2,3,4`,
  },
  {
    provider: 'ado',
    sql: (cutoff) =>
      `SELECT '' login, author_name name, lower(author_email) email, toString(toMonday(committed_at)) weekMonday, toUInt32(uniqExact(sha)) c FROM ado_commits WHERE committed_at >= toDateTime('${cutoff} 00:00:00') GROUP BY 1,2,3,4`,
  },
];

/**
 * Distinct code-commit counts per author identity per ISO week, from `cutoff`
 * (a 'YYYY-MM-DD' Monday) forward. A failed source query is logged and skipped
 * so heat degrades gracefully rather than failing the whole sync.
 */
export async function fetchCommitHeat(
  ch: ClickHouseClient,
  cutoff: string,
): Promise<CommitHeatRow[]> {
  const out: CommitHeatRow[] = [];
  for (const spec of HEAT_SPECS) {
    let rows: Array<{ login: string; name: string; email: string; weekMonday: string; c: number }>;
    try {
      const res = await ch.query({ query: spec.sql(cutoff), format: 'JSONEachRow' });
      rows = (await res.json()) as typeof rows;
    } catch (err) {
      console.error(`org-sync: heat query failed, skipping: ${(err as Error).message}`);
      continue;
    }
    for (const r of rows) {
      out.push({
        provider: spec.provider,
        login: r.login || null,
        name: r.name || null,
        email: r.email || null,
        weekMonday: r.weekMonday,
        count: Number(r.c) || 0,
      });
    }
  }
  return out;
}

// --- GitHub login → email bridge -------------------------------------------

/**
 * Map each GitHub login to its most-used commit author email, learned from
 * `github_commits` (the one GitHub table that carries both login and email).
 *
 * PR and review rows only carry `author_login`/`reviewer_login`, and those logins
 * often bear a tenant suffix (e.g. `jane-doe_acme`) that defeats the first|last
 * name matcher, while their display-name column is null. Bridging the login to the
 * commit email lets the same email-based matcher that already resolves commits also
 * resolve PRs and reviews. Ambiguity is resolved by frequency: the email a login
 * commits with most often wins.
 */
export async function fetchGithubLoginEmails(ch: ClickHouseClient): Promise<Map<string, string>> {
  const bridge = new Map<string, string>();
  const sql =
    `SELECT lower(author_login) login, lower(author_email) email, toUInt32(count()) c ` +
    `FROM github_commits ` +
    `WHERE author_login != '' AND author_email != '' ` +
    `GROUP BY 1,2 ORDER BY login, c DESC`;
  let rows: Array<{ login: string; email: string; c: number }>;
  try {
    const res = await ch.query({ query: sql, format: 'JSONEachRow' });
    rows = (await res.json()) as typeof rows;
  } catch (err) {
    // Degrade gracefully: without the bridge, PR/review identity falls back to the
    // login/name matcher (same as before this bridge existed).
    console.error(`org-sync: login-email bridge query failed, skipping: ${(err as Error).message}`);
    return bridge;
  }
  // Rows are ordered by descending count per login, so the first email seen for a
  // login is its most frequent; keep that one.
  for (const r of rows) {
    if (!bridge.has(r.login)) bridge.set(r.login, r.email);
  }
  return bridge;
}

/**
 * Fill the `email` field of GitHub rows that carry a login but no email, using the
 * login→email bridge, so the downstream email matcher can resolve them. Mutates and
 * returns the same array; a no-op when the bridge is absent.
 */
function applyLoginEmailBridge<T extends { provider: string; login: string | null; email: string | null }>(
  rows: T[],
  bridge?: Map<string, string>,
): T[] {
  if (!bridge) return rows;
  for (const r of rows) {
    if (r.provider === 'github' && r.login && !r.email) {
      const email = bridge.get(r.login.toLowerCase());
      if (email) r.email = email;
    }
  }
  return rows;
}

// --- Leaderboard ranking metrics -------------------------------------------

/** One (identity, metric) contribution tally over the rolling ranking window. */
export type RankingMetricKind = 'ticketsClosed' | 'prsMerged' | 'commitsToMain' | 'reviewComments';

export interface RankingMetricRow {
  provider: 'github' | 'ado' | 'jira';
  metric: RankingMetricKind;
  login: string | null;
  name: string | null;
  email: string | null;
  count: number;
}

// Normalized-status expression mirroring the intelligence builders'
// `chNormalizedStatusExpr` (lower-cased, whitespace/punctuation collapsed to single
// spaces) so a "done" transition here agrees with the timesheet/flow builders.
const normStatusExpr = (col: string): string =>
  `trimBoth(replaceRegexpAll(lowerUTF8(${col}), '[\\\\s_-]+', ' '))`;

// The narrow "delivered" status set (done/closed/resolved), quoted for a SQL IN list.
const DONE_IN = `(${DONE_STATUS_NAMES.map((s) => `'${s}'`).join(', ')})`;

// Each spec projects (login, name, email, cnt) for one metric+provider, over the
// window `cutoff` (a 'YYYY-MM-DD' date) forward. RMT tables whose aggregate could
// double-count un-merged re-synced parts (count()/sum()) read with FINAL; the
// uniqExact-based counts (sha, issue_key) are dedup-safe without it, mirroring the
// commit-heat SPECS above.
const RANKING_SPECS: Array<{
  metric: RankingMetricKind;
  provider: RankingMetricRow['provider'];
  sql: (cutoff: string) => string;
}> = [
  // Tickets closed — attributed to the assignee (who was working the issue), counted
  // on the transition INTO a done state.
  {
    metric: 'ticketsClosed',
    provider: 'jira',
    sql: (c) =>
      // Jira `assignee` is a display name, not an email (see the activity SPEC note):
      // route it by shape so the name matcher can resolve it.
      `SELECT '' login, if(assignee LIKE '%@%', '', assignee) name, if(assignee LIKE '%@%', lower(assignee), '') email, toUInt32(uniqExact(issue_key)) cnt ` +
      `FROM jira_transitions FINAL ` +
      `WHERE assignee IS NOT NULL AND assignee != '' ` +
      `AND transitioned_at >= toDateTime('${c} 00:00:00') ` +
      `AND ${normStatusExpr('to_status')} IN ${DONE_IN} ` +
      `GROUP BY 1,2,3`,
  },
  {
    metric: 'ticketsClosed',
    provider: 'ado',
    sql: (c) =>
      `SELECT '' login, ifNull(assigned_to,'') name, '' email, toUInt32(uniqExact(work_item_id)) cnt ` +
      `FROM ado_transitions FINAL ` +
      `WHERE assigned_to IS NOT NULL AND assigned_to != '' ` +
      `AND changed_at >= toDateTime('${c} 00:00:00') ` +
      `AND ${normStatusExpr('to_state')} IN ${DONE_IN} ` +
      `GROUP BY 1,2,3`,
  },
  // PRs merged — attributed to the author.
  {
    metric: 'prsMerged',
    provider: 'github',
    sql: (c) =>
      `SELECT author_login login, ifNull(author_name,'') name, '' email, toUInt32(count()) cnt ` +
      `FROM github_pull_requests FINAL ` +
      `WHERE merged_at IS NOT NULL AND merged_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
  {
    metric: 'prsMerged',
    provider: 'ado',
    sql: (c) =>
      `SELECT created_by_login login, ifNull(created_by_name,'') name, '' email, toUInt32(count()) cnt ` +
      `FROM ado_pull_requests FINAL ` +
      `WHERE status = 'completed' AND closed_at IS NOT NULL AND closed_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
  // Commits — authored work, excluding merge-bubble commits. uniqExact(sha) is dedup-safe.
  {
    metric: 'commitsToMain',
    provider: 'github',
    sql: (c) =>
      `SELECT ifNull(author_login,'') login, author_name name, lower(author_email) email, toUInt32(uniqExact(sha)) cnt ` +
      `FROM github_commits ` +
      `WHERE is_merge_commit = 0 AND committed_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
  {
    metric: 'commitsToMain',
    provider: 'ado',
    sql: (c) =>
      `SELECT ifNull(author_login,'') login, author_name name, lower(author_email) email, toUInt32(uniqExact(sha)) cnt ` +
      `FROM ado_commits ` +
      `WHERE is_merge_commit = 0 AND committed_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
  // Review comments — attributed to the reviewer, summed across their reviews.
  {
    metric: 'reviewComments',
    provider: 'github',
    sql: (c) =>
      `SELECT reviewer_login login, ifNull(reviewer_name,'') name, '' email, toUInt32(sum(comment_count)) cnt ` +
      `FROM github_reviews FINAL ` +
      `WHERE reviewer_login != '' AND submitted_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
  {
    metric: 'reviewComments',
    provider: 'ado',
    sql: (c) =>
      `SELECT reviewer_login login, ifNull(reviewer_name,'') name, '' email, toUInt32(sum(comment_count)) cnt ` +
      `FROM ado_reviews FINAL ` +
      `WHERE reviewer_login != '' AND submitted_at >= toDateTime('${c} 00:00:00') ` +
      `GROUP BY 1,2,3`,
  },
];

/**
 * Per-identity, per-metric contribution counts from `cutoff` (a 'YYYY-MM-DD' date)
 * forward. A failed source query is logged and skipped so ranking degrades gracefully
 * rather than failing the whole sync (mirrors `fetchCommitHeat`).
 */
export async function fetchRankingMetrics(
  ch: ClickHouseClient,
  cutoff: string,
  loginEmails?: Map<string, string>,
): Promise<RankingMetricRow[]> {
  const out: RankingMetricRow[] = [];
  for (const spec of RANKING_SPECS) {
    let rows: Array<{ login: string; name: string; email: string; cnt: number }>;
    try {
      const res = await ch.query({ query: spec.sql(cutoff), format: 'JSONEachRow' });
      rows = (await res.json()) as typeof rows;
    } catch (err) {
      console.error(`org-sync: ranking query failed, skipping: ${(err as Error).message}`);
      continue;
    }
    for (const r of rows) {
      out.push({
        provider: spec.provider,
        metric: spec.metric,
        login: r.login || null,
        name: r.name || null,
        email: r.email || null,
        count: Number(r.cnt) || 0,
      });
    }
  }
  return applyLoginEmailBridge(out, loginEmails);
}

export async function fetchActivityIdentities(
  ch: ClickHouseClient,
  loginEmails?: Map<string, string>,
): Promise<ActivityIdentityRow[]> {
  const out: ActivityIdentityRow[] = [];
  for (const spec of SPECS) {
    let rows: Array<{ login: string; name: string; email: string; rowKey?: string; parentKey?: string; epicKey?: string; scopeKey: string; lastTs: string }>;
    try {
      const res = await ch.query({ query: spec.sql, format: 'JSONEachRow' });
      rows = (await res.json()) as typeof rows;
    } catch (err) {
      console.error(`org-sync: source query failed, skipping: ${(err as Error).message}`);
      continue;
    }
    for (const r of rows) {
      out.push({
        provider: spec.provider,
        kind: spec.kind,
        login: r.login || null,
        name: r.name || null,
        email: r.email || null,
        scopeKey: r.scopeKey,
        rowKey: r.rowKey || null,
        parentKey: r.parentKey || null,
        epicKey: r.epicKey || null,
        lastTs: normalizeTs(r.lastTs),
        isAssignment: spec.isAssignment,
        contributedCode: spec.contributedCode,
      });
    }
  }
  return applyLoginEmailBridge(out, loginEmails);
}
