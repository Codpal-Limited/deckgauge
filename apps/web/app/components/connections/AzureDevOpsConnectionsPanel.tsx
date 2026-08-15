'use client';
import { useState, useTransition } from 'react';
import {
  createAdoProjectSync,
  deleteAdoProjectSync,
  updateAdoProjectSync,
  saveAdoProductionConfig,
  type AdoProjectSyncRow,
} from '../../actions/connections';

interface Props {
  initialSyncs: AdoProjectSyncRow[];
}

interface EditDraft {
  syncPrs: boolean;
  syncCommits: boolean;
  syncReposText: string;
  syncAllRepos: boolean;
  prodDefinitionsText: string;
  prodStagesText: string;
}

function parseCsv(text: string): string[] {
  return text
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

export function AzureDevOpsConnectionsPanel({ initialSyncs }: Props) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [isPending, startTransition] = useTransition();
  const [instanceId, setInstanceId] = useState('');
  const [adoProject, setAdoProject] = useState('');
  const [reposText, setReposText] = useState('');
  const [syncPrs, setSyncPrs] = useState(true);
  const [syncCommits, setSyncCommits] = useState(true);
  const [syncAllRepos, setSyncAllRepos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  function add() {
    setError(null);
    const syncRepos = parseCsv(reposText);
    startTransition(async () => {
      try {
        const row = await createAdoProjectSync({
          azureDevOpsInstanceId: instanceId,
          adoProject,
          syncPrs,
          syncCommits,
          syncRepos,
          syncAllRepos,
        });
        setSyncs((prev) => [{ ...row, boardCount: 0 }, ...prev]);
        setInstanceId('');
        setAdoProject('');
        setReposText('');
        setSyncPrs(true);
        setSyncCommits(true);
        setSyncAllRepos(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to create');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteAdoProjectSync(id);
        setSyncs((prev) => prev.filter((s) => s.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to delete');
      }
    });
  }

  function startEdit(s: AdoProjectSyncRow) {
    setError(null);
    setEditingId(s.id);
    setEditDraft({
      syncPrs: s.syncPrs,
      syncCommits: s.syncCommits,
      syncReposText: s.syncRepos.join(', '),
      syncAllRepos: s.syncAllRepos,
      prodDefinitionsText: s.prodReleaseDefinitions.join(', '),
      prodStagesText: s.prodStages.join(', '),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
  }

  function saveEdit(id: string) {
    if (!editDraft) return;
    const row = syncs.find((s) => s.id === id);
    if (!row) return;
    setError(null);
    const patch = {
      syncPrs: editDraft.syncPrs,
      syncCommits: editDraft.syncCommits,
      syncRepos: parseCsv(editDraft.syncReposText),
      syncAllRepos: editDraft.syncAllRepos,
    };
    const prodPatch = {
      prodReleaseDefinitions: parseCsv(editDraft.prodDefinitionsText),
      prodStages: parseCsv(editDraft.prodStagesText),
    };
    startTransition(async () => {
      try {
        // Two endpoints, deliberately: the sync flags are AUTHENTICATED and keyed
        // by the sync row, while production config is keyed by the INSTANCE so
        // the connection-ownership policy applies. Local state is updated only
        // after BOTH succeed — a user who lacks ownership must not be shown a
        // production config the server refused to store.
        await updateAdoProjectSync(id, patch);
        await saveAdoProductionConfig(row.azureDevOpsInstanceId, row.adoProject, {
          definitions: prodPatch.prodReleaseDefinitions,
          stages: prodPatch.prodStages,
        });
        setSyncs((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch, ...prodPatch } : s)));
        setEditingId(null);
        setEditDraft(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to update');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">Azure DevOps project syncs</h2>
      {syncs.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No Azure DevOps project syncs yet.</p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="pb-2">Instance</th>
              <th className="pb-2">Project</th>
              <th className="pb-2">Code sync</th>
              <th className="pb-2">Production deploys</th>
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
                    {s.azureDevOpsInstanceId.slice(0, 8)}
                  </td>
                  <td className="py-2 font-mono">{s.adoProject}</td>
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
                          PRs
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
                        <input
                          value={editDraft.syncReposText}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, syncReposText: e.target.value })
                          }
                          placeholder="repo1, repo2"
                          disabled={editDraft.syncAllRepos}
                          className="rounded border border-slate-300 px-2 py-1 text-xs disabled:bg-slate-100 disabled:text-slate-400"
                        />
                        <label className="flex items-center gap-1 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={editDraft.syncAllRepos}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, syncAllRepos: e.target.checked })
                            }
                          />
                          All repositories
                        </label>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1 text-xs text-slate-600">
                        <span className={s.syncPrs ? 'text-emerald-700' : 'text-slate-400'}>
                          PRs {s.syncPrs ? 'on' : 'off'}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className={s.syncCommits ? 'text-emerald-700' : 'text-slate-400'}>
                          Commits {s.syncCommits ? 'on' : 'off'}
                        </span>
                        {s.syncAllRepos ? (
                          <span className="ml-1 text-slate-500">(All repos)</span>
                        ) : (
                          s.syncRepos.length > 0 && (
                            <span className="ml-1 text-slate-500">({s.syncRepos.join(', ')})</span>
                          )
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    {isEditing && editDraft ? (
                      <div className="flex flex-col gap-1">
                        <input
                          value={editDraft.prodDefinitionsText}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, prodDefinitionsText: e.target.value })
                          }
                          placeholder="Production pipelines"
                          className="rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                        <input
                          value={editDraft.prodStagesText}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, prodStagesText: e.target.value })
                          }
                          placeholder="Production stages"
                          className="rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                        <span className="text-[11px] text-slate-500">
                          Comma-separated. Leave both empty to infer production from stage names.
                        </span>
                      </div>
                    ) : s.prodReleaseDefinitions.length === 0 && s.prodStages.length === 0 ? (
                      // Nothing configured. Say WHICH rule is running rather than
                      // leaving the cell blank — a blank reads as "no deploys",
                      // when in fact the stage-name heuristic is deciding, and on
                      // a project whose stages are all named "Stage 1" it cannot.
                      <span
                        className="text-xs text-slate-500"
                        title="Deploy frequency and change failure rate infer production from the release stage name. Projects whose stages are all named ADO's default 'Stage 1' cannot be classified — list their pipelines or stages here."
                      >
                        Auto (stage names)
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {[...s.prodReleaseDefinitions, ...s.prodStages].map((v) => (
                          <span
                            key={v}
                            className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700"
                          >
                            {v}
                          </span>
                        ))}
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
                          className="text-indigo-600 hover:underline disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={isPending}
                          className="text-slate-500 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => startEdit(s)}
                          disabled={isPending || editingId !== null}
                          className="text-indigo-600 hover:underline disabled:opacity-50"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => remove(s.id)}
                          disabled={isPending || editingId !== null}
                          className="text-rose-600 hover:underline disabled:opacity-50"
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
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          placeholder="instance uuid"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input
          value={adoProject}
          onChange={(e) => setAdoProject(e.target.value)}
          placeholder="project name"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input
          value={reposText}
          onChange={(e) => setReposText(e.target.value)}
          placeholder="repo1, repo2"
          disabled={syncAllRepos}
          className="rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400"
        />
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={syncAllRepos}
            onChange={(e) => setSyncAllRepos(e.target.checked)}
          />
          All repositories
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={syncPrs}
            onChange={(e) => setSyncPrs(e.target.checked)}
          />
          PRs
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
          disabled={!instanceId || !adoProject || isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
