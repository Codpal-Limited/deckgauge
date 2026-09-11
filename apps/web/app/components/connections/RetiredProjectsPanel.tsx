'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RetiredJiraProjectDto } from '@deckgauge/shared';
import {
  createRetiredProject,
  updateRetiredProject,
  deleteRetiredProject,
} from '../../actions/retired-projects';

interface RetiredProjectsPanelProps {
  initial: RetiredJiraProjectDto[];
  /** Jira project keys already known to the Sources page, offered in the dropdown. */
  knownProjectKeys: string[];
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

export function RetiredProjectsPanel({ initial, knownProjectKeys }: RetiredProjectsPanelProps) {
  const router = useRouter();
  const [projectKey, setProjectKey] = useState('');
  const [cutoffDate, setCutoffDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAdd() {
    setError(null);
    setBusy(true);
    const result = await createRetiredProject({
      projectKey,
      cutoffDate,
      note: note.trim() ? note.trim() : null,
    });
    setBusy(false);
    if (result.ok) {
      setProjectKey('');
      setCutoffDate('');
      setNote('');
      router.refresh();
    } else {
      setError(result.error);
    }
  }

  async function onDelete(key: string) {
    setError(null);
    const result = await deleteRetiredProject(key);
    if (result.ok) router.refresh();
    else setError(result.error);
  }

  async function onUpdateCutoff(key: string, nextDate: string) {
    setError(null);
    const result = await updateRetiredProject(key, { cutoffDate: nextDate });
    if (result.ok) router.refresh();
    else setError(result.error);
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">Retired projects</h2>
      <p className="mt-1 text-sm text-slate-600">
        A retired Jira project stops accruing timesheet hours after its cutoff date. Hours logged
        before the cutoff are preserved; removing a project here restores its hours.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-slate-700">Project key</span>
          <input
            aria-label="Project key"
            list="known-project-keys"
            value={projectKey}
            onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
            placeholder="PT"
            className="rounded border border-slate-300 px-2 py-1"
          />
          <datalist id="known-project-keys">
            {knownProjectKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-slate-700">Cutoff date</span>
          <input
            aria-label="Cutoff date"
            type="date"
            value={cutoffDate}
            onChange={(e) => setCutoffDate(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-slate-700">Note (optional)</span>
          <input
            aria-label="Note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="migrated to JMPT"
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          onClick={onAdd}
          disabled={busy || !projectKey || !cutoffDate}
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {busy ? 'Retiring…' : 'Retire project'}
        </button>
      </div>

      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}

      {initial.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No retired projects.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {initial.map((r) => (
            <li
              key={r.projectKey}
              // `sm:` rather than the repo's usual `md:` boundary because this
              // row's left column is short (a project key plus an optional note),
              // so it survives the 640-767px band. Same reasoning as
              // `InstancesPanel`.
              // Stacks below `sm` for the same reason as `InstancesPanel`: the
              // left column had no `min-w-0`, so a long note could not give way
              // and the row pushed the page wider than the phone.
              className="flex flex-col gap-2 rounded border border-slate-100 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <div className="min-w-0">
                <span className="text-sm font-medium text-slate-900">{r.projectKey}</span>
                {r.note ? <span className="ml-2 text-xs text-slate-500">{r.note}</span> : null}
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
                <input
                  aria-label={`Cutoff date for ${r.projectKey}`}
                  type="date"
                  defaultValue={fmtDate(r.cutoffDate)}
                  onBlur={(e) => {
                    if (e.target.value && e.target.value !== fmtDate(r.cutoffDate)) {
                      onUpdateCutoff(r.projectKey, e.target.value);
                    }
                  }}
                  className="inline-flex min-h-11 items-center rounded border border-slate-300 px-2 py-1 text-sm md:min-h-0"
                />
                <button
                  onClick={() => onDelete(r.projectKey)}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-rose-600 hover:underline md:min-h-0 md:min-w-0"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
