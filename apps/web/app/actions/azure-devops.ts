'use server';

import { authFetch } from './api';
import type { RemoteProjectsResult } from './board-sources';

// --- Azure DevOps Instances ---

export async function fetchAzureDevOpsInstances() {
  try {
    const res = await authFetch('/azure-devops/instances', { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function createAzureDevOpsInstance(data: {
  name: string;
  orgUrl: string;
  authMethod: 'PAT' | 'BASIC';
  accessToken: string;
  username?: string | null;
  projects?: string[];
}) {
  const res = await authFetch('/azure-devops/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create Azure DevOps instance: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function updateAzureDevOpsInstance(
  instanceId: string,
  data: { projects: string[] },
) {
  const res = await authFetch(`/azure-devops/instances/${instanceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update Azure DevOps instance: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function deleteAzureDevOpsInstance(instanceId: string): Promise<boolean> {
  try {
    const res = await authFetch(`/azure-devops/instances/${instanceId}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testAzureDevOpsConnection(
  instanceId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authFetch(`/azure-devops/instances/${instanceId}/test`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false, error: 'Could not reach API' };
  }
}

export async function fetchWorkItemTypes(
  instanceId: string,
  project: string,
): Promise<string[]> {
  try {
    const res = await authFetch(
      `/azure-devops/instances/${instanceId}/work-item-types?project=${encodeURIComponent(project)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.types ?? [];
  } catch {
    return [];
  }
}

// The legacy `/azure-devops/sync-configs` and
// `/azure-devops/instances/:id/sync-configs` callers are gone: the API removed
// those routes with the AzureDevOpsSyncConfig model in the p9 cleanup
// (1fbe7f3f), and nothing in the app called them any more. Per-project sync is
// `/project-syncs/ado` — see actions/board-sources.ts.

// --- Azure DevOps Sync ---

export async function fetchAzureDevOpsSyncStatus() {
  try {
    const res = await authFetch('/azure-devops/sync/status', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function triggerAzureDevOpsSync(): Promise<boolean> {
  try {
    const res = await authFetch('/azure-devops/sync', {
      method: 'POST',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// The `/azure-devops/project-syncs`, `/azure-devops/instances/:id/project-syncs`
// and `/azure-devops/instances/:id/repositories` callers are gone too: no API
// route ever served them, and nothing in the app called them. Project syncs are
// `/project-syncs/ado`; a board source's repository scope is
// `/boards/:id/sources/ado/...` (actions/board-sources.ts).

export async function listAzureDevOpsRemoteProjects(
  instanceId: string,
): Promise<RemoteProjectsResult> {
  try {
    const res = await authFetch(`/azure-devops/instances/${instanceId}/projects`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      const authFailed = res.status === 401 || res.status === 403;
      return { ok: false, authFailed, error: `Discovery failed (${res.status})` };
    }
    const data = (await res.json()) as { projects?: string[] };
    return { ok: true, projects: data.projects ?? [] };
  } catch {
    return { ok: false, authFailed: false, error: 'Could not reach Azure DevOps.' };
  }
}
