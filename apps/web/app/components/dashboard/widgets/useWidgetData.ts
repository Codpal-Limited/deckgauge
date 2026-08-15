'use client';

import { useContext, useEffect, useState } from 'react';
import { fetchWidgetData } from '../../../actions/widgets';
import { WidgetDataBatchContext, widgetBatchKey } from './widget-data-batch-context';

export interface WidgetDataState<T> {
  data: T | null;
  error: Error | null;
}

// Wraps fetchWidgetData with explicit error capture so a 500 / network failure
// surfaces as a per-widget error UI rather than an unhandled promise rejection
// that bubbles up and triggers Next.js's global error overlay. Each widget
// previously did `.then(setData)` with no `.catch`, which meant one flaky
// endpoint crashed the entire dashboard.
export function useWidgetData<T>(
  boardId: string,
  widgetType: string,
  config: Record<string, unknown>
): WidgetDataState<T> {
  const batch = useContext(WidgetDataBatchContext);

  // JSON.stringify on config is intentional — config is a fresh object every
  // render, so reference equality would re-fetch on every parent re-render.
  const configKey = JSON.stringify(config);
  const key = widgetBatchKey(widgetType, config);

  // When a batch provider is present it owns fetching: while it loads, every
  // covered widget waits (no individual request); once it's ready, each widget
  // reads its slice. Only fall back to a per-widget fetch when there is no
  // provider (widget used standalone) or the provider finished without this
  // widget's entry.
  const batchHandles = batch != null && (batch.status === 'loading' || batch.entries.has(key));

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (batchHandles) return;
    let cancelled = false;
    setData(null);
    setError(null);
    fetchWidgetData(boardId, widgetType, config)
      .then((result) => {
        if (!cancelled) setData(result as T);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
    // configKey is JSON.stringify(config); listing config itself would re-fetch
    // every render since callers pass a fresh object literal each time.
  }, [boardId, widgetType, configKey, batchHandles]);

  if (batchHandles) {
    const entry = batch!.entries.get(key);
    // status === 'loading' (entry not yet present) → surface as still-loading.
    if (!entry) return { data: null, error: null };
    return {
      data: (entry.data as T) ?? null,
      error: entry.error ? new Error(entry.error) : null,
    };
  }

  return { data, error };
}
