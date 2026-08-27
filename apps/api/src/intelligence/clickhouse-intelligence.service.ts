// EI-018 — ClickhouseIntelligenceService.
// P1 — All six query methods accept an optional trailing `scope?: BoardScope`
// parameter. When omitted, behaviour is unchanged. When `scope.isEmpty` is true,
// methods short-circuit with an empty payload. Otherwise WHERE-IN filters are
// added against the columns present on each table (see clickhouse/schemas).
import type { BoardScope } from './board-scope.js';

// P8.6 — minimal Prisma shape we depend on: just the DeveloperProfile lookup.
// Importing the real PrismaClient type would pull a heavyweight dependency
// into this leaf service module; structural typing is enough.
export interface DeveloperProfileLookupClient {
  developerProfile: {
    findMany(args: {
      // `organizationId` is REQUIRED in the structural type, not optional: this
      // is the one place the compiler can insist the tenant predicate is
      // present on a PII read.
      where: { organizationId: string; provider: string; login: { in: string[] } };
      select: { login: true; userId: true; displayName: true };
    }): Promise<Array<{ login: string; userId: string; displayName: string | null }>>;
  };
}

export interface ChQueryClient {
  query(params: { query: string; query_params?: Record<string, unknown>; format?: string }): Promise<{
    json(): Promise<unknown>;
  }>;
}

/**
 * ClickHouse serialises UInt64 as a JSON *string* (the range exceeds a
 * double-precision integer), and `castRows` is an unchecked cast, so the counts
 * arrive as strings while the DTO declares numbers. That lie is not cosmetic:
 * the web layer sums and compares these, where `"3" + 1` is `"31"`.
 *
 * Applied at every `getTeamOverview` return path rather than inside the SQL, so
 * the aggregate stays exact in the database and is narrowed only on the way out.
 */
function toTeamOverview(row: TeamOverviewDto): TeamOverviewDto {
  return {
    prs_merged: Number(row.prs_merged),
    median_cycle_h: row.median_cycle_h === null ? null : Number(row.median_cycle_h),
    active_devs: Number(row.active_devs),
    ai_pct: Number(row.ai_pct),
  };
}

export interface TeamOverviewDto {
  prs_merged: number;
  median_cycle_h: number | null;
  active_devs: number;
  ai_pct: number;
}

export interface DeveloperWeeklyPoint {
  week_start: string;
  prs_merged: number;
  prs_opened: number;
  median_cycle_h: number | null;
  additions: number;
  ai_prs: number;
}

export interface DeveloperAnomaly {
  developer_login: string;
  baseline: number;
  recent: number;
  delta_pct: number;
}

export interface AiBreakdownRow {
  author_login: string;
  ai_prs: number;
  total_prs: number;
  ai_pct: number;
}

export interface TicketCoverageDto {
  coverage_rate: number;
}

/**
 * P8.6 — the DeveloperProfile post-join, and the organization whose profiles it
 * is allowed to see.
 *
 * ONE option rather than two, so `prisma` cannot be supplied without a tenant.
 * `developer_profiles` is now tenant-keyed, and this join reads logins, display
 * names, emails and local user ids — an optional `organizationId` alongside a
 * required client is precisely the shape that lets a caller forget it and read
 * every tenant's directory.
 */
export interface DeveloperProfileJoin {
  prisma: DeveloperProfileLookupClient;
  organizationId: string;
}

export interface ClickhouseIntelligenceServiceOptions {
  client: ChQueryClient;
  // Omit to skip the post-join entirely (userId/displayName come back null).
  profileJoin?: DeveloperProfileJoin;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ClickHouse DateTime params accept 'YYYY-MM-DD HH:MM:SS' (no fractional seconds,
// no trailing Z). Date.prototype.toISOString() returns 'YYYY-MM-DDTHH:MM:SS.sssZ',
// which fails the parameter parser with code 457. Format manually.
function formatDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function castRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as { data: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

export class ClickhouseIntelligenceService {
  private readonly client: ChQueryClient;
  // P8.6 — optional tenant-bound Prisma lookup for the DeveloperProfile post-join.
  private readonly profileJoin?: DeveloperProfileJoin;

  constructor(opts: ClickhouseIntelligenceServiceOptions) {
    this.client = opts.client;
    this.profileJoin = opts.profileJoin;
  }

  async getTeamOverview(from: Date, to: Date, scope?: BoardScope): Promise<TeamOverviewDto> {
    if (scope?.isEmpty) {
      return { prs_merged: 0, median_cycle_h: null, active_devs: 0, ai_pct: 0 };
    }

    // Board-scoped path filters the raw github_pull_requests source table
    // directly by repo_full_name. We compute the same four KPIs from the
    // source rows that fall inside the scope. For board scope we restrict to
    // github only since that's the only repo-level scope the planning doc
    // defines for overview KPIs (Jira project keys don't apply to PR metrics).
    if (scope && scope.githubRepoFullNames.length > 0) {
      const result = await this.client.query({
        query: `
          SELECT
            countIf(state = 'merged')                                          AS prs_merged,
            quantileIf(0.5)(cycle_time_hours, state = 'merged' AND cycle_time_hours IS NOT NULL) AS median_cycle_h,
            count(DISTINCT author_login)                                       AS active_devs,
            round(if(countIf(state = 'merged') = 0, 0,
              sumIf(toUInt32(ai_assisted), state = 'merged') / countIf(state = 'merged') * 100)) AS ai_pct
          FROM cockpit.github_pull_requests
          WHERE created_at BETWEEN {from:DateTime} AND {to:DateTime}
            AND repo_full_name IN ({gh:Array(String)})
        `,
        query_params: {
          from: formatDateTime(from),
          to: formatDateTime(to),
          gh: scope.githubRepoFullNames,
        },
        format: 'JSONEachRow',
      });
      const rows = castRows<TeamOverviewDto>(await result.json());
      const row = rows[0];
      return row
        ? toTeamOverview(row)
        : { prs_merged: 0, median_cycle_h: null, active_devs: 0, ai_pct: 0 };
    }

    // Unscoped (and the original) path — aggregates over deduplicated FINAL
    // source tables instead of the developer_weekly_pr_state MV (which
    // permanently over-counts due to per-block MV fires accumulating
    // ReplacingMergeTree re-sync inserts in the AggregatingMergeTree state).
    const result = await this.client.query({
      query: `
        SELECT
          prs_merged_total                                            AS prs_merged,
          median_cycle_h_raw                                          AS median_cycle_h,
          active_devs,
          round(if(prs_merged_total = 0, 0, ai_count / prs_merged_total * 100)) AS ai_pct
        FROM (
          SELECT
            countIf(is_merged)                            AS prs_merged_total,
            quantileIf(0.5)(cycle_time_hours, is_merged AND cycle_time_hours IS NOT NULL) AS median_cycle_h_raw,
            count(DISTINCT developer_login)               AS active_devs,
            sum(toUInt32(ai_assisted))                    AS ai_count
          FROM (${normalizedWeeklyPrUnionSql()})
          WHERE week_start BETWEEN {from:Date} AND {to:Date}
        )
      `,
      query_params: { from: formatDate(from), to: formatDate(to) },
      format: 'JSONEachRow',
    });
    const rows = castRows<TeamOverviewDto>(await result.json());
    const row = rows[0];
    return row
      ? toTeamOverview(row)
      : { prs_merged: 0, median_cycle_h: null, active_devs: 0, ai_pct: 0 };
  }

  async getDeveloperWeeklyTimeSeries(
    login: string,
    from: Date,
    to: Date,
    scope?: BoardScope,
  ): Promise<DeveloperWeeklyPoint[]> {
    if (scope?.isEmpty) return [];

    // Board-scoped path: compute weekly time series directly from the raw
    // github_pull_requests table so we can filter by repo_full_name. The MV
    // doesn't retain that column.
    if (scope && scope.githubRepoFullNames.length > 0) {
      const result = await this.client.query({
        query: `
          SELECT
            toString(toMonday(created_at))                            AS week_start,
            countIf(state = 'merged')                                 AS prs_merged,
            count()                                                   AS prs_opened,
            quantileIf(0.5)(cycle_time_hours, state = 'merged' AND cycle_time_hours IS NOT NULL) AS median_cycle_h,
            sum(additions)                                            AS additions,
            sumIf(toUInt32(ai_assisted), state = 'merged')            AS ai_prs
          FROM cockpit.github_pull_requests
          WHERE author_login = {login:String}
            AND created_at BETWEEN {from:DateTime} AND {to:DateTime}
            AND repo_full_name IN ({gh:Array(String)})
          GROUP BY week_start
          ORDER BY week_start
        `,
        query_params: {
          login,
          from: formatDateTime(from),
          to: formatDateTime(to),
          gh: scope.githubRepoFullNames,
        },
        format: 'JSONEachRow',
      });
      return castRows<DeveloperWeeklyPoint>(await result.json());
    }

    const result = await this.client.query({
      query: `
        SELECT
          toString(week_start)                                AS week_start,
          countIf(is_merged)                                  AS prs_merged,
          count()                                             AS prs_opened,
          quantileIf(0.5)(cycle_time_hours, is_merged AND cycle_time_hours IS NOT NULL) AS median_cycle_h,
          sum(additions)                                      AS additions,
          sum(toUInt32(ai_assisted))                          AS ai_prs
        FROM (${normalizedWeeklyPrUnionSql()})
        WHERE developer_login = {login:String}
          AND week_start BETWEEN {from:Date} AND {to:Date}
        GROUP BY week_start
        ORDER BY week_start
      `,
      query_params: { login, from: formatDate(from), to: formatDate(to) },
      format: 'JSONEachRow',
    });
    return castRows<DeveloperWeeklyPoint>(await result.json());
  }

  async detectSlowdownAnomalies(
    thresholdPct = -0.4,
    scope?: BoardScope,
  ): Promise<DeveloperAnomaly[]> {
    if (scope?.isEmpty) return [];

    // Board-scoped path: derive baseline/recent from the raw github_pull_requests
    // table so we can apply the repo_full_name filter. Only github-backed
    // boards produce anomaly data; the MV-based unscoped path remains the
    // global fallback.
    if (scope && scope.githubRepoFullNames.length > 0) {
      const result = await this.client.query({
        query: `
          WITH
            weekly AS (
              SELECT author_login                                                AS developer_login,
                     toMonday(created_at)                                        AS week_start,
                     countIf(state = 'merged')                                   AS prs
              FROM cockpit.github_pull_requests
              WHERE created_at BETWEEN now() - INTERVAL 97 DAY AND now() - INTERVAL 14 DAY
                AND repo_full_name IN ({gh:Array(String)})
              GROUP BY developer_login, week_start
            ),
            baseline AS (
              SELECT developer_login, avg(prs) AS avg_weekly_prs
              FROM weekly
              GROUP BY developer_login
            ),
            recent_weekly AS (
              SELECT author_login                                                AS developer_login,
                     toMonday(created_at)                                        AS week_start,
                     countIf(state = 'merged')                                   AS prs
              FROM cockpit.github_pull_requests
              WHERE created_at >= now() - INTERVAL 14 DAY
                AND repo_full_name IN ({gh:Array(String)})
              GROUP BY developer_login, week_start
            ),
            recent AS (
              SELECT developer_login, avg(prs) AS recent_weekly_prs
              FROM recent_weekly
              GROUP BY developer_login
            )
          SELECT
            b.developer_login                              AS developer_login,
            b.avg_weekly_prs                               AS baseline,
            r.recent_weekly_prs                            AS recent,
            (r.recent_weekly_prs - b.avg_weekly_prs) / b.avg_weekly_prs AS delta_pct
          FROM baseline b
          JOIN recent r ON b.developer_login = r.developer_login
          WHERE delta_pct < {threshold:Float64}
          ORDER BY delta_pct ASC
        `,
        query_params: { threshold: thresholdPct, gh: scope.githubRepoFullNames },
        format: 'JSONEachRow',
      });
      return castRows<DeveloperAnomaly>(await result.json());
    }

    const result = await this.client.query({
      query: `
        WITH
          weekly AS (
            SELECT developer_login,
              week_start,
              countIf(is_merged) AS prs
            FROM (${normalizedWeeklyPrUnionSql()})
            WHERE week_start BETWEEN today() - 97 AND today() - 14
            GROUP BY developer_login, week_start, provider
          ),
          baseline AS (
            SELECT developer_login, avg(prs) AS avg_weekly_prs
            FROM weekly
            GROUP BY developer_login
          ),
          recent_weekly AS (
            SELECT developer_login,
              week_start,
              countIf(is_merged) AS prs
            FROM (${normalizedWeeklyPrUnionSql()})
            WHERE week_start >= today() - 14
            GROUP BY developer_login, week_start, provider
          ),
          recent AS (
            SELECT developer_login, avg(prs) AS recent_weekly_prs
            FROM recent_weekly
            GROUP BY developer_login
          )
        SELECT
          b.developer_login                              AS developer_login,
          b.avg_weekly_prs                               AS baseline,
          r.recent_weekly_prs                            AS recent,
          (r.recent_weekly_prs - b.avg_weekly_prs) / b.avg_weekly_prs AS delta_pct
        FROM baseline b
        JOIN recent r ON b.developer_login = r.developer_login
        WHERE delta_pct < {threshold:Float64}
        ORDER BY delta_pct ASC
      `,
      query_params: { threshold: thresholdPct },
      format: 'JSONEachRow',
    });
    return castRows<DeveloperAnomaly>(await result.json());
  }

  async getAiBreakdownByDeveloper(from: Date, scope?: BoardScope): Promise<AiBreakdownRow[]> {
    if (scope?.isEmpty) return [];

    // The github_pull_requests table has `repo_full_name`, so we apply the
    // WHERE-IN filter when scope.githubRepoFullNames is non-empty. When scope
    // is given but only Jira/ADO/GitLab sources exist (no GitHub repos), this
    // table has nothing relevant — return empty rather than the global view.
    if (scope && scope.githubRepoFullNames.length === 0) return [];

    const repoFilter = scope ? 'AND repo_full_name IN ({gh:Array(String)})' : '';
    const params: Record<string, unknown> = { from: formatDateTime(from) };
    if (scope) params.gh = scope.githubRepoFullNames;

    const result = await this.client.query({
      query: `
        SELECT
          author_login                                   AS author_login,
          countIf(ai_assisted = 1)                       AS ai_prs,
          count()                                        AS total_prs,
          if(count() = 0, 0, countIf(ai_assisted = 1) / count()) AS ai_pct
        FROM cockpit.github_pull_requests
        WHERE created_at >= {from:DateTime}
          ${repoFilter}
        GROUP BY author_login
        ORDER BY ai_pct DESC
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    return castRows<AiBreakdownRow>(await result.json());
  }

  async getTicketCoverage(from: Date, scope?: BoardScope): Promise<TicketCoverageDto> {
    if (scope?.isEmpty) return { coverage_rate: 0 };
    if (scope && scope.githubRepoFullNames.length === 0) return { coverage_rate: 0 };

    const repoFilter = scope ? 'AND repo_full_name IN ({gh:Array(String)})' : '';
    const params: Record<string, unknown> = { from: formatDateTime(from) };
    if (scope) params.gh = scope.githubRepoFullNames;

    const result = await this.client.query({
      query: `
        SELECT
          if(count() = 0, 0, countIf(length(linked_ticket_keys) > 0) / count()) AS coverage_rate
        FROM cockpit.github_pull_requests
        WHERE state = 'merged'
          AND created_at >= {from:DateTime}
          ${repoFilter}
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = castRows<TicketCoverageDto>(await result.json());
    return rows[0] ?? { coverage_rate: 0 };
  }

  // EI-021 — unified ticket timeline across Jira / GitHub / GitLab / ADO.
  async getTicketTimeline(key: string, scope?: BoardScope): Promise<TicketTimelineEvent[]> {
    if (scope?.isEmpty) return [];

    // Apply per-source WHERE-IN filters when scope is supplied. Each UNION
    // branch is gated by its own column: jira_transitions.project_key,
    // github_pull_requests.repo_full_name, github_commits.repo_full_name,
    // gitlab_merge_requests.project_path, ado_pull_requests.project.
    const params: Record<string, unknown> = { key };
    if (scope) {
      params.jira = scope.jiraProjectKeys;
      params.gh = scope.githubRepoFullNames;
      params.gl = scope.gitlabProjectPaths;
      params.ado = scope.adoProjects;
    }

    const jiraFilter = scope ? 'AND project_key IN ({jira:Array(String)})' : '';
    const ghPrFilter = scope ? 'AND repo_full_name IN ({gh:Array(String)})' : '';
    const ghCommitFilter = scope ? 'AND repo_full_name IN ({gh:Array(String)})' : '';
    const glFilter = scope ? 'AND project_path IN ({gl:Array(String)})' : '';
    const adoFilter = scope ? 'AND project IN ({ado:Array(String)})' : '';

    const result = await this.client.query({
      query: `
        SELECT * FROM (
          SELECT 'jira'                  AS source,
                 transitioned_at         AS ts,
                 concat('Jira: ', from_status, ' → ', to_status) AS title,
                 transitioned_by         AS actor,
                 issue_key               AS ref
          FROM cockpit.jira_transitions
          WHERE issue_key = {key:String}
          ${jiraFilter}
          UNION ALL
          SELECT 'github'                AS source,
                 created_at              AS ts,
                 concat('GitHub PR #', toString(number), ': ', title) AS title,
                 author_login            AS actor,
                 toString(number)        AS ref
          FROM cockpit.github_pull_requests
          WHERE has(linked_ticket_keys, {key:String})
          ${ghPrFilter}
          UNION ALL
          SELECT 'github-commit'         AS source,
                 committed_at            AS ts,
                 concat('Commit: ', message_subject)             AS title,
                 coalesce(author_login, author_name) AS actor,
                 sha                     AS ref
          FROM cockpit.github_commits
          WHERE has(linked_ticket_keys, {key:String})
          ${ghCommitFilter}
          UNION ALL
          SELECT 'gitlab'                AS source,
                 created_at              AS ts,
                 concat('GitLab MR !', toString(iid), ': ', title) AS title,
                 author_username         AS actor,
                 toString(iid)           AS ref
          FROM cockpit.gitlab_merge_requests
          WHERE has(linked_ticket_keys, {key:String})
          ${glFilter}
          UNION ALL
          SELECT 'ado'                   AS source,
                 created_at              AS ts,
                 concat('ADO PR #', toString(pr_id), ': ', title) AS title,
                 created_by_login        AS actor,
                 toString(pr_id)         AS ref
          FROM cockpit.ado_pull_requests
          WHERE has(linked_ticket_keys, {key:String})
          ${adoFilter}
        )
        ORDER BY ts ASC
        LIMIT 1000
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    return castRows<TicketTimelineEvent>(await result.json());
  }
}

export interface TicketTimelineEvent {
  source: string;
  ts: string;
  title: string;
  actor: string | null;
  ref: string;
}

// P2 — DTOs for the new methods (mirrored in @deckgauge/shared).
// P8.6 — adds userId + displayName joined from DeveloperProfile (Postgres).
export interface DeveloperTableRow {
  login: string;
  prs_merged: number;
  median_cycle_h: number | null;
  ai_pct: number;
  anomaly: boolean;
  sparkline: number[];
  userId: string | null;
  displayName: string | null;
}

export interface DeveloperHeatmapCell {
  date: string;
  count: number;
}

export interface DeveloperRecentPr {
  repo: string;
  number: number;
  title: string;
  merged_at: string | null;
  cycle_h: number | null;
  ai_assisted: boolean;
}

export interface DeveloperAiTrendPoint {
  week_start: string;
  ai_pct: number;
}

export interface DeveloperDetailDto {
  login: string;
  heatmap: DeveloperHeatmapCell[];
  recent_prs: DeveloperRecentPr[];
  ai_trend: DeveloperAiTrendPoint[];
}

export interface PullRequestRow {
  provider: string;
  repo: string;
  number: number;
  title: string;
  author_login: string | null;
  state: string;
  created_at: string;
  merged_at: string | null;
  cycle_hours: number | null;
  ai_assisted: boolean;
}

export interface PullRequestListDto {
  items: PullRequestRow[];
  total: number;
  page: number;
  perPage: number;
}

export interface AiWeeklyTrendPoint {
  week_start: string;
  ai_pct: number;
  total_prs: number;
}

// Re-open the class with the new P2 methods.
// (Implemented via prototype patch below to keep the diff additive and
// preserve the original constructor + private field declaration above.)
declare module './clickhouse-intelligence.service.js' {
  interface ClickhouseIntelligenceService {
    getDeveloperTable(from: Date, to: Date): Promise<DeveloperTableRow[]>;
    getDeveloperDetail(login: string, days?: number): Promise<DeveloperDetailDto>;
    getPullRequestList(opts: {
      from: Date;
      to: Date;
      page?: number;
      perPage?: number;
    }): Promise<PullRequestListDto>;
    getAiWeeklyTrend(from: Date, to: Date): Promise<AiWeeklyTrendPoint[]>;
  }
}

// Normalized, deduplicated, cross-provider PR rows. Replaces reads of the
// developer_weekly_pr_state materialized view, which permanently over-counts:
// a ClickHouse MV fires per inserted block, so ReplacingMergeTree re-sync
// inserts accumulate in the AggregatingMergeTree state and are never
// deduplicated. FINAL on each source table drops those re-sync duplicates.
// Columns mirror the MV's SELECT (clickhouse/schemas/50_materialized_views.sql)
// minus the State() wrappers, so downstream aggregation semantics are unchanged.
// All three provider legs are present at code level; gitlab returns 0 rows today.
function normalizedWeeklyPrUnionSql(): string {
  return `
    SELECT
      author_login         AS developer_login,
      toMonday(created_at) AS week_start,
      'github'             AS provider,
      state = 'merged'     AS is_merged,
      cycle_time_hours     AS cycle_time_hours,
      additions            AS additions,
      deletions            AS deletions,
      ai_assisted          AS ai_assisted
    FROM cockpit.github_pull_requests FINAL
    UNION ALL
    SELECT
      author_username      AS developer_login,
      toMonday(created_at) AS week_start,
      'gitlab'             AS provider,
      state = 'merged'     AS is_merged,
      cycle_time_hours     AS cycle_time_hours,
      additions            AS additions,
      deletions            AS deletions,
      ai_assisted          AS ai_assisted
    FROM cockpit.gitlab_merge_requests FINAL
    UNION ALL
    SELECT
      created_by_login     AS developer_login,
      toMonday(created_at) AS week_start,
      'ado'                AS provider,
      status = 'completed' AS is_merged,
      cycle_time_hours     AS cycle_time_hours,
      additions            AS additions,
      deletions            AS deletions,
      ai_assisted          AS ai_assisted
    FROM cockpit.ado_pull_requests FINAL
  `;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === '1' || v === true;
}

function toNumber(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toSparkline(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => toNumber(x, 0));
}

ClickhouseIntelligenceService.prototype.getDeveloperTable = async function (
  this: ClickhouseIntelligenceService,
  from: Date,
  to: Date,
): Promise<DeveloperTableRow[]> {
  // 12-week PRs per developer aggregated over deduplicated FINAL source tables.
  // Sparkline = weekly counts as an array, ordered oldest-first.
  // Uses groupArray over a sorted subquery so ClickHouse 24.3 doesn't trip
  // over ORDER BY inside an aggregate.
  const client = (this as unknown as { client: ChQueryClient }).client;
  const result = await client.query({
    query: `
      SELECT
        developer_login                                    AS login,
        sum(prs_merged_w)                                  AS prs_merged,
        if(sum(prs_merged_w) = 0, NULL, avg(median_cycle_w)) AS median_cycle_h,
        if(sum(prs_merged_w) = 0, 0,
           sum(ai_count_w) / sum(prs_merged_w))            AS ai_pct,
        0                                                  AS anomaly,
        groupArray(prs_merged_w)                           AS sparkline
      FROM (
        SELECT
          developer_login,
          week_start,
          countIf(is_merged)                    AS prs_merged_w,
          quantileIf(0.5)(cycle_time_hours, is_merged AND cycle_time_hours IS NOT NULL) AS median_cycle_w,
          sum(toUInt32(ai_assisted))            AS ai_count_w
        FROM (${normalizedWeeklyPrUnionSql()})
        WHERE week_start BETWEEN {from:Date} AND {to:Date}
        GROUP BY developer_login, week_start
        ORDER BY week_start ASC
      )
      GROUP BY developer_login
      ORDER BY prs_merged DESC
      LIMIT 200
    `,
    query_params: { from: formatDate(from), to: formatDate(to) },
    format: 'JSONEachRow',
  });
  const rawRows = castRows<Record<string, unknown>>(await result.json());
  const baseRows = rawRows.map((r) => ({
    login: String(r.login ?? ''),
    prs_merged: toNumber(r.prs_merged, 0),
    median_cycle_h: toNullableNumber(r.median_cycle_h),
    ai_pct: toNumber(r.ai_pct, 0),
    anomaly: toBool(r.anomaly),
    sparkline: toSparkline(r.sparkline),
  }));

  // P8.6 — post-join DeveloperProfile via Postgres so the web table can link
  // each login to the local user. If Prisma is not wired in (e.g. legacy
  // tests), or if there are no rows, fall back to nulls.
  const join = (this as unknown as { profileJoin?: DeveloperProfileJoin }).profileJoin;
  if (baseRows.length === 0 || !join) {
    return baseRows.map((r) => ({ ...r, userId: null, displayName: null }));
  }
  const logins = baseRows.map((r) => r.login).filter((l) => l !== '');
  const profiles = await join.prisma.developerProfile.findMany({
    // `organizationId` first: `developer_profiles` is tenant-keyed, and a
    // (provider, login) lookup without it reads every tenant's mapping.
    where: { organizationId: join.organizationId, provider: 'github', login: { in: logins } },
    select: { login: true, userId: true, displayName: true },
  });
  const byLogin = new Map(profiles.map((p) => [p.login, p]));
  return baseRows.map((r) => {
    const p = byLogin.get(r.login);
    return {
      ...r,
      userId: p?.userId ?? null,
      displayName: p?.displayName ?? null,
    };
  });
};

ClickhouseIntelligenceService.prototype.getDeveloperDetail = async function (
  this: ClickhouseIntelligenceService,
  login: string,
  days = 90,
): Promise<DeveloperDetailDto> {
  const client = (this as unknown as { client: ChQueryClient }).client;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  // 1) Heatmap: per-day commit count across providers. GitHub matches by
  //    author_login; ADO commits have no login (NULL) so match by author_email,
  //    which equals the ADO developer's UPN/login. GitHub logins and ADO UPNs
  //    are disjoint, so each developer matches exactly one leg.
  const heatmapResp = await client.query({
    query: `
      -- developer-detail:heatmap
      SELECT
        toString(date) AS date,
        sum(c)         AS count
      FROM (
        SELECT toDate(committed_at) AS date, count() AS c
        FROM cockpit.github_commits
        WHERE author_login = {login:String}
          AND committed_at >= {from:DateTime}
        GROUP BY date
        UNION ALL
        SELECT toDate(committed_at) AS date, count() AS c
        FROM cockpit.ado_commits
        WHERE lower(author_email) = lower({login:String})
          AND committed_at >= {from:DateTime}
        GROUP BY date
      )
      GROUP BY date
      ORDER BY date ASC
    `,
    query_params: { login, from: formatDateTime(from) },
    format: 'JSONEachRow',
  });
  const heatmapRows = castRows<Record<string, unknown>>(await heatmapResp.json()).map((r) => ({
    date: String(r.date ?? ''),
    count: toNumber(r.count, 0),
  }));

  // 2) Recent PRs (last 20) by author, across providers. GitHub matches by
  //    author_login; ADO has no login — created_by_login is the author's
  //    email/UPN, the same key the heatmap's ADO leg uses. Disjoint namespaces
  //    mean a given login matches exactly one leg. FINAL drops ReplacingMergeTree
  //    re-sync duplicates so no PR lists twice. ADO has no merged_at: a completed
  //    PR's merge timestamp is closed_at.
  const prsResp = await client.query({
    query: `
      -- developer-detail:recent-prs
      SELECT repo, number, title, merged_at, cycle_h, ai_assisted
      FROM (
        SELECT
          repo_full_name   AS repo,
          number           AS number,
          title            AS title,
          merged_at        AS merged_at,
          created_at       AS created_at,
          cycle_time_hours AS cycle_h,
          ai_assisted      AS ai_assisted
        FROM cockpit.github_pull_requests FINAL
        WHERE author_login = {login:String}
          AND created_at >= {from:DateTime}
        UNION ALL
        SELECT
          repo_name                                 AS repo,
          pr_id                                     AS number,
          title                                     AS title,
          if(status = 'completed', closed_at, NULL) AS merged_at,
          created_at                                AS created_at,
          cycle_time_hours                          AS cycle_h,
          ai_assisted                               AS ai_assisted
        FROM cockpit.ado_pull_requests FINAL
        WHERE lower(created_by_login) = lower({login:String})
          AND created_at >= {from:DateTime}
      )
      ORDER BY coalesce(merged_at, created_at) DESC
      LIMIT 20
    `,
    query_params: { login, from: formatDateTime(from) },
    format: 'JSONEachRow',
  });
  const recentPrs = castRows<Record<string, unknown>>(await prsResp.json()).map((r) => ({
    repo: String(r.repo ?? ''),
    number: toNumber(r.number, 0),
    title: String(r.title ?? ''),
    merged_at: r.merged_at == null ? null : String(r.merged_at),
    cycle_h: toNullableNumber(r.cycle_h),
    ai_assisted: toBool(r.ai_assisted),
  }));

  // 3) Weekly AI% over the window.
  const aiResp = await client.query({
    query: `
      -- developer-detail:ai-trend
      SELECT
        toString(week_start)                                 AS week_start,
        if(countIf(is_merged) = 0, 0,
           sum(toUInt32(ai_assisted)) / countIf(is_merged)) AS ai_pct
      FROM (${normalizedWeeklyPrUnionSql()})
      WHERE developer_login = {login:String}
        AND week_start BETWEEN {from:Date} AND {to:Date}
      GROUP BY week_start
      ORDER BY week_start ASC
    `,
    query_params: { login, from: formatDate(from), to: formatDate(to) },
    format: 'JSONEachRow',
  });
  const aiTrend = castRows<Record<string, unknown>>(await aiResp.json()).map((r) => ({
    week_start: String(r.week_start ?? ''),
    ai_pct: toNumber(r.ai_pct, 0),
  }));

  return { login, heatmap: heatmapRows, recent_prs: recentPrs, ai_trend: aiTrend };
};

ClickhouseIntelligenceService.prototype.getPullRequestList = async function (
  this: ClickhouseIntelligenceService,
  opts: { from: Date; to: Date; page?: number; perPage?: number },
): Promise<PullRequestListDto> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, Math.min(200, opts.perPage ?? 50));
  const offset = (page - 1) * perPage;
  const client = (this as unknown as { client: ChQueryClient }).client;

  const countResp = await client.query({
    query: `
      -- pr-list:count
      SELECT count() AS total
      FROM cockpit.github_pull_requests
      WHERE created_at BETWEEN {from:DateTime} AND {to:DateTime}
    `,
    query_params: { from: formatDateTime(opts.from), to: formatDateTime(opts.to) },
    format: 'JSONEachRow',
  });
  const totalRows = castRows<Record<string, unknown>>(await countResp.json());
  const total = toNumber(totalRows[0]?.total, 0);

  const itemsResp = await client.query({
    query: `
      -- pr-list:items
      SELECT
        'github'                       AS provider,
        repo_full_name                 AS repo,
        number                         AS number,
        title                          AS title,
        author_login                   AS author_login,
        state                          AS state,
        created_at                     AS created_at,
        merged_at                      AS merged_at,
        cycle_time_hours               AS cycle_hours,
        ai_assisted                    AS ai_assisted
      FROM cockpit.github_pull_requests
      WHERE created_at BETWEEN {from:DateTime} AND {to:DateTime}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: {
      from: formatDateTime(opts.from),
      to: formatDateTime(opts.to),
      limit: perPage,
      offset,
    },
    format: 'JSONEachRow',
  });
  const items = castRows<Record<string, unknown>>(await itemsResp.json()).map((r) => ({
    provider: String(r.provider ?? 'github'),
    repo: String(r.repo ?? ''),
    number: toNumber(r.number, 0),
    title: String(r.title ?? ''),
    author_login: r.author_login == null ? null : String(r.author_login),
    state: String(r.state ?? ''),
    created_at: String(r.created_at ?? ''),
    merged_at: r.merged_at == null ? null : String(r.merged_at),
    cycle_hours: toNullableNumber(r.cycle_hours),
    ai_assisted: toBool(r.ai_assisted),
  }));

  return { items, total, page, perPage };
};

ClickhouseIntelligenceService.prototype.getAiWeeklyTrend = async function (
  this: ClickhouseIntelligenceService,
  from: Date,
  to: Date,
): Promise<AiWeeklyTrendPoint[]> {
  const client = (this as unknown as { client: ChQueryClient }).client;
  const result = await client.query({
    query: `
      SELECT
        toString(week_start)                                  AS week_start,
        if(countIf(is_merged) = 0, 0,
           sum(toUInt32(ai_assisted)) / countIf(is_merged)) AS ai_pct,
        countIf(is_merged)                                    AS total_prs
      FROM (${normalizedWeeklyPrUnionSql()})
      WHERE week_start BETWEEN {from:Date} AND {to:Date}
      GROUP BY week_start
      ORDER BY week_start ASC
    `,
    query_params: { from: formatDate(from), to: formatDate(to) },
    format: 'JSONEachRow',
  });
  const rows = castRows<Record<string, unknown>>(await result.json());
  return rows.map((r) => ({
    week_start: String(r.week_start ?? ''),
    ai_pct: toNumber(r.ai_pct, 0),
    total_prs: toNumber(r.total_prs, 0),
  }));
};
