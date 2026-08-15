import type { PrismaClient } from '@deckgauge/db';
import type {
  AzureDevOpsInstance,
  CreateAzureDevOpsInstanceInput,
  UpdateAzureDevOpsInstanceInput,
} from '@deckgauge/shared';

export type AzureDevOpsInstancePublic = Omit<AzureDevOpsInstance, 'accessToken'> & {
  accessToken: '***';
};

type FetchFn = typeof fetch;
type RefreshResult = { ok: boolean; error?: string; notFound?: boolean };

function mask(instance: AzureDevOpsInstance): AzureDevOpsInstancePublic {
  return { ...instance, accessToken: '***' as const };
}

export class AzureDevOpsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listInstances(): Promise<AzureDevOpsInstancePublic[]> {
    const rows = await this.prisma.azureDevOpsInstance.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => mask(r as AzureDevOpsInstance));
  }

  async createInstance(
    input: CreateAzureDevOpsInstanceInput,
    actingUserId?: string,
  ): Promise<AzureDevOpsInstancePublic> {
    const row = await this.prisma.azureDevOpsInstance.create({
      data: {
        name: input.name,
        orgUrl: input.orgUrl,
        authMethod: input.authMethod,
        accessToken: input.accessToken,
        username: input.username ?? null,
        projects: input.projects,
        ...(actingUserId && { createdById: actingUserId }),
      },
    });
    return mask(row as AzureDevOpsInstance);
  }

  async updateInstance(
    id: string,
    input: UpdateAzureDevOpsInstanceInput,
    actingUserId?: string,
  ): Promise<AzureDevOpsInstancePublic | null> {
    const existing = await this.prisma.azureDevOpsInstance.findUnique({ where: { id } });
    if (!existing) return null;
    // Claim-on-first-edit: an unclaimed (null owner) row is claimed by
    // whoever edits it first. An already-claimed row keeps its owner.
    const claim =
      existing.createdById === null && actingUserId ? { createdById: actingUserId } : {};
    const row = await this.prisma.azureDevOpsInstance.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.orgUrl !== undefined && { orgUrl: input.orgUrl }),
        ...(input.authMethod !== undefined && { authMethod: input.authMethod }),
        ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
        ...(input.username !== undefined && { username: input.username }),
        ...(input.projects !== undefined && { projects: input.projects }),
        ...claim,
      },
    });
    return mask(row as AzureDevOpsInstance);
  }

  async deleteInstance(id: string): Promise<boolean> {
    const existing = await this.prisma.azureDevOpsInstance.findUnique({ where: { id } });
    if (!existing) return false;
    await this.prisma.azureDevOpsInstance.delete({ where: { id } });
    return true;
  }

  async getRawInstanceById(id: string): Promise<AzureDevOpsInstance | null> {
    const row = await this.prisma.azureDevOpsInstance.findUnique({ where: { id } });
    return row ? (row as AzureDevOpsInstance) : null;
  }

  async getLastSyncRun() {
    return this.prisma.syncRun.findFirst({
      where: { source: 'azure-devops' },
      orderBy: { startedAt: 'desc' },
    });
  }

  private async probeToken(
    params: { orgUrl: string; authMethod: string; username: string | null; token: string },
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = `${params.orgUrl.replace(/\/+$/, '')}/_apis/projects?$top=1&api-version=7.0`;
    const authHeader =
      params.authMethod === 'PAT'
        ? `Basic ${Buffer.from(`:${params.token}`).toString('base64')}`
        : `Basic ${Buffer.from(`${params.username ?? ''}:${params.token}`).toString('base64')}`;
    try {
      const res = await fetchFn(url, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, error: `Azure DevOps returned ${res.status}` };
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async testConnection(
    id: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    const instance = await this.getRawInstanceById(id);
    if (!instance) return { ok: false, error: 'Instance not found' };
    return this.probeToken(
      {
        orgUrl: instance.orgUrl,
        authMethod: instance.authMethod,
        username: instance.username,
        token: instance.accessToken,
      },
      fetchFn,
    );
  }

  async refreshToken(
    id: string,
    newToken: string,
    fetchFn: FetchFn = fetch,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    const instance = await this.getRawInstanceById(id);
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const probe = await this.probeToken(
      {
        orgUrl: instance.orgUrl,
        authMethod: instance.authMethod,
        username: instance.username,
        token: newToken,
      },
      fetchFn,
    );
    if (!probe.ok) return probe;
    const updated = await this.updateInstance(id, { accessToken: newToken }, actingUserId);
    if (!updated) return { ok: false, notFound: true, error: 'Instance not found' };
    return { ok: true };
  }
  /**
   * Which release pipelines / stages count as a PRODUCTION deploy for one ADO
   * project, for DORA deploy frequency. Both lists empty = fall back to the name
   * heuristic in deploymentsUnion.
   *
   * Exists because no name rule separates an operational pipeline from a
   * deployment one: 'Restart <region> Core Processor', 'Reset IIS' and
   * 'Publish <Lib>Components' (a NuGet publish) must not count, while
   * 'Release-<App>.Dashboard.sln-Master' must.
   */
  async getProductionConfig(
    instanceId: string,
    adoProject: string,
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    const sync = await this.prisma.azureDevOpsProjectSync.findFirst({
      where: { azureDevOpsInstanceId: instanceId, adoProject },
      select: { prodReleaseDefinitions: true, prodStages: true },
    });
    if (!sync) return null;
    return { definitions: sync.prodReleaseDefinitions, stages: sync.prodStages };
  }

  async setProductionConfig(
    instanceId: string,
    adoProject: string,
    input: { definitions: string[]; stages: string[] },
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    const sync = await this.prisma.azureDevOpsProjectSync.findFirst({
      where: { azureDevOpsInstanceId: instanceId, adoProject },
      select: { id: true },
    });
    if (!sync) return null;
    const updated = await this.prisma.azureDevOpsProjectSync.update({
      where: { id: sync.id },
      data: {
        prodReleaseDefinitions: dedupeTrimmed(input.definitions),
        prodStages: dedupeTrimmed(input.stages),
      },
      select: { prodReleaseDefinitions: true, prodStages: true },
    });
    return { definitions: updated.prodReleaseDefinitions, stages: updated.prodStages };
  }
}

/** Drop blanks and duplicates; these lists are matched with has() in ClickHouse. */
function dedupeTrimmed(values: string[]): string[] {
  return Array.from(
    new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)),
  );
}
