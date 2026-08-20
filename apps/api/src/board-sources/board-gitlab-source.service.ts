import type { PrismaClient } from '@deckgauge/db';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';

// Surface the project sync's `syncPrs/syncCommits/lastSyncedAt` so the
// board-sources UI can render the connection's code-sync state and last
// sync timestamp from the canonical source instead of defaulting to null.
const GITLAB_SYNC_INCLUDE = {
  gitlabProjectSync: {
    select: {
      id: true,
      projectPath: true,
      gitlabInstanceId: true,
      syncPrs: true,
      syncCommits: true,
      lastSyncedAt: true,
    },
  },
} as const;

export class BoardGitLabSourceService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(boardId: string) {
    return this.prisma.boardGitLabSource.findMany({
      where: { boardId },
      include: GITLAB_SYNC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * `organizationId` first — see BoardJiraSourceService.attach for the full rule.
   *
   * GitLab's spelling differs from the other three providers: the client accessor
   * is `gitLabProjectSync` (capital L) while its instance RELATION field is
   * `gitlabInstance` (lower-case l), matching the `gitlabInstanceId` column.
   */
  async attach(
    organizationId: string,
    input: {
      boardId: string;
      gitlabProjectSyncId: string;
      targetGroupId?: string | null;
      syncIssuesToBoard?: boolean;
      syncMrsToBoard?: boolean;
    },
  ) {
    const sync = await this.prisma.gitLabProjectSync.findFirst({
      where: { id: input.gitlabProjectSyncId, gitlabInstance: { organizationId } },
      select: { id: true },
    });
    if (!sync) throw new CrossOrganizationSyncError('gitlab', input.gitlabProjectSyncId);

    return this.prisma.boardGitLabSource.create({ data: input, include: GITLAB_SYNC_INCLUDE });
  }

  async update(
    id: string,
    patch: Partial<{
      targetGroupId: string | null;
      syncIssuesToBoard: boolean;
      syncMrsToBoard: boolean;
    }>,
  ) {
    return this.prisma.boardGitLabSource.update({ where: { id }, data: patch });
  }

  async detach(id: string): Promise<void> {
    await this.prisma.boardGitLabSource.delete({ where: { id } });
  }
}
