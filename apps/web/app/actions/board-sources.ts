'use server';
import { authFetch } from './api';

/**
 * Result of an attach action. Attach actions must *return* failures rather than
 * `throw`, because a thrown error inside a server action is masked behind an
 * opaque Next.js digest before it reaches the browser — so the API's message
 * (e.g. "already attached") would be lost. Returning it keeps it intact.
 */
export type AttachOutcome<T> = { ok: true; row: T } | { ok: false; error: string };

/** Result of discovering a connection's remote projects — distinguishes an
 *  expired/invalid token (401/403) from other failures so the UI can offer a
 *  reconnect flow. */
export type RemoteProjectsResult =
  | { ok: true; projects: string[] }
  | { ok: false; authFailed: boolean; error: string };

/** Extract a human-readable message from a non-ok API response. */
async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Body was not JSON — fall through to the raw text.
  }
  return text || `Request failed (${res.status})`;
}

// ---------------- Jira ----------------

export interface BoardJiraSourceRow {
  id: string;
  boardId: string;
  jiraProjectSyncId: string;
  targetGroupId: string | null;
  allowedIssueTypes: string[];
  statusMapping: Record<string, string>;
  defaultSyncedFields: string[];
  createdAt: string;
  updatedAt: string;
  jiraProjectSync: { id: string; jiraProjectKey: string; jiraInstanceId: string };
}

export async function listBoardJiraSources(boardId: string): Promise<BoardJiraSourceRow[]> {
  const res = await authFetch(`/boards/${boardId}/sources/jira`, { method: 'GET' });
  if (!res.ok) throw new Error(`list board jira sources: ${res.status}`);
  return res.json();
}

export async function attachBoardJiraSource(input: {
  boardId: string;
  jiraProjectSyncId: string;
  allowedIssueTypes?: string[];
}): Promise<AttachOutcome<BoardJiraSourceRow>> {
  const res = await authFetch(`/boards/${input.boardId}/sources/jira`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, row: await res.json() };
}

export async function detachBoardJiraSource(boardId: string, id: string): Promise<void> {
  const res = await authFetch(`/boards/${boardId}/sources/jira/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------- GitHub ----------------

export interface BoardGitHubSourceRow {
  id: string;
  boardId: string;
  gitHubRepoSyncId: string;
  targetGroupId: string | null;
  allowedLabels: string[];
  includeClosedIssues: boolean;
  statusMapping: Record<string, string>;
  defaultSyncedFields: string[];
  syncIssuesToBoard: boolean;
  createdAt: string;
  updatedAt: string;
  gitHubRepoSync: {
    id: string;
    repoFullName: string;
    githubInstanceId: string;
    lastSuccessAt: string | null;
  };
}

export async function listBoardGitHubSources(boardId: string): Promise<BoardGitHubSourceRow[]> {
  const res = await authFetch(`/boards/${boardId}/sources/github`, { method: 'GET' });
  if (!res.ok) throw new Error(`list board github sources: ${res.status}`);
  return res.json();
}

export async function attachBoardGitHubSource(input: {
  boardId: string;
  gitHubRepoSyncId: string;
  allowedLabels?: string[];
  includeClosedIssues?: boolean;
  syncIssuesToBoard?: boolean;
  useForIntelligence?: boolean;
}): Promise<AttachOutcome<BoardGitHubSourceRow>> {
  const res = await authFetch(`/boards/${input.boardId}/sources/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, row: await res.json() };
}

export async function detachBoardGitHubSource(boardId: string, id: string): Promise<void> {
  const res = await authFetch(`/boards/${boardId}/sources/github/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------- ADO ----------------

export interface BoardAdoSourceRow {
  id: string;
  boardId: string;
  azureDevOpsProjectSyncId: string;
  targetGroupId: string | null;
  allowedWorkItemTypes: string[];
  wiqlFilter: string | null;
  statusMapping: Record<string, string>;
  defaultSyncedFields: string[];
  createdAt: string;
  updatedAt: string;
  azureDevOpsProjectSync: { id: string; adoProject: string; azureDevOpsInstanceId: string };
}

export async function listBoardAdoSources(boardId: string): Promise<BoardAdoSourceRow[]> {
  const res = await authFetch(`/boards/${boardId}/sources/ado`, { method: 'GET' });
  if (!res.ok) throw new Error(`list board ado sources: ${res.status}`);
  return res.json();
}

export async function attachBoardAdoSource(input: {
  boardId: string;
  azureDevOpsProjectSyncId: string;
  allowedWorkItemTypes?: string[];
  wiqlFilter?: string | null;
  syncWorkItemsToBoard?: boolean;
  useForIntelligence?: boolean;
}): Promise<AttachOutcome<BoardAdoSourceRow>> {
  const res = await authFetch(`/boards/${input.boardId}/sources/ado`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, row: await res.json() };
}

export async function detachBoardAdoSource(boardId: string, id: string): Promise<void> {
  const res = await authFetch(`/boards/${boardId}/sources/ado/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------- GitLab ----------------

export interface BoardGitLabSourceRow {
  id: string;
  boardId: string;
  gitlabProjectSyncId: string;
  targetGroupId: string | null;
  syncIssuesToBoard: boolean;
  syncMrsToBoard: boolean;
  createdAt: string;
  updatedAt: string;
  gitlabProjectSync: { id: string; projectPath: string; gitlabInstanceId: string };
}

export async function listBoardGitLabSources(boardId: string): Promise<BoardGitLabSourceRow[]> {
  const res = await authFetch(`/boards/${boardId}/sources/gitlab`, { method: 'GET' });
  if (!res.ok) throw new Error(`list board gitlab sources: ${res.status}`);
  return res.json();
}

export async function attachBoardGitLabSource(input: {
  boardId: string;
  gitlabProjectSyncId: string;
  syncIssuesToBoard?: boolean;
  syncMrsToBoard?: boolean;
}): Promise<AttachOutcome<BoardGitLabSourceRow>> {
  const res = await authFetch(`/boards/${input.boardId}/sources/gitlab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  return { ok: true, row: await res.json() };
}

export async function detachBoardGitLabSource(boardId: string, id: string): Promise<void> {
  const res = await authFetch(`/boards/${boardId}/sources/gitlab/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------- Provider sync list helpers (re-exports) ----------------
// Lightweight read helpers used by the Sources page to populate the "attach" dropdowns.
// These mirror the GET endpoints exposed by apps/api/src/project-syncs/*.routes.ts.

export interface GitHubRepoSyncRow {
  id: string;
  githubInstanceId: string;
  repoFullName: string;
  syncPrs: boolean;
  syncCommits: boolean;
}

export async function listGitHubRepoSyncs(): Promise<GitHubRepoSyncRow[]> {
  const res = await authFetch('/project-syncs/github', { method: 'GET' });
  if (!res.ok) throw new Error(`list github repo syncs: ${res.status}`);
  return res.json();
}

export interface AdoProjectSyncRow {
  id: string;
  azureDevOpsInstanceId: string;
  adoProject: string;
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos: string[];
}

export async function listAdoProjectSyncs(): Promise<AdoProjectSyncRow[]> {
  const res = await authFetch('/project-syncs/ado', { method: 'GET' });
  if (!res.ok) throw new Error(`list ado project syncs: ${res.status}`);
  return res.json();
}

export interface GitLabProjectSyncRow {
  id: string;
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs: boolean;
  syncCommits: boolean;
}

export async function listGitLabProjectSyncs(): Promise<GitLabProjectSyncRow[]> {
  const res = await authFetch('/project-syncs/gitlab', { method: 'GET' });
  if (!res.ok) throw new Error(`list gitlab project syncs: ${res.status}`);
  return res.json();
}

// ---------------- ensure-sync (find-or-create) for inline "add new project" ----------------

export async function ensureJiraProjectSync(jiraInstanceId: string, jiraProjectKey: string): Promise<{ id: string }> {
  const res = await authFetch('/project-syncs/jira/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jiraInstanceId, jiraProjectKey }),
  });
  if (!res.ok) throw new Error(`ensure jira sync: ${res.status}`);
  return res.json();
}

export async function ensureGitHubRepoSync(githubInstanceId: string, repoFullName: string): Promise<{ id: string }> {
  const res = await authFetch('/project-syncs/github/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ githubInstanceId, repoFullName }),
  });
  if (!res.ok) throw new Error(`ensure github sync: ${res.status}`);
  return res.json();
}

export async function ensureAdoProjectSync(azureDevOpsInstanceId: string, adoProject: string): Promise<{ id: string }> {
  const res = await authFetch('/project-syncs/ado/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ azureDevOpsInstanceId, adoProject }),
  });
  if (!res.ok) throw new Error(`ensure ado sync: ${res.status}`);
  return res.json();
}

export async function ensureGitLabProjectSync(gitlabInstanceId: string, projectPath: string): Promise<{ id: string }> {
  const res = await authFetch('/project-syncs/gitlab/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gitlabInstanceId, projectPath }),
  });
  if (!res.ok) throw new Error(`ensure gitlab sync: ${res.status}`);
  return res.json();
}

// ---------------- Patch helpers + preview-count ----------------

import type { z as _z } from 'zod';
import {
  BoardJiraSourcePatchSchema,
  BoardGitHubSourcePatchSchema,
  BoardAdoSourcePatchSchema,
  BoardGitLabSourcePatchSchema,
  type AdoSourceRepositoriesResponseDto,
  type AdoAreaPathsResponseDto,
} from '@deckgauge/shared';

export type BoardJiraSourcePatch = _z.infer<typeof BoardJiraSourcePatchSchema>;
export type BoardGitHubSourcePatch = _z.infer<typeof BoardGitHubSourcePatchSchema>;
export type BoardAdoSourcePatch = _z.infer<typeof BoardAdoSourcePatchSchema>;
export type BoardGitLabSourcePatch = _z.infer<typeof BoardGitLabSourcePatchSchema>;

export async function patchBoardJiraSource(
  boardId: string,
  sourceId: string,
  patch: BoardJiraSourcePatch,
) {
  const res = await authFetch(`/boards/${boardId}/sources/jira/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch jira source failed: ${res.status}`);
  return res.json();
}

export async function patchBoardGitHubSource(
  boardId: string,
  sourceId: string,
  patch: BoardGitHubSourcePatch,
) {
  const res = await authFetch(`/boards/${boardId}/sources/github/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch github source failed: ${res.status}`);
  return res.json();
}

export async function patchBoardAdoSource(
  boardId: string,
  sourceId: string,
  patch: BoardAdoSourcePatch,
) {
  const res = await authFetch(`/boards/${boardId}/sources/ado/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch ado source failed: ${res.status}`);
  return res.json();
}

export async function patchBoardGitLabSource(
  boardId: string,
  sourceId: string,
  patch: BoardGitLabSourcePatch,
) {
  const res = await authFetch(`/boards/${boardId}/sources/gitlab/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch gitlab source failed: ${res.status}`);
  return res.json();
}

export interface PreviewCount {
  count: number;
  sampledAt: string;
}

export async function fetchSourcePreviewCount(
  boardId: string,
  provider: 'jira' | 'github' | 'ado' | 'gitlab',
  sourceId: string,
): Promise<PreviewCount | null> {
  const res = await authFetch(
    `/boards/${boardId}/sources/${provider}/${sourceId}/preview-count`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`preview count failed: ${res.status}`);
  return res.json();
}

// Returns the list of source-side status values (e.g. Jira workflow statuses,
// GitHub labels + state, ADO work-item states) seen in ClickHouse for this
// board source. The web status-mapping editor uses this to populate the
// "source" column of the mapping table. GitLab not supported — it has no
// statusMapping column yet.
export async function fetchSourceStatuses(
  boardId: string,
  provider: 'jira' | 'github' | 'ado',
  sourceId: string,
): Promise<string[]> {
  const res = await authFetch(
    `/boards/${boardId}/sources/${provider}/${sourceId}/source-statuses`,
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`source statuses failed: ${res.status}`);
  const body = (await res.json()) as { statuses?: string[] };
  return body.statuses ?? [];
}

// Returns the list of Jira issue types discovered live for this board source.
// Used by the zone-card chip picker so real (incl. custom) types appear instead
// of the hardcoded {Bug, Story, Task, Epic, Sub-task} default.
export async function fetchSourceJiraIssueTypes(
  boardId: string,
  sourceId: string,
): Promise<{ types: string[] }> {
  const res = await authFetch(
    `/boards/${boardId}/sources/jira/${sourceId}/issue-types`,
  );
  if (res.status === 404) return { types: [] };
  if (!res.ok) throw new Error(`source jira issue-types failed: ${res.status}`);
  return res.json();
}

// Same idea for Azure DevOps — live work-item-type discovery per board source.
export async function fetchSourceAdoWorkItemTypes(
  boardId: string,
  sourceId: string,
): Promise<{ types: string[] }> {
  const res = await authFetch(
    `/boards/${boardId}/sources/ado/${sourceId}/work-item-types`,
  );
  if (res.status === 404) return { types: [] };
  if (!res.ok) throw new Error(`source ado work-item-types failed: ${res.status}`);
  return res.json();
}

// Repositories a board's ADO source can choose from for its engineering-
// intelligence scope, with each repo's PR count for the picker (Task 12/13).
// This is the *board-source*-level list — do not confuse with
// `listAdoProjectSyncs`'s `syncRepos`, which is the shared project sync's
// ingest scope.
export async function fetchAdoSourceRepositories(
  boardId: string,
  sourceId: string,
): Promise<AdoSourceRepositoriesResponseDto> {
  const res = await authFetch(
    `/boards/${boardId}/sources/ado/${sourceId}/repositories`,
    { method: 'GET' },
  );
  if (res.status === 404) return { repos: [], otherBoardNames: [] };
  if (!res.ok) throw new Error(`fetch ado source repositories failed: ${res.status}`);
  return res.json();
}

// Persists the board's engineering-intelligence repository scope. Deliberately
// narrow (only `intelligenceRepos`) rather than routing callers through the
// general `patchBoardAdoSource`, so the repository-scope picker cannot
// accidentally clobber the board source's other fields — and cannot be
// confused with `updateAdoProjectSync` (connections.ts), which patches the
// shared project sync's `syncRepos` ingest scope instead.
export async function saveAdoIntelligenceRepos(
  boardId: string,
  sourceId: string,
  intelligenceRepos: string[],
) {
  const res = await authFetch(`/boards/${boardId}/sources/ado/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intelligenceRepos }),
  });
  if (!res.ok) throw new Error(`save ado intelligence repos failed: ${res.status}`);
  return res.json();
}

// Area paths a board's ADO source can choose from for its work-item scope,
// with each area path's work-item count for the picker (Task 6/9). Area paths
// govern BOTH which work items the board syncs as cards and its engineering-
// intelligence widgets — not analytics alone. The `areaPaths` counterpart to
// `fetchAdoSourceRepositories` — `intelligenceRepos` cannot narrow work items,
// since `ado_work_items` has no repository column.
export async function fetchAdoSourceAreaPaths(
  boardId: string,
  sourceId: string,
): Promise<AdoAreaPathsResponseDto> {
  const res = await authFetch(
    `/boards/${boardId}/sources/ado/${sourceId}/area-paths`,
    { method: 'GET' },
  );
  if (res.status === 404) return { areaPaths: [] };
  if (!res.ok) throw new Error(`fetch ado source area paths failed: ${res.status}`);
  return res.json();
}

// Persists the board's work-item area-path scope — narrows both the board's
// synced cards and its engineering-intelligence widgets (Task 6/9), not
// analytics alone. Deliberately narrow (only `areaPaths`) rather than routing
// callers through the general `patchBoardAdoSource`, for the same reason
// `saveAdoIntelligenceRepos` is: a patch that omits the field must leave the
// existing selection untouched, and a broad action makes that easy to get
// wrong.
export async function saveAdoAreaPaths(
  boardId: string,
  sourceId: string,
  areaPaths: string[],
) {
  const res = await authFetch(`/boards/${boardId}/sources/ado/${sourceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ areaPaths }),
  });
  if (!res.ok) throw new Error(`save ado intelligence area paths failed: ${res.status}`);
  return res.json();
}

// Returns the list of GitHub labels discovered live for this board source's
// repository. Used by the zone-card label picker to drive autocomplete so
// users can't typo a label that doesn't exist on the repo.
export async function fetchSourceGitHubLabels(
  boardId: string,
  sourceId: string,
): Promise<{ labels: string[] }> {
  const res = await authFetch(
    `/boards/${boardId}/sources/github/${sourceId}/labels`,
  );
  if (res.status === 404) return { labels: [] };
  if (!res.ok) throw new Error(`source github labels failed: ${res.status}`);
  return res.json();
}

// Returns the list of GitHub Issue Types discovered live for this board
// source's org (org-level feature, may be []  for orgs without it enabled).
// Used by the zone-card type-chip picker.
export async function fetchSourceGitHubIssueTypes(
  boardId: string,
  sourceId: string,
): Promise<{ types: string[] }> {
  const res = await authFetch(
    `/boards/${boardId}/sources/github/${sourceId}/issue-types`,
  );
  if (res.status === 404) return { types: [] };
  if (!res.ok) throw new Error(`source github issue-types failed: ${res.status}`);
  return res.json();
}
