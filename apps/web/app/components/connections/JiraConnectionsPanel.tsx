'use client';
import { useState, useTransition } from 'react';
import {
  createJiraProjectSync,
  deleteJiraProjectSync,
  type JiraProjectSyncRow,
} from '../../actions/connections';
import { TableScroller } from '../TableScroller';

interface Props {
  initialSyncs: JiraProjectSyncRow[];
}

export function JiraConnectionsPanel({ initialSyncs }: Props) {
  const [syncs, setSyncs] = useState(initialSyncs);
  const [isPending, startTransition] = useTransition();
  const [newKey, setNewKey] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    setError(null);
    startTransition(async () => {
      try {
        const row = await createJiraProjectSync({
          jiraInstanceId: instanceId,
          jiraProjectKey: newKey,
          syncChangelog: true,
          syncWorklogs: false,
        });
        setSyncs((prev) => [{ ...row, boardCount: 0 }, ...prev]);
        setNewKey('');
        setInstanceId('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to create');
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      try {
        await deleteJiraProjectSync(id);
        setSyncs((prev) => prev.filter((s) => s.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to delete');
      }
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">Jira project syncs</h2>
      {syncs.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No Jira project syncs yet.</p>
      ) : (
        <TableScroller className="mt-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="pb-2">Instance</th>
                <th className="pb-2">Project key</th>
                <th className="pb-2">Used by</th>
                <th className="pb-2">Last synced</th>
                <th className="pb-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="py-2 font-mono text-xs text-slate-600">
                    {s.jiraInstanceId.slice(0, 8)}
                  </td>
                  <td className="py-2 font-mono">{s.jiraProjectKey}</td>
                  <td className="py-2">
                    {s.boardCount} board{s.boardCount === 1 ? '' : 's'}
                  </td>
                  <td className="py-2 text-slate-500">
                    {s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => remove(s.id)}
                      disabled={isPending}
                      className="text-rose-600 hover:underline disabled:opacity-50"
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
      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          placeholder="instance uuid"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="PROJECTKEY"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          onClick={add}
          disabled={!instanceId || !newKey || isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  );
}
