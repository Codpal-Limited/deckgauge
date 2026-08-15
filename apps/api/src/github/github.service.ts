import type { PrismaClient } from '@deckgauge/db';
import type {
  CreateGitHubInstanceInput,
  GitHubInstance,
  GitHubProjectsPort,
} from '@deckgauge/shared';
import { normalizeRepoFullName, GitHubProjectsGraphQLAdapter } from '@deckgauge/shared';

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

  async listInstances(): Promise<GitHubInstancePublic[]> {
    const rows = await this.prisma.gitHubInstance.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => mask(r as GitHubInstance));
  }

  async createInstance(
    input: CreateGitHubInstanceInput,
    actingUserId?: string,
  ): Promise<GitHubInstancePublic> {
    const row = await this.prisma.gitHubInstance.create({
      data: {
        baseUrl: input.baseUrl,
        accessToken: input.accessToken,
        repos: (input.repos ?? []).map(normalizeRepoFullName),
        ...(actingUserId && { createdById: actingUserId }),
      },
    });
    return mask(row as GitHubInstance);
  }

  async updateInstanceRepos(
    id: string,
    repos: string[],
    actingUserId?: string,
  ): Promise<GitHubInstancePublic | null> {
    const existing = await this.prisma.gitHubInstance.findUnique({ where: { id } });
    if (!existing) return null;
    // Claim-on-first-edit: an unclaimed (null owner) row is claimed by
    // whoever edits it first. An already-claimed row keeps its owner.
    const claim =
      existing.createdById === null && actingUserId ? { createdById: actingUserId } : {};
    const row = await this.prisma.gitHubInstance.update({
      where: { id },
      data: { repos: repos.map(normalizeRepoFullName), ...claim },
    });
    return mask(row as GitHubInstance);
  }

  /**
   * Replace an instance's access token (and optionally its base URL). Used to
   * recover from an expired/revoked PAT without recreating the connection.
   */
  async updateInstanceToken(
    id: string,
    data: { accessToken: string; baseUrl?: string },
    actingUserId?: string,
  ): Promise<GitHubInstancePublic | null> {
    const existing = await this.prisma.gitHubInstance.findUnique({ where: { id } });
    if (!existing) return null;
    const claim =
      existing.createdById === null && actingUserId ? { createdById: actingUserId } : {};
    const row = await this.prisma.gitHubInstance.update({
      where: { id },
      data: {
        accessToken: data.accessToken,
        ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
        ...claim,
      },
    });
    return mask(row as GitHubInstance);
  }

  async deleteInstance(id: string): Promise<boolean> {
    const existing = await this.prisma.gitHubInstance.findUnique({ where: { id } });
    if (!existing) return false;
    await this.prisma.gitHubInstance.delete({ where: { id } });
    return true;
  }

  async getRawInstanceById(id: string): Promise<GitHubInstance | null> {
    const row = await this.prisma.gitHubInstance.findUnique({ where: { id } });
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
    instanceId: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    const instance = await this.getRawInstanceById(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };
    return this.probeToken(instance.baseUrl, instance.accessToken, instance.org, fetchFn);
  }

  async refreshToken(
    id: string,
    newToken: string,
    fetchFn: FetchFn = fetch,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    const instance = await this.getRawInstanceById(id);
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const probe = await this.probeToken(instance.baseUrl, newToken, instance.org, fetchFn);
    if (!probe.ok) return probe;
    const updated = await this.updateInstanceToken(id, { accessToken: newToken }, actingUserId);
    if (!updated) return { ok: false, notFound: true, error: 'Instance not found' };
    return { ok: true };
  }

  async discoverRepos(instanceId: string, fetchFn: FetchFn = fetch): Promise<string[] | null> {
    const instance = await this.getRawInstanceById(instanceId);
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

  async getLastSyncRun() {
    return this.prisma.syncRun.findFirst({
      where: { source: 'github' },
      orderBy: { startedAt: 'desc' },
    });
  }

  async listProjectsForInstance(instanceId: string) {
    const instance = await this.prisma.gitHubInstance.findUnique({ where: { id: instanceId } });
    if (!instance) throw new Error(`GitHub instance ${instanceId} not found`);
    const adapter = this.projectsAdapterFactory({
      accessToken: instance.accessToken,
      baseUrl: instance.baseUrl,
    });
    return adapter.listAccessibleProjects();
  }
}
