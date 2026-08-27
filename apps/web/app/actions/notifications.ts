'use server';

import type { NotificationDto } from '@deckgauge/shared';
import { authFetch } from './api';

/**
 * Every function here returns a value rather than throwing. A thrown server
 * action surfaces only an opaque digest in production, and the bell is a
 * peripheral control — a failure must degrade to "no notifications", never to a
 * broken page.
 */

export async function fetchUnreadCount(): Promise<number> {
  try {
    const res = await authFetch('/notifications/unread-count', { cache: 'no-store' });
    if (!res.ok) return 0;
    const body = (await res.json()) as { count?: number };
    return typeof body.count === 'number' ? body.count : 0;
  } catch {
    return 0;
  }
}

export interface NotificationList {
  notifications: NotificationDto[];
  /** The access-filtered count — the truth, as opposed to the polled hint. */
  unreadCount: number;
}

export async function fetchNotifications(): Promise<NotificationList> {
  try {
    const res = await authFetch('/notifications', { cache: 'no-store' });
    if (!res.ok) return { notifications: [], unreadCount: 0 };
    const body = (await res.json()) as Partial<NotificationList>;
    return {
      notifications: body.notifications ?? [],
      unreadCount: body.unreadCount ?? 0,
    };
  } catch {
    return { notifications: [], unreadCount: 0 };
  }
}

/** `false` when it could not be marked — the caller leaves the row as it was. */
export async function markNotificationRead(id: string): Promise<boolean> {
  try {
    const res = await authFetch(`/notifications/${id}/read`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function markAllNotificationsRead(): Promise<boolean> {
  try {
    const res = await authFetch('/notifications/read-all', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}
