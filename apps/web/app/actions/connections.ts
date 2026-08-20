'use server';
import { authFetch } from './api';
import { forbiddenMessage } from '../lib/connection-permission';

export interface JiraProjectSyncRow {
  id: string;
  jiraInstanceId: string;
  jiraProjectKey: string;
  syncChangelog: boolean;
  syncWorklogs: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export async function listJiraProjectSyncs(): Promise<JiraProjectSyncRow[]> {
  const res = await authFetch('/project-syncs/jira', { method: 'GET' });
  if (!res.ok) throw new Error(`list jira project syncs failed: ${res.status}`);
  return res.json();
}

export async function createJiraProjectSync(input: {
  jiraInstanceId: string;
  jiraProjectKey: string;
  syncChangelog: boolean;
  syncWorklogs: boolean;
}) {
  const res = await authFetch('/project-syncs/jira', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteJiraProjectSync(id: string): Promise<void> {
  const res = await authFetch(`/project-syncs/jira/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---- GitHub ----

// The bulk-repo ingestion model (Task 16) always syncs PRs, reviews, commits,
// workflow runs, deployments, and issues per repo; cadence is governed by
// `tier`. Per-repo syncPrs/syncCommits toggles were removed, so this row mirrors
// what `GET /project-syncs/github` returns — no per-feature flags.
export interface GitHubRepoSyncRow {
  id: string;
  githubInstanceId: string;
  repoFullName: string;
  tier: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export async function listGitHubRepoSyncs(): Promise<GitHubRepoSyncRow[]> {
  const res = await authFetch('/project-syncs/github', { method: 'GET' });
  if (!res.ok) throw new Error(`list github repo syncs failed: ${res.status}`);
  return res.json();
}

export async function createGitHubRepoSync(input: {
  githubInstanceId: string;
  repoFullName: string;
}) {
  const res = await authFetch('/project-syncs/github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteGitHubRepoSync(id: string): Promise<void> {
  const res = await authFetch(`/project-syncs/github/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---- Azure DevOps ----

export interface AdoProjectSyncRow {
  id: string;
  azureDevOpsInstanceId: string;
  adoProject: string;
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos: string[];
  syncAllRepos: boolean;
  /** Explicit production allow-lists; BOTH empty = fall back to the heuristic. */
  prodReleaseDefinitions: string[];
  prodStages: string[];
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export async function listAdoProjectSyncs(): Promise<AdoProjectSyncRow[]> {
  const res = await authFetch('/project-syncs/ado', { method: 'GET' });
  if (!res.ok) throw new Error(`list ado project syncs failed: ${res.status}`);
  return res.json();
}

export async function createAdoProjectSync(input: {
  azureDevOpsInstanceId: string;
  adoProject: string;
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos: string[];
  syncAllRepos: boolean;
}) {
  const res = await authFetch('/project-syncs/ado', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/**
 * Set which release pipelines / stages count as a production deploy.
 *
 * Separate from updateAdoProjectSync because it is a different endpoint with a
 * different guard: the sync flags are orgRole(MEMBER) and keyed by the sync ROW,
 * while production config is keyed by the INSTANCE id and requires the
 * organization ADMIN role. Passing two empty lists clears the override and
 * returns the project to the stage-name heuristic.
 *
 * Because the two writes span two policies with no transaction across them, the
 * caller must not issue this one unconditionally — see the `writesProdConfig`
 * guard in AzureDevOpsConnectionsPanel.
 *
 * Throws rather than returning a result, because its only caller already catches
 * and renders `error.message` — so a refusal must arrive as a message a member
 * can act on, not as `Forbidden`.
 */
export async function saveAdoProductionConfig(
  instanceId: string,
  project: string,
  input: { definitions: string[]; stages: string[] }
) {
  const res = await authFetch(
    `/azure-devops/instances/${instanceId}/project-syncs/${encodeURIComponent(project)}/production-config`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    let code: string | undefined;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string') code = body.error;
    } catch {
      // Non-JSON body — fall through to the raw text below.
    }
    throw new Error(forbiddenMessage(res.status, code) ?? text);
  }
  return res.json();
}

export async function updateAdoProjectSync(
  id: string,
  patch: { syncPrs?: boolean; syncCommits?: boolean; syncRepos?: string[]; syncAllRepos?: boolean }
) {
  const res = await authFetch(`/project-syncs/ado/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAdoProjectSync(id: string): Promise<void> {
  const res = await authFetch(`/project-syncs/ado/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---- GitLab ----

export interface GitLabProjectSyncRow {
  id: string;
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs: boolean;
  syncCommits: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  boardCount: number;
}

export async function listGitLabProjectSyncs(): Promise<GitLabProjectSyncRow[]> {
  const res = await authFetch('/project-syncs/gitlab', { method: 'GET' });
  if (!res.ok) throw new Error(`list gitlab project syncs failed: ${res.status}`);
  return res.json();
}

export async function createGitLabProjectSync(input: {
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs: boolean;
  syncCommits: boolean;
}) {
  const res = await authFetch('/project-syncs/gitlab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateGitLabProjectSync(
  id: string,
  patch: { syncPrs?: boolean; syncCommits?: boolean }
) {
  const res = await authFetch(`/project-syncs/gitlab/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteGitLabProjectSync(id: string): Promise<void> {
  const res = await authFetch(`/project-syncs/gitlab/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---- Instances: list (normalized), refresh token, test ----

export interface SourceInstanceRow {
  id: string;
  label: string;
  sublabel: string;
}

export interface RefreshResult {
  ok: boolean;
  error?: string;
}

/**
 * One failure shape for every connection mutation.
 *
 * These routes are gated on the organization ADMIN role, so a refusal is the
 * one error a member can still provoke from a stale tab or a direct link.
 * `Forbidden` / `Request failed: 403` reads as a broken app; the permission copy
 * reads as something the person can act on. Every other status keeps the API's
 * own message, falling back to `<fallback>: <status>`.
 */
async function failureFrom(res: Response, fallback: string): Promise<RefreshResult> {
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // Non-JSON body — the status-derived fallback below is the best available.
  }
  const refused = forbiddenMessage(res.status, code);
  if (refused) return { ok: false, error: refused };
  return { ok: false, error: code ?? `${fallback}: ${res.status}` };
}

async function refreshTokenAt(path: string, token: string): Promise<RefreshResult> {
  const res = await authFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (res.ok) return { ok: true };
  return failureFrom(res, 'Request failed');
}

async function testConnectionAt(path: string): Promise<RefreshResult> {
  const res = await authFetch(path, { method: 'POST' });
  if (res.ok) return { ok: true };
  return failureFrom(res, 'Request failed');
}

async function listInstancesRaw(path: string): Promise<Record<string, unknown>[]> {
  const res = await authFetch(path, { method: 'GET' });
  if (!res.ok) throw new Error(`list instances failed: ${res.status}`);
  return res.json();
}

export async function listJiraInstances(): Promise<SourceInstanceRow[]> {
  const rows = await listInstancesRaw('/jira/instances');
  return rows.map((r) => ({ id: String(r.id), label: String(r.name ?? r.atlassianUrl), sublabel: String(r.email ?? '') }));
}
export async function listGitHubInstances(): Promise<SourceInstanceRow[]> {
  const rows = await listInstancesRaw('/github/instances');
  return rows.map((r) => ({ id: String(r.id), label: String(r.org || 'GitHub'), sublabel: String(r.baseUrl ?? '') }));
}
export async function listAdoInstances(): Promise<SourceInstanceRow[]> {
  const rows = await listInstancesRaw('/azure-devops/instances');
  return rows.map((r) => ({ id: String(r.id), label: String(r.name ?? r.orgUrl), sublabel: String(r.orgUrl ?? '') }));
}
export async function listGitLabInstances(): Promise<SourceInstanceRow[]> {
  const rows = await listInstancesRaw('/gitlab/instances');
  return rows.map((r) => ({ id: String(r.id), label: String(r.name ?? 'GitLab'), sublabel: String(r.baseUrl ?? '') }));
}

export async function refreshJiraToken(id: string, token: string) {
  return refreshTokenAt(`/jira/instances/${id}/refresh-token`, token);
}
export async function refreshGitHubToken(id: string, token: string) {
  return refreshTokenAt(`/github/instances/${id}/refresh-token`, token);
}
export async function refreshAdoToken(id: string, token: string) {
  return refreshTokenAt(`/azure-devops/instances/${id}/refresh-token`, token);
}
export async function refreshGitLabToken(id: string, token: string) {
  return refreshTokenAt(`/gitlab/instances/${id}/refresh-token`, token);
}

export async function testJiraConnection(id: string) {
  return testConnectionAt(`/jira/instances/${id}/test`);
}
export async function testGitHubConnection(id: string) {
  return testConnectionAt(`/github/instances/${id}/test`);
}
export async function testAdoConnection(id: string) {
  return testConnectionAt(`/azure-devops/instances/${id}/test`);
}
export async function testGitLabConnection(id: string) {
  return testConnectionAt(`/gitlab/instances/${id}/test`);
}

// ---- Instances: delete ----
// Deleting an instance cascades (Prisma onDelete: Cascade): the instance's
// project syncs and every board's source rows built on them are removed too.
async function deleteInstanceAt(path: string): Promise<RefreshResult> {
  const res = await authFetch(path, { method: 'DELETE' });
  if (res.ok) return { ok: true };
  return failureFrom(res, 'Delete failed');
}

// ---- Instances: create ----

export type ConnectionProvider = 'jira' | 'github' | 'ado' | 'gitlab';

/** Where each provider's create endpoint lives, and the empty scope it starts with. */
const CREATE_ENDPOINT: Record<ConnectionProvider, { path: string; scope: Record<string, string[]> }> = {
  jira: { path: '/jira/instances', scope: { projectKeys: [] } },
  github: { path: '/github/instances', scope: { repos: [] } },
  ado: { path: '/azure-devops/instances', scope: { projects: [] } },
  gitlab: { path: '/gitlab/instances', scope: { projects: [] } },
};

/**
 * Creates a connection. Requires the organization ADMIN role.
 *
 * Returns its failure rather than throwing: a server action that throws reaches
 * the client as an opaque Next.js digest with no message, and the message is the
 * whole point here — a refused create must say the administrator role is missing,
 * and a rejected credential must say so in the provider's own words.
 */
export async function createConnection(
  provider: ConnectionProvider,
  values: Record<string, string>,
): Promise<RefreshResult & { id?: string }> {
  const { path, scope } = CREATE_ENDPOINT[provider];
  let res: Response;
  try {
    res = await authFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, ...scope }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'Could not reach the server. Try again.' };
  }
  if (!res.ok) return failureFrom(res, 'Could not create the connection');
  try {
    const body = (await res.json()) as { id?: unknown };
    return { ok: true, id: typeof body.id === 'string' ? body.id : undefined };
  } catch {
    return { ok: true };
  }
}

export async function deleteJiraInstance(id: string) {
  return deleteInstanceAt(`/jira/instances/${id}`);
}
export async function deleteGitHubInstance(id: string) {
  return deleteInstanceAt(`/github/instances/${id}`);
}
export async function deleteAdoInstance(id: string) {
  return deleteInstanceAt(`/azure-devops/instances/${id}`);
}
export async function deleteGitLabInstance(id: string) {
  return deleteInstanceAt(`/gitlab/instances/${id}`);
}
