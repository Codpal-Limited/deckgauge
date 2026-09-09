'use client';

// "Excluded items" — the undo path for a blacklisted sync key.
//
// Deleting a synced row records a `BoardSyncExclusion`, and every promote
// service filters those keys out of all future syncs. That is deliberate, but
// it used to be invisible and irreversible: a bulk delete could blacklist
// dozens of work items with no way to see or undo it, and the board would
// simply stop receiving them forever.
//
// This was originally built for a 60-key list and rendered every excluded key
// as a dense selectable grid in one request. That assumption broke on the real
// `PAM - Compliance` board, which carries 20,607 ADO exclusions written in a
// single bulk action on 2026-09-04 — shipping all of them to the browser on
// every Sources page load, for every provider's card, regardless of which one
// was open. The block now shows one capped, source-scoped page at a time
// (`listBoardSyncExclusions` takes `{ source, limit, offset }` and the server
// enforces a hard per-page cap), with the true total and Previous/Next to move
// between pages, plus a server-side "Restore all N" that never asks the
// browser to hold or resend the full id list.

import { useCallback, useEffect, useState } from 'react';
import {
  listBoardSyncExclusions,
  restoreAllBoardSyncExclusions,
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

/** One page of keys per request — matched to the server's rendering, not its
 * hard cap (`MAX_PAGE = 200` in `BoardSyncExclusionService`). Kept small so a
 * page of checkboxes stays scannable. */
const PAGE_SIZE = 50;

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

interface Props {
  boardId: string;
  provider: ProviderName;
}

export function ExcludedItemsBlock({ boardId, provider }: Props) {
  const [rows, setRows] = useState<SyncExclusion[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'running' | 'done'>('idle');

  const source = SOURCE_BY_PROVIDER[provider];

  // A new board or provider always starts back at page one — the previous
  // offset almost certainly does not exist in the new scope.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
  }, [boardId, source]);

  useEffect(() => {
    let active = true;
    listBoardSyncExclusions(boardId, { source, limit: PAGE_SIZE, offset }).then((page) => {
      if (!active) return;
      setRows(page.rows);
      setTotal(page.total);
    });
    return () => {
      active = false;
    };
  }, [boardId, source, offset]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function restoreSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Optimistic: drop the keys now, put them back if the server refuses. The
    // doomed rows are captured first so the revert is exact.
    const previousRows = rows;
    const previousTotal = total;
    setRows((prev) => prev.filter((r) => !ids.includes(r.id)));
    setTotal((prev) => Math.max(0, prev - ids.length));
    setSelected(new Set());
    setError(null);
    setBusy(true);

    const result = await restoreBoardSyncExclusions(boardId, ids);
    setBusy(false);

    if (!result.ok) {
      setRows(previousRows);
      setTotal(previousTotal);
      setError(result.error);
      return;
    }
    setRestoredCount(result.restored);
    setSyncState('idle');

    // The optimistic decrement above just drops the restored keys from THIS
    // page and shrinks the count — correct for the count, but not for the
    // rows: on a large board every later row's offset has shifted, so the
    // page now silently omits whatever the server would have pulled up from
    // the next page. Refetch the current page (same call the initial-load
    // effect makes) to reconcile.
    const page = await listBoardSyncExclusions(boardId, { source, limit: PAGE_SIZE, offset });
    setRows(page.rows);
    setTotal(page.total);
  }

  async function restoreAll() {
    // Confirm BEFORE anything is deleted — exclusions are a deliberate user
    // act and are never cleared without an explicit choice. Nothing below
    // this check runs unless the user confirms.
    const confirmed = window.confirm(
      `Restore all ${formatCount(total)} ${LABEL_BY_PROVIDER[provider].toLowerCase()}? They will reappear on the next sync.`,
    );
    if (!confirmed) return;

    setError(null);
    setBusy(true);
    const result = await restoreAllBoardSyncExclusions(boardId, source);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRows([]);
    setTotal(0);
    setOffset(0);
    setSelected(new Set());
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
  if (total === 0 && restoredCount === null) return null;

  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < total;

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
          {LABEL_BY_PROVIDER[provider]}
        </span>
        {total > 0 && (
          <span className="text-xs font-semibold text-slate-700 bg-slate-100 rounded-full px-2 py-0.5">
            {formatCount(total)}
          </span>
        )}
        {total > 0 && (
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
                <label
                  key={r.id}
                  className={`flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={isSelected}
                    onChange={() => toggle(r.id)}
                  />
                  {r.externalId}
                </label>
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
              onClick={() => void restoreSelected()}
              className="ml-auto text-xs px-2 py-1 rounded-md border border-indigo-200 text-indigo-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-50"
            >
              Restore selected
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={!hasPrev || busy}
                onClick={() => {
                  setSelected(new Set());
                  setOffset((prev) => Math.max(0, prev - PAGE_SIZE));
                }}
                className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!hasNext || busy}
                onClick={() => {
                  setSelected(new Set());
                  setOffset((prev) => prev + PAGE_SIZE);
                }}
                className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
              >
                Next
              </button>
            </div>
            <button
              type="button"
              disabled={busy || total === 0}
              onClick={() => void restoreAll()}
              className="text-xs px-2 py-1 rounded-md border border-slate-200 text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              {`Restore all ${formatCount(total)}`}
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
