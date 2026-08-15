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
 * Last-known sync state for the sources configured on this instance.
 *
 * **Instance-wide, not board-scoped.** The `sources` and `connections` screens
 * both list the sync records themselves (`GET /project-syncs/{jira,github,gitlab,ado}`),
 * so scoping this resolver to one board left it unable to answer the questions
 * actually asked on those pages. Those routes are authentication-only inside
 * the protected plugin, which is the posture this read borrows — the same way
 * the timesheet resolver borrows `GET /timesheet/status-rules`. There is no id
 * to verify and therefore no authorization step to add.
 *
 * Reads the four sync tables directly rather than calling the `*SyncService.list()`
 * methods behind those routes: their reads are unbounded (an unbounded query and
 * an unbounded amount of LLM context), and GitHub's omits the per-feed watermarks
 * that are the only way to answer "how far has this repo got?".
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
 * the `instance` it belongs to — instance-wide, a label alone can collide, since the uniqueness
 * constraint on each sync table is per instance. It also carries `boardCount`: with no board in
 * scope, nothing else in the payload says whether a source feeds any board at all, and a sync
 * row attached to zero boards is the ordinary explanation for a board that stays empty while
 * its source looks healthy.
 */
export async function resolveSourcesPageState(deps: PageStateDeps): Promise<PageStateResult> {
  const [jira, github, gitlab, ado] = await Promise.all([
    deps.prisma.jiraProjectSync.findMany({
      ...BOUND,
      include: { ...withBoardCount, jiraInstance: { select: { name: true } } },
    }),
    deps.prisma.gitHubRepoSync.findMany({
      ...BOUND,
      include: {
        ...withBoardCount,
        githubInstance: { select: { org: true, baseUrl: true } },
      },
    }),
    deps.prisma.gitLabProjectSync.findMany({
      ...BOUND,
      include: { ...withBoardCount, gitlabInstance: { select: { name: true } } },
    }),
    deps.prisma.azureDevOpsProjectSync.findMany({
      ...BOUND,
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
