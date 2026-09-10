'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SourceInstanceRow, RefreshResult } from '../../actions/connections';
import { TokenTutorial } from '../board-sources/providers/TokenTutorial';
import type { Provider } from '../board-sources/providers/roles';
import { TokenRefreshBox } from './TokenRefreshBox';

type Health = 'unknown' | 'valid' | 'expired';

interface InstancesPanelProps {
  provider: Provider;
  title: string;
  instances: SourceInstanceRow[];
  /** Project-sync count per instance id, used for the delete impact message. */
  syncCount: Record<string, number>;
  onTest: (id: string) => Promise<RefreshResult>;
  onRefresh: (id: string, token: string) => Promise<RefreshResult>;
  onDelete: (id: string) => Promise<RefreshResult>;
}

type OpenPanel = { id: string; mode: 'refresh' | 'delete' } | null;

const badgeLabel: Record<Health, string> = { unknown: 'Unknown', valid: 'Valid', expired: 'Expired' };
const badgeClass: Record<Health, string> = {
  unknown: 'bg-slate-100 text-slate-600',
  valid: 'bg-emerald-100 text-emerald-700',
  expired: 'bg-rose-100 text-rose-700',
};

/**
 * What deleting a connection ACTUALLY destroys, verified against the schema rather
 * than guessed at.
 *
 * The cascade runs Instance → ProjectSync → Board*Source and stops there.
 * `Board*Source` holds the board's sync setup: allowed issue types, filters, field
 * mappings, status mapping, target group. Real configuration work, and re-adding
 * the connection does not bring it back.
 *
 * `Project` — the board's actual rows — has no foreign key to any of it. Its only
 * cascades come from board, group, owner and status, so the rows SURVIVE and simply
 * stop updating.
 *
 * The old copy said "removes N project syncs and their synced data from your
 * boards", which reads as "your board items will be deleted". They will not, and
 * getting this right matters more now that a member can trigger it rather than only
 * an administrator.
 */
function impactMessage(label: string, count: number): string {
  // count <= 0 also covers "unknown" — a failed sync-count fetch defaults to 0 — so
  // this must still describe the destruction rather than reading as "nothing
  // happens".
  if (count <= 0) {
    return `Delete “${label}”? Any board using it stops syncing and loses its field mapping. Rows already on those boards stay, frozen.`;
  }
  const noun = count === 1 ? 'board will' : 'boards will';
  return `Delete “${label}”? ${count} ${noun} stop syncing and lose their field mapping. Rows already on those boards stay, frozen.`;
}

export function InstancesPanel({
  provider,
  title,
  instances,
  syncCount,
  onTest,
  onRefresh,
  onDelete,
}: InstancesPanelProps) {
  const router = useRouter();
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [open, setOpen] = useState<OpenPanel>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    instances.forEach((inst) => {
      onTest(inst.id).then((r) => {
        if (active) setHealth((h) => ({ ...h, [inst.id]: r.ok ? 'valid' : 'expired' }));
      });
    });
    return () => {
      active = false;
    };
  }, [instances, onTest]);

  function toggle(id: string, mode: 'refresh' | 'delete') {
    setDeleteError(null);
    setOpen((prev) => (prev && prev.id === id && prev.mode === mode ? null : { id, mode }));
  }

  async function confirmDelete(id: string) {
    setDeleteError(null);
    setDeletingId(id);
    const result = await onDelete(id);
    setDeletingId(null);
    if (result.ok) {
      setOpen(null);
      router.refresh();
    } else {
      setDeleteError(result.error ?? 'Delete failed');
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">{title} connections</h2>
      {instances.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No {title} instances connected.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {instances.map((inst) => {
            const h = health[inst.id] ?? 'unknown';
            const isDeleteOpen = open?.id === inst.id && open.mode === 'delete';
            return (
              <li key={inst.id} className="rounded border border-slate-100 p-3">
                {/* `sm:` rather than the repo's usual `md:` boundary (see
                    `AppChrome.tsx`) because these two columns TRUNCATE, so they
                    survive the 640-767px band that an untruncated row could not.
                    Stacks below `sm`. Measured at 390px: this row pushed the
                    page to 450px because the left column had no `min-w-0` (so it
                    could not shrink below a long instance URL) while the right
                    cluster is a badge plus two text buttons. `min-w-0` plus
                    `truncate` is what lets the label give way instead of the
                    viewport. */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    {/* `title` because the sublabel is the instance URL, and that
                        is how an administrator tells two Jira instances apart.
                        Truncating without it removes information that used to
                        wrap and be fully readable, on desktop too. */}
                    <div className="truncate text-sm font-medium text-slate-900" title={inst.label}>{inst.label}</div>
                    <div className="truncate text-xs text-slate-500" title={inst.sublabel}>{inst.sublabel}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      {inst.isPersonal ? (
                        <span
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                          title="Only you can use this connection. Data it syncs onto a board is visible to everyone who can see that board."
                        >
                          Personal
                        </span>
                      ) : null}
                      {/* Em dash, not a blank: a connection predating created_by_id
                          has nobody to name, and claim-on-first-edit is gone, so it
                          must not credit whoever edited it first. */}
                      <span className="text-[11px] text-slate-400">
                        Added by {inst.addedBy ?? '—'}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${badgeClass[h]}`}>{badgeLabel[h]}</span>
                    <button
                      onClick={() => toggle(inst.id, 'refresh')}
                      className="text-sm text-indigo-600 hover:underline"
                    >
                      Refresh token
                    </button>
                    <button
                      onClick={() => toggle(inst.id, 'delete')}
                      className="text-sm text-rose-600 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {open?.id === inst.id && open.mode === 'refresh' ? (
                  <div className="mt-3 space-y-2">
                    <TokenTutorial provider={provider} mode="reconnect" />
                    <TokenRefreshBox
                      onRefresh={(tok) => onRefresh(inst.id, tok)}
                      onSuccess={() => {
                        setOpen(null);
                        setHealth((hh) => ({ ...hh, [inst.id]: 'valid' }));
                      }}
                    />
                  </div>
                ) : null}
                {isDeleteOpen ? (
                  <div className="mt-3 space-y-2 rounded border border-rose-100 bg-rose-50 p-3">
                    <p className="text-sm text-slate-700">{impactMessage(inst.label, syncCount[inst.id] ?? 0)}</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => confirmDelete(inst.id)}
                        disabled={deletingId === inst.id}
                        className="rounded bg-rose-600 px-3 py-1 text-sm text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        {deletingId === inst.id ? 'Deleting…' : 'Delete connection'}
                      </button>
                      <button
                        onClick={() => setOpen(null)}
                        className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      {deleteError ? <span className="text-xs text-rose-600">{deleteError}</span> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
