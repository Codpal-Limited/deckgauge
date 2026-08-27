'use client';

import { useMemo, useState } from 'react';
import { SlideOverPanel } from '@deckgauge/ui';
import type { NotificationDto } from '@deckgauge/shared';
import { NotificationRow } from './NotificationRow';

/**
 * The notification panel: a right-side slide-over, not a dropdown.
 *
 * `SlideOverPanel` is the same primitive `ItemDetailPanel` uses, so this inherits
 * the app's panel behaviour (backdrop, Escape, scroll lock) rather than
 * reimplementing it 320px wide.
 *
 * Two structural devices, both encoding something real rather than decorating:
 *
 *   - **Board headers** group consecutive rows, because "which board is this
 *     about" is the question a busy reader asks first, and a flat list of
 *     twenty rows across four boards answers it twenty times over.
 *   - **A digest expands in place.** It is a summary of things that already
 *     happened, so navigating away from the panel to see them would lose the
 *     thing the reader is looking at. Nothing else here expands.
 */

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'mentions', label: 'Mentions' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Turns `ITEM_STATUS_CHANGED: 12` into "12 status changes". */
const DIGEST_KIND_NOUNS: Record<string, [string, string]> = {
  MENTION: ['mention', 'mentions'],
  ITEM_ASSIGNED: ['assignment', 'assignments'],
  ITEM_STATUS_CHANGED: ['status change', 'status changes'],
  ITEM_DUE_DATE_CHANGED: ['due-date change', 'due-date changes'],
  ITEM_COMMENT_ADDED: ['comment', 'comments'],
  ITEM_DUE_SOON: ['item due soon', 'items due soon'],
  ITEM_OVERDUE: ['overdue item', 'overdue items'],
  ENTITY_SHARED: ['share', 'shares'],
  ACCESS_ROLE_CHANGED: ['role change', 'role changes'],
  ORG_MEMBER_INVITED: ['workspace invite', 'workspace invites'],
  AUTOMATION_NOTIFY: ['automation', 'automations'],
};

function digestBreakdown(payload: Record<string, unknown> | null): string[] {
  const byKind = payload?.byKind;
  if (!byKind || typeof byKind !== 'object' || Array.isArray(byKind)) return [];
  return Object.entries(byKind as Record<string, unknown>).flatMap(([kind, raw]) => {
    const count = typeof raw === 'number' ? raw : 0;
    if (count <= 0) return [];
    const nouns = DIGEST_KIND_NOUNS[kind] ?? [kind, kind];
    return [`${count} ${count === 1 ? nouns[0] : nouns[1]}`];
  });
}

/** Consecutive rows sharing a board name, in order. Never re-sorts the list. */
function groupByBoard(
  items: readonly NotificationDto[],
): Array<{ boardName: string | null; items: NotificationDto[] }> {
  const groups: Array<{ boardName: string | null; items: NotificationDto[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.boardName === item.boardName) {
      last.items.push(item);
      continue;
    }
    groups.push({ boardName: item.boardName, items: [item] });
  }
  return groups;
}

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Null while the first fetch is in flight — distinct from "nothing to show". */
  items: NotificationDto[] | null;
  unreadCount: number;
  onRowClick: (notification: NotificationDto) => void;
  onMarkAllRead: () => void;
  onOpenPreferences?: () => void;
}

export function NotificationPanel({
  isOpen,
  onClose,
  items,
  unreadCount,
  onRowClick,
  onMarkAllRead,
  onOpenPreferences,
}: NotificationPanelProps) {
  const [tab, setTab] = useState<TabId>('all');
  const [expandedDigestIds, setExpandedDigestIds] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => {
    if (!items) return null;
    if (tab === 'unread') return items.filter((n) => n.readAt === null);
    if (tab === 'mentions') return items.filter((n) => n.kind === 'MENTION');
    return items;
  }, [items, tab]);

  const groups = useMemo(() => (visible ? groupByBoard(visible) : []), [visible]);

  const toggleDigest = (id: string) => {
    // New Set, never a mutation: the old one may still be rendering.
    setExpandedDigestIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <SlideOverPanel
      isOpen={isOpen}
      onClose={onClose}
      title={unreadCount > 0 ? `Notifications (${unreadCount})` : 'Notifications'}
    >
      <div role="tablist" aria-label="Filter notifications" className="mb-4 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === t.id
                ? 'bg-teal-50 font-medium text-teal-700'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {visible === null && <p className="py-8 text-center text-sm text-slate-400">Loading…</p>}

      {visible !== null && visible.length === 0 && (
        // An invitation, not a shrug: the reader came here on purpose.
        <p className="py-10 text-center text-sm text-slate-400">
          {tab === 'all'
            ? "You're all caught up."
            : tab === 'unread'
              ? "You're all caught up. Nothing unread."
              : 'No mentions yet.'}
        </p>
      )}

      <div className="space-y-4">
        {groups.map((group, index) => (
          <section
            key={`${group.boardName ?? 'no-board'}-${index}`}
            role="group"
            aria-label={group.boardName ?? 'Workspace'}
          >
            <h3 className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wide text-slate-400">
              {group.boardName ?? 'Workspace'}
            </h3>
            <div className="space-y-0.5">
              {group.items.map((n) =>
                n.kind === 'DIGEST' ? (
                  <DigestCard
                    key={n.id}
                    notification={n}
                    isExpanded={expandedDigestIds.has(n.id)}
                    onToggle={() => toggleDigest(n.id)}
                  />
                ) : (
                  <NotificationRow key={n.id} notification={n} onClick={() => onRowClick(n)} />
                ),
              )}
            </div>
          </section>
        ))}
      </div>

      {visible !== null && visible.length > 0 && (
        <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onMarkAllRead}
            className="text-xs text-slate-500 transition-colors hover:text-slate-700"
          >
            Mark all read
          </button>
          {onOpenPreferences && (
            <button
              type="button"
              onClick={onOpenPreferences}
              className="text-xs text-slate-500 transition-colors hover:text-slate-700"
            >
              Notification settings
            </button>
          )}
        </div>
      )}
    </SlideOverPanel>
  );
}

interface DigestCardProps {
  notification: NotificationDto;
  isExpanded: boolean;
  onToggle: () => void;
}

/**
 * A released digest. Clicking EXPANDS it rather than navigating: it summarises
 * events that already happened, so leaving the panel to read it would close the
 * very thing being read.
 */
function DigestCard({ notification, isExpanded, onToggle }: DigestCardProps) {
  const count = notification.digestCount ?? 0;
  const breakdown = digestBreakdown(notification.payload);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full items-center justify-between px-3 py-2.5 text-left"
      >
        <span className="text-sm text-slate-700">
          <span className="font-medium">
            {count} update{count === 1 ? '' : 's'}
          </span>{' '}
          while you were away
        </span>
        <span aria-hidden="true" className="text-slate-400">
          {isExpanded ? '−' : '+'}
        </span>
      </button>
      {isExpanded && (
        <ul className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
          {breakdown.length === 0 && <li>No breakdown recorded.</li>}
          {breakdown.map((line) => (
            <li key={line} className="py-0.5">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
