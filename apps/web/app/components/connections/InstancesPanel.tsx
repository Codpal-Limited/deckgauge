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

function impactMessage(label: string, count: number): string {
  // count <= 0 also covers "unknown" (a failed sync-count fetch defaults to 0),
  // so the wording still warns about board data rather than downplaying the
  // cascade when we can't count it.
  if (count <= 0) return `Delete “${label}”? Removes this connection and any synced data from your boards.`;
  const noun = count === 1 ? 'project sync' : 'project syncs';
  return `Delete “${label}”? Removes ${count} ${noun} and their synced data from your boards.`;
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
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{inst.label}</div>
                    <div className="text-xs text-slate-500">{inst.sublabel}</div>
                  </div>
                  <div className="flex items-center gap-3">
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
