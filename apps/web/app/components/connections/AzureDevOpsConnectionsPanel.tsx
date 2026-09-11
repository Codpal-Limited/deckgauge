'use client';
import { useState, useTransition } from 'react';
import {
  createAdoProjectSync,
  deleteAdoProjectSync,
  updateAdoProjectSync,
  saveAdoProductionConfig,
  type AdoProjectSyncRow,
} from '../../actions/connections';
import { TableScroller } from '../TableScroller';

interface Props {
  initialSyncs: AdoProjectSyncRow[];
  /**
   * Whether the caller may manage connections — organization ADMIN.
   *
   * Everything else on this panel is project-sync management, which an
   * organization MEMBER may do (`orgRole(MEMBER)`). The production-deploy
   * allow-lists are the exception: they are keyed by the INSTANCE and their
   * endpoint is `orgRole(ADMIN)`, so a member must never be offered inputs whose
   * save the server will refuse. Defaults to true, like the other connection
   * surfaces (BoardSourceCard, BoardSourcesList), so callers that have no role to
   * pass keep today's behaviour.
   */
  canManageConnections?: boolean;
}

interface EditDraft {
  syncPrs: boolean;
  syncCommits: boolean;
  syncReposText: string;
  syncAllRepos: boolean;
  prodDefinitionsText: string;
  prodStagesText: string;
}

/**
 * What a response actually guarantees. Both `listAdoProjectSyncs` and
 * `createAdoProjectSync` hand back `res.json()`, so the declared row type is an
 * assertion rather than a check and the production allow-lists may simply be
 * absent.
 */
type UncheckedSyncRow = Omit<AdoProjectSyncRow, 'prodReleaseDefinitions' | 'prodStages'> &
  Partial<Pick<AdoProjectSyncRow, 'prodReleaseDefinitions' | 'prodStages'>>;

/**
 * Normalises a row on its way INTO state, so the render can rely on the arrays
 * being there. An absent allow-list means the same thing as an empty one — the
 * stage-name heuristic decides — and collapsing the two here keeps that single
 * uncertainty out of the three places that read them.
 */
function withProdLists(row: UncheckedSyncRow): AdoProjectSyncRow {
  return {
    ...row,
    prodReleaseDefinitions: row.prodReleaseDefinitions ?? [],
    prodStages: row.prodStages ?? [],
  };
}

function parseCsv(text: string): string[] {
  return text
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The read-only view of the production-deploy allow-lists, shared by the
 * non-editing row and by the edit row of a caller who may not change them. The
 * lists arrive on the member-visible `GET /project-syncs/ado` read, so gating the
 * INPUTS must not hide the VALUES: dropping the column for members would take
 * away a read the API still grants.
 */
function ProductionDeploysSummary({ sync }: { sync: AdoProjectSyncRow }) {
  if (sync.prodReleaseDefinitions.length === 0 && sync.prodStages.length === 0) {
    // Nothing configured. Say WHICH rule is running rather than leaving the cell
    // blank — a blank reads as "no deploys", when in fact the stage-name
    // heuristic is deciding, and on a project whose stages are all named
    // "Stage 1" it cannot.
    return (
      <span
        className="text-xs text-slate-500"
        title="Deploy frequency and change failure rate infer production from the release stage name. Projects whose stages are all named ADO's default 'Stage 1' cannot be classified — list their pipelines or stages here."
      >
        Auto (stage names)
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {[...sync.prodReleaseDefinitions, ...sync.prodStages].map((v) => (
        <span
          key={v}
          className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

export function AzureDevOpsConnectionsPanel({
  initialSyncs,
  canManageConnections = true,
}: Props) {
  // `withProdLists` (from main) normalises rows whose production allow-lists are
  // absent. Both sides of this merge fixed that crash by different means and both
  // are kept: main made the COMPONENT tolerate a row without the lists, which is
  // what a real API response can be; this branch corrected the create MOCK that
  // had been hiding it in the suite. Dropping either one loses a real fix.
  const [syncs, setSyncs] = useState(() => initialSyncs.map((s) => withProdLists(s)));
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
        setSyncs((prev) => [withProdLists({ ...row, boardCount: 0 }), ...prev]);
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
    // Two endpoints, deliberately: the sync flags are keyed by the sync row
    // (`PATCH /project-syncs/ado/:id`, orgRole(MEMBER)) while production config is
    // keyed by the INSTANCE (`PUT .../production-config`, orgRole(ADMIN)). There
    // is no transaction across them, so the second call is issued only when it is
    // both PERMITTED and NEEDED:
    //
    //   - permitted: without the `canManageConnections` guard a member's save
    //     persisted the flags, then 403'd on the production config, and the panel
    //     reported failure — telling the user nothing was saved while half of it
    //     had been. The inputs are gated on the same flag, so this is belt and
    //     braces rather than the only guard;
    //   - needed: skipping an unchanged write narrows the untransactional window
    //     for an ADMIN too. A save that only touches the sync flags now issues one
    //     request, so there is no second one left to fail after the first landed.
    const writesProdConfig =
      canManageConnections &&
      (!sameList(prodPatch.prodReleaseDefinitions, row.prodReleaseDefinitions) ||
        !sameList(prodPatch.prodStages, row.prodStages));
    startTransition(async () => {
      try {
        await updateAdoProjectSync(id, patch);
        if (writesProdConfig) {
          // Local state is updated only after BOTH succeed — a caller whose
          // production config the server refused must not be shown it as stored.
          await saveAdoProductionConfig(row.azureDevOpsInstanceId, row.adoProject, {
            definitions: prodPatch.prodReleaseDefinitions,
            stages: prodPatch.prodStages,
          });
        }
        setSyncs((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, ...patch, ...(writesProdConfig ? prodPatch : {}) } : s,
          ),
        );
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
        <TableScroller className="mt-4">
          <table className="w-full text-sm">
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
                      {isEditing && editDraft && canManageConnections ? (
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
                      ) : (
                        <div className="flex flex-col gap-1">
                          <ProductionDeploysSummary sync={s} />
                          {isEditing ? (
                            <span className="text-[11px] text-slate-500">
                              Only an organization administrator can change production deploys.
                            </span>
                          ) : null}
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
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
