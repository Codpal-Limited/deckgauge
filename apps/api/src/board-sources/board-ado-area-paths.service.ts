// `BoardAdoAreaPathsService` resolves one board's ADO source to the (orgUrl,
// project) pair `listAdoAreaPaths` needs, for the intelligence-scope area-path
// picker (Task 9) — the `intelligenceAreaPaths` counterpart to
// `AdoSourceRepositoriesService`.
//
// Unlike the repositories service, there is no Postgres-side name list to join
// against (no `ado_repo_sync_states` equivalent for area paths) and no shared
// project-sync scope another board could be affected by, so this stays a thin
// resolve-then-query — no `otherBoardNames`, no syncing/historical badge.
//
// Tenancy follows the identical rule `AdoSourceRepositoriesService` documents:
// `AzureDevOpsProjectSync` has no `organizationId` column at all, so the tenant
// boundary is reachable only through `azureDevOpsInstance`. The board id is
// included in the same lookup so a source id from another board (even in the
// same org) also reports not-found rather than leaking area-path names across
// boards.

import type { PrismaClient } from '@deckgauge/db';
import type { ChReadClient } from '../analytics/ch-read-scope.js';
import { listAdoAreaPaths, type AdoAreaPathRow } from '../azure-devops/ado-area-paths.service.js';

export class BoardAdoAreaPathsNotFoundError extends Error {
  constructor(boardId: string, sourceId: string) {
    super(`ado board source ${sourceId} not found for board ${boardId}`);
    this.name = 'BoardAdoAreaPathsNotFoundError';
  }
}

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
}

export class BoardAdoAreaPathsService {
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
  ): Promise<AdoAreaPathRow[]> {
    const source = await this.prisma.boardAdoSource.findFirst({
      where: {
        id: sourceId,
        boardId,
        azureDevOpsProjectSync: { azureDevOpsInstance: { organizationId } },
      },
      select: {
        azureDevOpsProjectSync: {
          select: {
            adoProject: true,
            azureDevOpsInstance: { select: { orgUrl: true } },
          },
        },
      },
    });
    if (!source) throw new BoardAdoAreaPathsNotFoundError(boardId, sourceId);

    // Normalised the same way `resolveBoardScope` normalises before writing
    // org_url to ClickHouse (trailing slashes stripped) — same rule
    // `AdoSourceRepositoriesService` follows, and required for the query to
    // match anything at all.
    const orgUrl = source.azureDevOpsProjectSync.azureDevOpsInstance.orgUrl.replace(/\/+$/, '');

    return listAdoAreaPaths(this.clickhouse, {
      orgUrl,
      project: source.azureDevOpsProjectSync.adoProject,
    });
  }
}
