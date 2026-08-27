'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NotificationDto } from '@deckgauge/shared';
import { NotificationPanel } from './NotificationPanel';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '../actions/notifications';

/**
 * The in-app notification bell.
 *
 * **Always rendered**, including at zero unread. It used to hide itself when
 * there was nothing to show; a control that vanishes is one people never learn
 * to look for, and with eleven trigger kinds there is now a settings screen and
 * a history behind it worth reaching.
 *
 * Polls one integer rather than the whole list: the count endpoint is cheap and
 * unfiltered, the list applies access filtering. They can therefore disagree
 * after someone's board access is revoked — deliberately. The badge is a hint;
 * the LIST is the truth, and opening the menu reconciles the badge from the
 * filtered result.
 *
 * Not a websocket. There is a ws-server in the repo, but it is the local advisor
 * bridge, not a general push channel; polling survives an API restart with no
 * reconnect logic.
 */

/** Slow enough to be invisible in the network tab, fast enough to feel live. */
const POLL_INTERVAL_MS = 60_000;

export function NotificationBell() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void fetchUnreadCount().then((n) => {
        if (!cancelled) setCount(n);
      });
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const openMenu = useCallback(async () => {
    setOpen(true);
    const result = await fetchNotifications();
    setItems(result.notifications);
    // Reconcile the polled hint with the access-filtered truth.
    setCount(result.unreadCount);
  }, []);

  const onRowClick = useCallback(
    async (n: NotificationDto) => {
      if (n.readAt === null) {
        const ok = await markNotificationRead(n.id);
        if (ok) {
          setItems((prev) =>
            prev
              ? prev.map((it) => (it.id === n.id ? { ...it, readAt: new Date() } : it))
              : prev,
          );
          setCount((c) => Math.max(0, c - 1));
        }
      }
      // `router.push`, not `location.href`: every destination is an internal
      // route, and a full page load would throw away the board state the user is
      // about to look at. Navigating LAST, so the read is recorded first.
      setOpen(false);
      router.push(n.href);
    },
    [router],
  );

  const onMarkAll = useCallback(async () => {
    const ok = await markAllNotificationsRead();
    if (!ok) return;
    setItems((prev) => (prev ? prev.map((it) => ({ ...it, readAt: it.readAt ?? new Date() })) : prev));
    setCount(0);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label={count > 0 ? `Notifications (${count} unread)` : 'Notifications'}
        onClick={() => (open ? setOpen(false) : void openMenu())}
        className="relative px-2 py-1 text-slate-500 transition-colors hover:text-slate-700"
      >
        <span aria-hidden="true">{'\u{1F514}'}</span>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[1rem] rounded-full bg-red-500 px-1 text-center text-[10px] leading-4 text-white">
            {count}
          </span>
        )}
      </button>

      <NotificationPanel
        isOpen={open}
        onClose={() => setOpen(false)}
        items={items}
        unreadCount={count}
        onRowClick={(n) => void onRowClick(n)}
        onMarkAllRead={() => void onMarkAll()}
        onOpenPreferences={() => {
          setOpen(false);
          router.push('/settings/notifications');
        }}
      />
    </>
  );
}
