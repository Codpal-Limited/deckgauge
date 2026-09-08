import { DONE_STATUS_NAMES } from '@deckgauge/shared';
import type { BoardScope } from '../intelligence/board-scope.js';
import { chNormalizedStatusExpr } from './widget-helpers.js';

export interface UnionResult {
  /** Null when no scope leg applies. */
  sql: string | null;
  params: Record<string, unknown>;
}

// Separator for the exact (org_url, project) pair key. org_url is always a URL
// and can never contain '#', so splitting at the first '#' is unambiguous — the
// concatenation is injective.
const ADO_REF_SEP = '#';

/**
 * WHERE fragment scoping an ADO table to the board's exact (org, project) pairs.
 *
 * ADO project names are unique only within an organisation and more than one org
 * can be connected, so `project IN (...)` alone would blend two orgs' rows into
 * one board. `(org_url, project) IN {…:Array(Tuple(String,String))}` would say
 * this directly, but @clickhouse/client cannot serialise a tuple array (the
 * server rejects it with CANNOT_PARSE_INPUT_ASSERTION_FAILED), so the exact
 * check is a concatenated key. The two plain IN filters are kept alongside it so
 * the primary key — (org_url, project, …) on every ADO table — still prunes.
 *
 * Falls back to project-only filtering when the scope carries no refs (hand-built
 * scopes in tests; correct for a single-org install).
 *
 * `opts.repoColumn` layers on a per-project repository restriction (Task 3's
 * `repos` on each `adoProjectRefs` element). "Empty means all" is per-PROJECT,
 * not global — a board can have one project narrowed to two repos and another
 * left wide open, and the narrowed project's rows must be restricted while the
 * other project's rows stay completely unrestricted. A plain
 * `repoColumn IN (...)` cannot express that: it would blank the wide-open
 * project down to zero rows. So the predicate is a guarded disjunction —
 * "this (org, project) isn't one of the narrowed ones, OR its repo is in the
 * allow-list" — appended only when `repoColumn` is given and at least one ref
 * actually carries a non-empty `repos`. With no `repoColumn` (the five ADO
 * tables that have no repository column at all: ado_work_items,
 * ado_transitions, ado_deployments, ...) the emitted SQL and params are
 * byte-identical to before this option existed.
 *
 * `opts.alias` qualifies every emitted column (org_url, project, and the
 * repository column) with a table alias, e.g. `pr.org_url` — needed wherever
 * this filter's outer query joins another aliased source that also has a
 * `project` column (review-quality-index.ts / review-quality-trend.ts join a
 * `rv` subquery that does), which would otherwise make a bare `project`
 * ambiguous. Omitting it emits bare column names exactly as before.
 *
 * `opts.areaPathColumn` layers on a per-project area-path restriction (Task 3's
 * `areaPaths` on each `adoProjectRefs` element) — the `ado_work_items`
 * counterpart to `repos`, since that table has no repository column at all.
 * Same guarded-disjunction shape and the same "empty means all, per project"
 * rule as `repoColumn`, but the comparison is by PREFIX rather than exact
 * membership: an area path is a tree, and selecting a parent node in ADO
 * always means its subtree too.
 */
export function adoScopeFilter(
  scope: BoardScope,
  params: Record<string, unknown>,
  opts?: { repoColumn?: string; areaPathColumn?: string; alias?: string },
): string {
  const prefix = opts?.alias ? `${opts.alias}.` : '';
  const orgCol = `${prefix}org_url`;
  const projectCol = `${prefix}project`;

  const refs = scope.adoProjectRefs;
  if (!refs || refs.length === 0) {
    params.adoProjects = scope.adoProjects;
    return `${projectCol} IN {adoProjects:Array(String)}`;
  }
  params.adoProjects = Array.from(new Set(refs.map((r) => r.project)));
  params.adoOrgs = Array.from(new Set(refs.map((r) => r.orgUrl)));
  params.adoRefs = refs.map((r) => `${r.orgUrl}${ADO_REF_SEP}${r.project}`);
  let sql = `${orgCol} IN {adoOrgs:Array(String)}
        AND ${projectCol} IN {adoProjects:Array(String)}
        AND has({adoRefs:Array(String)}, concat(${orgCol}, '${ADO_REF_SEP}', ${projectCol}))`;

  const scopedRefs = refs.filter((r) => r.repos && r.repos.length > 0);
  if (opts?.repoColumn && scopedRefs.length > 0) {
    const repoCol = `${prefix}${opts.repoColumn}`;
    params.adoRepoScopedRefs = scopedRefs.map((r) => `${r.orgUrl}${ADO_REF_SEP}${r.project}`);
    params.adoRepoRefs = scopedRefs.flatMap((r) =>
      (r.repos ?? []).map((repo) => `${r.orgUrl}${ADO_REF_SEP}${r.project}${ADO_REF_SEP}${repo}`),
    );
    sql += `
        AND ( NOT has({adoRepoScopedRefs:Array(String)}, concat(${orgCol}, '${ADO_REF_SEP}', ${projectCol}))
              OR  has({adoRepoRefs:Array(String)}, concat(${orgCol}, '${ADO_REF_SEP}', ${projectCol}, '${ADO_REF_SEP}', ${repoCol})) )`;
  }

  // Per-project area-path restriction, the ado_work_items counterpart to
  // `repos`. Same guarded-disjunction shape and the same "empty means all, per
  // project" rule, but compared by PREFIX: area paths are a tree, and selecting
  // a parent node in ADO always means its subtree. The stored value is used
  // verbatim — ADO separates with backslashes and nothing normalises them.
  const areaScopedRefs = refs.filter((r) => r.areaPaths && r.areaPaths.length > 0);
  if (opts?.areaPathColumn && areaScopedRefs.length > 0) {
    const areaCol = `${prefix}${opts.areaPathColumn}`;
    params.adoAreaScopedRefs = areaScopedRefs.map((r) => `${r.orgUrl}${ADO_REF_SEP}${r.project}`);
    params.adoAreaPaths = areaScopedRefs.flatMap((r) => r.areaPaths ?? []);
    sql += `
        AND ( NOT has({adoAreaScopedRefs:Array(String)}, concat(${orgCol}, '${ADO_REF_SEP}', ${projectCol}))
              OR  arrayExists(p -> startsWith(${areaCol}, p), {adoAreaPaths:Array(String)}) )`;
  }
  return sql;
}

/**
 * WHERE fragment scoping a Jira table to the board's projects, and — where the
 * board's source carries a resolved `jqlFilter` — to the issue keys that filter
 * admits.
 *
 * The project `IN` is always emitted, both because it is the correct scope on an
 * unfiltered board and because every Jira table's primary key leads with
 * `project_key`, so it still prunes.
 *
 * The narrowing clause is a guarded disjunction — "this project isn't one of the
 * narrowed ones, OR this issue is in its allow-list" — for the same reason
 * `adoScopeFilter`'s `repos` handling is: "empty means all" is per-PROJECT, and a
 * plain `keyColumn IN (...)` would blank a wide-open project down to zero rows.
 * It is appended only when at least one ref actually carries a non-empty
 * `issueKeys`, so a board with no filters emits SQL and params byte-identical to
 * before this function existed.
 *
 * `jiraAllowedKeys` is flat across projects rather than a per-project map. That
 * is sound because a Jira issue key embeds its own project (`RDRR-123`), so keys
 * from two projects cannot collide, and `jiraKeyScopedProjects` is what decides
 * which projects the allow-list applies to.
 *
 * `opts.keyColumn` names the issue-key column: `key` on `jira_issues` (the
 * default), `issue_key` on `jira_transitions`. `opts.alias` qualifies every
 * emitted column, needed wherever the outer query joins another aliased source
 * that also has a `project_key`.
 */
export function jiraScopeFilter(
  scope: BoardScope,
  params: Record<string, unknown>,
  opts?: { keyColumn?: string; alias?: string },
): string {
  const prefix = opts?.alias ? `${opts.alias}.` : '';
  const projectCol = `${prefix}project_key`;
  const keyCol = `${prefix}${opts?.keyColumn ?? 'key'}`;

  const refs = scope.jiraProjectRefs;
  if (!refs || refs.length === 0) {
    params.jiraProjects = scope.jiraProjectKeys;
    return `${projectCol} IN {jiraProjects:Array(String)}`;
  }

  params.jiraProjects = Array.from(new Set(refs.map((r) => r.projectKey)));
  let sql = `${projectCol} IN {jiraProjects:Array(String)}`;

  const narrowed = refs.filter((r) => r.issueKeys && r.issueKeys.length > 0);
  if (narrowed.length > 0) {
    params.jiraKeyScopedProjects = narrowed.map((r) => r.projectKey);
    params.jiraAllowedKeys = narrowed.flatMap((r) => r.issueKeys ?? []);
    sql += `
        AND ( NOT has({jiraKeyScopedProjects:Array(String)}, ${projectCol})
              OR  has({jiraAllowedKeys:Array(String)}, ${keyCol}) )`;
  }
  return sql;
}

// Canonical issue shape: id, created_at, closed_at, state, type, assignee,
// sprint_name, source.
//
// Per-provider divergences (see clickhouse/schemas/{01,09,30}_*.sql):
//   jira_issues:    status_category (not state), issue_type, assignee,
//                   resolved_at (not closed_at), sprint_name. resolved_at is
//                   frequently NULL — many workflows close by status transition
//                   without setting a resolution date — so closed_at falls back
//                   to the first "done" transition (jira_transitions), matching
//                   how issue-cycle.ts / flow-throughput-cycle.ts detect done.
//                   This keeps every closed_at-based widget (throughput,
//                   investment-allocation, issues-opened-vs-closed, time-to-
//                   restore) from silently undercounting Jira closes.
//
//                   The fallback MUST be wrapped in nullIf(..., toDateTime(0)):
//                   ClickHouse runs with join_use_nulls = 0, so a LEFT JOIN miss
//                   yields the joined column's DEFAULT rather than NULL, and
//                   `transitioned_at` is a non-nullable DateTime whose default is
//                   1970-01-01. Without the guard every never-closed issue reads
//                   as "closed in 1970", which is not NULL and not in any recent
//                   window — that silently zeroed WIP_COUNT for Jira boards.
//
// Every issue table is ReplacingMergeTree(synced_at), so each leg pins FINAL to
// drop superseded row versions; otherwise re-synced issues are counted twice.
// The Jira leg is aliased (it joins the transitions aggregate) and ClickHouse
// expects FINAL after the alias — `AS ji FINAL`.
//   github_issues:  native state ('open'/'closed'), no type column (derive
//                   from labels: 'bug'/'defect' → 'Bug', else 'Other'),
//                   assignee_login, closed_at, no sprint.
//   ado_work_items: native state (workflow names — 'To Do', 'Active', 'Done', ...),
//                   work_item_type, assigned_to, closed_at, sprint_name.
const JIRA_ISSUES_COLUMNS = `
  toString(id)                                                                      AS id,
  created_at                                                                        AS created_at,
  coalesce(resolved_at, nullIf(done_tr.done_at, toDateTime(0)))                      AS closed_at,
  status_category                                                                   AS state,
  issue_type                                                                        AS type,
  assignee                                                                          AS assignee,
  sprint_name                                                                       AS sprint_name
`;

const GITHUB_ISSUES_COLUMNS = `
  toString(id)                                                                      AS id,
  created_at                                                                        AS created_at,
  closed_at                                                                         AS closed_at,
  state                                                                             AS state,
  if(hasAny(arrayMap(x -> lowerUTF8(x), labels), ['bug', 'defect']), 'Bug', 'Other') AS type,
  assignee_login                                                                    AS assignee,
  CAST(NULL AS Nullable(String))                                                    AS sprint_name
`;

const ADO_ISSUES_COLUMNS = `
  toString(id)                                                                      AS id,
  created_at                                                                        AS created_at,
  closed_at                                                                         AS closed_at,
  state                                                                             AS state,
  work_item_type                                                                    AS type,
  assigned_to                                                                       AS assignee,
  sprint_name                                                                       AS sprint_name
`;

// gitlab_issues: native state ('opened'/'closed' — normalise 'opened' → 'open'
// so it matches the github leg), no type column (derive from labels the same
// way as github: 'bug'/'defect' → 'Bug', else 'Other'), assignee_username, no
// sprint.
const GITLAB_ISSUES_COLUMNS = `
  toString(id)                                                                      AS id,
  created_at                                                                        AS created_at,
  closed_at                                                                         AS closed_at,
  if(state = 'opened', 'open', state)                                               AS state,
  if(hasAny(arrayMap(x -> lowerUTF8(x), labels), ['bug', 'defect']), 'Bug', 'Other') AS type,
  assignee_username                                                                 AS assignee,
  CAST(NULL AS Nullable(String))                                                    AS sprint_name
`;

export function issuesUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    // closed_at falls back to the first done transition when resolved_at is NULL
    // (see JIRA_ISSUES_COLUMNS note). Pre-aggregate transitions per issue, then
    // LEFT JOIN so issues with neither a resolution date nor a done transition
    // still appear (closed_at stays NULL = still open).
    legs.push(`SELECT ${JIRA_ISSUES_COLUMNS}, 'jira' AS source
      FROM cockpit.jira_issues AS ji FINAL
      LEFT JOIN (
        SELECT issue_key, min(transitioned_at) AS done_at
        FROM cockpit.jira_transitions
        WHERE ${jiraScopeFilter(scope, params, { keyColumn: 'issue_key' })}
          AND ${chNormalizedStatusExpr('to_status')} IN {jiraDoneStatuses:Array(String)}
        GROUP BY issue_key
      ) AS done_tr ON done_tr.issue_key = ji.key
      WHERE ${jiraScopeFilter(scope, params, { alias: 'ji' })}`);
    params.jiraDoneStatuses = [...DONE_STATUS_NAMES];
  }
  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${GITHUB_ISSUES_COLUMNS}, 'github' AS source
      FROM cockpit.github_issues FINAL WHERE repo_full_name IN {ghRepos:Array(String)}`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  if (scope.gitlabProjectPaths.length) {
    legs.push(`SELECT ${GITLAB_ISSUES_COLUMNS}, 'gitlab' AS source
      FROM cockpit.gitlab_issues FINAL WHERE project_path IN {glIssuePaths:Array(String)}`);
    params.glIssuePaths = scope.gitlabProjectPaths;
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${ADO_ISSUES_COLUMNS}, 'ado' AS source
      FROM cockpit.ado_work_items FINAL WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })}`);
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Canonical FOCUS task shape: id, provider, key, title, description, state,
// assignee, created_at, epic_key.
//
// Deliberately NOT `issuesUnion`, for one reason that matters: this selects the
// RAW workflow state (`status` / `state`), where issuesUnion selects Jira's
// `status_category`. The Focus view's delivery-stage map keys on states like
// 'QA In Progress', 'Deployed to Uat' and 'Approved' — the whole point of the
// funnel is that 'Approved' means groomed here and finished elsewhere, and
// status_category flattens exactly that distinction away.
//
// GitHub and GitLab have no leg. The view reports where a TEAM's tracked work
// went, and this install tracks that in Jira and ADO; adding an issues-from-
// GitHub leg would mix a different unit of work into the denominators.
//
// ado_work_items has no epic column — parent_ado_id is a work-item link, not a
// roadmap epic — so its epic_key is NULL and attribution falls to the classifier.
// That is the normal case rather than the exception: only 12 of the reference
// window's 105 tasks carried an epic link at all.
//
// ONE key per row: `task_key`, which is what a person reads and what the
// transition tables join on. There was briefly a second, `board_item_key`, to
// match the spelling `classification-mirror.ts` writes into
// `board_item_classification` — but CAPEX and the on-board check now read
// Postgres directly, so there is no second spelling to keep in step and no
// translation to get wrong.
const JIRA_FOCUS_COLUMNS = `
  toString(id)        AS id,
  key                 AS task_key,
  summary             AS title,
  description         AS description,
  status              AS state,
  assignee            AS assignee,
  created_at          AS created_at,
  updated_at          AS updated_at,
  epic_key            AS epic_key`;

const ADO_FOCUS_COLUMNS = `
  toString(ado_id)    AS id,
  concat('ADO-', toString(ado_id)) AS task_key,
  title               AS title,
  description         AS description,
  state               AS state,
  assigned_to         AS assignee,
  created_at          AS created_at,
  updated_at          AS updated_at,
  CAST(NULL AS Nullable(String)) AS epic_key`;

export function focusTasksUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.jiraProjectKeys.length) {
    legs.push(`SELECT ${JIRA_FOCUS_COLUMNS}, 'jira' AS provider
      FROM cockpit.jira_issues FINAL WHERE ${jiraScopeFilter(scope, params)}`);
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${ADO_FOCUS_COLUMNS}, 'ado' AS provider
      FROM cockpit.ado_work_items FINAL WHERE ${adoScopeFilter(scope, params, { areaPathColumn: 'area_path' })}`);
  }

  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Canonical PR shape every caller can rely on:
//   id, repo, number, title, created_at, merged_at, closed_at, state, author,
//   additions, deletions, cycle_time_hours, first_review_at, is_ai_assisted,
//   linked_ticket_keys, source.
//
// `id` is the provider's internal identifier and is not shown to anyone; `repo`
// and `number` are the pair a human recognises and can search for, which is what
// the PR scatter labels its points with. `repo` is also the column the
// PR_CYCLE_TIME_SCATTER `repo` drill dimension names — it was declared in
// drill.ts long before any leg projected it, so `?filter=repo:...` passed the
// dimension check and then failed in ClickHouse with UNKNOWN_IDENTIFIER.
//
// Each provider table has a different physical schema (see clickhouse/schemas/),
// so each leg aliases its native columns into this shape:
//   github_pull_requests:   author_login, state, ai_assisted, merged_at,
//                           repo_full_name, number
//   gitlab_merge_requests:  author_username, state, ai_assisted, merged_at,
//                           project_path, iid (not number)
//   ado_pull_requests:      created_by_login, status (not state), ai_assisted,
//                           first_vote_at (not first_review_at), no merged_at
//                           (synthesised from status='completed' + closed_at),
//                           pr_id (not number), and no single repo identifier —
//                           repo_name is unique only WITHIN a project, so `repo`
//                           is the project/repo pair for the same reason
//                           adoScopeFilter keys on (org_url, project).
const GITHUB_PR_COLUMNS = `
  toString(id)                                AS id,
  repo_full_name                              AS repo,
  number                                      AS number,
  title                                       AS title,
  created_at                                  AS created_at,
  merged_at                                   AS merged_at,
  closed_at                                   AS closed_at,
  state                                       AS state,
  author_login                                AS author,
  additions                                   AS additions,
  deletions                                   AS deletions,
  cycle_time_hours                            AS cycle_time_hours,
  first_review_at                             AS first_review_at,
  ai_assisted                                 AS is_ai_assisted,
  linked_ticket_keys                          AS linked_ticket_keys
`;

const GITLAB_MR_COLUMNS = `
  toString(id)                                AS id,
  project_path                                AS repo,
  iid                                         AS number,
  title                                       AS title,
  created_at                                  AS created_at,
  merged_at                                   AS merged_at,
  closed_at                                   AS closed_at,
  state                                       AS state,
  author_username                             AS author,
  additions                                   AS additions,
  deletions                                   AS deletions,
  cycle_time_hours                            AS cycle_time_hours,
  first_review_at                             AS first_review_at,
  ai_assisted                                 AS is_ai_assisted,
  linked_ticket_keys                          AS linked_ticket_keys
`;

// ADO writes raw status ('completed' | 'active' | 'abandoned') and has no
// merged_at column. Map status → state ('completed' → 'merged', 'abandoned' →
// 'closed', else passthrough) and synthesise merged_at from closed_at when
// completed, so outer queries can filter (`merged_at IS NOT NULL` /
// `state = 'merged'`) uniformly across providers.
const ADO_PR_COLUMNS = `
  toString(id)                                                                   AS id,
  concat(project, '/', repo_name)                                                AS repo,
  pr_id                                                                          AS number,
  title                                                                          AS title,
  created_at                                                                     AS created_at,
  if(status = 'completed', closed_at, CAST(NULL AS Nullable(DateTime)))          AS merged_at,
  closed_at                                                                      AS closed_at,
  if(status = 'completed', 'merged', if(status = 'abandoned', 'closed', status)) AS state,
  created_by_login                                                               AS author,
  additions                                                                      AS additions,
  deletions                                                                      AS deletions,
  cycle_time_hours                                                               AS cycle_time_hours,
  first_vote_at                                                                  AS first_review_at,
  ai_assisted                                                                    AS is_ai_assisted,
  linked_ticket_keys                                                             AS linked_ticket_keys
`;

export function pullRequestsUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${GITHUB_PR_COLUMNS}, 'github' AS source
      FROM cockpit.github_pull_requests WHERE repo_full_name IN {ghRepos:Array(String)}`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  if (scope.gitlabProjectPaths.length) {
    legs.push(`SELECT ${GITLAB_MR_COLUMNS}, 'gitlab' AS source
      FROM cockpit.gitlab_merge_requests WHERE project_path IN {glPaths:Array(String)}`);
    params.glPaths = scope.gitlabProjectPaths;
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${ADO_PR_COLUMNS}, 'ado' AS source
      FROM cockpit.ado_pull_requests WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })}`);
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Canonical commit shape: sha, committed_at, author, message, additions,
// deletions, is_merge_commit, is_ai_assisted, source.
//
// Per-provider divergences (see clickhouse/schemas/{11,21,32}_*_commits.sql):
//   github_commits: author_login (Nullable) + author_email
//   gitlab_commits: NO author_login — only author_name + author_email
//   ado_commits:    author_login (Nullable) + author_email
// All three use ai_assisted (not is_ai_assisted).
//
// Author aliasing favours git email as a cross-provider identity fallback —
// every commit has a non-null email, whereas login is provider-specific and
// often null for bot / unauthored commits.
const GITHUB_COMMIT_COLUMNS = `
  sha                                         AS sha,
  committed_at                                AS committed_at,
  coalesce(author_login, author_email)        AS author,
  message                                     AS message,
  additions                                   AS additions,
  deletions                                   AS deletions,
  is_merge_commit                             AS is_merge_commit,
  ai_assisted                                 AS is_ai_assisted
`;

const GITLAB_COMMIT_COLUMNS = `
  sha                                         AS sha,
  committed_at                                AS committed_at,
  author_email                                AS author,
  message                                     AS message,
  additions                                   AS additions,
  deletions                                   AS deletions,
  is_merge_commit                             AS is_merge_commit,
  ai_assisted                                 AS is_ai_assisted
`;

const ADO_COMMIT_COLUMNS = `
  sha                                         AS sha,
  committed_at                                AS committed_at,
  coalesce(author_login, author_email)        AS author,
  message                                     AS message,
  additions                                   AS additions,
  deletions                                   AS deletions,
  is_merge_commit                             AS is_merge_commit,
  ai_assisted                                 AS is_ai_assisted
`;

export function commitsUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${GITHUB_COMMIT_COLUMNS}, 'github' AS source
      FROM cockpit.github_commits WHERE repo_full_name IN {ghRepos:Array(String)}`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  if (scope.gitlabProjectPaths.length) {
    legs.push(`SELECT ${GITLAB_COMMIT_COLUMNS}, 'gitlab' AS source
      FROM cockpit.gitlab_commits WHERE project_path IN {glPaths:Array(String)}`);
    params.glPaths = scope.gitlabProjectPaths;
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${ADO_COMMIT_COLUMNS}, 'ado' AS source
      FROM cockpit.ado_commits WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })}`);
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Canonical review shape: reviewer, provider, submitted_at, is_bot, is_approval.
// github_reviews/ado_reviews/gitlab_reviews are ReplacingMergeTree(synced_at) —
// FINAL drops re-sync duplicates. ADO has no review bots, so is_bot is constant
// 0 there; approval is `vote >= 5` (10 = approved, 5 = approved-with-suggestions).
// gitlab_reviews likewise has no bot signal modeled, so is_bot is constant 0;
// approval is `state = 'approved'` ('commented' is the other native state).
const GITHUB_REVIEW_COLUMNS = `
  reviewer_login                              AS reviewer,
  'github'                                    AS provider,
  submitted_at                                AS submitted_at,
  endsWith(reviewer_login, '[bot]')           AS is_bot,
  lower(state) = 'approved'                   AS is_approval
`;

const ADO_REVIEW_COLUMNS = `
  reviewer_login                              AS reviewer,
  'ado'                                       AS provider,
  submitted_at                                AS submitted_at,
  toUInt8(0)                                  AS is_bot,
  vote >= 5                                   AS is_approval
`;

const GITLAB_REVIEW_COLUMNS = `
  reviewer_username                           AS reviewer,
  'gitlab'                                    AS provider,
  submitted_at                                AS submitted_at,
  toUInt8(0)                                  AS is_bot,
  state = 'approved'                          AS is_approval
`;

export function reviewsUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${GITHUB_REVIEW_COLUMNS}
      FROM cockpit.github_reviews FINAL WHERE repo_full_name IN {ghRepos:Array(String)}`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${ADO_REVIEW_COLUMNS}
      FROM cockpit.ado_reviews FINAL WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })}`);
  }
  if (scope.gitlabProjectPaths.length) {
    legs.push(`SELECT ${GITLAB_REVIEW_COLUMNS}
      FROM cockpit.gitlab_reviews FINAL WHERE project_path IN {glReviewPaths:Array(String)}`);
    params.glReviewPaths = scope.gitlabProjectPaths;
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Per-developer commit shape. Surfaces both author_name and author_email
// (universal across all three commit tables) so the COMMITS_PER_DEV builder can
// key identity on the display name and fall back to email when the name is
// blank. Distinct from commitsUnion (whose shape rework-rate / bot-vs-human
// depend on) so those consumers stay untouched.
const DEV_COMMIT_COLUMNS = `
  author_email   AS author_email,
  author_name    AS author_name,
  committed_at   AS committed_at,
  additions      AS additions,
  deletions      AS deletions,
  ai_assisted    AS ai_assisted
`;

export function developerCommitsUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${DEV_COMMIT_COLUMNS}
      FROM cockpit.github_commits
      WHERE repo_full_name IN {ghRepos:Array(String)} AND is_merge_commit = 0`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  if (scope.gitlabProjectPaths.length) {
    legs.push(`SELECT ${DEV_COMMIT_COLUMNS}
      FROM cockpit.gitlab_commits
      WHERE project_path IN {glPaths:Array(String)} AND is_merge_commit = 0`);
    params.glPaths = scope.gitlabProjectPaths;
  }
  if (scope.adoProjects.length) {
    legs.push(`SELECT ${DEV_COMMIT_COLUMNS}
      FROM cockpit.ado_commits
      WHERE ${adoScopeFilter(scope, params, { repoColumn: 'repo_name' })} AND is_merge_commit = 0`);
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}

// Canonical deployment shape: deployed_at, is_success, is_production, release_key, source.
//
// Real deployment records, so DORA's deploy frequency can stop proxying it from
// merged-PR count (see packages/shared/src/dora.ts and dora-metrics.ts).
//
// Per-provider divergences:
//   ado_deployments:    status ('succeeded' | 'failed' | 'partiallySucceeded' |
//                       'canceled' | ...), is_production already resolved at
//                       ingest from the stage name, completed_at Nullable so the
//                       timestamp coalesces down to started_at.
//   github_deployments: latest_status ('success' | 'failure' | ...) and
//                       `production` (a 0/1 mirror of GitHub's
//                       production_environment). Rows have been ingested by the
//                       worker since Phase 3 but were never read by anything —
//                       this union is their first consumer.
//
// Both tables are ReplacingMergeTree, so each leg pins FINAL: a redeployed or
// re-synced record would otherwise be counted twice and inflate the metric.
// Production classification for ADO is decided HERE, at query time, from the raw
// columns — not read from the ingest-time is_production flag. ADO has no
// "this stage is production" field, so any rule is a guess over names, and the
// rule has already had to change twice against real data. Deciding at query time
// means a revised rule applies retroactively to every ingested row; reading the
// stored flag would need a full re-sync, which the deployment watermark makes
// impossible (the same trap that froze ado_pull_requests).
//
// The rule (chosen deliberately as the tightest of the options):
//   a production-ish name in the STAGE or the RELEASE DEFINITION,
//   AND the release was built from a default/release branch.
//
// Why the definition name matters: in several projects the environment lives in
// the pipeline name while the "stage" is a deployment TARGET —
// 'Authentication PROD - Internal' deploys stage 'C8 - <Service> Auth'. Looking
// only at the stage name reported 0 production deploys for a whole board.
//
// Why the branch clause: it excludes pre-production runs of a prod-named
// pipeline. It also DROPS legitimate production deploys cut from a non-default
// branch — on real data at the time of writing, one project fell from 881 rows
// to 493. That trade was made knowingly.
//
// Why the redirect exclusion: a pipeline named 'PROD-<Project> - PROD to UAT'
// carries PROD in its name but deploys to UAT.
const ADO_PROD_NAME_RE = '(^|[^a-z])(prod|production|live|release)([^a-z]|$)';
const ADO_PROD_DEFINITION_RE = '(^|[^a-z])(prod|production)([^a-z]|$)';
const ADO_PROD_REDIRECT_RE = 'to[^a-z]*(uat|dev|qa|sit|test)';
// Matches 'refs/heads/main', 'refs/heads/master', 'refs/heads/release'. A
// versioned branch like 'release/1.2' deliberately does NOT match — treat that as
// a known limitation rather than loosening the anchor.
const ADO_DEFAULT_BRANCH_RE = '(^|/)(main|master|release)$';

const ADO_DEPLOYMENT_COLUMNS = `
  coalesce(completed_at, started_at)          AS deployed_at,
  status = 'succeeded'                        AS is_success,
  (
       (match(lowerUTF8(environment), '${ADO_PROD_NAME_RE}')
        OR match(lowerUTF8(definition_name), '${ADO_PROD_DEFINITION_RE}'))
   AND NOT match(lowerUTF8(definition_name), '${ADO_PROD_REDIRECT_RE}')
   AND match(lowerUTF8(coalesce(source_branch, '')), '${ADO_DEFAULT_BRANCH_RE}')
  )                                           AS is_production,
  -- One logical release fans out to one deployment row PER STAGE, and some
  -- "stages" are not deploys at all ('Post New Relic Deployment Marker'). Counting
  -- rows inflated deploy frequency 2-4x (worst observed projects: 4.4x, 3.5x).
  -- Callers count DISTINCT release_key so a release reaching production once
  -- counts once. Falls back to the deployment id when release_id is absent, so
  -- those rows stay distinct instead of collapsing into a single bucket.
  concat('ado#', toString(if(release_id > 0, release_id, deployment_id))) AS release_key
`;

// GitHub needs no name guessing and no branch corroboration: `production` is an
// explicit flag on the deployment itself (a mirror of GitHub's
// production_environment), not an inference from a label. ANDing a branch clause
// here would only discard deploys GitHub has already told us were production.
const GITHUB_DEPLOYMENT_COLUMNS = `
  coalesce(latest_status_at, created_at)      AS deployed_at,
  latest_status = 'success'                   AS is_success,
  production                                  AS is_production,
  concat('gh#', toString(deployment_id))      AS release_key
`;

export function deploymentsUnion(scope: BoardScope): UnionResult {
  const legs: string[] = [];
  const params: Record<string, unknown> = {};

  // Projects with an explicit production allow-list get their OWN leg, because
  // no name rule can separate an operational pipeline from a deployment one:
  // 'Restart <region> Core Processor', 'Reset IIS' and 'Publish <Lib>Components'
  // (a NuGet publish) must not count, while
  // 'Release-<App>.Dashboard.sln-Master' must — and none of them carries a
  // prod/production marker. An explicit list is authoritative, so it also skips
  // the heuristic's default-branch requirement, exactly as GitHub's own
  // `production` flag does.
  const configured = scope.adoProdConfig ?? [];
  const configuredKeys = new Set(configured.map((c) => `${c.orgUrl}${ADO_REF_SEP}${c.project}`));
  configured.forEach((cfg, i) => {
    const defsKey = `adoProdDefs${i}`;
    const stagesKey = `adoProdStages${i}`;
    const orgKey = `adoProdOrg${i}`;
    const projKey = `adoProdProject${i}`;
    params[defsKey] = cfg.definitions;
    params[stagesKey] = cfg.stages;
    params[orgKey] = cfg.orgUrl;
    params[projKey] = cfg.project;
    legs.push(`SELECT
        coalesce(completed_at, started_at)                     AS deployed_at,
        status = 'succeeded'                                   AS is_success,
        (has({${defsKey}:Array(String)}, definition_name)
         OR has({${stagesKey}:Array(String)}, environment))    AS is_production,
        concat('ado#', toString(if(release_id > 0, release_id, deployment_id))) AS release_key,
        'ado' AS source
      FROM cockpit.ado_deployments FINAL
      WHERE org_url = {${orgKey}:String} AND project = {${projKey}:String}`);
  });

  // Everything else keeps the heuristic. Configured projects are excluded here so
  // a project is never counted by both rules.
  const heuristicRefs = (scope.adoProjectRefs ?? []).filter(
    (ref) => !configuredKeys.has(`${ref.orgUrl}${ADO_REF_SEP}${ref.project}`),
  );
  const usesHeuristic =
    scope.adoProjects.length > 0 &&
    (scope.adoProjectRefs === undefined || scope.adoProjectRefs.length === 0
      ? true // no refs at all — fall back to project-only filtering
      : heuristicRefs.length > 0);
  if (usesHeuristic) {
    const heuristicScope: BoardScope =
      scope.adoProjectRefs === undefined || scope.adoProjectRefs.length === 0
        ? scope
        : { ...scope, adoProjectRefs: heuristicRefs };
    legs.push(`SELECT ${ADO_DEPLOYMENT_COLUMNS}, 'ado' AS source
      FROM cockpit.ado_deployments FINAL WHERE ${adoScopeFilter(heuristicScope, params)}`);
  }
  if (scope.githubRepoFullNames.length) {
    legs.push(`SELECT ${GITHUB_DEPLOYMENT_COLUMNS}, 'github' AS source
      FROM cockpit.github_deployments FINAL WHERE repo_full_name IN {ghRepos:Array(String)}`);
    params.ghRepos = scope.githubRepoFullNames;
  }
  return { sql: legs.length ? legs.join(' UNION ALL ') : null, params };
}
