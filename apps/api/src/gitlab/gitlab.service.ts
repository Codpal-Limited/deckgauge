import { withOwnershipFields, CREATED_BY_SELECT } from '../connections/connection-list-row.js';
// EI-030 — GitLab service. CRUD on GitLabInstance + GitLabProjectSync.
import { PrismaClient } from '@deckgauge/db';
import { gitlabApiBase } from '@deckgauge/shared';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

export interface CreateGitLabInstanceInput {
  name: string;
  baseUrl?: string;
  accessToken: string;
  projects: string[];
}

export interface CreateGitLabProjectSyncInput {
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs?: boolean;
  syncCommits?: boolean;
}

type RefreshResult = { ok: boolean; error?: string; notFound?: boolean };

/** Carries the upstream GitLab HTTP status so the route can preserve 401/403
 *  (which drives the picker's reconnect flow) instead of flattening to 422. */
export class GitLabApiError extends Error {
  constructor(readonly status: number) {
    super(`GitLab API error: ${status}`);
    this.name = 'GitLabApiError';
  }
}

// Re-exported from @deckgauge/shared so the API create path and the worker
// sync adapters share one normalization implementation (a prior divergence —
// the worker path not normalizing — is what left instances hitting the web UI
// and 404ing). Kept as a named export here for existing importers.
export { gitlabApiBase };

export class GitLabService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * `organizationId` is deliberately the FIRST parameter on every scoped read
   * below: a mis-ordered call then fails to compile instead of silently becoming
   * a tenant bypass.
   *
   * `findFirst`, not `findUnique`: the predicate is `(id, organizationId)`, and
   * `findUnique` only accepts a unique key. Reverting these to `findUnique`
   * reopens the cross-tenant credential hole.
   *
   * Unlike Jira/GitHub/Azure DevOps, this service has NO raw getter — it
   * resolves a credential INLINE in testConnection, updateInstanceToken,
   * refreshToken and listRemoteProjects. Every one of those sites carries its own
   * filters — now TWO of them, tenant AND ownership — so adding a method here
   * means adding both there too.
   */
  async listInstances(caller: ConnectionCaller) {
    const rows = await this.prisma.gitLabInstance.findMany({
      where: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        projects: true,
        createdAt: true,
        updatedAt: true,
        // Selected only to be DERIVED from: withOwnershipFields strips both and
        // returns isPersonal/addedBy in their place.
        ownerUserId: true,
        createdBy: CREATED_BY_SELECT,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => withOwnershipFields(r));
  }

  /** `organizationId` is the tenant boundary, `createdById` ownership within it. */
  async createInstance(
    caller: ConnectionCaller,
    input: CreateGitLabInstanceInput,
    actingUserId?: string,
  ) {
    return this.prisma.gitLabInstance.create({
      data: {
        organizationId: caller.organizationId,
        name: input.name,
        baseUrl: gitlabApiBase(input.baseUrl ?? 'https://gitlab.com/api/v4'),
        accessToken: input.accessToken,
        projects: input.projects,
        // Stamped from the creator's role and never re-derived: promoting or
        // demoting somebody must not move a connection across the visibility
        // boundary. An admin creates for the organization (null); a member creates
        // for themselves.
        ownerUserId: caller.isOrgAdmin ? null : (caller.userId ?? null),
        ...(actingUserId && { createdById: actingUserId }),
      },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        projects: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Organization-scoped. The `ORG_ADMIN` policy on the route decides WHO may
   * call this, not WHOSE row it lands on — so without the predicate here an
   * administrator of one organization could delete another's connection by id,
   * cascading away every board source built on it. A miss returns false, which
   * the route answers as 404: indistinguishable from an id that names nothing.
   *
   * Reads before it deletes, rather than passing a compound `where` to `delete`
   * (Prisma's `delete` takes a unique key only, so it cannot express the tenant
   * filter). The read also removes the P2025-out-of-the-handler 500 that a
   * nonexistent id used to produce.
   */
  async deleteInstance(caller: ConnectionCaller, id: string): Promise<boolean> {
    const existing = await this.prisma.gitLabInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { id: true },
    });
    if (!existing) return false;
    await this.prisma.gitLabInstance.delete({ where: { id } });
    return true;
  }

  /**
   * The project syncs of ONE organization, optionally narrowed to one instance.
   *
   * `instanceId` is caller-supplied (a query-string parameter), so the tenant
   * predicate is ANDed with it rather than replaced by it: naming another
   * organization's instance now yields nothing instead of their sync rows. With
   * no predicate at all this listed every organization's rows at once.
   *
   * Scoped through the instance because the sync row carries no organization of
   * its own. See gitlab.service.test.ts.
   */
  async listProjectSyncs(caller: ConnectionCaller, instanceId?: string) {
    return this.prisma.gitLabProjectSync.findMany({
      where: {
        gitlabInstance: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
        ...(instanceId ? { gitlabInstanceId: instanceId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createProjectSync(input: CreateGitLabProjectSyncInput) {
    return this.prisma.gitLabProjectSync.create({
      data: {
        gitlabInstanceId: input.gitlabInstanceId,
        projectPath: input.projectPath,
        syncPrs: input.syncPrs ?? true,
        syncCommits: input.syncCommits ?? false,
      },
    });
  }

  async deleteProjectSync(id: string) {
    await this.prisma.gitLabProjectSync.delete({ where: { id } });
  }

  private async probeToken(
    baseUrl: string,
    token: string,
    fetchFn = this.fetchFn,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = `${gitlabApiBase(baseUrl)}/user`;
    try {
      const res = await fetchFn(url, {
        headers: { 'PRIVATE-TOKEN': token },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `GitLab returned ${res.status}: ${text}` };
      }
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  async testConnection(
    caller: ConnectionCaller,
    instanceId: string,
  ): Promise<{ ok: boolean; error?: string; notFound?: boolean }> {
    // Inline credential resolve #1 — tenant-filtered at the point the token is
    // read, so a cross-organization id never reaches the network as someone
    // else's PRIVATE-TOKEN.
    const instance = await this.prisma.gitLabInstance.findFirst({
      where: { id: instanceId, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { baseUrl: true, accessToken: true },
    });
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    return this.probeToken(instance.baseUrl, instance.accessToken);
  }

  async updateInstanceToken(
    caller: ConnectionCaller,
    id: string,
    accessToken: string,
  ) {
    // Inline credential resolve #2 — this one WRITES the stored token, so the
    // tenant filter is what stops another organization's credential being
    // replaced with the caller's.
    const existing = await this.prisma.gitLabInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return null;
    // No claim-on-first-edit. It was ownership bookkeeping for the deleted
    // `connectionOwner` policy, and it makes `createdById` UNTRUE: an unclaimed row
    // edited by whoever opened it first would then display "Added by" that person,
    // who did not add it. Ownership lives in `ownerUserId` now.
    return this.prisma.gitLabInstance.update({ where: { id }, data: { accessToken } });
  }

  async refreshToken(
    caller: ConnectionCaller,
    id: string,
    newToken: string,
    fetchFn = this.fetchFn,
  ): Promise<RefreshResult> {
    // Inline credential resolve #3 — the scoped resolve is what stops a
    // cross-organization id from having its stored token overwritten.
    const instance = await this.prisma.gitLabInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { baseUrl: true, accessToken: true },
    });
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const probe = await this.probeToken(instance.baseUrl, newToken, fetchFn);
    if (!probe.ok) return probe;
    const updated = await this.updateInstanceToken(caller, id, newToken);
    if (!updated) return { ok: false, notFound: true, error: 'Instance not found' };
    return { ok: true };
  }

  /**
   * List projects for the picker.
   *
   * - No `search` term → the caller's own projects (`membership=true`).
   * - With a term → the caller's own *matching* projects first (`membership=true`
   *   + `search`); only if that is empty do we widen to every project the token
   *   can see (`search`, no membership). This keeps gitlab.com results scoped to
   *   the user's projects (a bare `search` there returns public projects across
   *   the whole platform, which would bury or exclude the user's own repo under
   *   the 100-row cap), while still letting self-managed users — who often have
   *   instance-wide read access but no formal project membership — find projects.
   *
   * Capped at 100 rows; the search box is how you narrow past that.
   */
  async listRemoteProjects(
    caller: ConnectionCaller,
    instanceId: string,
    search?: string,
  ): Promise<string[]> {
    // Inline credential resolve #4 — the picker spends the stored token against
    // GitLab, so the tenant filter belongs on this resolve too.
    const instance = await this.prisma.gitLabInstance.findFirst({
      where: { id: instanceId, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { baseUrl: true, accessToken: true },
    });
    if (!instance) throw new Error(`GitLab instance not found: ${instanceId}`);

    const base = gitlabApiBase(instance.baseUrl);
    const fetchProjects = async (extra: Record<string, string>) => {
      const params = new URLSearchParams({
        simple: 'true',
        per_page: '100',
        order_by: 'last_activity_at',
        ...extra,
      });
      const res = await this.fetchFn(`${base}/projects?${params.toString()}`, {
        headers: { 'PRIVATE-TOKEN': instance.accessToken },
      });
      if (!res.ok) {
        throw new GitLabApiError(res.status);
      }
      return (await res.json()) as Array<{ path_with_namespace: string }>;
    };

    const term = search?.trim();
    if (!term) {
      return (await fetchProjects({ membership: 'true' })).map((p) => p.path_with_namespace);
    }
    const mine = await fetchProjects({ membership: 'true', search: term });
    const rows = mine.length > 0 ? mine : await fetchProjects({ search: term });
    return rows.map((p) => p.path_with_namespace);
  }
}
