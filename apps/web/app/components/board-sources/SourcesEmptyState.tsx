'use client';

import type { Provider } from './BoardAddSource';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'jira', label: 'Jira' },
  { id: 'github', label: 'GitHub' },
  { id: 'ado', label: 'Azure DevOps' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'bitbucket', label: 'Bitbucket' },
];

interface SourcesEmptyStateProps {
  /** True when no connections exist yet, so the picker would be empty. */
  catalogEmpty: boolean;
  /** Open the add-source wizard pre-selected to the chosen provider. */
  onConnect: (provider: Provider) => void;
}

/**
 * Onboarding empty state for a board with no sources yet. Explains the value and
 * offers a tile per provider that jumps straight into the add-source wizard.
 */
export function SourcesEmptyState({ catalogEmpty, onConnect }: SourcesEmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center">
      <h2 className="text-base font-semibold text-slate-900">Bring this board to life</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
        Connect your issue tracker or git provider and this board&rsquo;s dashboard and roadmap
        fill in automatically. Pick one to get started:
      </p>
      <div className="mx-auto mt-5 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-5">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onConnect(p.id)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-4 text-sm font-medium text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 hover:shadow"
          >
            {p.label}
          </button>
        ))}
      </div>
      {catalogEmpty && (
        <p className="mt-4 text-xs text-slate-400">
          No connections yet.{' '}
          <a href="/sources" className="text-indigo-600 hover:underline">
            Set up a new source in the Sources catalog &rarr;
          </a>
        </p>
      )}
    </div>
  );
}
