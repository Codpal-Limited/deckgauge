'use server';

import { authFetch } from './api';
import type { RemoteProjectsResult } from './board-sources';
import {
  ConnectionHintSchema,
  type ConnectionHint,
  type DiscoveredJiraField,
  type AttachJiraFieldInput,
} from '@deckgauge/shared';

// --- Jira Instances ---

export async function fetchJiraInstances() {
  try {
    const res = await authFetch('/jira/instances', { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function createJiraInstance(data: {
  name: string;
  atlassianUrl: string;
  email: string;
  apiToken: string;
  projectKeys: string[];
}) {
  const res = await authFetch('/jira/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Jira instance: ${res.status} ${body}`);
  }
  return await res.json();
}

export type TestConnectionResult =
  | { ok: true }
  | { ok: false; error: string; hint?: ConnectionHint };

/**
 * Returns the API's real failure message instead of null. The previous `null`
 * became a bare "test failed" in the UI, hiding diagnoses the API had already
 * produced (e.g. a 401 caused by a vanity Atlassian host).
 */
export async function testJiraConnection(instanceId: string): Promise<TestConnectionResult> {
  try {
    const res = await authFetch(`/jira/instances/${instanceId}/test`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      hint?: unknown;
    };
    const parsedHint = ConnectionHintSchema.safeParse(body.hint);
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `Test failed (${res.status})`,
      hint: parsedHint.success ? parsedHint.data : undefined,
    };
  } catch {
    return { ok: false, error: 'Could not reach the API.' };
  }
}

export async function discoverJiraProjects(
  instanceId: string,
): Promise<RemoteProjectsResult> {
  try {
    const res = await authFetch(`/jira/instances/${instanceId}/projects`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) {
      const authFailed = res.status === 401 || res.status === 403;
      return { ok: false, authFailed, error: `Discovery failed (${res.status})` };
    }
    const data = (await res.json()) as Array<{ key?: string; projectKey?: string } | string>;
    const projects = data
      .map((p) => (typeof p === 'string' ? p : p.key ?? p.projectKey ?? ''))
      .filter((s): s is string => s.length > 0);
    return { ok: true, projects };
  } catch {
    return { ok: false, authFailed: false, error: 'Could not reach Jira.' };
  }
}

export async function updateJiraInstance(
  instanceId: string,
  data: { projectKeys?: string[]; atlassianUrl?: string },
) {
  const res = await authFetch(`/jira/instances/${instanceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update Jira instance: ${res.status} ${body}`);
  }
}

export async function deleteJiraInstance(
  instanceId: string,
): Promise<boolean> {
  try {
    const res = await authFetch(`/jira/instances/${instanceId}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Board Statuses ---

export interface BoardStatusOption {
  id: string;
  label: string;
  color: string;
}

export async function fetchBoardStatuses(boardId: string): Promise<BoardStatusOption[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/statuses`, {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// --- Boards ---

export async function fetchBoards() {
  try {
    const res = await authFetch('/boards', { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// The legacy `/sync-configs` and `/boards/:id/sync-configs` callers
// (fetchAllSyncConfigs, fetchSyncConfigs, create/update/deleteSyncConfig) are
// gone: the API removed those routes with the JiraSyncConfig model in the p9
// cleanup (eb4ddc10), and nothing in the app called them any more. Per-project
// sync is `/project-syncs/jira` — see actions/connections.ts and
// actions/board-sources.ts.

export async function fetchIssueTypes(
  instanceId: string,
  projectKey: string,
): Promise<string[]> {
  try {
    const res = await authFetch(
      `/jira/instances/${instanceId}/projects/${encodeURIComponent(projectKey)}/issue-types`,
    );
    if (!res.ok) return [];
    return res.json() as Promise<string[]>;
  } catch {
    return [];
  }
}

// --- Jira field mapping (Task 11) ---

export async function listJiraSourceFields(
  boardId: string,
  sourceId: string,
): Promise<{ fields: DiscoveredJiraField[] }> {
  const res = await authFetch(`/boards/${boardId}/sources/jira/${sourceId}/fields`);
  if (!res.ok) throw new Error('Failed to load Jira fields');
  return res.json() as Promise<{ fields: DiscoveredJiraField[] }>;
}

export async function attachJiraSourceField(
  boardId: string,
  sourceId: string,
  input: AttachJiraFieldInput,
): Promise<{ columnId: string }> {
  const res = await authFetch(`/boards/${boardId}/sources/jira/${sourceId}/fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to add the field');
  return res.json() as Promise<{ columnId: string }>;
}

export async function detachJiraSourceField(
  boardId: string,
  sourceId: string,
  fieldId: string,
): Promise<void> {
  const res = await authFetch(
    `/boards/${boardId}/sources/jira/${sourceId}/fields/${encodeURIComponent(fieldId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error('Failed to remove the field');
}
