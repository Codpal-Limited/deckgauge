'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdvisorSessionSummaryDto } from '@deckgauge/shared';
import { deleteSession, listSessions } from './advisor-api';

interface AdvisorSessionListProps {
  boardId: string;
  activeSessionId: string | null;
  onNewSession: () => void;
  onResume(sessionId: string): void;
  /**
   * Called after a session is deleted server-side. The provider may be holding
   * this id as the ACTIVE session — filtering the row out of this local list
   * would leave it pointing at a row that no longer exists, and every
   * subsequent `appendMessage` for the rest of that conversation would 404
   * into `advisor-api`'s log while the panel still looked healthy.
   */
  onDeleted(sessionId: string): void;
  onClose(): void;
}

const UNTITLED = 'Untitled session';

/** Compact relative age — the dropdown row has no space for a full timestamp. */
function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; sessions: AdvisorSessionSummaryDto[] };

export function AdvisorSessionList({
  boardId,
  activeSessionId,
  onNewSession,
  onResume,
  onDeleted,
  onClose,
}: AdvisorSessionListProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    // `listSessions` is total (see advisor-api.ts) — it reports failure as
    // `{ok:false}` rather than rejecting, so this `.then` cannot be the source
    // of an unhandled rejection that leaves the dropdown loading forever.
    void listSessions(boardId).then((result) => {
      if (cancelled) return;
      setLoad(result.ok ? { status: 'loaded', sessions: result.sessions } : { status: 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const remove = useCallback(
    async (sessionId: string) => {
      const ok = await deleteSession(boardId, sessionId);
      if (!ok) return;
      setLoad((prev) =>
        prev.status === 'loaded'
          ? { status: 'loaded', sessions: prev.sessions.filter((s) => s.id !== sessionId) }
          : prev,
      );
      onDeleted(sessionId);
    },
    [boardId, onDeleted],
  );

  const sessions = load.status === 'loaded' ? load.sessions : [];

  const now = Date.now();

  return (
    <div
      className="absolute right-3 top-14 z-10 w-72 rounded-lg border border-slate-200 bg-surface-1 py-1 shadow-lg"
      role="menu"
      aria-label="Advisor sessions"
    >
      <button
        type="button"
        onClick={onNewSession}
        className="w-full border-b border-slate-100 px-3 py-2 text-left text-sm font-medium text-indigo-700 hover:bg-slate-50"
      >
        ＋ New conversation
      </button>
      {load.status === 'loading' && (
        <p className="px-3 py-2 text-sm text-slate-400">Loading sessions…</p>
      )}
      {/* Never reported as "no earlier sessions": telling someone their
          history is empty when the request simply failed is a lie about their
          data, and it hides a recoverable outage behind a normal-looking
          empty state. */}
      {load.status === 'failed' && (
        <p role="alert" className="px-3 py-2 text-sm text-rose-600">
          Couldn’t load earlier sessions. Try again in a moment.
        </p>
      )}
      {load.status === 'loaded' && sessions.length === 0 && (
        <p className="px-3 py-2 text-sm text-slate-400">No earlier sessions for this board.</p>
      )}
      <ul>
        {sessions.map((session) => (
          <li key={session.id} className="group flex items-center gap-1 px-1">
            <button
              type="button"
              onClick={() => {
                onResume(session.id);
                onClose();
              }}
              className={`flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 ${
                session.id === activeSessionId ? 'font-semibold text-indigo-700' : 'text-slate-700'
              }`}
            >
              <span className="block truncate">{session.title || UNTITLED}</span>
              <span className="block text-[11px] text-slate-400">
                {relativeAge(session.updatedAt, now)} · {session.messageCount} messages
              </span>
            </button>
            <button
              type="button"
              aria-label={`Delete session ${session.title || UNTITLED}`}
              onClick={() => void remove(session.id)}
              // `focus-visible:opacity-100` is not decoration: without it a
              // keyboard-only user tabs onto an INVISIBLE, active, unconfirmed
              // destructive control — hover is the only thing that revealed it.
              className="rounded p-1 text-slate-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-400 group-hover:opacity-100"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
