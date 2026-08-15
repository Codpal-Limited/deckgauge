'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  triggerBoardSync,
  fetchBoardSyncStatus,
  fetchBoardSourceHealth,
  revalidateBoardData,
  type BoardSyncStatus,
  type BoardSourceHealth,
} from '../actions/board-sync';
import { pollForSyncCompletion } from '../utils/board-sync-runner';

interface SyncControlsProps {
  boardId: string;
  userRole?: 'OWNER' | 'EDITOR' | 'VIEWER' | null;
}

// Both states block sync, so both belong in the warning — but a `reauthorize`
// source has a working token whose SSO session lapsed, and telling that user to
// replace the token sends them to re-issue a credential that was never broken.
function isCredentialBlocked(state: BoardSourceHealth['state']): boolean {
  return state === 'expired' || state === 'reauthorize';
}

export function SyncControls({ boardId, userRole }: SyncControlsProps) {
  const router = useRouter();
  const [status, setStatus] = useState<BoardSyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toast, setToast] = useState<{ kind: 'error' | 'info' | 'success'; text: string } | null>(
    null
  );
  const [expired, setExpired] = useState<BoardSourceHealth[]>([]);
  const [fixOpen, setFixOpen] = useState(false);

  const loadStatus = useCallback(async () => {
    setStatus(await fetchBoardSyncStatus(boardId));
  }, [boardId]);

  const loadHealth = useCallback(async () => {
    const h = await fetchBoardSourceHealth(boardId);
    setExpired(h ? h.sources.filter((s) => isCredentialBlocked(s.state)) : []);
  }, [boardId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const canTrigger = userRole === 'OWNER' || userRole === 'EDITOR';
  // Drives the copy: a dead token needs replacing, a lapsed SSO session needs
  // re-authorizing. Mixed sets get the stronger "expired" wording.
  const hasTrulyExpired = expired.some((s) => s.state === 'expired');

  // Synced rows reach the board through the page's server render, so a finished
  // sync is invisible until that data is refetched. Drop the board's cached
  // server data, then re-run the render — without this the board keeps showing
  // its pre-sync rows (nothing at all, on a brand-new board) until a reload.
  const refreshBoardRows = useCallback(async () => {
    await revalidateBoardData(boardId);
    router.refresh();
  }, [boardId, router]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const result = await triggerBoardSync(boardId);
      if (!result.ok) {
        const text =
          result.reason === 'queue_unavailable'
            ? 'Sync queue is offline — contact admin'
            : result.reason === 'forbidden'
              ? 'You need EDITOR access to sync this board'
              : 'Failed to trigger sync — try again';
        setToast({ kind: 'error', text });
        return;
      }

      if (result.expired && result.expired.length > 0) {
        setExpired(result.expired);
        setFixOpen(true);
      }

      const next = await pollForSyncCompletion(boardId, status?.finishedAt ?? null);
      if (next) {
        setStatus(next);
        setToast({
          kind: 'success',
          text: `Synced — ${next.sourceCount} source${next.sourceCount === 1 ? '' : 's'} updated`,
        });
        await refreshBoardRows();
        return;
      }
      setToast({ kind: 'info', text: 'Sync may still be running' });
      // Poll window elapsed: show whatever the worker has written so far.
      await refreshBoardRows();
    } finally {
      setIsSyncing(false);
      void loadStatus();
      void loadHealth();
    }
  };

  const goFix = (s: BoardSourceHealth) => {
    setFixOpen(false);
    router.push(`/boards/${boardId}/sources?fix=${s.provider}:${s.instanceId}`);
  };

  const lastSyncedLabel = status?.finishedAt
    ? `Last synced ${formatRelativeTime(new Date(status.finishedAt))}`
    : 'Not synced yet';

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-slate-500">{lastSyncedLabel}</span>
      {canTrigger && (
        <button
          type="button"
          onClick={handleSync}
          disabled={isSyncing}
          className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
          aria-label="Sync now"
        >
          <span className={isSyncing ? 'animate-spin' : ''}>↻</span>
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </button>
      )}
      {expired.length > 0 && (
        <button
          type="button"
          onClick={() => goFix(expired[0])}
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            hasTrulyExpired
              ? 'bg-rose-100 text-rose-700 hover:bg-rose-200'
              : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
          }`}
        >
          {hasTrulyExpired ? '⚠ Token expired' : '⚠ Reauthorize connection'}
        </button>
      )}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 glass-elevated px-4 py-3 text-sm animate-slide-up ${
            toast.kind === 'error'
              ? 'text-red-600'
              : toast.kind === 'success'
                ? 'text-emerald-600'
                : 'text-slate-700'
          }`}
        >
          {toast.text}
        </div>
      )}
      {fixOpen && expired.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="glass-elevated w-full max-w-md rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Sync can&apos;t reach some connections
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              These sources were skipped because their credentials could not be used.
            </p>
            <ul className="mt-3 space-y-1 text-sm text-slate-700">
              {expired.map((s) => (
                <li key={`${s.provider}:${s.instanceId}`}>
                  <span className="font-medium capitalize">{s.provider}</span> — {s.label}
                  {s.state === 'reauthorize' ? (
                    <span className="text-amber-600">
                      {' '}
                      · single sign-on needs reauthorizing (the token itself is still valid)
                    </span>
                  ) : (
                    <span className="text-rose-600"> · token expired</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFixOpen(false)}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => goFix(expired[0])}
                className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700"
              >
                Update token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
