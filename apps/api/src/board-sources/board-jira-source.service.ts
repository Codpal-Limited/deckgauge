import type { PrismaClient } from '@deckgauge/db';

// Surface the project sync's `lastSyncedAt` so the board-sources UI can show
// the connection's true last sync time. Jira has no code-sync flags (issue
// tracker only), so no syncPrs/syncCommits to expose.
const JIRA_SYNC_INCLUDE = {
  jiraProjectSync: {
    select: {
      id: true,
      jiraProjectKey: true,
      jiraInstanceId: true,
      lastSyncedAt: true,
    },
  },
} as const;

export class BoardJiraSourceService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(boardId: string) {
    return this.prisma.boardJiraSource.findMany({
      where: { boardId },
      include: JIRA_SYNC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async attach(input: {
    boardId: string;
    jiraProjectSyncId: string;
    targetGroupId?: string | null;
    allowedIssueTypes?: string[];
    statusMapping?: Record<string, string>;
    defaultSyncedFields?: string[];
    jqlFilter?: string | null;
  }) {
    return this.prisma.boardJiraSource.create({ data: input, include: JIRA_SYNC_INCLUDE });
  }

  async update(
    id: string,
    patch: Partial<{
      targetGroupId: string | null;
      allowedIssueTypes: string[];
      statusMapping: Record<string, string>;
      defaultSyncedFields: string[];
      jqlFilter: string | null;
    }>,
  ) {
    return this.prisma.boardJiraSource.update({ where: { id }, data: patch });
  }

  async detach(id: string): Promise<void> {
    await this.prisma.boardJiraSource.delete({ where: { id } });
  }

  /**
   * Resolves the Jira browse URL for a board's rows, keyed by the row's own
   * `jiraProjectKey`. Replaces a single global "first JiraInstance wins" URL, which
   * pointed every board at whichever instance was listed first.
   *
   * `fallback` covers rows whose source has since been detached — those rows stay on
   * the board but their project key no longer maps. It is only offered when every
   * instance shares one URL, because then that URL is the only one such a row could
   * have come from; with several distinct sites the row's origin is unknowable and
   * `fallback` is null so the cell renders "—" rather than a wrong link.
   */
  async atlassianUrlsByProjectKey(
    boardId: string,
  ): Promise<{ byProjectKey: Record<string, string>; fallback: string | null }> {
    const [sources, instances] = await Promise.all([
      this.prisma.boardJiraSource.findMany({
        where: { boardId },
        select: {
          jiraProjectSync: {
            select: {
              jiraProjectKey: true,
              jiraInstance: { select: { atlassianUrl: true } },
            },
          },
        },
      }),
      this.prisma.jiraInstance.findMany({ select: { atlassianUrl: true } }),
    ]);

    // Same rule as the ADO map: `@@unique([jiraInstanceId, jiraProjectKey])` lets one
    // key live on two instances, and a row stores only the key — so a key claimed by
    // two different sites is ambiguous and gets dropped. Two connections to the same
    // site agree on the URL and stay.
    const AMBIGUOUS = null;
    const byKey = new Map<string, string | typeof AMBIGUOUS>();
    for (const { jiraProjectSync: sync } of sources) {
      const url = sync.jiraInstance.atlassianUrl;
      const existing = byKey.get(sync.jiraProjectKey);
      if (existing === undefined) {
        byKey.set(sync.jiraProjectKey, url);
      } else if (existing !== url) {
        byKey.set(sync.jiraProjectKey, AMBIGUOUS);
      }
    }

    const distinctUrls = new Set(instances.map((i) => i.atlassianUrl));

    return {
      byProjectKey: Object.fromEntries(
        [...byKey].filter((entry): entry is [string, string] => entry[1] !== AMBIGUOUS),
      ),
      fallback: distinctUrls.size === 1 ? [...distinctUrls][0]! : null,
    };
  }
}
