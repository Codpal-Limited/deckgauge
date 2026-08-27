'use client';

import type { NotificationDto } from '@deckgauge/shared';
import { isSubjectFirst, verbFor } from '@deckgauge/shared';

/**
 * One notification.
 *
 * The sentence is assembled from the kind's verb phrase, never stored — the same
 * table the API reads, imported from `@deckgauge/shared` so the two cannot drift.
 *
 * Two sentence shapes, because two kinds of thing happen. Most notifications have
 * an actor ("Dana assigned you Checkout"). The date-driven ones and the digest
 * are written by the hourly job and have no actor at all, so they read
 * subject-first ("Checkout is overdue") rather than crediting "Someone".
 */

/** A stable colour per actor, so the same person keeps the same swatch. */
const AVATAR_COLORS = ['#0f766e', '#0369a1', '#7c3aed', '#b45309', '#be123c', '#4d7c0f'];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

export function relativeTime(when: Date | string): string {
  const then = new Date(when).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface NotificationRowProps {
  notification: NotificationDto;
  onClick: () => void;
}

export function NotificationRow({ notification, onClick }: NotificationRowProps) {
  const isUnread = notification.readAt === null;
  // The actor's User row can be gone — the FK is SET NULL — and "you were
  // mentioned" still means something, so an absent actor becomes "Someone"
  // rather than dropping the row.
  const actor = notification.actorName ?? 'Someone';
  const subjectLed = isSubjectFirst(notification.kind);

  return (
    <button
      type="button"
      onClick={onClick}
      data-unread={String(isUnread)}
      className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-slate-50 ${
        isUnread ? 'bg-teal-50/40' : ''
      }`}
    >
      {subjectLed ? (
        // No actor to show, so the space goes to a quiet marker instead of a
        // fake avatar for a person who did not do anything.
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-500"
        >
          {notification.kind === 'DIGEST' ? '∑' : '⏱'}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium leading-none text-white"
          style={{ backgroundColor: avatarColor(actor) }}
        >
          {initials(actor)}
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className={`block text-sm ${isUnread ? 'text-slate-800' : 'text-slate-500'}`}>
          {subjectLed ? (
            <>
              <span className="font-medium">{notification.subjectLabel}</span>{' '}
              {verbFor(notification.kind)}
            </>
          ) : (
            <>
              <span className="font-medium">{actor}</span> {verbFor(notification.kind)}{' '}
              <span className="font-medium">{notification.subjectLabel}</span>
            </>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-slate-400">
          {relativeTime(notification.createdAt)}
        </span>
      </span>

      {isUnread && (
        <span
          aria-label="Unread"
          className="mt-2 h-2 w-2 shrink-0 rounded-full bg-teal-500"
          role="status"
        />
      )}
    </button>
  );
}
