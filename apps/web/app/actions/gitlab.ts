// EI-030 — GitLab server actions.
'use server';

import type { RemoteProjectsResult } from './board-sources';
import { authFetch } from './api';
import { MissingSessionError } from '../lib/api-server';

/**
 * `authFetch` now throws {@link MissingSessionError} rather than quietly
 * sending an anonymous request. Swallowing that in a `catch {}` and returning
 * an empty list would reinstate exactly the silent degradation this is meant
 * to remove: the page would render "no GitLab connections" for a user whose
 * session simply expired. Re-throw it so it surfaces (and is logged
 * server-side); genuine network/API failures keep their existing handling.
 */
function rethrowMissingSession(err: unknown): void {
  if (err instanceof MissingSessionError) throw err;
}

interface GitLabInstance {
  id: string;
  name: string;
  baseUrl: string;
  projects: string[];
  createdAt: string;
  updatedAt: string;
}

interface GitLabProjectSync {
  id: string;
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs: boolean;
  syncCommits: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchGitLabInstances(): Promise<GitLabInstance[]> {
  try {
    const resp = await authFetch('/gitlab/instances', { cache: 'no-store' });
    if (!resp.ok) return [];
    return (await resp.json()) as GitLabInstance[];
  } catch (err) {
    rethrowMissingSession(err);
    return [];
  }
}

export async function createGitLabInstance(input: {
  name: string;
  baseUrl?: string;
  accessToken: string;
  projects: string[];
}): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await authFetch('/gitlab/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { ok: false, message: `API ${resp.status} ${resp.statusText}` };
    return { ok: true, message: 'GitLab instance created.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function deleteGitLabInstance(id: string): Promise<{ ok: boolean }> {
  try {
    const resp = await authFetch(`/gitlab/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { ok: resp.ok };
  } catch (err) {
    rethrowMissingSession(err);
    return { ok: false };
  }
}

export async function fetchGitLabProjectSyncs(instanceId?: string): Promise<GitLabProjectSync[]> {
  try {
    const path = instanceId
      ? `/gitlab/project-syncs?instanceId=${encodeURIComponent(instanceId)}`
      : '/gitlab/project-syncs';
    const resp = await authFetch(path, { cache: 'no-store' });
    if (!resp.ok) return [];
    return (await resp.json()) as GitLabProjectSync[];
  } catch (err) {
    rethrowMissingSession(err);
    return [];
  }
}

export async function createGitLabProjectSync(input: {
  gitlabInstanceId: string;
  projectPath: string;
  syncPrs?: boolean;
  syncCommits?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await authFetch('/gitlab/project-syncs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { ok: false, message: `API ${resp.status} ${resp.statusText}` };
    return { ok: true, message: 'GitLab project sync created.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function testGitLabConnection(instanceId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await authFetch(`/gitlab/instances/${encodeURIComponent(instanceId)}/test`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!resp.ok) {
      const data = (await resp.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? `API ${resp.status}` };
    }
    return (await resp.json()) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function createGitLabInstanceReturning(input: {
  name: string;
  baseUrl?: string;
  accessToken: string;
  projects: string[];
}): Promise<{ id: string }> {
  const resp = await authFetch('/gitlab/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!resp.ok) throw new Error(`create gitlab instance: ${resp.status}`);
  return (await resp.json()) as { id: string };
}

export async function listGitLabRemoteProjects(
  instanceId: string,
  search?: string,
): Promise<RemoteProjectsResult> {
  try {
    const term = search?.trim();
    const qs = term ? `?search=${encodeURIComponent(term)}` : '';
    const resp = await authFetch(
      `/gitlab/instances/${encodeURIComponent(instanceId)}/projects${qs}`,
      { cache: 'no-store' },
    );
    if (!resp.ok) {
      const authFailed = resp.status === 401 || resp.status === 403;
      // Surface the API's message (e.g. a base-URL/HTML-parse error) instead of a
      // bare status, so a misconfigured connection is diagnosable from the UI.
      const body = (await resp.json().catch(() => ({}))) as { error?: unknown };
      const detail = typeof body.error === 'string' ? body.error : `Discovery failed (${resp.status})`;
      return { ok: false, authFailed, error: detail };
    }
    const data = (await resp.json()) as { projects?: string[] };
    return { ok: true, projects: data.projects ?? [] };
  } catch (err) {
    // This one has an error channel of its own, so say what actually happened
    // instead of blaming GitLab. `authFailed` stays false: it drives the
    // "reconnect this GitLab connection" flow, and the connection is fine —
    // it is the caller's Deckgauge session that is gone.
    if (err instanceof MissingSessionError) {
      return {
        ok: false,
        authFailed: false,
        error: 'Your Deckgauge session has expired — reload the page and sign in again.',
      };
    }
    return { ok: false, authFailed: false, error: 'Could not reach GitLab.' };
  }
}
