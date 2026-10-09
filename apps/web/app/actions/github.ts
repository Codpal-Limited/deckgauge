'use server';

import { authFetch } from './api';

// --- GitHub Instances ---

export async function fetchGitHubInstances() {
  try {
    const res = await authFetch('/github/instances', { cache: 'no-store' });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function createGitHubInstance(data: {
  baseUrl?: string;
  accessToken: string;
  repos?: string[];
  org?: string;
}) {
  const res = await authFetch('/github/instances', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create GitHub instance: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function updateGitHubInstance(
  instanceId: string,
  data: { repos?: string[]; accessToken?: string; baseUrl?: string; org?: string },
) {
  const res = await authFetch(`/github/instances/${instanceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update GitHub instance: ${res.status} ${body}`);
  }
  return await res.json();
}

export async function deleteGitHubInstance(instanceId: string): Promise<boolean> {
  try {
    const res = await authFetch(`/github/instances/${instanceId}`, {
      method: 'DELETE',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testGitHubConnection(
  instanceId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authFetch(`/github/instances/${instanceId}/test`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body?.error ?? `GitHub test failed (${res.status})` };
    }
    return await res.json();
  } catch {
    return { ok: false, error: 'Could not reach API' };
  }
}

export async function discoverGitHubRepos(instanceId: string): Promise<string[]> {
  try {
    const res = await authFetch(`/github/instances/${instanceId}/repos`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.repos ?? [];
  } catch {
    return [];
  }
}

// The legacy `/github/sync-configs`, `/github/milestones` and `/github/issues`
// callers, and the `/github/sync` / `/github/sync/status` ones whose only user
// was the removed GitHubGroupSection, are gone (issue #5). The first three
// routes were removed from the API in 4099a5a9 / 62ec09dc; per-repo sync is
// GitHubRepoSync now — see actions/board-sources.ts and actions/connections.ts.

// --- GitHub Projects v2 ---

export async function listGitHubProjectsAction(instanceId: string) {
  const res = await authFetch(`/github/instances/${instanceId}/projects`, {
    method: 'GET',
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 502 || res.status === 400 || res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Failed to list GitHub Projects: ${res.status}`);
    }
    throw new Error(`Failed to list GitHub Projects: ${res.status}`);
  }
  return (await res.json()) as Array<{
    nodeId: string;
    owner: string;
    number: number;
    title: string;
    ownerType: 'org' | 'user';
  }>;
}
