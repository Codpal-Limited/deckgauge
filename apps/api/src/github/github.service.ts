import { withOwnershipFields, CREATED_BY_SELECT } from '../connections/connection-list-row.js';
import type { PrismaClient } from '@deckgauge/db';
import type {
  CreateGitHubInstanceInput,
  GitHubInstance,
  GitHubProjectsPort,
} from '@deckgauge/shared';
import { normalizeRepoFullName, GitHubProjectsGraphQLAdapter } from '@deckgauge/shared';
import { logHostRepoint, type ConnectionAuditLog } from '../connections/host-repoint-audit.js';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

type FetchFn = typeof fetch;

type AdapterConfig = { accessToken: string; baseUrl: string };
type ProjectsAdapterFactory = (cfg: AdapterConfig) => GitHubProjectsPort;

export type GitHubInstancePublic = Omit<GitHubInstance, 'accessToken'> & { accessToken: '***' };

export type RefreshResult = { ok: boolean; error?: string; notFound?: boolean };

function mask(instance: GitHubInstance): GitHubInstancePublic {
  return { ...instance, accessToken: '***' as const };
}

export class GitHubService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly _githubAdapterFactory?: unknown,
    private readonly projectsAdapterFactory: ProjectsAdapterFactory = (cfg) =>
      new GitHubProjectsGraphQLAdapter(cfg),
  ) {}

  /**
   * Reads are organization-scoped: a cross-organization id resolves to null,
   * which routes surface as 404 rather than as another tenant's connection.
   *
   * `findFirst`, not `findUnique`: the predicate is `(id, organizationId)`, and
   * `findUnique` only accepts a unique key, so it cannot express the compound
   * tenant filter. Reverting one of these to `findUnique` would silently drop
   * the tenant filter, which is exactly the hole closed here (org-tenancy
   * design §11 precondition 4).
   *
   * `organizationId` is deliberately the FIRST parameter on every one of these:
   * a mis-ordered call then fails to compile instead of quietly becoming a
   * tenant bypass.
   */
  async listInstances(caller: ConnectionCaller): Promise<GitHubInstancePublic[]> {
    const rows = await this.prisma.gitHubInstance.findMany({
      where: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      // `addedBy` is resolved from this join, not from a second query per row.
      include: { createdBy: CREATED_BY_SELECT },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => withOwnershipFields({ ...mask(r as GitHubInstance), createdBy: r.createdBy }));
  }

  /** `organizationId` is the tenant boundary, `createdById` ownership within it. */
  async createInstance(
    caller: ConnectionCaller,
    input: CreateGitHubInstanceInput,
    actingUserId?: string,
  ): Promise<GitHubInstancePublic> {
    const row = await this.prisma.gitHubInstance.create({
      data: {
        organizationId: caller.organizationId,
        baseUrl: input.baseUrl,
        accessToken: input.accessToken,
        repos: (input.repos ?? []).map(normalizeRepoFullName),
        // Stamped from the creator's role and never re-derived: promoting or
        // demoting somebody must not move a connection across the visibility
        // boundary. An admin creates for the organization (null); a member creates
        // for themselves.
        ownerUserId: caller.isOrgAdmin ? null : (caller.userId ?? null),
        ...(actingUserId && { createdById: actingUserId }),
      },
    });
    return mask(row as GitHubInstance);
  }

  /**
   * Organization-scoped, like `deleteInstance` below. The `ORG_ADMIN` policy on
   * their routes decides WHO may call them, not WHOSE row the call lands on — so
   * without the predicate here an administrator of one organization could
   * repoint or delete another's connection by id. A miss resolves to null, which
   * the route answers as 404: indistinguishable from an id that names nothing,
   * so the guard never confirms another tenant's ids.
   */
  async updateInstanceRepos(
    caller: ConnectionCaller,
    id: string,
    repos: string[],
  ): Promise<GitHubInstancePublic | null> {
    const existing = await this.prisma.gitHubInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return null;
    // No claim-on-first-edit. It was ownership bookkeeping for the deleted
    // `connectionOwner` policy, and it makes `createdById` UNTRUE: an unclaimed row
    // edited by whoever opened it first would then display "Added by" that person,
    // who did not add it. Ownership lives in `ownerUserId` now.
    const row = await this.prisma.gitHubInstance.update({
      where: { id },
      data: { repos: repos.map(normalizeRepoFullName) },
    });
    return mask(row as GitHubInstance);
  }

  /**
   * Replace an instance's access token (and optionally its base URL). Used to
   * recover from an expired/revoked PAT without recreating the connection.
   */
  async updateInstanceToken(
    caller: ConnectionCaller,
    id: string,
    data: { accessToken: string; baseUrl?: string },
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ): Promise<GitHubInstancePublic | null> {
    // Scoped resolve first, so a cross-organization id cannot reach the
    // `update` and overwrite another tenant's stored PAT. Read through Prisma
    // rather than `getRawInstanceById` because the claim check below needs
    // `createdById`, which the shared `GitHubInstance` shape does not carry.
    const existing = await this.prisma.gitHubInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return null;
    // No claim-on-first-edit. It was ownership bookkeeping for the deleted
    // `connectionOwner` policy, and it makes `createdById` UNTRUE: an unclaimed row
    // edited by whoever opened it first would then display "Added by" that person,
    // who did not add it. Ownership lives in `ownerUserId` now.
    const row = await this.prisma.gitHubInstance.update({
      where: { id },
      data: {
        accessToken: data.accessToken,
        ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
      },
    });
    // After the write, so a rejected update is not recorded as a repoint. Note
    // this is the ONLY GitHub path that can change the host: a baseUrl-only PATCH
    // falls through to the repos branch and is rejected, so a repoint here always
    // arrives together with a token.
    logHostRepoint(log, {
      provider: 'github',
      instanceId: id,
      organizationId: caller.organizationId,
      actingUserId,
      from: existing.baseUrl,
      to: data.baseUrl,
    });
    return mask(row as GitHubInstance);
  }

  async deleteInstance(caller: ConnectionCaller, id: string): Promise<boolean> {
    const existing = await this.prisma.gitHubInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return false;
    await this.prisma.gitHubInstance.delete({ where: { id } });
    return true;
  }

  /** Returns the LIVE PAT. The tenant filter here is the credential boundary. */
  async getRawInstanceById(
    caller: ConnectionCaller,
    id: string,
  ): Promise<GitHubInstance | null> {
    const row = await this.prisma.gitHubInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    return row ? (row as GitHubInstance) : null;
  }

  /**
   * Probe the org the instance is configured for, not `/user`.
   *
   * `/user` resolves the caller's own identity, which an Entra-federated (EMU)
   * account cannot do without a live IdP session — it 403s even while every org
   * and repo the sync reads is perfectly readable. Probing the org asks the
   * question the health badge actually answers: can this connection sync?
   * Instances with no org configured have nothing better to probe, so they keep
   * using `/user`.
   *
   * What this proves: the credential is live (a revoked token 401s here) and the
   * org is not gated behind an unsatisfied SSO/IdP check. What it does NOT
   * prove: that any individual repo is readable — a public org answers 200 even
   * when the caller can see none of its repos. Per-repo access stays the repo
   * sync's own business, recorded in `github_repo_syncs.lastErrorMessage`.
   */
  private async probeToken(
    baseUrl: string,
    token: string,
    org: string | null | undefined,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    const base = baseUrl.replace(/\/+$/, '');
    const target = org ? `${base}/orgs/${encodeURIComponent(org)}` : `${base}/user`;
    try {
      const res = await fetchFn(target, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `GitHub returned ${res.status}: ${text}` };
      }
      return { ok: true };
    } catch (err: unknown) {
      let message = 'Unknown error';
      if (err instanceof Error) {
        message = err.message;
        const cause = (err as Error & { cause?: Error }).cause;
        if (cause) message += ` — ${cause.message}`;
      }
      return { ok: false, error: message };
    }
  }

  async testConnection(
    caller: ConnectionCaller,
    instanceId: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    // Scoped resolve first: a cross-organization id must never reach the
    // network as someone else's PAT.
    const instance = await this.getRawInstanceById(caller, instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };
    return this.probeToken(instance.baseUrl, instance.accessToken, instance.org, fetchFn);
  }

  async refreshToken(
    caller: ConnectionCaller,
    id: string,
    newToken: string,
    fetchFn: FetchFn = fetch,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    // The scoped resolve is what stops a cross-organization id from having its
    // stored credential overwritten.
    const instance = await this.getRawInstanceById(caller, id);
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const probe = await this.probeToken(instance.baseUrl, newToken, instance.org, fetchFn);
    if (!probe.ok) return probe;
    const updated = await this.updateInstanceToken(
      caller,
      id,
      { accessToken: newToken },
      actingUserId,
    );
    if (!updated) return { ok: false, notFound: true, error: 'Instance not found' };
    return { ok: true };
  }

  async discoverRepos(
    caller: ConnectionCaller,
    instanceId: string,
    fetchFn: FetchFn = fetch,
  ): Promise<string[] | null> {
    const instance = await this.getRawInstanceById(caller, instanceId);
    if (!instance) return null;

    const baseUrl = instance.baseUrl.replace(/\/+$/, '');
    const repos: string[] = [];
    let page = 1;

    while (true) {
      const res = await fetchFn(
        `${baseUrl}/user/repos?type=all&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${instance.accessToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

      const data = (await res.json()) as Array<{ full_name: string }>;
      repos.push(...data.map((r) => r.full_name));

      if (data.length < 100) break;
      page++;
    }

    return repos;
  }

  /**
   * The caller's organization's latest GitHub sync run.
   *
   * `organizationId` is REQUIRED, and is the whole tenant boundary of this read —
   * there is nothing behind it. Before 2026-08-26 the `where` was `{ source:
   * 'github' }` alone against a `SyncRun` that had no tenant column, so this
   * returned the DEPLOYMENT's newest run: one tenant's `errorMessage`, which
   * carries the provider's failure text verbatim and routinely names a private
   * repository, was served to every other tenant. See
   * `__isolation__/sync-run-tenancy.test.ts`.
   */
  async getLastSyncRun(organizationId: string) {
    return this.prisma.syncRun.findFirst({
      where: { source: 'github', organizationId },
      orderBy: { startedAt: 'desc' },
    });
  }

  async listProjectsForInstance(caller: ConnectionCaller, instanceId: string) {
    // Same tenant filter as `getRawInstanceById` — this one hands the PAT to the
    // GraphQL adapter, so an unscoped read here is a live exfiltration path.
    const instance = await this.prisma.gitHubInstance.findFirst({
      where: { id: instanceId, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!instance) throw new Error(`GitHub instance ${instanceId} not found`);
    const adapter = this.projectsAdapterFactory({
      accessToken: instance.accessToken,
      baseUrl: instance.baseUrl,
    });
    return adapter.listAccessibleProjects();
  }
}
