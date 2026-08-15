'use client';

// "Excluded items" — the undo path for a blacklisted sync key.
//
// Deleting a synced row records a `BoardSyncExclusion`, and every promote
// service filters those keys out of all future syncs. That is deliberate, but
// it used to be invisible and irreversible: a bulk delete could blacklist
// dozens of work items with no way to see or undo it, and the board would
// simply stop receiving them forever.
//
// Keys are short and uniform, so they render as a dense selectable grid rather
// than one row each — a 60-key list is far easier to scan across than down.

import { useCallback, useEffect, useState } from 'react';
import {
  listBoardSyncExclusions,
  restoreBoardSyncExclusions,
  triggerBoardSync,
  type SyncExclusion,
} from '../../actions/board-sync';

type ProviderName = 'jira' | 'github' | 'ado' | 'gitlab';

const SOURCE_BY_PROVIDER: Record<ProviderName, SyncExclusion['source']> = {
  jira: 'JIRA',
  github: 'GITHUB',
  ado: 'ADO',
  gitlab: 'GITLAB',
};

const LABEL_BY_PROVIDER: Record<ProviderName, string> = {
  jira: 'Excluded Jira items',
  github: 'Excluded GitHub items',
  ado: 'Excluded Azure DevOps items',
  gitlab: 'Excluded GitLab items',
};

interface Props {
  boardId: string;
  provider: ProviderName;
}

export function ExcludedItemsBlock({ boardId, provider }: Props) {
  const [rows, setRows] = useState<SyncExclusion[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'running' | 'done'>('idle');

  const source = SOURCE_BY_PROVIDER[provider];

  useEffect(() => {
    let active = true;
    listBoardSyncExclusions(boardId).then((all) => {
      if (active) setRows(all.filter((r) => r.source === source));
    });
    return () => {
      active = false;
    };
  }, [boardId, source]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function restore(ids: string[]) {
    if (ids.length === 0) return;
    // Optimistic: drop the keys now, put them back if the server refuses. The
    // doomed rows are captured first so the revert is exact.
    const previous = rows;
    setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
    setSelected(new Set());
    setError(null);
    setBusy(true);

    const result = await restoreBoardSyncExclusions(boardId, ids);
    setBusy(false);

    if (!result.ok) {
      setRows(previous);
      setError(result.error);
      return;
    }
    setRestoredCount(result.restored);
    setSyncState('idle');
  }

  async function syncNow() {
    setSyncState('running');
    const result = await triggerBoardSync(boardId);
    setSyncState(result.ok ? 'done' : 'idle');
    if (!result.ok) setError('Could not start the sync. Try the Sync button on the board.');
  }

  // Nothing blacklisted for this provider — render no affordance at all.
  if (rows.length === 0 && restoredCount === null) return null;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
          {LABEL_BY_PROVIDER[provider]}
        </span>
        {rows.length > 0 && (
          <span className="text-xs font-semibold text-slate-700 bg-slate-100 rounded-full px-2 py-0.5">
            {rows.length}
          </span>
        )}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-xs text-indigo-700 hover:underline font-medium"
          >
            {open ? 'Hide' : 'Review'}
          </button>
        )}
      </div>

      <p className="mt-1 text-[11px] text-slate-500">
        Deleted from this board, so sync leaves them out. Restore one to let it come back.
      </p>

      {open && rows.length > 0 && (
        <>
          <div className="mt-2 max-h-40 overflow-y-auto flex flex-wrap gap-1.5 p-2 rounded-md bg-slate-50 border border-slate-200">
            {rows.map((r) => {
              const isSelected = selected.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggle(r.id)}
                  className={`font-mono text-[11px] px-1.5 py-0.5 rounded border transition-colors ${
                    isSelected
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {r.externalId}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-slate-500">
              {selected.size > 0 ? `${selected.size} selected` : 'Select keys to restore'}
            </span>
            <button
              type="button"
              disabled={selected.size === 0 || busy}
              onClick={() => void restore(Array.from(selected))}
              className="ml-auto text-xs px-2 py-1 rounded-md border border-indigo-200 text-indigo-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-50"
            >
              Restore selected
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(rows.map((r) => r.id))}
              className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-700 font-medium disabled:opacity-40 hover:bg-slate-50"
            >
              Restore all
            </button>
          </div>
        </>
      )}

      {restoredCount !== null && (
        <div
          role="status"
          className="mt-2 flex items-center gap-2 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1.5"
        >
          <span>
            Restored {restoredCount} item{restoredCount === 1 ? '' : 's'} — they reappear on the
            next sync.
          </span>
          {syncState === 'done' ? (
            <span className="ml-auto font-medium">Sync started</span>
          ) : (
            <button
              type="button"
              disabled={syncState === 'running'}
              onClick={() => void syncNow()}
              className="ml-auto px-2 py-0.5 rounded border border-emerald-300 font-medium disabled:opacity-50 hover:bg-emerald-100"
            >
              {syncState === 'running' ? 'Starting…' : 'Sync now'}
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}
