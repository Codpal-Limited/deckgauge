'use client';

import { useEffect, useState } from 'react';

export interface BoardStatusOption {
  id: string;
  label: string;
  color: string;
}

interface Props {
  open: boolean;
  providerLabel: string;
  fetchSourceStatuses: () => Promise<string[]>;
  boardStatuses: BoardStatusOption[];
  initialMapping: Record<string, string>;
  // Persists the mapping. Resolves on success; throws to keep the modal open
  // with an error message. The editor closes itself on success via `onClose`.
  onSave: (mapping: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

const UNMAPPED = '';

export function StatusMappingEditor({
  open,
  providerLabel,
  fetchSourceStatuses,
  boardStatuses,
  initialMapping,
  onSave,
  onClose,
}: Props) {
  const [sourceStatuses, setSourceStatuses] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>(initialMapping);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initialMapping);
    setLoading(true);
    setError(null);
    setSaveError(null);
    fetchSourceStatuses()
      .then((statuses) => {
        // Merge any keys already in the mapping that are no longer in the live
        // source list — we don't want to silently lose mappings just because
        // ClickHouse hasn't seen that status recently.
        const merged = Array.from(new Set([...statuses, ...Object.keys(initialMapping)])).sort();
        setSourceStatuses(merged);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load source statuses'),
      )
      .finally(() => setLoading(false));
  }, [open, fetchSourceStatuses, initialMapping]);

  if (!open) return null;

  const setMapping = (source: string, boardStatusLabel: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (boardStatusLabel === UNMAPPED) delete next[source];
      else next[source] = boardStatusLabel;
      return next;
    });
  };

  const mappedCount = Object.keys(draft).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${providerLabel} status mapping`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-slate-100 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-900">
            {providerLabel} status mapping
          </h2>
          <span className="text-xs text-slate-500">
            {mappedCount} mapped of {sourceStatuses.length} known
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto text-slate-400 hover:text-slate-700 text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-3 text-xs text-slate-600 border-b border-slate-100">
          Map each {providerLabel} status to one of this board&apos;s statuses. Leave a row as
          <span className="font-mono text-[11px] mx-1 px-1 bg-slate-100 rounded">— unmapped —</span>
          to let the sync use its default behaviour for that status.
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-xs text-slate-500">Loading source statuses…</div>
          )}
          {error && (
            <div className="m-5 p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md">
              {error}
            </div>
          )}
          {saveError && (
            <div
              role="alert"
              className="m-5 p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md"
            >
              {saveError}
            </div>
          )}
          {!loading && !error && sourceStatuses.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-500">
              No source statuses observed yet — once items are synced, they&apos;ll appear here.
            </div>
          )}
          {!loading && !error && sourceStatuses.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-5 py-2 font-semibold w-1/2">{providerLabel} status</th>
                  <th className="text-left px-5 py-2 font-semibold">Board status</th>
                </tr>
              </thead>
              <tbody>
                {sourceStatuses.map((status) => (
                  <tr key={status} className="border-t border-slate-100">
                    <td className="px-5 py-2 font-mono text-slate-900">{status}</td>
                    <td className="px-5 py-2">
                      <select
                        aria-label={`Map ${status} to board status`}
                        className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white"
                        value={draft[status] ?? UNMAPPED}
                        onChange={(e) => setMapping(status, e.target.value)}
                      >
                        <option value={UNMAPPED}>— unmapped —</option>
                        {boardStatuses.map((bs) => (
                          <option key={bs.id} value={bs.label}>
                            {bs.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-100 flex items-center gap-2 bg-slate-50">
          <button
            type="button"
            disabled={saving}
            className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-medium disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={async () => {
              setSaveError(null);
              setSaving(true);
              try {
                await onSave(draft);
                onClose();
              } catch (err: unknown) {
                setSaveError(err instanceof Error ? err.message : 'Failed to save mapping');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button
            type="button"
            disabled={saving}
            className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600 disabled:opacity-60"
            onClick={onClose}
          >
            Cancel
          </button>
          {mappedCount > 0 && (
            <button
              type="button"
              disabled={saving}
              className="ml-auto text-xs text-rose-600 hover:underline disabled:opacity-60"
              onClick={() => setDraft({})}
            >
              Clear all mappings
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
