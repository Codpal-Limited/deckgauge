'use client';
import { useEffect, useRef, useState } from 'react';
import type { RefreshResult } from '../../actions/connections';

interface Props {
  onRefresh: (token: string) => Promise<RefreshResult>;
  note?: string;
  autoFocus?: boolean;
  onSuccess?: () => void;
}

export function TokenRefreshBox({ onRefresh, note, autoFocus, onSuccess }: Props) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  async function save() {
    setError(null);
    setSubmitting(true);
    const result = await onRefresh(token);
    if (!mounted.current) return;
    if (result.ok) {
      setToken('');
      onSuccess?.();
    } else {
      setError(result.error ?? 'Refresh failed');
    }
    setSubmitting(false);
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          autoFocus={autoFocus}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste new token"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <button
          onClick={save}
          disabled={!token || submitting}
          className="inline-flex min-h-11 items-center rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50 md:min-h-0"
        >
          {submitting ? 'Validating…' : 'Save'}
        </button>
        {error ? <span className="text-xs text-rose-600">{error}</span> : null}
      </div>
      {note ? <p className="mt-1 text-xs text-slate-400">{note}</p> : null}
    </div>
  );
}
