'use client';

import { useCallback, useContext, useEffect, useState } from 'react';
import { fetchWidgetData } from '../../../actions/widgets';
import { WidgetDataBatchContext, widgetBatchKey } from './widget-data-batch-context';

export interface WidgetDataState<T> {
  data: T | null;
  error: Error | null;
  /**
   * Fetch this widget's data again.
   *
   * Exists because a board setting can change what the SAME (boardId, type,
   * config) resolves to — saving a Focus stage map is the case — and nothing in
   * the key would tell this hook to look again. The API evicts its own 60s cache
   * on that write, so the refetch sees the new numbers.
   */
  refetch: () => void;
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
  const [reloads, setReloads] = useState(0);

  // After an explicit refetch this widget owns its own fetching. The batch
  // provider fetches one shared payload and has no way of being told that a
  // single entry went stale, so continuing to read its slice would leave the old
  // numbers on screen and make `refetch` look like it did nothing.
  const batchHandles =
    reloads === 0 && batch != null && (batch.status === 'loading' || batch.entries.has(key));

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (batchHandles) return;
    let cancelled = false;
    // A refetch keeps the last payload on screen until the new one lands.
    // Blanking it made a widget flash its loading state right after a save that
    // was only supposed to move the numbers — and on the FIRST takeover local
    // `data` is null anyway, because the batch provider had been serving it.
    // That case is covered by the batch fallback below.
    if (reloads === 0) setData(null);
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
  }, [boardId, widgetType, configKey, batchHandles, reloads]);

  if (batchHandles) {
    const entry = batch!.entries.get(key);
    // status === 'loading' (entry not yet present) → surface as still-loading.
    if (!entry) return { data: null, error: null, refetch };
    return {
      data: (entry.data as T) ?? null,
      error: entry.error ? new Error(entry.error) : null,
      refetch,
    };
  }

  // The slice the provider was serving before this widget took over its own
  // fetching, used only until the first refetch resolves.
  const batchSlice = batch?.entries.get(key)?.data as T | undefined;

  return { data: data ?? batchSlice ?? null, error, refetch };
}
