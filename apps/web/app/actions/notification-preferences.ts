'use server';

import type {
  BoardNotificationLevel,
  NotificationPreference,
} from '@deckgauge/shared';
import { authFetch } from './api';

/**
 * Every function here returns a value rather than throwing. A thrown server
 * action surfaces only an opaque digest in production, so a failed save has to
 * come back as `false` for the form to revert and say so.
 */

export async function fetchNotificationPreferences(): Promise<NotificationPreference[]> {
  try {
    const res = await authFetch('/notifications/preferences', { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { preferences?: NotificationPreference[] };
    return body.preferences ?? [];
  } catch {
    return [];
  }
}

/** `false` when the save did not land — the caller reverts its optimistic state. */
export async function saveNotificationPreferences(
  preferences: NotificationPreference[],
): Promise<boolean> {
  try {
    const res = await authFetch('/notifications/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Defaults to ALL, matching the sparse table: absent means "everything". */
export async function fetchBoardNotificationLevel(
  boardId: string,
): Promise<BoardNotificationLevel> {
  try {
    const res = await authFetch(`/boards/${boardId}/notification-setting`, {
      cache: 'no-store',
    });
    if (!res.ok) return 'ALL';
    const body = (await res.json()) as { level?: BoardNotificationLevel };
    return body.level ?? 'ALL';
  } catch {
    return 'ALL';
  }
}

export async function saveBoardNotificationLevel(
  boardId: string,
  level: BoardNotificationLevel,
): Promise<boolean> {
  try {
    const res = await authFetch(`/boards/${boardId}/notification-setting`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
