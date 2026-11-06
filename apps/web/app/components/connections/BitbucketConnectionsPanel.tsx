'use client';
import { useState, useTransition } from 'react';
import {
  deleteBitbucketRepoSync,
  updateBitbucketRepoSync,
  type BitbucketRepoSyncRow,
  type SourceInstanceRow,
} from '../../actions/connections';
import { connectionLabel } from './ConnectionSelect';
import { TableScroller } from '../TableScroller';

interface Props {
  initialSyncs: BitbucketRepoSyncRow[];
  /** The Bitbucket connections the caller can see — names each repo's connection. */
  instances: SourceInstanceRow[];
}

type Flag = 'syncPrs' | 'syncCommits' | 'syncDeployments';

const FLAGS: Array<{ key: Flag; label: string }> = [
  { key: 'syncPrs', label: 'Pull requests' },
  { key: 'syncCommits', label: 'Commits' },
  { key: 'syncDeployments', label: 'Deployments' },
];

function formatSynced(at: string | null): string {
  if (!at) return 'Not synced yet';
  return new Date(at).toLocaleString();
}

/**
 * The organization's Bitbucket repository syncs.
 *
 * Unlike GitLab there is no "type a project path" form here: repositories are
 * picked from a live, project-grouped list in a board's Add-source wizard, which
 * is both easier and cannot produce a typo'd path. This panel is where an
 * organization sees every repo being synced and tunes what each one pulls.
 */
export function BitbucketConnectionsPanel({ initialSyncs, instances }: Props) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(row: BitbucketRepoSyncRow, key: Flag) {
    setError(null);
    const next = !row[key];
    startTransition(async () => {
      try {
        await updateBitbucketRepoSync(row.id, { [key]: next });
        setSyncs((prev) => prev.map((s) => (s.id === row.id ? { ...s, [key]: next } : s)));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to update');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteBitbucketRepoSync(id);
        setSyncs((prev) => prev.filter((s) => s.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to delete');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">Bitbucket repositories</h2>
      <p className="mt-1 text-sm text-slate-600">
        Pull requests, commits and Pipelines deployments synced for code intelligence and DORA.
        Add repositories from a board&rsquo;s Sources tab &rarr; Add source &rarr; Bitbucket.
      </p>

      {error && (
        <p className="mt-3 text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}

      {syncs.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No Bitbucket repositories are synced yet.</p>
      ) : (
        <TableScroller>
          <table className="mt-4 w-full text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wider text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-3">Repository</th>
                <th scope="col" className="py-2 pr-3">Project</th>
                <th scope="col" className="py-2 pr-3">Connection</th>
                {FLAGS.map((f) => (
                  <th key={f.key} scope="col" className="py-2 pr-3">
                    {f.label}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-3">Boards</th>
                <th scope="col" className="py-2 pr-3">Last synced</th>
                <th scope="col" className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {syncs.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 pr-3 font-mono text-slate-800">{s.repoFullName}</td>
                  <td className="py-2 pr-3 text-slate-600">{s.projectKey ?? '—'}</td>
                  <td className="py-2 pr-3 text-slate-600">
                    {connectionLabel(instances, s.bitbucketInstanceId)}
                  </td>
                  {FLAGS.map((f) => (
                    <td key={f.key} className="py-2 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`${f.label} for ${s.repoFullName}`}
                        checked={s[f.key]}
                        disabled={isPending}
                        onChange={() => toggle(s, f.key)}
                      />
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-slate-600">{s.boardCount}</td>
                  <td className="py-2 pr-3 text-slate-600">{formatSynced(s.lastSyncedAt)}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      className="text-rose-600 hover:underline disabled:opacity-50"
                      disabled={isPending || s.boardCount > 0}
                      title={
                        s.boardCount > 0
                          ? 'Detach it from every board first'
                          : `Stop syncing ${s.repoFullName}`
                      }
                      onClick={() => remove(s.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}
