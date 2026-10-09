'use client';
import { useState, useTransition } from 'react';
import {
  createGitHubRepoSync,
  deleteGitHubRepoSync,
  type GitHubRepoSyncRow,
  type SourceInstanceRow,
} from '../../actions/connections';
import { ConnectionSelect, connectionLabel, defaultConnectionId } from './ConnectionSelect';
import { TableScroller } from '../TableScroller';

interface Props {
  initialSyncs: GitHubRepoSyncRow[];
  /**
   * The connections the caller can see — the same list InstancesPanel shows. The
   * add form picks from these (issue #4: it used to take a typed connection id the
   * UI displays nowhere), and the table names each sync's connection by them.
   */
  instances: SourceInstanceRow[];
}

export function GitHubConnectionsPanel({ initialSyncs, instances }: Props) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [isPending, startTransition] = useTransition();
  const [instanceId, setInstanceId] = useState(() => defaultConnectionId(instances));
  const [repoFullName, setRepoFullName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    setError(null);
    startTransition(async () => {
      try {
        const row = await createGitHubRepoSync({
          githubInstanceId: instanceId,
          repoFullName,
        });
        setSyncs((prev) => [{ ...row, boardCount: 0 }, ...prev]);
        setInstanceId(defaultConnectionId(instances));
        setRepoFullName('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to create');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteGitHubRepoSync(id);
        setSyncs((prev) => prev.filter((s) => s.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to delete');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">GitHub repo syncs</h2>
      <p className="mt-1 text-xs text-slate-500">
        PRs, reviews, commits, workflow runs, deployments, and issues are synced
        automatically for every repo; cadence is governed by the repo&apos;s tier.
      </p>
      {syncs.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No GitHub repo syncs yet.</p>
      ) : (
        <TableScroller className="mt-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="pb-2">Instance</th>
                <th className="pb-2">Repo</th>
                <th className="pb-2">Code sync</th>
                <th className="pb-2">Tier</th>
                <th className="pb-2">Used by</th>
                <th className="pb-2">Last synced</th>
                <th className="pb-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => (
                <tr key={s.id} className="border-t border-slate-100 align-top">
                  <td className="py-2 text-xs text-slate-600">
                    {connectionLabel(instances, s.githubInstanceId)}
                  </td>
                  <td className="py-2 font-mono">{s.repoFullName}</td>
                  <td className="py-2">
                    <span className="text-xs font-medium text-emerald-700">
                      PRs + commits (always on)
                    </span>
                  </td>
                  <td className="py-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                      {s.tier}
                    </span>
                  </td>
                  <td className="py-2">
                    {s.boardCount} board{s.boardCount === 1 ? '' : 's'}
                  </td>
                  <td className="py-2 text-slate-500">
                    {s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => remove(s.id)}
                      disabled={isPending}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center text-rose-600 hover:underline disabled:opacity-50 md:min-h-0 md:min-w-0"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ConnectionSelect
          label="GitHub connection"
          instances={instances}
          value={instanceId}
          onChange={setInstanceId}
        />
        <input
          value={repoFullName}
          onChange={(e) => setRepoFullName(e.target.value)}
          placeholder="owner/repo"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          onClick={add}
          disabled={!instanceId || !repoFullName || isPending}
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
