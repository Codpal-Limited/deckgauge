import { withOwnershipFields, CREATED_BY_SELECT } from '../connections/connection-list-row.js';
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
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';

// Certificate verification is ON for every Jira request unless the operator
// opts out with JIRA_TLS_INSECURE=1. The opt-out exists for an on-prem Jira
// behind a self-signed certificate on a network that cannot supply its CA; the
// right fix there is NODE_EXTRA_CA_CERTS (see .env.example), and this switch is
// the last resort. It is SCOPED to this module's requests via an undici
// dispatcher — never by mutating process.env.NODE_TLS_REJECT_UNAUTHORIZED,
// which would disable certificate validation process-wide for every other
// in-flight fetch (GitHub/GitLab/ADO health probes run concurrently with this).
//
// Read per call, not at import, so the switch is what the environment says NOW
// (and so tests can stub it); the Agent itself is built once.
let insecureDispatcher: Agent | undefined;
export function jiraTlsDispatcher(): Agent | undefined {
  if (process.env.JIRA_TLS_INSECURE !== "1") return undefined;
  insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureDispatcher;
}

/** Spread into a fetch init: adds `dispatcher` only when leniency is opted in. */
function tlsInit(): { dispatcher?: Agent } {
  const dispatcher = jiraTlsDispatcher();
  return dispatcher ? { dispatcher } : {};
}

function describeError(err: unknown): string {
  let message = "Unknown error";
  if (err instanceof Error) {
    message = err.message;
    const cause = (err as Error & { cause?: Error }).cause;
    if (cause) message += ` — ${cause.message}`;
  }
  return message;
}

function basicAuth(instance: { email: string; apiToken: string }): string {
  return `Basic ${Buffer.from(`${instance.email}:${instance.apiToken}`).toString("base64")}`;
}

export type DiscoveryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; notFound?: boolean };

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
  /**
   * `caller` replaces the bare organization id on every scoped method here. It
   * CARRIES the organization, so the tenant boundary is unchanged, and it makes
   * the ownership predicate impossible to forget: a call site that has not been
   * updated does not compile.
   */
  async list(caller: ConnectionCaller): Promise<JiraInstancePublic[]> {
    const rows = await this.prisma.jiraInstance.findMany({
      where: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      // `addedBy` is resolved from this join, not from a second query per row.
      include: { createdBy: CREATED_BY_SELECT },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => withOwnershipFields({ ...mask(r as JiraInstance), createdBy: r.createdBy }));
  }

  async getById(
    caller: ConnectionCaller,
    id: string,
  ): Promise<JiraInstancePublic | null> {
    const row = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!row) return null;
    return mask(row as JiraInstance);
  }

  /** Returns the LIVE apiToken. The tenant filter here is the credential boundary. */
  async getRawById(
    caller: ConnectionCaller,
    id: string,
  ): Promise<JiraInstance | null> {
    const row = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
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
    caller: ConnectionCaller,
    input: CreateJiraInstanceInput,
    actingUserId?: string,
  ): Promise<JiraInstancePublic> {
    const row = await this.prisma.jiraInstance.create({
      data: {
        organizationId: caller.organizationId,
        name: input.name,
        atlassianUrl: input.atlassianUrl,
        email: input.email,
        apiToken: input.apiToken,
        projectKeys: input.projectKeys,
        // Stamped from the creator's role and never re-derived: promoting or
        // demoting somebody must not move a connection across the visibility
        // boundary. An admin creates for the organization (null); a member creates
        // for themselves.
        ownerUserId: caller.isOrgAdmin ? null : (caller.userId ?? null),
        ...(actingUserId && { createdById: actingUserId }),
      },
    });
    return mask(row as JiraInstance);
  }

  async update(
    caller: ConnectionCaller,
    id: string,
    input: UpdateJiraInstanceInput,
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ): Promise<JiraInstancePublic | null> {
    // Resolved THROUGH the organization, so a cross-organization id resolves to
    // null and the route answers 404 — indistinguishable from an id that names
    // nothing, which keeps the guard from confirming another tenant's ids.
    const existing = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
    });
    if (!existing) return null;

    // No claim-on-first-edit. It was ownership bookkeeping for the deleted
    // `connectionOwner` policy, and it makes `createdById` UNTRUE: an unclaimed row
    // edited by whoever opened it first would then display "Added by" that person,
    // who did not add it. Ownership lives in `ownerUserId` now.

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
      },
    });
    // After the write, so a rejected update is not recorded as a repoint.
    logHostRepoint(log, {
      provider: 'jira',
      instanceId: id,
      organizationId: caller.organizationId,
      actingUserId,
      from: existing.atlassianUrl,
      to: input.atlassianUrl,
    });
    return mask(row as JiraInstance);
  }

  async delete(caller: ConnectionCaller, id: string): Promise<boolean> {
    const existing = await this.prisma.jiraInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
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
        // Opt-in, per-request TLS leniency — see `jiraTlsDispatcher` above.
        // Only the real global `fetch` honors `dispatcher`.
        ...tlsInit(),
      } as RequestInit);
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
      return { ok: false, error: describeError(err) };
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
        ...tlsInit(),
      } as RequestInit);
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
    caller: ConnectionCaller,
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
    const instance = await this.getRawById(caller, id);
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
    caller: ConnectionCaller,
    id: string,
    newToken: string,
    fetchFn: FetchFn = fetch,
    actingUserId?: string,
  ): Promise<RefreshResult> {
    // The scoped resolve is what stops a cross-organization id from having its
    // stored credential overwritten.
    const instance = await this.getRawById(caller, id);
    if (!instance) return { ok: false, notFound: true, error: "Instance not found" };
    const probe = await this.probeToken(
      { atlassianUrl: instance.atlassianUrl, email: instance.email, token: newToken },
      fetchFn,
    );
    if (!probe.ok) return probe;
    const updated = await this.update(caller, id, { apiToken: newToken }, actingUserId);
    if (!updated) return { ok: false, notFound: true, error: "Instance not found" };
    return { ok: true };
  }

  /**
   * Lists the Jira projects the stored credential can see. Lives here, not in
   * the route, so it shares the scoped TLS handling above — the route's inline
   * copy flipped NODE_TLS_REJECT_UNAUTHORIZED process-wide for its duration.
   */
  async listProjects(
    caller: ConnectionCaller,
    id: string,
    fetchFn: FetchFn = fetch,
  ): Promise<DiscoveryResult<Array<{ key: string; name: string }>>> {
    const instance = await this.getRawById(caller, id);
    if (!instance) return { ok: false, notFound: true, error: "Instance not found" };
    try {
      const baseUrl = instance.atlassianUrl.replace(/\/+$/, "");
      const response = await fetchFn(`${baseUrl}/rest/api/3/project`, {
        headers: { Authorization: basicAuth(instance), Accept: "application/json" },
        ...tlsInit(),
      } as RequestInit);
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Jira API error: ${response.status} ${text}` };
      }
      const projects = (await response.json()) as Array<{ key: string; name: string }>;
      return { ok: true, data: projects.map((p) => ({ key: p.key, name: p.name })) };
    } catch (err: unknown) {
      return { ok: false, error: `Failed to fetch projects: ${describeError(err)}` };
    }
  }

  /** Alphabetically sorted issue-type names of one project, sub-tasks excluded. */
  async listIssueTypes(
    caller: ConnectionCaller,
    id: string,
    projectKey: string,
    fetchFn: FetchFn = fetch,
  ): Promise<DiscoveryResult<string[]>> {
    const instance = await this.getRawById(caller, id);
    if (!instance) return { ok: false, notFound: true, error: "Instance not found" };
    try {
      const baseUrl = instance.atlassianUrl.replace(/\/+$/, "");
      const response = await fetchFn(`${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
        headers: { Authorization: basicAuth(instance), Accept: "application/json" },
        ...tlsInit(),
      } as RequestInit);
      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Jira API error: ${response.status} ${text}` };
      }
      const project = (await response.json()) as {
        issueTypes?: Array<{ name: string; subtask?: boolean }>;
      };
      const types = (project.issueTypes ?? [])
        .filter((t) => t.name && !t.subtask) // exclude Sub-task by default
        .map((t) => t.name)
        .sort();
      return { ok: true, data: types };
    } catch (err: unknown) {
      return { ok: false, error: `Failed to fetch issue types: ${describeError(err)}` };
    }
  }
}
