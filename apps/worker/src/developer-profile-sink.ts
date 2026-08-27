// P8.5 — worker-side DeveloperProfile sink.
//
// Lives in apps/worker (not apps/api) because cross-app imports between
// sibling apps are forbidden by this monorepo's conventions. The companion
// PrismaDeveloperProfileService in apps/api/src/developer-profiles/ does the
// same upsert; we re-implement it here against the worker's PrismaClient to
// avoid an apps/api → apps/worker import edge.
import type { PrismaClient } from '@deckgauge/db';

export type DeveloperProfileProvider = 'github' | 'gitlab' | 'ado' | 'jira';

export interface DeveloperProfileUpsert {
  provider: DeveloperProfileProvider;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export interface DeveloperProfileSink {
  upsertOnSync(input: DeveloperProfileUpsert): Promise<{ id: string }>;
}

/**
 * Bound to ONE organization at construction, exactly as the dual-writers'
 * `ChClientFactory` binds the ClickHouse client one level up — so the writers
 * themselves stay tenant-agnostic and `DeveloperProfileUpsert` needs no new
 * field. Required rather than optional: `developer_profiles` is unique per
 * `(organizationId, provider, login)`, and a sink that could be built without an
 * organization would be a sink that could write across the boundary.
 *
 * Note for whoever wires this up: there is currently NO production caller.
 * `writeGitHubToClickHouse` / `writeJiraToClickHouse` / `writeAdoToClickHouse`
 * all take `profileSink?` and are only ever invoked from tests; the deployed
 * sync handlers do not pass one. The tenant key is here so that when a caller
 * does appear it cannot appear without an organization.
 */
export class PrismaDeveloperProfileSink implements DeveloperProfileSink {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly organizationId: string,
  ) {}

  async upsertOnSync(input: DeveloperProfileUpsert): Promise<{ id: string }> {
    return this.prisma.developerProfile.upsert({
      where: {
        organizationId_provider_login: {
          organizationId: this.organizationId,
          provider: input.provider,
          login: input.login,
        },
      },
      create: { ...input, organizationId: this.organizationId },
      update: {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        email: input.email,
      },
      select: { id: true },
    });
  }
}
