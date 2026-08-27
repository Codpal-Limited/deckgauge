import {
  visibleConnectionWhere,
  type ConnectionCaller,
} from '../../connections/connection-visibility.js';
import type { PageStateDeps, PageStateResult } from './page-state.types.js';
import { MAX_CONFIG_ROWS, TRUNCATION_NOTE } from './page-state-notes.js';

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * Every instance-wide list is read one row past the cap, so "more rows exist"
 * is known without a second `count` query, and ordered so the capped subset is
 * the same subset on every call. `createdAt: 'desc'` matches the four
 * `*SyncService.list()` methods the sources and connections screens render.
 */
const BOUND = { take: MAX_CONFIG_ROWS + 1, orderBy: { createdAt: 'desc' as const } };

const withBoardCount = { _count: { select: { boardSources: true } } } as const;

/**
 * Last-known sync state for the sources configured for the caller's organization.
 *
 * **Organization-wide, not board-scoped.** The `sources` and `connections` screens
 * both list the sync records themselves (`GET /project-syncs/{jira,github,gitlab,ado}`),
 * so scoping this resolver to one board left it unable to answer the questions
 * actually asked on those pages.
 *
 * **The tenant predicate is not optional, and its absence here was a live leak**
 * (TENANCY-PROGRAMME §5a, fixed 2026-08-26). The docstring this replaces argued
 * that the routes behind these screens are "authentication-only inside the
 * protected plugin … there is no id to verify and therefore no authorization
 * step to add". That is true of AUTHORIZATION and irrelevant to TENANCY. The
 * predicate these reads were missing is the CALLER'S ORGANIZATION — which is not
 * an entity id, needs no id to verify, and is exactly what the four
 * `*SyncService.list()` methods behind those very routes apply. Reading the
 * tables directly instead of calling those services dropped their `where` along
 * with their unbounded `take`; only the `take` was meant to go. Any authenticated
 * member of any organization could therefore ask the Advisor a plain question and
 * be told every other organization's Jira project keys, GitHub repo names, GitLab
 * paths and ADO projects.
 *
 * So each read carries the same two nested predicates as its service, in the same
 * order and for the same reasons (`connections/connection-visibility.ts`):
 *
 *     where: { <instance>: { organizationId, ...visibleConnectionWhere(caller) } }
 *
 * The tenant boundary is the outer one; connection OWNERSHIP within that tenant is
 * the inner one. Both are needed and they are not interchangeable — filtering on
 * `organizationId` alone would close the cross-tenant leak and leave a colleague's
 * PERSONAL connection listed to every member of their organization. Neither sync
 * table carries an organization or an owner of its own: both facts ride on the
 * instance relation, which is why the predicate is nested rather than flat.
 *
 * Reads the four sync tables directly rather than calling the `*SyncService.list()`
 * methods behind those routes: their reads are unbounded (an unbounded query and
 * an unbounded amount of LLM context), and GitHub's omits the per-feed watermarks
 * that are the only way to answer "how far has this repo got?". That remains the
 * right call — but it is a bound this resolver ADDS to those services' reads, never
 * a predicate it drops from them.
 *
 * Deliberately reads stored columns rather than probing: `BoardSourceHealthService.probe()`
 * makes real outbound requests to Jira/GitHub/GitLab/ADO, and a tool the model invokes on
 * every question must not generate network traffic or burn provider rate limits. The payload
 * says so explicitly, so the model does not present a stored stamp as a live connection check.
 *
 * Shapes are per-provider on purpose. The providers genuinely do not share a sync-state
 * vocabulary:
 * - GitHub (`GitHubRepoSync`) tracks one watermark per feed and has no single per-feed
 *   `lastSyncedAt`. Synthesizing one — or silently picking the newest watermark and calling
 *   it that — would be a confidently-wrong answer, which is the exact failure this resolver
 *   exists to avoid. Its `lastSuccessAt` is reported under its own name: it is the last
 *   successful run of the bulk repo sync, which is what `board-sync.service.ts` reads as
 *   GitHub's last-synced signal, so reporting it keeps the Advisor and the UI in agreement.
 *   `disabledAt` and `tier` come with it, because they decide whether the repo runs at all
 *   (`github-intelligence-fanout.handler.ts` selects `disabledAt: null`) and how often
 *   (hot=1h, warm=6h, cold=24h) — without them a frozen watermark reads as a failure.
 * - ADO's (`AzureDevOpsProjectSync`) `lastSyncedAt` is the PR/commit *intelligence* stamp, not a
 *   work-item sync stamp (see the doc comment above `lastRevisionSyncAt` in schema.prisma). A
 *   project that syncs work items but has no linked repositories never sets it, so labelling it
 *   "last synced" would read a perfectly healthy sync as dead. It is reported here under a name
 *   that says what it actually is, alongside the opt-in flags and repo selection that decide
 *   whether its PR/commit intelligence runs at all.
 *
 * Jira and GitLab do carry a genuine single `lastSyncedAt` on their sync record, so those are
 * reported as-is, with the per-record flags that decide what each collects.
 *
 * Error detail is GitHub-only, and asymmetrically so: `GitHubRepoSync` has `lastErrorAt` /
 * `lastErrorMessage`, while `JiraProjectSync`, `GitLabProjectSync` and `AzureDevOpsProjectSync`
 * genuinely have no error columns to report. The note says this explicitly — otherwise a model
 * asked "did my Jira sync fail?" sees no error field and can imply it looked and found nothing.
 *
 * Every entry carries a `label` identifying which specific source it is (Jira's
 * `jiraProjectKey`, GitHub's `repoFullName`, GitLab's `projectPath`, ADO's `adoProject`) plus
 * the `instance` it belongs to — organization-wide, a label alone can collide, since the uniqueness
 * constraint on each sync table is per instance. It also carries `boardCount`: with no board in
 * scope, nothing else in the payload says whether a source feeds any board at all, and a sync
 * row attached to zero boards is the ordinary explanation for a board that stays empty while
 * its source looks healthy.
 */
export async function resolveSourcesPageState(deps: PageStateDeps): Promise<PageStateResult> {
  // Rebuilt from the caller facts the route threaded in, rather than passed as a
  // ready-made `ConnectionCaller`: `PageStateDeps` is one flat bag of caller
  // facts shared by every resolver, and `userId` is already on it — as `string`,
  // because a page-state read always has an authenticated caller, where
  // `ConnectionCaller.userId` is optional for the request that resolved no local
  // user. Widening it here rather than narrowing it there keeps that distinction.
  const caller: ConnectionCaller = {
    userId: deps.userId,
    organizationId: deps.organizationId,
    isOrgAdmin: deps.isOrgAdmin,
  };
  // Ownership rides on the SAME relation as tenancy: a sync row carries neither
  // an organization nor an owner of its own. Identical to the `where` in each
  // `*SyncService.list()`, deliberately — the two must not be able to disagree
  // about what this member may see.
  const visible = visibleConnectionWhere(caller);
  const scope = { organizationId: caller.organizationId, ...visible };

  const [jira, github, gitlab, ado] = await Promise.all([
    deps.prisma.jiraProjectSync.findMany({
      ...BOUND,
      where: { jiraInstance: scope },
      include: { ...withBoardCount, jiraInstance: { select: { name: true } } },
    }),
    deps.prisma.gitHubRepoSync.findMany({
      ...BOUND,
      where: { githubInstance: scope },
      include: {
        ...withBoardCount,
        githubInstance: { select: { org: true, baseUrl: true } },
      },
    }),
    deps.prisma.gitLabProjectSync.findMany({
      ...BOUND,
      where: { gitlabInstance: scope },
      include: { ...withBoardCount, gitlabInstance: { select: { name: true } } },
    }),
    deps.prisma.azureDevOpsProjectSync.findMany({
      ...BOUND,
      where: { azureDevOpsInstance: scope },
      include: { ...withBoardCount, azureDevOpsInstance: { select: { name: true } } },
    }),
  ]);

  const sources = [
    ...jira.slice(0, MAX_CONFIG_ROWS).map((row) => ({
      provider: 'jira' as const,
      label: row.jiraProjectKey,
      instance: row.jiraInstance.name,
      lastSyncedAt: iso(row.lastSyncedAt),
      syncChangelog: row.syncChangelog,
      syncWorklogs: row.syncWorklogs,
      boardCount: row._count.boardSources,
    })),
    ...github.slice(0, MAX_CONFIG_ROWS).map((row) => ({
      provider: 'github' as const,
      label: row.repoFullName,
      // GitHubInstance has no name column; the org is its identity, and the
      // base URL is the only identity a self-hosted instance with no org has.
      instance: row.githubInstance.org.trim() || row.githubInstance.baseUrl,
      // No single per-feed lastSyncedAt exists for GitHub — one watermark per feed instead.
      watermarks: {
        pullRequests: iso(row.prsWatermark),
        commits: iso(row.commitsWatermark),
        reviews: iso(row.reviewsWatermark),
        workflowRuns: iso(row.workflowRunsWatermark),
        deployments: iso(row.deploymentsWatermark),
        issues: iso(row.issuesWatermark),
      },
      lastSuccessAt: iso(row.lastSuccessAt),
      lastErrorAt: iso(row.lastErrorAt),
      lastErrorMessage: row.lastErrorMessage,
      tier: row.tier,
      disabledAt: iso(row.disabledAt),
      boardCount: row._count.boardSources,
    })),
    ...gitlab.slice(0, MAX_CONFIG_ROWS).map((row) => ({
      provider: 'gitlab' as const,
      label: row.projectPath,
      instance: row.gitlabInstance.name,
      lastSyncedAt: iso(row.lastSyncedAt),
      syncPrs: row.syncPrs,
      syncCommits: row.syncCommits,
      boardCount: row._count.boardSources,
    })),
    ...ado.slice(0, MAX_CONFIG_ROWS).map((row) => ({
      provider: 'ado' as const,
      label: row.adoProject,
      instance: row.azureDevOpsInstance.name,
      // `lastSyncedAt` on AzureDevOpsProjectSync is the PR/commit intelligence
      // stamp, NOT a work-item stamp: a repo-less project syncs work items
      // fine and never stamps it. Reported under names that say so.
      intelligenceLastSyncedAt: iso(row.lastSyncedAt),
      workItemRevisionsLastSyncedAt: iso(row.lastRevisionSyncAt),
      syncPrs: row.syncPrs,
      syncCommits: row.syncCommits,
      syncAllRepos: row.syncAllRepos,
      syncRepos: row.syncRepos,
      boardCount: row._count.boardSources,
    })),
  ];

  const truncatedProviders = [
    jira.length > MAX_CONFIG_ROWS ? 'jira' : null,
    github.length > MAX_CONFIG_ROWS ? 'github' : null,
    gitlab.length > MAX_CONFIG_ROWS ? 'gitlab' : null,
    ado.length > MAX_CONFIG_ROWS ? 'ado' : null,
  ].filter((provider): provider is string => provider !== null);

  return {
    available: true,
    page: 'sources',
    state: {
      sources,
      sourcesTruncated: truncatedProviders.length > 0,
      truncatedProviders,
      note:
        'This is every source configured on this Deckgauge instance, not one board\'s subset, and these are the last-known stored sync stamps rather than a live connection check. ' +
        'boardCount is how many boards each source is attached to: a source with boardCount 0 is configured but feeds no board, which is the usual reason a board stays empty while its source looks healthy. ' +
        'Each provider records different stamps: GitHub keeps one watermark per feed with no single per-feed last-synced time — its lastSuccessAt is the last successful run of the bulk repo sync, its tier sets how often that runs (hot hourly, warm every 6h, cold daily), and a non-null disabledAt means the repo is skipped entirely, so a frozen watermark there is expected rather than a failure. The Azure DevOps last-synced stamp covers PR and commit intelligence only — a project that syncs work items but has no repositories never sets it — and that intelligence is opt-in, so syncPrs/syncCommits off, or an empty syncRepos with syncAllRepos false, means it was never meant to run. ' +
        'Only GitHub records an error: lastErrorAt and lastErrorMessage exist on the GitHub sync record alone. The Jira, GitLab and Azure DevOps sync records have no error columns at all, so for those providers the absence of an error here is NOT evidence that their syncs succeeded — this tool cannot see whether they failed. Say so rather than implying you checked.',
      truncationNote: `${TRUNCATION_NOTE} The cap here is per provider, so truncatedProviders names the providers whose lists were capped; a provider absent from it is complete.`,
    },
  };
}
