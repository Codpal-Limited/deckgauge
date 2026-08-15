// EI-030 — GitLab service. CRUD on GitLabInstance + GitLabProjectSync.
import { PrismaClient } from '@deckgauge/db';
import { gitlabApiBase } from '@deckgauge/shared';

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

  async listInstances() {
    return this.prisma.gitLabInstance.findMany({
      select: {
        id: true,
        name: true,
        baseUrl: true,
        projects: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createInstance(input: CreateGitLabInstanceInput, actingUserId?: string) {
    return this.prisma.gitLabInstance.create({
      data: {
        name: input.name,
        baseUrl: gitlabApiBase(input.baseUrl ?? 'https://gitlab.com/api/v4'),
        accessToken: input.accessToken,
        projects: input.projects,
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

  async deleteInstance(id: string) {
    await this.prisma.gitLabInstance.delete({ where: { id } });
  }

  async listProjectSyncs(instanceId?: string) {
    return this.prisma.gitLabProjectSync.findMany({
      where: instanceId ? { gitlabInstanceId: instanceId } : undefined,
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

  async testConnection(instanceId: string): Promise<{ ok: boolean; error?: string }> {
    const instance = await this.prisma.gitLabInstance.findUnique({
      where: { id: instanceId },
      select: { baseUrl: true, accessToken: true },
    });
    if (!instance) return { ok: false, error: 'Instance not found' };
    return this.probeToken(instance.baseUrl, instance.accessToken);
  }

  async updateInstanceToken(id: string, accessToken: string, actingUserId?: string) {
    const existing = await this.prisma.gitLabInstance.findUnique({ where: { id } });
    if (!existing) return null;
    // Claim-on-first-edit: an unclaimed (null owner) row is claimed by
    // whoever edits it first. An already-claimed row keeps its owner.
    const claim =
      existing.createdById === null && actingUserId ? { createdById: actingUserId } : {};
    return this.prisma.gitLabInstance.update({ where: { id }, data: { accessToken, ...claim } });
  }

  async refreshToken(
    id: string,
    newToken: string,
    fetchFn = this.fetchFn,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    const instance = await this.prisma.gitLabInstance.findUnique({
      where: { id },
      select: { baseUrl: true, accessToken: true },
    });
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const probe = await this.probeToken(instance.baseUrl, newToken, fetchFn);
    if (!probe.ok) return probe;
    const updated = await this.updateInstanceToken(id, newToken, actingUserId);
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
  async listRemoteProjects(instanceId: string, search?: string): Promise<string[]> {
    const instance = await this.prisma.gitLabInstance.findUnique({
      where: { id: instanceId },
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
