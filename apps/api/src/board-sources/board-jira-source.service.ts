import type { PrismaClient } from '@deckgauge/db';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';

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

  /**
   * `organizationId` leads the signature so a mis-ordered call fails to compile
   * instead of silently becoming a tenant bypass.
   *
   * `jiraProjectSyncId` arrives from the request body, so it must be proven to
   * belong to the caller's organization BEFORE the row is written — see
   * CrossOrganizationSyncError for what an unguarded attach lets through. The
   * tenant is reached through `jiraInstance`: JiraProjectSync has no
   * `organizationId` column of its own.
   */
  async attach(
    organizationId: string,
    input: {
      boardId: string;
      jiraProjectSyncId: string;
      targetGroupId?: string | null;
      allowedIssueTypes?: string[];
      statusMapping?: Record<string, string>;
      defaultSyncedFields?: string[];
      jqlFilter?: string | null;
    },
  ) {
    // `findFirst`, not `findUnique`: Prisma's unique lookup cannot express the
    // compound `{ id, jiraInstance: { organizationId } }` predicate, so this is
    // the correct shape for a tenant-scoped resolve rather than a workaround.
    const sync = await this.prisma.jiraProjectSync.findFirst({
      where: { id: input.jiraProjectSyncId, jiraInstance: { organizationId } },
      select: { id: true },
    });
    if (!sync) throw new CrossOrganizationSyncError('jira', input.jiraProjectSyncId);

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
   * instance IN THE CALLER'S ORGANIZATION shares one URL, because then that URL is
   * the only one such a row could have come from; with several distinct sites the
   * row's origin is unknowable and `fallback` is null so the cell renders "—"
   * rather than a wrong link. The organization filter is load-bearing: another
   * tenant's site is never a URL this board's rows could have come from, so
   * counting it both leaked a hostname and could produce a wrong link.
   */
  async atlassianUrlsByProjectKey(
    organizationId: string,
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
      // Scoped to the caller's organization. Unfiltered, this was a live
      // cross-tenant read: when the caller's organization owns NO Jira instance
      // and exactly one other organization owns exactly one, `distinctUrls` held
      // that single foreign URL and it was returned as `fallback` — leaking
      // another tenant's Atlassian site hostname through a `board(VIEWER)` read.
      // A hostname, not a token, but the "exactly one" condition makes it most
      // likely on a small install.
      this.prisma.jiraInstance.findMany({
        where: { organizationId },
        select: { atlassianUrl: true },
      }),
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
