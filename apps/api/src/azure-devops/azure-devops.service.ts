import type { PrismaClient } from '@deckgauge/db';
import { logHostRepoint, type ConnectionAuditLog } from '../connections/host-repoint-audit.js';
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

  /**
   * `organizationId` is deliberately the FIRST parameter on every scoped read
   * below: a mis-ordered call then fails to compile instead of silently becoming
   * a tenant bypass.
   *
   * `findFirst`, not `findUnique`: the predicate is `(id, organizationId)`, and
   * `findUnique` only accepts a unique key. Reverting these to `findUnique`
   * reopens the cross-tenant credential hole.
   */
  async listInstances(organizationId: string): Promise<AzureDevOpsInstancePublic[]> {
    const rows = await this.prisma.azureDevOpsInstance.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => mask(r as AzureDevOpsInstance));
  }

  /** `organizationId` is the tenant boundary, `createdById` ownership within it. */
  async createInstance(
    organizationId: string,
    input: CreateAzureDevOpsInstanceInput,
    actingUserId?: string,
  ): Promise<AzureDevOpsInstancePublic> {
    const row = await this.prisma.azureDevOpsInstance.create({
      data: {
        organizationId,
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

  /**
   * Organization-scoped, like `deleteInstance` below. The `ORG_ADMIN` policy on
   * their routes decides WHO may call them, not WHOSE row the call lands on — so
   * without the predicate here an administrator of one organization could
   * repoint or delete another's connection by id. A miss resolves to null, which
   * the route answers as 404: indistinguishable from an id that names nothing,
   * so the guard never confirms another tenant's ids.
   */
  async updateInstance(
    organizationId: string,
    id: string,
    input: UpdateAzureDevOpsInstanceInput,
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ): Promise<AzureDevOpsInstancePublic | null> {
    const existing = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId },
    });
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
    // After the write, so a rejected update is not recorded as a repoint.
    logHostRepoint(log, {
      provider: 'azure-devops',
      instanceId: id,
      organizationId,
      actingUserId,
      from: existing.orgUrl,
      to: input.orgUrl,
    });
    return mask(row as AzureDevOpsInstance);
  }

  async deleteInstance(organizationId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return false;
    await this.prisma.azureDevOpsInstance.delete({ where: { id } });
    return true;
  }

  /** Returns the LIVE PAT. The tenant filter here is the credential boundary. */
  async getRawInstanceById(
    organizationId: string,
    id: string,
  ): Promise<AzureDevOpsInstance | null> {
    const row = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId },
    });
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
    organizationId: string,
    id: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    // Scoped resolve first: a cross-organization id must never reach the network
    // as someone else's PAT.
    const instance = await this.getRawInstanceById(organizationId, id);
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
    organizationId: string,
    id: string,
    newToken: string,
    fetchFn: FetchFn = fetch,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    // The scoped resolve is what stops a cross-organization id from having its
    // stored credential overwritten.
    const instance = await this.getRawInstanceById(organizationId, id);
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
    const updated = await this.updateInstance(
      organizationId,
      id,
      { accessToken: newToken },
      actingUserId,
    );
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
    organizationId: string,
    instanceId: string,
    adoProject: string,
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    // The sync row carries no organizationId — it is reachable only through its
    // instance — so the tenant check belongs on the instance. Without it, a bare
    // instance id read another organization's deploy configuration.
    const instance = await this.getRawInstanceById(organizationId, instanceId);
    if (!instance) return null;

    const sync = await this.prisma.azureDevOpsProjectSync.findFirst({
      where: { azureDevOpsInstanceId: instanceId, adoProject },
      select: { prodReleaseDefinitions: true, prodStages: true },
    });
    if (!sync) return null;
    return { definitions: sync.prodReleaseDefinitions, stages: sync.prodStages };
  }

  async setProductionConfig(
    organizationId: string,
    instanceId: string,
    adoProject: string,
    input: { definitions: string[]; stages: string[] },
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    // Same instance-level tenant check as getProductionConfig — this one WRITES
    // the allow-lists that decide what DORA counts as a production deploy.
    const instance = await this.getRawInstanceById(organizationId, instanceId);
    if (!instance) return null;

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
