'use server';

import { revalidateTag } from 'next/cache';
import { authFetch } from './api';
import { boardTag } from '../utils/cache-tags';

export interface TriggerResult {
  ok: boolean;
  enqueued?: { jira: number; github: number; ado: number; gitlab: number };
  expired?: BoardSourceHealth[];
  reason?: 'forbidden' | 'queue_unavailable' | 'network' | 'unknown';
}

export interface BoardSyncStatus {
  status: 'IDLE' | 'RUNNING';
  finishedAt: string | null;
  sourceCount: number;
}

// `reauthorize` means the credential is still valid but its identity provider
// wants an interactive re-auth (Entra AADSTS…, GitHub SAML enforcement) — a new
// token does not fix it, so it must not be worded as "expired".
export type SourceHealth = 'valid' | 'expired' | 'reauthorize' | 'unreachable';

export interface BoardSourceHealth {
  provider: 'jira' | 'github' | 'ado' | 'gitlab';
  instanceId: string;
  label: string;
  state: SourceHealth;
  error?: string;
}

export interface BoardSourceHealthResult {
  sources: BoardSourceHealth[];
  hasExpired: boolean;
}

export async function triggerBoardSync(boardId: string): Promise<TriggerResult> {
  try {
    const res = await authFetch(`/boards/${boardId}/sync`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (res.status === 503) return { ok: false, reason: 'queue_unavailable' };
    if (!res.ok) return { ok: false, reason: 'unknown' };
    const body = (await res.json()) as {
      boardId: string;
      enqueued: { jira: number; github: number; ado: number; gitlab: number };
      expired?: BoardSourceHealth[];
    };
    return { ok: true, enqueued: body.enqueued, expired: body.expired ?? [] };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export async function fetchBoardSyncStatus(boardId: string): Promise<BoardSyncStatus | null> {
  // The no-boards board view renders with `boardId=""` and `SyncControls` polls
  // anyway, which is where `GET /boards//sync/status` came from. A request with
  // no board id cannot answer anything.
  if (!boardId) return null;
  try {
    const res = await authFetch(`/boards/${boardId}/sync/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BoardSyncStatus;
  } catch {
    return null;
  }
}

/**
 * Drops the board's cached server data (groups, projects, columns, owners) so the
 * next render fetches it again. A sync writes rows straight to the database
 * without going through a server action, so nothing else invalidates that cache —
 * without this the board keeps rendering its pre-sync rows until a full reload.
 */
export async function revalidateBoardData(boardId: string): Promise<void> {
  revalidateTag(boardTag(boardId));
}

export interface SyncExclusion {
  id: string;
  source: 'JIRA' | 'GITHUB' | 'ADO' | 'GITLAB';
  /** Provider-native identifier: Jira issue key, ADO work-item id, GitHub issue id. */
  externalId: string;
  excludedAt: string;
  excludedBy: string | null;
}

export type RestoreExclusionsResult =
  | { ok: true; restored: number }
  | { ok: false; error: string };

/**
 * The keys this board has blacklisted by having a synced row deleted. An empty
 * list is also the failure shape: the block that renders this hides itself when
 * there is nothing to show, and an unreachable API is not worth an error banner
 * on a screen the user opened to do something else.
 */
export async function listBoardSyncExclusions(boardId: string): Promise<SyncExclusion[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/sync/exclusions`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()) as SyncExclusion[];
  } catch {
    return [];
  }
}

/**
 * Drops exclusions so the next sync re-creates their rows. Returns a result
 * union rather than throwing — a thrown server action reaches the client as an
 * opaque digest, which would leave the user with a silent no-op.
 */
export async function restoreBoardSyncExclusions(
  boardId: string,
  ids: string[],
): Promise<RestoreExclusionsResult> {
  if (ids.length === 0) return { ok: true, restored: 0 };
  try {
    const res = await authFetch(`/boards/${boardId}/sync/exclusions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
      cache: 'no-store',
    });
    if (res.status === 403) {
      return { ok: false, error: "You need edit access to this board to restore items." };
    }
    if (!res.ok) return { ok: false, error: await res.text() };
    const body = (await res.json()) as { restored: number };
    return { ok: true, restored: body.restored };
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and retry.' };
  }
}

export async function fetchBoardSourceHealth(
  boardId: string,
): Promise<BoardSourceHealthResult | null> {
  // Same reason as `fetchBoardSyncStatus` — see there.
  if (!boardId) return null;
  try {
    const res = await authFetch(`/boards/${boardId}/sync/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BoardSourceHealthResult;
  } catch {
    return null;
  }
}
