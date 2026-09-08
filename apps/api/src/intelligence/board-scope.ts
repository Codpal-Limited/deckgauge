// P1 — Board-scope helper.
// Aggregates the four Board*Source tables for a given board into a flat
// per-provider list of identifiers the ClickHouse queries use as WHERE-IN
// filters. A board with no sources connected yields isEmpty=true so callers
// can short-circuit and return an empty payload without issuing a query.
import type { PrismaClient } from '@deckgauge/db';
import { hasActiveJqlFilter, JQL_FILTER_MATCHES_NOTHING_KEY } from '@deckgauge/shared';

/** Explicit production allow-list for one ADO project. */
export interface AdoProdConfig {
  orgUrl: string;
  project: string;
  definitions: string[];
  stages: string[];
}

export interface BoardScope {
  /** Jira project keys (e.g. ['BWAY','DOS']) — filters jira_issues/transitions/worklogs */
  jiraProjectKeys: string[];
  /**
   * Per-project issue-key restrictions behind {@link jiraProjectKeys}.
   *
   * A board's Jira source may carry a `jqlFilter`; the worker resolves it to the
   * set of issue keys it admits and persists it (`board_jira_source_keys`). The
   * restriction is carried INSIDE the ref it belongs to rather than as a second
   * top-level list, for the same reason `adoProjectRefs` carries `repos`: a
   * caller that reads the project but not the sibling field silently misses the
   * restriction, which is exactly the drift this file's history records.
   *
   * `issueKeys` absent or empty means "no restriction — every issue in the
   * project", never "none": a board whose source has no filter must keep seeing
   * everything. Optional at this level so the many hand-built scopes in tests
   * keep compiling; `resolveBoardScope` always populates it.
   *
   * A source whose `jqlFilter` is ACTIVE but currently matches zero issues is a
   * third case that must not collapse into the second: `board_jira_source_keys`
   * is empty either way, so `resolveBoardScope` tells them apart by checking
   * `jqlFilter` itself (see `resolveSourceIssueKeys`) and, for the zero-match
   * case, populates `issueKeys` with the single sentinel
   * `JQL_FILTER_MATCHES_NOTHING_KEY` (`@deckgauge/shared`) rather than leaving it
   * empty — a value no real Jira key (`PROJECT-<digits>`) can ever equal, so the
   * existing guarded disjunction (`jiraScopeFilter` in `widgets/unions.ts`)
   * narrows the project to nothing, as a filter matching nothing should. This is
   * the Jira-side fix for the same fail-open class `adoProjectRefs.areaPaths`
   * (below) already closed on the ADO side by unioning the raw prefix back into
   * an empty expansion; a JQL allow-list has no such "keep the input" fallback,
   * since it is a set of concrete keys rather than a prefix, so the sentinel is
   * the equivalent fail-closed device here.
   */
  jiraProjectRefs?: Array<{ projectKey: string; issueKeys?: string[] }>;
  /** GitHub repo full names (e.g. ['Acme/api']) — filters github_pull_requests/commits/reviews */
  githubRepoFullNames: string[];
  /** ADO projects (e.g. ['Acme/PaymentsService']) — filters ado_pull_requests/work_items */
  adoProjects: string[];
  /**
   * Exact (orgUrl, project) pairs behind {@link adoProjects}.
   *
   * ADO project names are unique only WITHIN an organisation, and more than one
   * org can be connected at once — a real install had two, each with a project
   * of the same name differing only in case, kept apart only by ClickHouse's IN being
   * case-sensitive. Filtering on project name alone would blend both orgs' PRs,
   * commits and work items into both boards.
   *
   * Optional so the many hand-built scopes in tests keep compiling; the ADO
   * union legs fall back to project-name-only filtering when it is absent,
   * which is correct for a single-org install. getBoardScope always populates
   * it, so the real query path is always exact.
   *
   * `repos` is the per-board ADO repository restriction
   * (`BoardAdoSource.intelligenceRepos`), carried INSIDE the ref it belongs to
   * rather than as a second top-level list — the same drift `adoProjectRefs`
   * itself once caused (see the doc comment on {@link resolveBoardScope}) is
   * exactly what a parallel field here would risk: a caller that reads the
   * project but not the sibling field would silently miss the restriction.
   * Optional, and absent/empty both mean "no restriction — all repositories",
   * never "none": a board that has not been narrowed must keep seeing
   * everything. On an (orgUrl, project) collision between two sources the
   * lists union and an empty list wins, for the same reason.
   *
   * `areaPaths` is the ado_work_items counterpart to `repos`
   * (`BoardAdoSource.intelligenceAreaPaths`) — `repos` cannot narrow work
   * items at all, since `ado_work_items` has no repository column. Same
   * optional/empty-means-all/union-on-collision rules as `repos`, but matched
   * by PREFIX in `adoScopeFilter` rather than exact membership.
   */
  adoProjectRefs?: Array<{ orgUrl: string; project: string; repos?: string[]; areaPaths?: string[] }>;
  /**
   * Per-project overrides for which release pipelines / stages count as a
   * PRODUCTION deploy. Only projects that have been configured appear here;
   * anything absent falls back to the name heuristic in deploymentsUnion.
   */
  adoProdConfig?: AdoProdConfig[];
  /** GitLab project paths (e.g. ['Acme/api']) — filters gitlab_merge_requests/commits */
  gitlabProjectPaths: string[];
  /** True when no sources are connected for this board. */
  isEmpty: boolean;
}

const EMPTY_SCOPE: BoardScope = {
  jiraProjectKeys: [],
  githubRepoFullNames: [],
  adoProjects: [],
  adoProjectRefs: [],
  adoProdConfig: [],
  gitlabProjectPaths: [],
  isEmpty: true,
};

/**
 * A scope that has actually been resolved from the database, as opposed to one
 * hand-built in a test: the ADO pair list and production config are always
 * present, never merely optional.
 */
export interface ResolvedBoardScope extends BoardScope {
  jiraProjectRefs: Array<{ projectKey: string; issueKeys?: string[] }>;
  adoProjectRefs: Array<{ orgUrl: string; project: string; repos?: string[]; areaPaths?: string[] }>;
  adoProdConfig: AdoProdConfig[];
}

export interface ResolveBoardScopeOptions {
  /**
   * The caller's organization, or `null` for a membership-less caller.
   *
   * REQUIRED — not optional — so a call site that has not thought about the
   * tenant boundary fails to compile, the same rule §5a set for
   * `PromoteOptions.instanceId` and `PageStateDeps.organizationId`. Before this
   * existed, `board-scope.ts` contained no reference to `organizationId` at all:
   * it resolved the four `Board*Source` tables by `boardId` alone, so the
   * boundary held only by luck of each caller passing a route-verified id — and
   * `intelligence.routes.ts` did not, taking `?boardId=` under the `ANALYTICS`
   * policy, which checks no entity.
   *
   * Nullable because `null` is the break-glass identity, and it is deliberately
   * UNSCOPED here for the same reason `policy.ts`'s board branch leaves its
   * no-membership fallback unscoped: there is no organization to scope to, and
   * denying would change behaviour for every existing single-tenant deployment.
   *
   * The predicate goes through the BOARD relation rather than a column on these
   * tables: `BoardJiraSource` and its three siblings carry no `organizationId`
   * (they reach a tenant through `Board`), and adding one would be a migration
   * this needs no part of.
   */
  organizationId: string | null;
  /**
   * Honour the per-source `useForIntelligence` flag on the GitHub and ADO
   * sources. Jira and GitLab board sources carry no such flag, so they are
   * unaffected either way.
   *
   * True for the intelligence-query path; FALSE for the widget path, which has
   * always read every attached source. That difference is deliberate and
   * load-bearing, which is exactly why it is a named parameter here rather than
   * an accident of two hand-maintained copies — see the note on
   * {@link resolveBoardScope}.
   */
  intelligenceOnly: boolean;
}

/**
 * THE board-scope resolver. Both entry points delegate here.
 *
 * There were two independent implementations of this — `getBoardScope` and
 * `widgets/getWidgetBoardScope` — kept apart on purpose ("different path +
 * namespace, to avoid merge conflicts"). They drifted, twice, and the second
 * time it shipped: `adoProjectRefs` was added to this one to stop two orgs'
 * identically-named projects bleeding into each other, but every
 * board dashboard reads the OTHER one, which had no such field — so the fix
 * passed its tests and changed nothing on screen. Unit tests missed it because
 * they hand-built scopes that already carried the field.
 *
 * One implementation, one place to fix, and the single genuine behavioural
 * difference expressed as a parameter instead of a divergence.
 */
export async function resolveBoardScope(
  prisma: PrismaClient,
  boardId: string,
  { intelligenceOnly, organizationId }: ResolveBoardScopeOptions,
): Promise<ResolvedBoardScope> {
  const intelligenceFilter = intelligenceOnly ? { useForIntelligence: true } : {};
  // See `organizationId` on the options type for why this is empty when null.
  const tenantFilter = organizationId ? { board: { organizationId } } : {};
  const [jiraSources, githubSources, adoSources, gitlabSources] = await Promise.all([
    prisma.boardJiraSource.findMany({
      where: { boardId, ...tenantFilter },
      select: {
        jqlFilter: true,
        jiraProjectSync: { select: { jiraProjectKey: true } },
        filteredKeys: { select: { issueKey: true } },
      },
    }),
    prisma.boardGitHubSource.findMany({
      where: { boardId, ...intelligenceFilter, ...tenantFilter },
      select: { gitHubRepoSync: { select: { repoFullName: true } } },
    }),
    prisma.boardAdoSource.findMany({
      where: { boardId, ...intelligenceFilter, ...tenantFilter },
      select: {
        intelligenceRepos: true,
        intelligenceAreaPaths: true,
        azureDevOpsProjectSync: {
          select: {
            adoProject: true,
            prodReleaseDefinitions: true,
            prodStages: true,
            azureDevOpsInstance: { select: { orgUrl: true } },
          },
        },
      },
    }),
    prisma.boardGitLabSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { gitlabProjectSync: { select: { projectPath: true } } },
    }),
  ]);

  const present = <T>(xs: Array<T | null | undefined>): T[] =>
    xs.filter((v): v is T => v !== null && v !== undefined);

  const jiraProjectKeys = uniq(present(jiraSources.map((s) => s.jiraProjectSync?.jiraProjectKey)));
  // One ref per distinct project key, unioning the key sets of every source on
  // that project. An UNFILTERED source (no rows) wins: its `issueKeys` is left
  // absent, which means "no restriction". Same rule as uniqRefs applies to
  // adoProjectRefs on an (orgUrl, project) collision, and for the same reason —
  // a board that has not been narrowed must keep seeing everything.
  const jiraRefsByProject = new Map<string, { projectKey: string; issueKeys?: string[] }>();
  for (const source of jiraSources) {
    const projectKey = source.jiraProjectSync?.jiraProjectKey;
    if (!projectKey) continue;
    const keys = resolveSourceIssueKeys(source);
    const existing = jiraRefsByProject.get(projectKey);
    if (!existing) {
      jiraRefsByProject.set(
        projectKey,
        keys.length > 0 ? { projectKey, issueKeys: keys } : { projectKey },
      );
      continue;
    }
    // Either side unfiltered ⇒ the project stays unfiltered.
    if (keys.length === 0 || existing.issueKeys === undefined) {
      jiraRefsByProject.set(projectKey, { projectKey });
      continue;
    }
    existing.issueKeys = uniq([...existing.issueKeys, ...keys]);
  }
  const jiraProjectRefs = Array.from(jiraRefsByProject.values());
  const githubRepoFullNames = uniq(
    present(githubSources.map((s) => s.gitHubRepoSync?.repoFullName)),
  );
  const adoProjects = uniq(present(adoSources.map((s) => s.azureDevOpsProjectSync?.adoProject)));
  // Normalised the same way the ADO adapters normalise before writing org_url
  // to ClickHouse (trailing slashes stripped), so the pair filter matches.
  // A source whose instance did not come back (shouldn't happen — the relation
  // is required) contributes no ref rather than throwing; the union then falls
  // back to project-only filtering for the board instead of 500-ing a dashboard.
  const adoProjectRefs = uniqRefs(
    adoSources.flatMap((s) => {
      const orgUrl = s.azureDevOpsProjectSync?.azureDevOpsInstance?.orgUrl;
      const project = s.azureDevOpsProjectSync?.adoProject;
      if (!orgUrl || !project) return [];
      // Empty/absent means "no restriction — all repositories", never "none".
      const repos = s.intelligenceRepos ?? [];
      const areaPaths = s.intelligenceAreaPaths ?? [];
      return [
        {
          orgUrl: orgUrl.replace(/\/+$/, ''),
          project,
          ...(repos.length > 0 ? { repos } : {}),
          ...(areaPaths.length > 0 ? { areaPaths } : {}),
        },
      ];
    }),
  );
  const adoProdConfig = collectAdoProdConfig(
    adoSources.map((s) => ({
      orgUrl: s.azureDevOpsProjectSync?.azureDevOpsInstance?.orgUrl,
      project: s.azureDevOpsProjectSync?.adoProject ?? '',
      definitions: s.azureDevOpsProjectSync?.prodReleaseDefinitions,
      stages: s.azureDevOpsProjectSync?.prodStages,
    })),
  );
  const gitlabProjectPaths = uniq(
    present(gitlabSources.map((s) => s.gitlabProjectSync?.projectPath)),
  );

  const isEmpty =
    jiraProjectKeys.length === 0 &&
    githubRepoFullNames.length === 0 &&
    adoProjects.length === 0 &&
    gitlabProjectPaths.length === 0;

  return {
    jiraProjectKeys,
    jiraProjectRefs,
    githubRepoFullNames,
    adoProjects,
    adoProjectRefs,
    adoProdConfig,
    gitlabProjectPaths,
    isEmpty,
  };
}

export async function getBoardScope(
  prisma: PrismaClient,
  boardId: string,
  organizationId: string | null,
): Promise<BoardScope> {
  return resolveBoardScope(prisma, boardId, { intelligenceOnly: true, organizationId });
}

/**
 * Keep only projects that actually have an override configured, de-duplicated by
 * (org, project). A project with both lists empty is deliberately omitted so the
 * union can tell "configured to nothing" from "not configured" — the former would
 * mean zero production deploys, the latter means use the heuristic.
 */
export function collectAdoProdConfig(
  rows: Array<{
    orgUrl?: string;
    project: string;
    definitions?: string[] | null;
    stages?: string[] | null;
  }>,
): AdoProdConfig[] {
  const byKey = new Map<string, AdoProdConfig>();
  for (const row of rows) {
    if (!row.orgUrl) continue;
    const definitions = row.definitions ?? [];
    const stages = row.stages ?? [];
    if (definitions.length === 0 && stages.length === 0) continue;
    const orgUrl = row.orgUrl.replace(/\/+$/, '');
    byKey.set(`${orgUrl} ${row.project}`, { orgUrl, project: row.project, definitions, stages });
  }
  return Array.from(byKey.values());
}

/** One board's resolved scope, tagged with its id + display name. */
export interface BoardScopeEntry {
  boardId: string;
  boardName: string;
  scope: BoardScope;
}

/**
 * Multi-board scope resolver for P6 comparison views. Resolves each board's
 * single-board scope (via {@link getBoardScope}) plus its display name, in
 * parallel, returning one entry per input board in the requested order.
 * No new SQL — this is a fan-out over the existing single-board path.
 */
export async function getBoardScopes(
  prisma: PrismaClient,
  boardIds: string[],
  organizationId: string | null,
): Promise<BoardScopeEntry[]> {
  return Promise.all(
    boardIds.map(async (boardId) => {
      const [board, scope] = await Promise.all([
        // `findFirst` with the tenant predicate, not `findUnique` by id. The
        // display name is the one field in these payloads a human recognises,
        // and the unscoped read meant a comparison holding a board id from
        // another organization surfaced that board's NAME. Falling back to the
        // id (below) is what a missing board already did, so a foreign board and
        // an absent one now look identical.
        organizationId
          ? prisma.board.findFirst({ where: { id: boardId, organizationId }, select: { name: true } })
          : prisma.board.findFirst({ where: { id: boardId }, select: { name: true } }),
        getBoardScope(prisma, boardId, organizationId),
      ]);
      return { boardId, boardName: board?.name ?? boardId, scope };
    }),
  );
}

export function emptyBoardScope(): BoardScope {
  return { ...EMPTY_SCOPE };
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/**
 * A source's admitted issue keys, distinguishing "no filter" from "a filter
 * that currently matches nothing" — see `JQL_FILTER_MATCHES_NOTHING_KEY`.
 *
 * `filteredKeys` (`board_jira_source_keys`, written by the worker) is EMPTY in
 * both of those cases, so it cannot answer the question on its own. Whether a
 * filter exists at all is already persisted on `jqlFilter`, independent of how
 * many rows it currently resolved to — so that column, not the row count, is
 * what decides which of the two this is. This was the merge-blocking gap: an
 * empty `filteredKeys` from an active-but-zero-match filter used to fall
 * through as "unrestricted" here (and identically in `resolve-scope.ts`'s
 * `collectJiraIssueKeys`), reverting a scoped board to project-wide analytics
 * on ordinary Jira drift (a renamed component, a stale `cf[10001]` id, an
 * ended sprint) with no error anywhere.
 */
function resolveSourceIssueKeys(source: {
  jqlFilter?: string | null;
  filteredKeys?: ReadonlyArray<{ issueKey: string }>;
}): string[] {
  const realKeys = (source.filteredKeys ?? []).map((k) => k.issueKey);
  if (realKeys.length > 0) return realKeys;
  return hasActiveJqlFilter(source.jqlFilter) ? [JQL_FILTER_MATCHES_NOTHING_KEY] : [];
}

/**
 * De-duplicate by (orgUrl, project). On a collision the repo lists UNION, and
 * an empty (or absent) list WINS — because empty means "all repositories",
 * and a restriction from one source must never narrow what another source on
 * the same project already opened up. `areaPaths` follows the identical rule,
 * independently of `repos` — the two are separate restrictions (`repos`
 * narrows PRs/commits/reviews, `areaPaths` narrows work items), so one
 * carrying a restriction must never blank the other's.
 */
function uniqRefs(
  refs: Array<{ orgUrl: string; project: string; repos?: string[]; areaPaths?: string[] }>,
): Array<{ orgUrl: string; project: string; repos?: string[]; areaPaths?: string[] }> {
  const seen = new Map<
    string,
    { orgUrl: string; project: string; repos?: string[]; areaPaths?: string[] }
  >();
  for (const ref of refs) {
    const key = `${ref.orgUrl} ${ref.project}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, ref);
      continue;
    }
    // Either side lacking a restriction (empty/absent) means the merged ref
    // must also lack one — empty wins. Computed independently per field.
    const repos =
      !existing.repos || existing.repos.length === 0 || !ref.repos || ref.repos.length === 0
        ? undefined
        : uniq([...existing.repos, ...ref.repos]);
    const areaPaths =
      !existing.areaPaths ||
      existing.areaPaths.length === 0 ||
      !ref.areaPaths ||
      ref.areaPaths.length === 0
        ? undefined
        : uniq([...existing.areaPaths, ...ref.areaPaths]);
    seen.set(key, {
      orgUrl: ref.orgUrl,
      project: ref.project,
      ...(repos ? { repos } : {}),
      ...(areaPaths ? { areaPaths } : {}),
    });
  }
  return Array.from(seen.values());
}
