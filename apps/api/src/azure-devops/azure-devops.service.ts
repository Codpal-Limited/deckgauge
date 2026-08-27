import { withOwnershipFields, CREATED_BY_SELECT } from '../connections/connection-list-row.js';
import type { PrismaClient } from '@deckgauge/db';
import { logHostRepoint, type ConnectionAuditLog } from '../connections/host-repoint-audit.js';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';
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
  async listInstances(caller: ConnectionCaller): Promise<AzureDevOpsInstancePublic[]> {
    const rows = await this.prisma.azureDevOpsInstance.findMany({
      where: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      // `addedBy` is resolved from this join, not from a second query per row.
      include: { createdBy: CREATED_BY_SELECT },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => withOwnershipFields({ ...mask(r as AzureDevOpsInstance), createdBy: r.createdBy }));
  }

  /** `organizationId` is the tenant boundary, `createdById` ownership within it. */
  async createInstance(
    caller: ConnectionCaller,
    input: CreateAzureDevOpsInstanceInput,
    actingUserId?: string,
  ): Promise<AzureDevOpsInstancePublic> {
    const row = await this.prisma.azureDevOpsInstance.create({
      data: {
        organizationId: caller.organizationId,
        name: input.name,
        orgUrl: input.orgUrl,
        authMethod: input.authMethod,
        accessToken: input.accessToken,
        username: input.username ?? null,
        projects: input.projects,
        // Stamped from the creator's role and never re-derived: promoting or
        // demoting somebody must not move a connection across the visibility
        // boundary. An admin creates for the organization (null); a member creates
        // for themselves.
        ownerUserId: caller.isOrgAdmin ? null : (caller.userId ?? null),
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
    caller: ConnectionCaller,
    id: string,
    input: UpdateAzureDevOpsInstanceInput,
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ): Promise<AzureDevOpsInstancePublic | null> {
    const existing = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return null;
    // No claim-on-first-edit. It was ownership bookkeeping for the deleted
    // `connectionOwner` policy, and it makes `createdById` UNTRUE: an unclaimed row
    // edited by whoever opened it first would then display "Added by" that person,
    // who did not add it. Ownership lives in `ownerUserId` now.
    const row = await this.prisma.azureDevOpsInstance.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.orgUrl !== undefined && { orgUrl: input.orgUrl }),
        ...(input.authMethod !== undefined && { authMethod: input.authMethod }),
        ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
        ...(input.username !== undefined && { username: input.username }),
        ...(input.projects !== undefined && { projects: input.projects }),
      },
    });
    // After the write, so a rejected update is not recorded as a repoint.
    logHostRepoint(log, {
      provider: 'azure-devops',
      instanceId: id,
      organizationId: caller.organizationId,
      actingUserId,
      from: existing.orgUrl,
      to: input.orgUrl,
    });
    return mask(row as AzureDevOpsInstance);
  }

  async deleteInstance(caller: ConnectionCaller, id: string): Promise<boolean> {
    const existing = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return false;
    await this.prisma.azureDevOpsInstance.delete({ where: { id } });
    return true;
  }

  /** Returns the LIVE PAT. The tenant filter here is the credential boundary. */
  async getRawInstanceById(
    caller: ConnectionCaller,
    id: string,
  ): Promise<AzureDevOpsInstance | null> {
    const row = await this.prisma.azureDevOpsInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    return row ? (row as AzureDevOpsInstance) : null;
  }

  /**
   * The caller's organization's latest Azure DevOps sync run.
   *
   * `organizationId` is REQUIRED, and is the whole tenant boundary of this read.
   * Before 2026-08-26 the `where` was `{ source: 'azure-devops' }` alone against
   * a `SyncRun` with no tenant column, so this served the deployment's newest
   * run — `errorMessage` included, which for ADO carries the team project name
   * (`TF200016: The following project does not exist: <name>`). See
   * `__isolation__/sync-run-tenancy.test.ts`.
   */
  async getLastSyncRun(organizationId: string) {
    return this.prisma.syncRun.findFirst({
      where: { source: 'azure-devops', organizationId },
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
    caller: ConnectionCaller,
    id: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string }> {
    // Scoped resolve first: a cross-organization id must never reach the network
    // as someone else's PAT.
    const instance = await this.getRawInstanceById(caller, id);
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
      caller,
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
    caller: ConnectionCaller,
    instanceId: string,
    adoProject: string,
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    // The sync row carries no organizationId — it is reachable only through its
    // instance — so the tenant check belongs on the instance. Without it, a bare
    // instance id read another organization's deploy configuration.
    const instance = await this.getRawInstanceById(caller, instanceId);
    if (!instance) return null;

    const sync = await this.prisma.azureDevOpsProjectSync.findFirst({
      where: { azureDevOpsInstanceId: instanceId, adoProject },
      select: { prodReleaseDefinitions: true, prodStages: true },
    });
    if (!sync) return null;
    return { definitions: sync.prodReleaseDefinitions, stages: sync.prodStages };
  }

  async setProductionConfig(
    caller: ConnectionCaller,
    instanceId: string,
    adoProject: string,
    input: { definitions: string[]; stages: string[] },
  ): Promise<{ definitions: string[]; stages: string[] } | null> {
    // Same instance-level tenant check as getProductionConfig — this one WRITES
    // the allow-lists that decide what DORA counts as a production deploy.
    const instance = await this.getRawInstanceById(caller, instanceId);
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
