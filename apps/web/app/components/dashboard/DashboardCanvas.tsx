'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Responsive, WidthProvider, Layout, LayoutItem } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import { fetchWidgets, fetchWidgetDataBatch, updateWidgetLayouts } from '../../actions/widgets';
import WidgetCard from './WidgetCard';
import WidgetPicker from './WidgetPicker';
import { widgetRegistry } from './widgetRegistry';
import { BoardPeriodProvider } from './BoardPeriodProvider';
import { BoardPeriodPicker } from './BoardPeriodPicker';
import {
  WidgetDataBatchContext,
  widgetBatchKey,
  type WidgetDataBatch,
} from './widgets/widget-data-batch-context';

const ResponsiveGrid = WidthProvider(Responsive);

interface DashboardWidget {
  id: string;
  widgetType: string;
  title: string;
  config: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
}

interface DashboardCanvasProps {
  boardId: string;
  viewId: string;
  canEdit: boolean;
  /**
   * Task 13 fix round 1: forwarded to every widget so a non-admin does not
   * see the intelligence-console drill-through affordance (row/point click)
   * on a widget that has one. Same `isOrganizationAdmin` signal threaded
   * through `BoardPageContent` — see that component's `isAdmin` prop doc.
   */
  isAdmin: boolean;
}

// Column counts per breakpoint. Only `lg` matches the 12-column geometry a
// widget's stored layout is written in — see persistLayout.
const BREAKPOINTS = { lg: 1200, md: 996, sm: 768 } as const;
const COLS = { lg: 12, md: 8, sm: 4 } as const;
const DESKTOP_BREAKPOINT = 'lg';

export default function DashboardCanvas({ boardId, viewId, canEdit, isAdmin }: DashboardCanvasProps) {
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  // WidthProvider renders at 1280px before it measures, so lg is the correct
  // starting assumption; react-grid-layout reports every later change.
  const [breakpoint, setBreakpoint] = useState<string>(DESKTOP_BREAKPOINT);
  const canArrange = canEdit && breakpoint === DESKTOP_BREAKPOINT;

  const loadWidgets = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchWidgets(boardId, viewId);
      setWidgets(data);
    } finally {
      setIsLoading(false);
    }
  }, [boardId, viewId]);

  useEffect(() => {
    loadWidgets();
  }, [loadWidgets]);

  // One batch request for every widget's data, replacing N per-widget server
  // actions (which Next.js serializes). The dashboard fetches once and hands
  // each widget its slice via WidgetDataBatchContext.
  const [batch, setBatch] = useState<WidgetDataBatch>({
    status: 'loading',
    entries: new Map(),
  });

  // Depend on widget *types + configs*, not the widgets array identity: a
  // layout drag replaces the array (same content → identical string → the
  // effect below does not refire) but must not re-trigger the data batch. We
  // read the live widget list through a ref so the effect need not list
  // `widgets` as a dependency (which would refire on every layout change).
  const batchInputKey = useMemo(
    () => JSON.stringify(widgets.map((w) => [w.widgetType, w.config])),
    [widgets]
  );
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const batchRef = useRef(batch);
  batchRef.current = batch;
  // Which (board, view) the entries currently in batchRef were fetched FOR.
  // `widgetBatchKey` is `${widgetType}:${JSON.stringify(config)}` with no board
  // in it, so keys collide across boards trivially — two boards each holding a
  // TOTAL_COUNT with an empty config produce one key for two different numbers.
  // Without this the guard below could serve another board's data, silently and
  // with no request to contradict it.
  const batchIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    const current = widgetsRef.current;
    if (current.length === 0) {
      setBatch({ status: 'ready', entries: new Map() });
      return;
    }

    // De-duplicate: two widgets of the same type+config share one result.
    const seen = new Set<string>();
    const items = current
      .filter((w) => {
        const k = widgetBatchKey(w.widgetType, w.config);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((w) => ({ widgetType: w.widgetType, config: w.config }));

    // Removing a widget only ever SHRINKS this key set, and results fetched for
    // THIS board and view stay valid — so refetching would flash every surviving
    // widget back to its loading state for nothing. Skip only when the entries in
    // hand were fetched for this same identity and cover every key still needed;
    // a board or view change falls through to a real fetch as it always did.
    const identity = `${boardId}:${viewId}`;
    const resolved = batchRef.current;
    if (
      batchIdentityRef.current === identity &&
      resolved.status === 'ready' &&
      items.every((item) => resolved.entries.has(widgetBatchKey(item.widgetType, item.config)))
    ) {
      return;
    }

    let cancelled = false;
    setBatch({ status: 'loading', entries: new Map() });

    fetchWidgetDataBatch(boardId, items)
      .then((res) => {
        if (cancelled) return;
        const entries = new Map(
          res.results.map((r) => [
            widgetBatchKey(r.widgetType, r.config),
            { data: r.data, error: r.error },
          ])
        );
        // Stamp BEFORE setBatch, deliberately: the ref pair may only ever read
        // "identity at least as new as the entries", which degrades to a
        // spurious refetch. The reverse order can serve another board's data.
        batchIdentityRef.current = identity;
        setBatch({ status: 'ready', entries });
      })
      .catch(() => {
        // Batch endpoint unavailable → mark ready with no entries so each
        // widget falls back to its own per-widget fetch (previous behaviour).
        if (cancelled) return;
        batchIdentityRef.current = identity;
        setBatch({ status: 'ready', entries: new Map() });
      });

    return () => {
      cancelled = true;
    };
  }, [boardId, viewId, batchInputKey]);

  const layouts: Layout = widgets.map((w) => ({
    i: w.id,
    x: w.layout.x,
    y: w.layout.y,
    w: w.layout.w,
    h: w.layout.h,
    minW: 2,
    minH: 2,
  }));

  // A widget stores ONE layout, and it is expressed in lg's 12 columns. Below
  // lg, react-grid-layout re-flows that layout itself (correctBounds + compact
  // against 8 or 4 columns) and reports the result through onLayoutChange, which
  // is indistinguishable from a user edit. Persisting it overwrote the desktop
  // layout with narrow-screen coordinates, so on the next wide render widgets
  // came back squashed into the left of the grid. Persist real drag/resize
  // gestures only, and only while the grid is actually showing 12 columns.
  const persistLayout = useCallback(
    (newLayout: Layout) => {
      if (!canEdit) return;
      const changed = (newLayout as readonly LayoutItem[])
        .filter((item) => {
          const widget = widgets.find((w) => w.id === item.i);
          if (!widget) return false;
          return (
            widget.layout.x !== item.x ||
            widget.layout.y !== item.y ||
            widget.layout.w !== item.w ||
            widget.layout.h !== item.h
          );
        })
        .map((item) => ({
          id: item.i,
          layout: { x: item.x, y: item.y, w: item.w, h: item.h },
        }));

      if (changed.length === 0) return;

      startTransition(async () => {
        await updateWidgetLayouts(boardId, viewId, changed);
        setWidgets((prev) =>
          prev.map((w) => {
            const update = changed.find((c) => c.id === w.id);
            return update ? { ...w, layout: update.layout } : w;
          })
        );
      });
    },
    [boardId, viewId, canEdit, widgets]
  );

  const handleRemoved = useCallback((widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  }, []);

  const handleGestureStop = useCallback(
    (newLayout: Layout) => {
      if (!canArrange) return;
      persistLayout(newLayout);
    },
    [canArrange, persistLayout]
  );

  const showPeriodPicker = widgets.some(
    (w) => widgetRegistry[w.widgetType]?.timeAware === true,
  );

  if (isLoading) {
    return (
      <BoardPeriodProvider>
        <div
          className="flex flex-col items-center justify-center py-24 text-slate-400"
          role="status"
          aria-live="polite"
        >
          <svg
            className="w-10 h-10 mb-4 animate-spin text-teal-500"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth={4}
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p className="text-sm font-medium">Loading intelligence…</p>
        </div>
      </BoardPeriodProvider>
    );
  }

  if (widgets.length === 0 && !isPending) {
    return (
      <BoardPeriodProvider>
        <div className="flex flex-col items-center justify-center py-24 text-slate-400">
          <svg
            className="w-16 h-16 mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"
            />
          </svg>
          <p className="text-lg font-medium mb-2">No widgets yet</p>
          {canEdit && (
            <button
              className="mt-2 px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium hover:bg-indigo-600 transition-colors"
              onClick={() => setShowPicker(true)}
            >
              Add your first widget
            </button>
          )}
          {showPicker && (
            <WidgetPicker
              boardId={boardId}
              viewId={viewId}
              onClose={() => setShowPicker(false)}
              onAdded={loadWidgets}
            />
          )}
        </div>
      </BoardPeriodProvider>
    );
  }

  return (
    <BoardPeriodProvider>
      <WidgetDataBatchContext.Provider value={batch}>
      <div className="p-4">
        <div className="flex items-center justify-end gap-2 mb-3">
          {canEdit && !canArrange && (
            <p className="mr-auto text-xs text-slate-400">
              Rearranging widgets is available on a wider screen.
            </p>
          )}
          {showPeriodPicker && <BoardPeriodPicker />}
          {canEdit && (
            <button
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
              onClick={() => setShowPicker(true)}
            >
              + Add Widget
            </button>
          )}
        </div>

      <ResponsiveGrid
        className="layout"
        layouts={{ lg: layouts }}
        breakpoints={BREAKPOINTS}
        cols={COLS}
        rowHeight={80}
        isDraggable={canArrange}
        isResizable={canArrange}
        onBreakpointChange={setBreakpoint}
        onDragStop={handleGestureStop}
        onResizeStop={handleGestureStop}
      >
        {widgets.map((widget) => {
          const WidgetComponent = widgetRegistry[widget.widgetType]?.component;
          return (
            <div key={widget.id}>
              <WidgetCard
                boardId={boardId}
                viewId={viewId}
                widgetId={widget.id}
                widgetType={widget.widgetType}
                title={widget.title}
                canEdit={canEdit}
                onRemoved={() => handleRemoved(widget.id)}
              >
                {WidgetComponent ? (
                  <WidgetComponent
                    boardId={boardId}
                    config={widget.config}
                    canEdit={canEdit}
                    isAdmin={isAdmin}
                  />
                ) : (
                  <p className="text-sm text-slate-400">Unknown widget type</p>
                )}
              </WidgetCard>
            </div>
          );
        })}
      </ResponsiveGrid>

      {showPicker && (
        <WidgetPicker
          boardId={boardId}
          viewId={viewId}
          onClose={() => setShowPicker(false)}
          onAdded={loadWidgets}
        />
      )}
    </div>
      </WidgetDataBatchContext.Provider>
    </BoardPeriodProvider>
  );
}
