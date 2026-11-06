// Bitbucket Cloud connection service — CRUD on BitbucketInstance plus the
// credential-spending reads (test, refresh, remote repos). Mirrors
// gitlab.service.ts; read that file's header for the tenancy rules, which apply
// here unchanged:
//
//   - `caller` (organization + ownership) is the FIRST parameter of every scoped
//     method, so a mis-ordered call fails to compile instead of becoming a tenant
//     bypass;
//   - every credential resolve is `findFirst` over (id, organizationId,
//     visibility) — never `findUnique` by id;
//   - a miss is `notFound` / null / false, which routes answer as 404 — the same
//     answer for a foreign id and an id that names nothing.
//
// Differences from GitLab, all from the design spec:
//   - Basic auth with an Atlassian email + an API token CREATED WITH BITBUCKET
//     SCOPES. A plain Atlassian token answers 401 "no Bitbucket scopes"; that is
//     the most likely onboarding mistake, so it maps to its own actionable copy.
//   - The workspace is detected on create when the token sees exactly one, and
//     the caller is asked to choose when it sees several.
//   - The API host is fixed (api.bitbucket.org), so a "repoint" can only change
//     the WORKSPACE. That is still recorded through the host-repoint audit — it
//     changes what the stored credential is spent on.
//
// No error message or return value produced here ever contains the token: the
// shared client never puts it in a message, and every failure surfaced to a
// caller goes through `describeFailure`.
import type { PrismaClient } from '@deckgauge/db';
import {
  BitbucketClient,
  BitbucketAuthError,
  BitbucketApiError,
  getBitbucketCurrentUser,
  listBitbucketWorkspaces,
  listBitbucketRepos,
  groupBitbucketReposByProject,
  type BitbucketAuthErrorKind,
  type BitbucketClientConfig,
  type BitbucketWorkspace,
  type BitbucketRemoteReposResponse,
} from '@deckgauge/shared';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';
import { withOwnershipFields, CREATED_BY_SELECT } from '../connections/connection-list-row.js';
import { logHostRepoint, type ConnectionAuditLog } from '../connections/host-repoint-audit.js';

/** The onboarding copy for a plain Atlassian token. Pinned by the service test. */
export const BITBUCKET_NO_SCOPES_MESSAGE =
  'This is a plain Atlassian API token. Create one with “Create API token with scopes”, choose Bitbucket, and tick the read scopes listed above.';

export const BITBUCKET_INVALID_MESSAGE =
  'Bitbucket rejected this email and API token. Check the Atlassian account email and paste the token again.';

export type BitbucketFailureKind = BitbucketAuthErrorKind | 'unreachable';

/** Credentials Bitbucket refused, or could not be checked. Routes answer 400/422. */
export class BitbucketCredentialError extends Error {
  constructor(
    readonly kind: BitbucketFailureKind,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BitbucketCredentialError';
  }
}

/** The token sees zero or several workspaces and none was named. Routes answer 400. */
/** A workspace change was refused because repositories are still synced from the old one. */
export class BitbucketWorkspaceInUseError extends Error {
  constructor(readonly repoSyncCount: number) {
    super(
      `This connection still syncs ${repoSyncCount} ${repoSyncCount === 1 ? 'repository' : 'repositories'} from its current workspace. Remove them before changing the workspace.`,
    );
    this.name = 'BitbucketWorkspaceInUseError';
  }
}

export class BitbucketWorkspaceChoiceError extends Error {
  constructor(readonly workspaces: BitbucketWorkspace[], requested?: string) {
    super(
      workspaces.length === 0
        ? 'This API token cannot see any Bitbucket workspace. Check that it was created with the read:workspace:bitbucket scope.'
        : requested
          ? `This API token cannot see the workspace "${requested}". Choose one it can see.`
          : 'This API token can see several Bitbucket workspaces. Choose the one to connect.',
    );
    this.name = 'BitbucketWorkspaceChoiceError';
  }
}

/** Upstream failure on a credential-spending read; carries the status so 401/403 survive. */
export class BitbucketUpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BitbucketUpstreamError';
  }
}

export interface CreateBitbucketInstanceInput {
  name: string;
  email: string;
  apiToken: string;
  workspace?: string;
}

export interface UpdateBitbucketInstanceInput {
  name?: string;
  email?: string;
  apiToken?: string;
  workspace?: string;
}

export interface BitbucketCredentials {
  email: string;
  apiToken: string;
}

export type CredentialTestResult =
  | {
      ok: true;
      user: { nickname: string; displayName: string | null };
      workspaces: BitbucketWorkspace[];
    }
  | { ok: false; kind: BitbucketFailureKind; status: number; error: string };

export type ConnectionTestResult =
  | {
      ok: true;
      user: { nickname: string; displayName: string | null };
      workspaces: BitbucketWorkspace[];
    }
  | { ok: false; error: string; notFound?: boolean };

type RefreshResult = { ok: boolean; error?: string; notFound?: boolean };

/** What the API returns for an instance — never the token. */
const PUBLIC_SELECT = {
  id: true,
  name: true,
  workspace: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** A failure, as a kind + status + message safe to show (never the token). */
function describeFailure(err: unknown): { kind: BitbucketFailureKind; status: number; error: string } {
  if (err instanceof BitbucketAuthError) {
    if (err.kind === 'no-bitbucket-scopes') return { kind: err.kind, status: err.status, error: BITBUCKET_NO_SCOPES_MESSAGE };
    if (err.kind === 'invalid') return { kind: err.kind, status: err.status, error: BITBUCKET_INVALID_MESSAGE };
    return { kind: err.kind, status: err.status, error: err.message };
  }
  if (err instanceof BitbucketApiError) return { kind: 'unreachable', status: err.status, error: err.message };
  return {
    kind: 'unreachable',
    status: 0,
    error: `Could not reach Bitbucket: ${err instanceof Error ? err.message : 'unknown error'}`,
  };
}

const workspaceHost = (workspace: string | null | undefined) =>
  workspace ? `https://bitbucket.org/${workspace}` : null;

export class BitbucketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchFn: typeof fetch = fetch,
    /** Tests shorten retries; production keeps the client's defaults. */
    private readonly clientOptions: Pick<BitbucketClientConfig, 'sleep' | 'maxRetries' | 'baseUrl'> = {},
  ) {}

  private client(creds: BitbucketCredentials): BitbucketClient {
    return new BitbucketClient({ ...this.clientOptions, ...creds, fetchImpl: this.fetchFn });
  }

  /** The ONE scoped credential resolve. Every credential-spending path goes through it. */
  private resolveInstance(caller: ConnectionCaller, id: string) {
    return this.prisma.bitbucketInstance.findFirst({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { id: true, email: true, apiToken: true, workspace: true },
    });
  }

  async listInstances(caller: ConnectionCaller) {
    const rows = await this.prisma.bitbucketInstance.findMany({
      where: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      select: { ...PUBLIC_SELECT, ownerUserId: true, createdBy: CREATED_BY_SELECT },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => withOwnershipFields(r));
  }

  /** Pre-save "Create & test": who the token belongs to and which workspaces it sees. */
  async testCredentials(creds: BitbucketCredentials): Promise<CredentialTestResult> {
    try {
      const client = this.client(creds);
      const user = await getBitbucketCurrentUser(client);
      const workspaces = await listBitbucketWorkspaces(client);
      return { ok: true, user: { nickname: user.nickname, displayName: user.displayName }, workspaces };
    } catch (err) {
      return { ok: false, ...describeFailure(err) };
    }
  }

  /**
   * Throws BitbucketCredentialError when the token cannot authenticate, and
   * BitbucketWorkspaceChoiceError when no workspace was named and the token does
   * not see exactly one. Nothing is written in either case.
   */
  async createInstance(caller: ConnectionCaller, input: CreateBitbucketInstanceInput, actingUserId?: string) {
    // Always tested — the form promises "Create & test", and a typed workspace
    // is no proof that the email and token work, or that the token can see it.
    const tested = await this.testCredentials(input);
    if (!tested.ok) throw new BitbucketCredentialError(tested.kind, tested.status, tested.error);
    let workspace = input.workspace;
    if (workspace) {
      if (!tested.workspaces.some((w) => w.slug === workspace)) {
        throw new BitbucketWorkspaceChoiceError(tested.workspaces, workspace);
      }
    } else {
      if (tested.workspaces.length !== 1) throw new BitbucketWorkspaceChoiceError(tested.workspaces);
      workspace = tested.workspaces[0]!.slug;
    }
    return this.prisma.bitbucketInstance.create({
      data: {
        organizationId: caller.organizationId,
        name: input.name,
        email: input.email,
        apiToken: input.apiToken,
        workspace,
        // Stamped from the creator's role and never re-derived — see GitLabService.
        ownerUserId: caller.isOrgAdmin ? null : (caller.userId ?? null),
        ...(actingUserId && { createdById: actingUserId }),
      },
      select: PUBLIC_SELECT,
    });
  }

  /**
   * Null when the caller may not see the row. New credentials (email or token)
   * are tested before they are stored, so a PATCH cannot silently break sync.
   */
  async updateInstance(
    caller: ConnectionCaller,
    id: string,
    patch: UpdateBitbucketInstanceInput,
    actingUserId?: string,
    log?: ConnectionAuditLog,
  ) {
    const existing = await this.resolveInstance(caller, id);
    if (!existing) return null;

    const workspaceChanges = patch.workspace !== undefined && patch.workspace !== existing.workspace;
    if (patch.email !== undefined || patch.apiToken !== undefined || workspaceChanges) {
      const tested = await this.testCredentials({
        email: patch.email ?? existing.email,
        apiToken: patch.apiToken ?? existing.apiToken,
      });
      if (!tested.ok) throw new BitbucketCredentialError(tested.kind, tested.status, tested.error);
      const target = patch.workspace ?? existing.workspace;
      if (target && !tested.workspaces.some((w) => w.slug === target)) {
        throw new BitbucketWorkspaceChoiceError(tested.workspaces, target);
      }
    }
    // Repo syncs are named `workspace/repo`; moving the connection to another
    // workspace would leave every one of them pointing outside it, failing on
    // each run. Detach them first.
    if (workspaceChanges) {
      const syncs = await this.prisma.bitbucketRepoSync.count({ where: { bitbucketInstanceId: id } });
      if (syncs > 0) throw new BitbucketWorkspaceInUseError(syncs);
    }

    const updated = await this.prisma.bitbucketInstance.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.email !== undefined && { email: patch.email }),
        ...(patch.apiToken !== undefined && { apiToken: patch.apiToken }),
        ...(patch.workspace !== undefined && { workspace: patch.workspace }),
      },
      select: PUBLIC_SELECT,
    });
    logHostRepoint(log, {
      provider: 'bitbucket',
      instanceId: id,
      organizationId: caller.organizationId,
      actingUserId,
      from: workspaceHost(existing.workspace),
      to: patch.workspace === undefined ? undefined : workspaceHost(patch.workspace),
    });
    return updated;
  }

  /** Cascades to BitbucketRepoSync → BoardBitbucketSource. False on a miss. */
  async deleteInstance(caller: ConnectionCaller, id: string): Promise<boolean> {
    const existing = await this.resolveInstance(caller, id);
    if (!existing) return false;
    await this.prisma.bitbucketInstance.delete({ where: { id } });
    return true;
  }

  /**
   * The stored credential against `/user`, plus a check that the connection's
   * workspace is still visible. Failures carry the HTTP status in the message
   * ("Bitbucket returned 401: …") because board health classifies on it.
   */
  async testConnection(caller: ConnectionCaller, id: string): Promise<ConnectionTestResult> {
    const instance = await this.resolveInstance(caller, id);
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const tested = await this.testCredentials(instance);
    if (!tested.ok) {
      return { ok: false, error: tested.status ? `Bitbucket returned ${tested.status}: ${tested.error}` : tested.error };
    }
    if (instance.workspace && !tested.workspaces.some((w) => w.slug === instance.workspace)) {
      return {
        ok: false,
        error: `Bitbucket returned 403: this API token can no longer see the workspace "${instance.workspace}".`,
      };
    }
    return tested;
  }

  /** Replace the token after testing it with the stored email. The old one stays on failure. */
  async refreshToken(caller: ConnectionCaller, id: string, newToken: string): Promise<RefreshResult> {
    const instance = await this.resolveInstance(caller, id);
    if (!instance) return { ok: false, notFound: true, error: 'Instance not found' };
    const tested = await this.testCredentials({ email: instance.email, apiToken: newToken });
    if (!tested.ok) return { ok: false, error: tested.error };
    const { count } = await this.prisma.bitbucketInstance.updateMany({
      where: { id, organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      data: { apiToken: newToken },
    });
    if (count === 0) return { ok: false, notFound: true, error: 'Instance not found' };
    return { ok: true };
  }

  /**
   * Every repository in the connection's workspace, grouped by Bitbucket
   * project for the picker. Throws `Error(/not found/)` for a row the caller
   * may not see (before any network call), and BitbucketUpstreamError with the
   * upstream status otherwise — 401/403 drive the web layer's reconnect flow.
   */
  async listRemoteRepos(caller: ConnectionCaller, id: string): Promise<BitbucketRemoteReposResponse> {
    const instance = await this.resolveInstance(caller, id);
    if (!instance) throw new Error(`Bitbucket instance not found: ${id}`);
    if (!instance.workspace) {
      throw new BitbucketUpstreamError(409, 'This connection has no workspace yet. Edit it and choose one.');
    }
    try {
      const repos = await listBitbucketRepos(this.client(instance), instance.workspace);
      return { workspace: instance.workspace, projects: groupBitbucketReposByProject(repos) };
    } catch (err) {
      const f = describeFailure(err);
      throw new BitbucketUpstreamError(f.status || 502, f.error);
    }
  }
}
