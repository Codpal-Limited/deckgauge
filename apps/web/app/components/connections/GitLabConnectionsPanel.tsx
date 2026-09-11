'use client';
import { useState, useTransition } from 'react';
import {
  createGitLabProjectSync,
  deleteGitLabProjectSync,
  updateGitLabProjectSync,
  type GitLabProjectSyncRow,
} from '../../actions/connections';
import { TableScroller } from '../TableScroller';

interface Props {
  initialSyncs: GitLabProjectSyncRow[];
}

interface EditDraft {
  syncPrs: boolean;
  syncCommits: boolean;
}

export function GitLabConnectionsPanel({ initialSyncs }: Props) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [isPending, startTransition] = useTransition();
  const [instanceId, setInstanceId] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [syncPrs, setSyncPrs] = useState(true);
  const [syncCommits, setSyncCommits] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  function add() {
    setError(null);
    startTransition(async () => {
      try {
        const row = await createGitLabProjectSync({
          gitlabInstanceId: instanceId,
          projectPath,
          syncPrs,
          syncCommits,
        });
        setSyncs((prev) => [{ ...row, boardCount: 0 }, ...prev]);
        setInstanceId('');
        setProjectPath('');
        setSyncPrs(true);
        setSyncCommits(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to create');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteGitLabProjectSync(id);
        setSyncs((prev) => prev.filter((s) => s.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to delete');
      }
    });
  }

  function startEdit(s: GitLabProjectSyncRow) {
    setError(null);
    setEditingId(s.id);
    setEditDraft({ syncPrs: s.syncPrs, syncCommits: s.syncCommits });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  function saveEdit(id: string) {
    if (!editDraft) return;
    setError(null);
    const patch = { syncPrs: editDraft.syncPrs, syncCommits: editDraft.syncCommits };
    startTransition(async () => {
      try {
        await updateGitLabProjectSync(id, patch);
        setSyncs((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
        setEditingId(null);
        setEditDraft(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to update');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">GitLab project syncs</h2>
      {syncs.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No GitLab project syncs yet.</p>
      ) : (
        <TableScroller className="mt-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="pb-2">Instance</th>
                <th className="pb-2">Project path</th>
                <th className="pb-2">Code sync</th>
                <th className="pb-2">Used by</th>
                <th className="pb-2">Last synced</th>
                <th className="pb-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => {
                const isEditing = editingId === s.id && editDraft !== null;
                return (
                  <tr key={s.id} className="border-t border-slate-100 align-top">
                    <td className="py-2 font-mono text-xs text-slate-600">
                      {s.gitlabInstanceId.slice(0, 8)}
                    </td>
                    <td className="py-2 font-mono">{s.projectPath}</td>
                    <td className="py-2">
                      {isEditing && editDraft ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-1 text-xs text-slate-700">
                            <input
                              type="checkbox"
                              checked={editDraft.syncPrs}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, syncPrs: e.target.checked })
                              }
                            />
                            MRs
                          </label>
                          <label className="flex items-center gap-1 text-xs text-slate-700">
                            <input
                              type="checkbox"
                              checked={editDraft.syncCommits}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, syncCommits: e.target.checked })
                              }
                            />
                            Commits
                          </label>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-600">
                          <span className={s.syncPrs ? 'text-emerald-700' : 'text-slate-400'}>
                            MRs {s.syncPrs ? 'on' : 'off'}
                          </span>
                          <span className="text-slate-300">·</span>
                          <span className={s.syncCommits ? 'text-emerald-700' : 'text-slate-400'}>
                            Commits {s.syncCommits ? 'on' : 'off'}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="py-2">
                      {s.boardCount} board{s.boardCount === 1 ? '' : 's'}
                    </td>
                    <td className="py-2 text-slate-500">
                      {s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right">
                      {isEditing ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => saveEdit(s.id)}
                            disabled={isPending}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center text-indigo-600 hover:underline disabled:opacity-50 md:min-h-0 md:min-w-0"
                          >
                            Save
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={isPending}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center text-slate-500 hover:underline disabled:opacity-50 md:min-h-0 md:min-w-0"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => startEdit(s)}
                            disabled={isPending || editingId !== null}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center text-indigo-600 hover:underline disabled:opacity-50 md:min-h-0 md:min-w-0"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => remove(s.id)}
                            disabled={isPending || editingId !== null}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center text-rose-600 hover:underline disabled:opacity-50 md:min-h-0 md:min-w-0"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          placeholder="instance uuid"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder="group/project"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={syncPrs}
            onChange={(e) => setSyncPrs(e.target.checked)}
          />
          MRs
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={syncCommits}
            onChange={(e) => setSyncCommits(e.target.checked)}
          />
          Commits
        </label>
        <button
          onClick={add}
          disabled={!instanceId || !projectPath || isPending}
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
