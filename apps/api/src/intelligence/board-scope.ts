// P1 — Board-scope helper.
// Aggregates the four Board*Source tables for a given board into a flat
// per-provider list of identifiers the ClickHouse queries use as WHERE-IN
// filters. A board with no sources connected yields isEmpty=true so callers
// can short-circuit and return an empty payload without issuing a query.
import type { PrismaClient } from '@deckgauge/db';

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
   */
  adoProjectRefs?: Array<{ orgUrl: string; project: string }>;
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
  adoProjectRefs: Array<{ orgUrl: string; project: string }>;
  adoProdConfig: AdoProdConfig[];
}

export interface ResolveBoardScopeOptions {
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
  { intelligenceOnly }: ResolveBoardScopeOptions,
): Promise<ResolvedBoardScope> {
  const intelligenceFilter = intelligenceOnly ? { useForIntelligence: true } : {};
  const [jiraSources, githubSources, adoSources, gitlabSources] = await Promise.all([
    prisma.boardJiraSource.findMany({
      where: { boardId },
      select: { jiraProjectSync: { select: { jiraProjectKey: true } } },
    }),
    prisma.boardGitHubSource.findMany({
      where: { boardId, ...intelligenceFilter },
      select: { gitHubRepoSync: { select: { repoFullName: true } } },
    }),
    prisma.boardAdoSource.findMany({
      where: { boardId, ...intelligenceFilter },
      select: {
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
      where: { boardId },
      select: { gitlabProjectSync: { select: { projectPath: true } } },
    }),
  ]);

  const present = <T>(xs: Array<T | null | undefined>): T[] =>
    xs.filter((v): v is T => v !== null && v !== undefined);

  const jiraProjectKeys = uniq(present(jiraSources.map((s) => s.jiraProjectSync?.jiraProjectKey)));
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
      return [{ orgUrl: orgUrl.replace(/\/+$/, ''), project }];
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
): Promise<BoardScope> {
  return resolveBoardScope(prisma, boardId, { intelligenceOnly: true });
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
): Promise<BoardScopeEntry[]> {
  return Promise.all(
    boardIds.map(async (boardId) => {
      const [board, scope] = await Promise.all([
        prisma.board.findUnique({ where: { id: boardId }, select: { name: true } }),
        getBoardScope(prisma, boardId),
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

function uniqRefs(
  refs: Array<{ orgUrl: string; project: string }>,
): Array<{ orgUrl: string; project: string }> {
  const seen = new Map<string, { orgUrl: string; project: string }>();
  for (const ref of refs) seen.set(`${ref.orgUrl} ${ref.project}`, ref);
  return Array.from(seen.values());
}
