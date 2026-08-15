'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntelligenceSchema } from '@deckgauge/shared';
import {
  fetchIntelligenceSchema,
  fetchIntelligenceSql,
  runIntelligenceQuery,
  type RunIntelligenceQueryErr,
  type RunIntelligenceQueryOk,
} from '../../../actions/intelligence-query';
import { SqlEditor } from './SqlEditor';
import { ScopeBadge } from './ScopeBadge';
import { ResultTable } from './ResultTable';

const WELCOME = `-- Welcome. Pick a table from the autocomplete and write your query.
-- Scope is enforced server-side: this console can only read sources connected
-- to this board.`;

interface Props {
  boardId: string;
  initialWidget?: string;
  initialConfig?: string;
  initialFilter?: string;
}

export function IntelligenceConsole({
  boardId,
  initialWidget,
  initialConfig,
  initialFilter,
}: Props) {
  const [schema, setSchema] = useState<IntelligenceSchema | null>(null);
  const [sql, setSql] = useState<string>(WELCOME);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<RunIntelligenceQueryOk | null>(null);
  const [error, setError] = useState<RunIntelligenceQueryErr | null>(null);
  const [running, setRunning] = useState(false);

  // Keep latest sql in a ref so run() reads fresh state without re-creating
  // the callback every keystroke. This also fixes Cmd+Enter stale-closure
  // issues since SqlEditor registers the command once on mount.
  const sqlRef = useRef(sql);
  useEffect(() => {
    sqlRef.current = sql;
  });

  // Track running in a ref so the run callback's reentry guard is stable
  // and doesn't pollute its dependency list.
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  });

  // Auto-run fires at most once per mount, after widget SQL loads.
  const autoRanRef = useRef(false);

  const run = useCallback(
    async (overrideSql?: string) => {
      if (runningRef.current) return;
      setRunning(true);
      setError(null);
      try {
        // `overrideSql` lets callers (notably the auto-run path right after
        // `setSql`) bypass the ref entirely. Without it, run() could fire
        // before React's render + useEffect had refreshed `sqlRef.current`,
        // shipping the WELCOME comment-only template to /execute — which the
        // api validator rejects as MULTI_STATEMENT.
        const sqlToRun = overrideSql ?? sqlRef.current;
        const r = await runIntelligenceQuery(boardId, sqlToRun);
        if (r.ok) {
          setResult(r);
        } else {
          setError(r);
          setResult(null);
        }
      } finally {
        setRunning(false);
      }
    },
    [boardId],
  );

  useEffect(() => {
    let cancelled = false;
    fetchIntelligenceSchema(boardId)
      .then((s) => {
        if (!cancelled) setSchema(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load schema');
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  useEffect(() => {
    if (!initialWidget) return;
    let cancelled = false;
    fetchIntelligenceSql({
      boardId,
      widget: initialWidget,
      config: initialConfig,
      filter: initialFilter,
    })
      .then((r) => {
        if (cancelled) return;
        setSql(r.sql);
        if (!autoRanRef.current) {
          autoRanRef.current = true;
          // Pass the just-fetched SQL straight into run() — don't bounce
          // through `sqlRef.current`, which under React 18 concurrent
          // scheduling can still hold the WELCOME default when the timer
          // fires before the render commit + ref-update useEffect.
          void run(r.sql);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load widget SQL');
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, initialWidget, initialConfig, initialFilter, run]);

  if (loadError) {
    return <div className="p-8 text-rose-600">Could not load console: {loadError}</div>;
  }

  if (schema && schema.tables.length === 0) {
    return (
      <div className="p-8 text-slate-500">
        Connect a source first.{' '}
        <a className="underline" href={`/boards/${boardId}/sources`}>
          Sources tab
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
        <h1 className="text-sm font-semibold text-slate-700">Intelligence</h1>
        {schema && <ScopeBadge scope={schema.scope} />}
        <div className="ml-auto flex items-center gap-2">
          {running && <span className="text-xs text-slate-500">Running…</span>}
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="text-xs px-3 py-1.5 rounded bg-slate-900 text-slate-50 disabled:bg-slate-400 disabled:cursor-not-allowed hover:bg-slate-700"
            title="Run query (Cmd/Ctrl+Enter)"
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
      <div className="min-h-[240px]">
        <SqlEditor value={sql} onChange={setSql} schema={schema} onRun={run} />
      </div>
      <div className="flex-1 flex flex-col min-h-0">
        <ResultTable result={result} error={error} running={running} />
      </div>
    </div>
  );
}
