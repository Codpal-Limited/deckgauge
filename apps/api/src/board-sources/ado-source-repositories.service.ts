// `AdoSourceRepositoriesService` lists the repositories a board's ADO source
// can choose from, for the repository-scope picker (Task 12/13's UI).
//
// Names come from Postgres, NOT ClickHouse — this is deliberate, not an
// oversight. `ado_repo_sync_states` is the durable per-repo sync ledger (see
// `AdoRepoSyncState` in schema.prisma); `cockpit.ado_pull_requests` is a
// derived analytics stream that only has rows for repos with synced PRs.
// Measured on staging: one project has 52 repo sync-state rows but only 21
// repositories present in `ado_pull_requests` — and one of the 31 carrying a
// sync watermark and ZERO PR rows was a repository a user had explicitly
// selected. A ClickHouse-derived list would silently drop a chosen repository
// the moment it (or ADO) went quiet; joining PR counts onto the Postgres list
// in memory, defaulting missing repos to 0, cannot.
//
// `syncing` distinguishes repos the project sync currently ingests
// (sync_all_repos, or named in sync_repos) from ones it merely ingested at
// some point in the past — `ado_repo_sync_states` never shrinks, so the list
// also carries every repo the sync has EVER touched. On staging, that same
// project names just two repositories in `sync_repos` (sync_all_repos = false)
// yet has 52 sync-state rows: the other 50 — two of them carrying 93 and 582
// PRs — are frozen, and selecting one in the picker analyses history that will
// never update again. They stay selectable (that's a legitimate analysis),
// just badged.
//
// `otherBoardNames` names every OTHER board attached to this same project
// sync — the sync is project-level and shared, so editing its scope
// (EditableCodeSync in CodeIntelZone.tsx) affects those boards too, and the
// UI needs to say so rather than let the two controls read as duplicates.
//
// Tenancy: `AzureDevOpsProjectSync` has no `organizationId` column at all — its
// tenant is reachable only through `azureDevOpsInstance`, same as
// `BoardAdoSourceService.attach`. The board id is included in the same lookup
// so a source id from another board (even in the same org) also reports
// not-found rather than leaking repo names across boards.

import type { PrismaClient } from '@deckgauge/db';
import type { ChReadClient } from '../analytics/ch-read-scope.js';

export interface AdoSourceRepository {
  repoName: string;
  prCount: number;
  syncing: boolean;
}

export interface AdoSourceRepositoriesResult {
  repos: AdoSourceRepository[];
  otherBoardNames: string[];
}

export class AdoSourceRepositoriesNotFoundError extends Error {
  constructor(boardId: string, sourceId: string) {
    super(`ado board source ${sourceId} not found for board ${boardId}`);
    this.name = 'AdoSourceRepositoriesNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
}

export class AdoSourceRepositoriesService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChReadClient;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
  }

  async list(
    boardId: string,
    sourceId: string,
    organizationId: string,
  ): Promise<AdoSourceRepositoriesResult> {
    const source = await this.prisma.boardAdoSource.findFirst({
      where: {
        id: sourceId,
        boardId,
        azureDevOpsProjectSync: { azureDevOpsInstance: { organizationId } },
      },
      select: {
        azureDevOpsProjectSync: {
          select: {
            id: true,
            adoProject: true,
            syncRepos: true,
            syncAllRepos: true,
            repoSyncStates: { select: { repoName: true } },
            azureDevOpsInstance: { select: { orgUrl: true } },
          },
        },
      },
    });
    if (!source) throw new AdoSourceRepositoriesNotFoundError(boardId, sourceId);

    const projectSync = source.azureDevOpsProjectSync;

    // Every other board attached to this same project sync — the sync is
    // project-level/shared, so a change to it (via EditableCodeSync) affects
    // these boards too. `id: { not: sourceId }` excludes this board's own
    // row. `board: { organizationId }` is EXPRESSED here rather than relied
    // on implicitly: today it is unreachable regardless (the only caller is
    // the `findFirst` above, which already required this org), but this
    // service had its tenancy fixed once already after shipping without a
    // stated predicate — same posture as the `findFirst`'s own where clause.
    // Deterministic order (`orderBy`) because Postgres makes no ordering
    // guarantee without one, and this list is read into a sentence
    // ("Changing this affects the X and Y boards too.") a user reads as a
    // safety warning — it must not reorder itself between loads.
    const otherBoards = await this.prisma.boardAdoSource.findMany({
      where: {
        azureDevOpsProjectSyncId: projectSync.id,
        id: { not: sourceId },
        board: { organizationId },
      },
      select: { board: { select: { name: true } } },
      orderBy: { board: { name: 'asc' } },
    });
    const otherBoardNames = otherBoards.map((b) => b.board.name);

    const repoNames = projectSync.repoSyncStates.map((r) => r.repoName);
    if (repoNames.length === 0) return { repos: [], otherBoardNames };

    // Normalised the same way `resolveBoardScope` normalises before writing
    // org_url to ClickHouse (trailing slashes stripped), so this matches.
    // Two connected ADO organizations can share a project name — kept apart
    // only by this guard, since ClickHouse row policies isolate
    // organization_id, not ADO instances. See the module doc comment.
    const orgUrl = projectSync.azureDevOpsInstance.orgUrl.replace(/\/+$/, '');

    // No FINAL: `ado_pull_requests` is a ReplacingMergeTree, so this can, in
    // principle, double-count an unmerged duplicate part. Deliberately left
    // out anyway, to match `pullRequestsUnion`'s ADO leg
    // (apps/api/src/widgets/unions.ts:277), which also reads this table
    // without FINAL. Adding FINAL here would make the picker's prCount
    // disagree with the number of points the PR scatter widget actually
    // plots for the same repository — a repo reading "5 PRs" in the picker
    // but showing 7 dots in the widget is worse than both being consistently
    // approximate until ClickHouse merges parts. Keep the two in sync; do
    // not "fix" this in isolation.
    const result = await this.clickhouse.query({
      query: `
        SELECT repo_name AS repoName, count() AS total
        FROM cockpit.ado_pull_requests
        WHERE project = {project:String} AND org_url = {orgUrl:String}
        GROUP BY repo_name
      `,
      query_params: { project: projectSync.adoProject, orgUrl },
      format: 'JSONEachRow',
    });
    const rows = (await result.json()) as Array<{ repoName: string; total: number | string }>;
    const prCountByRepo = new Map(rows.map((row) => [row.repoName, Number(row.total)]));

    const isSyncing = (repoName: string) =>
      projectSync.syncAllRepos || projectSync.syncRepos.includes(repoName);

    return {
      repos: repoNames.map((repoName) => ({
        repoName,
        prCount: prCountByRepo.get(repoName) ?? 0,
        syncing: isSyncing(repoName),
      })),
      otherBoardNames,
    };
  }
}
