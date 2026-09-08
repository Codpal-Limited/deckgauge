// apps/web/app/components/dashboard/ApplyPresetBanner.tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { applyPreset } from '../../actions/presets';

interface Props {
  boardId: string;
  alreadyApplied: boolean;
  onApplied?: (viewId: string) => void;
  /**
   * Which preset to offer. Defaults to Engineering Intelligence so every
   * existing call site keeps its behaviour; the Focus view passes its own.
   */
  presetKey?: string;
}

const COPY: Record<string, { title: string; body: string }> = {
  'engineering-intelligence-v1': {
    title: 'Try the Engineering Intelligence preset.',
    body: '14 hand-tuned widgets covering DORA, planning accuracy, and ticket\u2194code coverage. Adds a new tab; doesn\u2019t modify your existing dashboards.',
  },
  'team-focus-v1': {
    title: 'Try the Team Focus preset.',
    body: 'Where the team\u2019s attention actually went, how much of it reached production, and which roadmap epics received nothing. Adds a new tab; doesn\u2019t modify your existing dashboards.',
  },
};

export default function ApplyPresetBanner({
  boardId,
  alreadyApplied,
  onApplied,
  presetKey = 'engineering-intelligence-v1',
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[presetKey] ?? COPY['engineering-intelligence-v1']!;
  if (alreadyApplied) return null;

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const r = await applyPreset(boardId, presetKey);
      if (r.viewId) onApplied?.(r.viewId);
      // Reload the server-rendered view list so the new preset view appears and
      // this banner's `alreadyApplied` flips to true (hiding it). Without this,
      // the stale client view list keeps the banner up and a second click would
      // hit the API's benign 409 "already applied" path.
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to apply preset');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm">
      <p className="text-slate-700">
        <span className="font-semibold">{copy.title}</span> {copy.body}
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        className="ml-auto rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {busy ? 'Applying…' : 'Apply preset'}
      </button>
      {error ? <span className="text-xs text-rose-600">{error}</span> : null}
    </div>
  );
}
