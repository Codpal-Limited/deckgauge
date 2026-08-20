import type { PrismaClient } from "@deckgauge/db";
import type {
  JiraInstancePublic,
  CreateJiraInstanceInput,
  UpdateJiraInstanceInput,
  JiraInstance,
  ConnectionHint,
} from "@deckgauge/shared";
import { Agent } from "undici";
import { logHostRepoint, type ConnectionAuditLog } from '../connections/host-repoint-audit.js';

// Some corporate Jira instances sit behind self-signed/lenient TLS. Scope the
// leniency to this single request via an undici dispatcher — never mutate
// process.env.NODE_TLS_REJECT_UNAUTHORIZED, which would disable certificate
// validation process-wide for every other in-flight fetch (GitHub/GitLab/ADO
// health probes now run concurrently alongside this one via Promise.all).
const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

function mask(instance: JiraInstance): JiraInstancePublic {
  return { ...instance, apiToken: "***" as const };
}

type FetchFn = typeof fetch;
type RefreshResult = { ok: boolean; error?: string; notFound?: boolean };

export class JiraInstanceService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Reads are organization-scoped: a cross-organization id resolves to null,
   * which routes surface as 404 rather than as another tenant's connection.
   *
   * `findFirst`, not `findUnique`: the predicate is `(id, organizationId)`, and
   * `findUnique` only accepts a unique key. Reverting these to `findUnique`
   * would silently drop the tenant filter, which is precisely the hole closed
   * here (org-tenancy design §11 precondition 4).
   *
   * `organizationId` is deliberately the FIRST parameter on every one of these:
   * a mis-ordered call then fails to compile instead of quietly becoming a
   * tenant bypass.
   */
  async list(organizationId: string): Promise<JiraInstancePublic[]> {
    const rows = await this.prisma.jiraInstance.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => mask(r as JiraInstance));
  }

  async getById(
    organizationId: string,
    id: string,
  ): Promise<JiraInstancePublic | null> {
    const row = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId },
    });
    if (!row) return null;
    return mask(row as JiraInstance);
  }

  /** Returns the LIVE apiToken. The tenant filter here is the credential boundary. */
  async getRawById(
    organizationId: string,
    id: string,
  ): Promise<JiraInstance | null> {
    const row = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId },
    });
    if (!row) return null;
    return row as JiraInstance;
  }

  /**
   * `organizationId` is the tenant boundary; `createdById` is ownership *within*
   * that organization. Both axes are load-bearing and neither replaces the
   * other — see the org-tenancy ruling in planning/STATE.md.
   *
   * `update`/`delete` below are organization-scoped as well. The `ORG_ADMIN`
   * policy on their routes decides WHO may call them, not WHOSE row the call
   * lands on — so without the predicate here an administrator of one
   * organization could repoint or delete another's connection by id.
   */
  async create(
    organizationId: string,
    input: CreateJiraInstanceInput,
    actingUserId?: string,
  ): Promise<JiraInstancePublic> {
    const row = await this.prisma.jiraInstance.create({
      data: {
        organizationId,
        name: input.name,
        atlassianUrl: input.atlassianUrl,
        email: input.email,
        apiToken: input.apiToken,
        projectKeys: input.projectKeys,
        ...(actingUserId && { createdById: actingUserId }),
      },
    });
    return mask(row as JiraInstance);
  }

  async update(
    organizationId: string,
    id: string,
    input: UpdateJiraInstanceInput,
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ): Promise<JiraInstancePublic | null> {
    // Resolved THROUGH the organization, so a cross-organization id resolves to
    // null and the route answers 404 — indistinguishable from an id that names
    // nothing, which keeps the guard from confirming another tenant's ids.
    const existing = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return null;

    // Claim-on-first-edit: an unclaimed (null owner) row is claimed by
    // whoever edits it first. An already-claimed row keeps its owner.
    const claim =
      existing.createdById === null && actingUserId
        ? { createdById: actingUserId }
        : {};

    const row = await this.prisma.jiraInstance.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.atlassianUrl !== undefined && {
          atlassianUrl: input.atlassianUrl,
        }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.apiToken !== undefined && { apiToken: input.apiToken }),
        ...(input.projectKeys !== undefined && {
          projectKeys: input.projectKeys,
        }),
        ...claim,
      },
    });
    // After the write, so a rejected update is not recorded as a repoint.
    logHostRepoint(log, {
      provider: 'jira',
      instanceId: id,
      organizationId,
      actingUserId,
      from: existing.atlassianUrl,
      to: input.atlassianUrl,
    });
    return mask(row as JiraInstance);
  }

  async delete(organizationId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId },
    });
    if (!existing) return false;

    await this.prisma.jiraInstance.delete({ where: { id } });
    return true;
  }

  private async probeToken(
    params: { atlassianUrl: string; email: string; token: string },
    fetchFn: FetchFn = fetch,
  ): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
      const encoded = Buffer.from(`${params.email}:${params.token}`).toString(
        "base64",
      );
      const baseUrl = params.atlassianUrl.replace(/\/+$/, "");
      const res = await fetchFn(`${baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${encoded}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
        // Scoped per-request TLS leniency (self-signed/corporate certs on
        // some Jira instances) — see `insecureDispatcher` above. Only the
        // real global `fetch` honors `dispatcher`; injected test fetches
        // ignore the extra init field.
        dispatcher: insecureDispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          status: res.status,
          error: `Jira returned ${res.status}: ${text}`,
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      let message = "Unknown error";
      if (err instanceof Error) {
        message = err.message;
        const cause = (err as Error & { cause?: Error }).cause;
        if (cause) message += ` — ${cause.message}`;
      }
      return { ok: false, error: message };
    }
  }

  /**
   * Atlassian Cloud sites answer on both a canonical `*.atlassian.net` host and
   * an optional vanity display domain. The vanity host serves the UI but
   * discards HTTP Basic credentials, so REST calls against it arrive anonymous
   * and 401 even with a valid token. `serverInfo` needs no auth and reports the
   * canonical `baseUrl`, which turns that confusing 401 into a fixable answer.
   *
   * Best-effort only: any failure means "no hint", never a thrown error.
   */
  private async diagnoseHost(
    atlassianUrl: string,
    fetchFn: FetchFn = fetch,
  ): Promise<ConnectionHint | undefined> {
    try {
      const entered = new URL(atlassianUrl);
      const base = atlassianUrl.replace(/\/+$/, "");
      // No Authorization header — this endpoint is public and the entered host
      // is not yet trusted with the credential.
      const res = await fetchFn(`${base}/rest/api/2/serverInfo`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        dispatcher: insecureDispatcher,
      } as RequestInit & { dispatcher: Agent });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { baseUrl?: unknown };
      if (typeof body.baseUrl !== "string") return undefined;
      const canonical = new URL(body.baseUrl);
      if (canonical.host === entered.host) return undefined;
      return { kind: "canonical-url", suggestedUrl: canonical.origin };
    } catch {
      return undefined;
    }
  }

  async testConnection(
    organizationId: string,
    id: string,
    fetchFn: FetchFn = fetch,
  ): Promise<{
    ok: boolean;
    error?: string;
    hint?: ConnectionHint;
    notFound?: boolean;
  }> {
    // Scoped resolve first: a cross-organization id must never reach the
    // network as someone else's Basic credential.
    const instance = await this.getRawById(organizationId, id);
    if (!instance) return { ok: false, notFound: true, error: "Instance not found" };
    const probe = await this.probeToken(
      { atlassianUrl: instance.atlassianUrl, email: instance.email, token: instance.apiToken },
      fetchFn,
    );
    if (probe.ok) return { ok: true };
    // Only an auth rejection can mean "right credential, wrong host". A DNS or
    // 5xx failure should not pay for a second round trip.
    if (probe.status === 401 || probe.status === 403) {
      const hint = await this.diagnoseHost(instance.atlassianUrl, fetchFn);
      if (hint) return { ok: false, error: probe.error, hint };
    }
    return { ok: false, error: probe.error };
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
    const instance = await this.getRawById(organizationId, id);
    if (!instance) return { ok: false, notFound: true, error: "Instance not found" };
    const probe = await this.probeToken(
      { atlassianUrl: instance.atlassianUrl, email: instance.email, token: newToken },
      fetchFn,
    );
    if (!probe.ok) return probe;
    const updated = await this.update(organizationId, id, { apiToken: newToken }, actingUserId);
    if (!updated) return { ok: false, notFound: true, error: "Instance not found" };
    return { ok: true };
  }
}
