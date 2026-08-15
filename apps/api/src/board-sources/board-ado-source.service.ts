import type { PrismaClient } from '@deckgauge/db';

// Surface the project sync's `syncPrs/syncCommits/syncRepos/syncAllRepos/lastSyncedAt`
// to the board-sources UI. Without these, `CodeIntelZone` (via hydrateAdo)
// always reads `connection.syncPrs === false` and renders "unavailable"
// even when PR + commit sync are enabled on the connection. `syncAllRepos`
// lets the wizard edit the code-sync scope inline instead of the Connections page.
const ADO_SYNC_INCLUDE = {
  azureDevOpsProjectSync: {
    select: {
      id: true,
      adoProject: true,
      azureDevOpsInstanceId: true,
      syncPrs: true,
      syncCommits: true,
      syncRepos: true,
      syncAllRepos: true,
      lastSyncedAt: true,
    },
  },
} as const;

export class BoardAdoSourceService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(boardId: string) {
    return this.prisma.boardAdoSource.findMany({
      where: { boardId },
      include: ADO_SYNC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async attach(input: {
    boardId: string;
    azureDevOpsProjectSyncId: string;
    targetGroupId?: string | null;
    allowedWorkItemTypes?: string[];
    wiqlFilter?: string | null;
    statusMapping?: Record<string, string>;
    defaultSyncedFields?: string[];
    syncWorkItemsToBoard?: boolean;
    useForIntelligence?: boolean;
  }) {
    return this.prisma.boardAdoSource.create({ data: input, include: ADO_SYNC_INCLUDE });
  }

  async update(
    id: string,
    patch: Partial<{
      targetGroupId: string | null;
      allowedWorkItemTypes: string[];
      wiqlFilter: string | null;
      statusMapping: Record<string, string>;
      defaultSyncedFields: string[];
      syncWorkItemsToBoard: boolean;
      useForIntelligence: boolean;
    }>,
  ) {
    return this.prisma.boardAdoSource.update({ where: { id }, data: patch });
  }

  async detach(id: string): Promise<void> {
    await this.prisma.boardAdoSource.delete({ where: { id } });
  }

  // Keyed by ADO project name rather than a single URL: a board can attach more
  // than one BoardAdoSource, so its work items can legitimately come from
  // different ADO orgs. Callers resolve a given row's link by its own
  // `adoProject`, instead of assuming one org for the whole board.
  async orgUrlsByProject(boardId: string): Promise<Record<string, string>> {
    const sources = await this.prisma.boardAdoSource.findMany({
      where: { boardId },
      select: {
        azureDevOpsProjectSync: {
          select: {
            adoProject: true,
            azureDevOpsInstance: { select: { orgUrl: true } },
          },
        },
      },
    });
    // A Project row records only `adoProject` (a name), never the instance it came
    // from, and `@@unique([azureDevOpsInstanceId, adoProject])` lets the same name
    // exist on two instances. When a board attaches same-named projects from
    // different orgs, a row's org is unknowable from the row alone — drop the entry
    // so the Source cell renders "—". Emitting either candidate would reintroduce
    // the wrong-org link this method exists to prevent. Same name + same orgUrl
    // (duplicate connection rows) is not ambiguous, so it is kept.
    const AMBIGUOUS = null;
    const byProject = new Map<string, string | typeof AMBIGUOUS>();
    for (const { azureDevOpsProjectSync: sync } of sources) {
      const orgUrl = sync.azureDevOpsInstance.orgUrl;
      const existing = byProject.get(sync.adoProject);
      if (existing === undefined) {
        byProject.set(sync.adoProject, orgUrl);
      } else if (existing !== orgUrl) {
        byProject.set(sync.adoProject, AMBIGUOUS);
      }
    }

    return Object.fromEntries(
      [...byProject].filter((entry): entry is [string, string] => entry[1] !== AMBIGUOUS),
    );
  }
}
