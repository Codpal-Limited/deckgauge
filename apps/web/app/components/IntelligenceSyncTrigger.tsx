// EI-022 — UI surface for the manual sync trigger.
'use client';

import { useState, useTransition } from 'react';
import { triggerIntelligenceSync } from '../actions/intelligence';

type Source = 'jira' | 'github' | 'ado' | 'gitlab' | 'all';

export function IntelligenceSyncTrigger() {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  function fire(source: Source) {
    setStatus(null);
    startTransition(async () => {
      const result = await triggerIntelligenceSync(source);
      setStatus(result);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Intelligence sync</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pulls the latest PRs, commits, status transitions, and worklogs from each provider
          into ClickHouse. The Dashboard tab on each board reads from ClickHouse. Runs
          automatically every 15 min; use the buttons below to trigger an immediate run.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => fire('all')}
          disabled={isPending}
          // "Sync All Now" and the four per-source buttons share one wrapping row,
          // so they are floored together — measured 38px tall.
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {isPending ? 'Enqueueing…' : 'Sync All Now'}
        </button>
        {(['jira', 'github', 'ado', 'gitlab'] as Source[]).map((s) => (
          <button
            key={s}
            onClick={() => fire(s)}
            disabled={isPending}
            className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 md:min-h-0"
          >
            {s === 'ado' ? 'ADO' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {status ? (
        <div
          className={`rounded border px-3 py-2 text-sm ${
            status.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          {status.message}
        </div>
      ) : null}
    </div>
  );
}
