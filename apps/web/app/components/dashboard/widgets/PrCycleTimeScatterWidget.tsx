'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { BENCHMARKS_V1 } from '@deckgauge/shared';
import { ScatterChart } from '../charts/ScatterChart';
import type { ScatterPoint } from '../charts/ScatterPointTooltip';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { openIntelligenceConsole } from '../openIntelligenceConsole';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
  // Task 13: the drill-through below opens the intelligence SQL console,
  // which the API gates at ADMIN.
  //
  // Unlike the other three drill-through widgets, a non-admin here gets a
  // NO-OP function rather than `undefined` (fix round 2) — ScatterChart has
  // no `onPointClick`-conditional cursor styling to lose either way (its only
  // `cursor` is Recharts' unrelated tooltip crosshair), but
  // `handleScatterPointClick` in ../charts/ScatterChart.tsx falls back to
  // `window.open(point.href, '_blank')` when `onPointClick` is undefined —
  // legacy behaviour for callers with no drill handler at all. This widget's
  // `href` is a documented API placeholder (`'#' + id`, see
  // pr-cycle-time-scatter.ts), so `undefined` here silently opened a blank
  // tab at a meaningless fragment for a non-admin instead of doing nothing.
  isAdmin?: boolean;
}

interface Data {
  // The point shape is the chart's, not this widget's — a local copy silently
  // drops any field the API starts sending (it dropped `subtitle` on the way in).
  points: ScatterPoint[];
  emptyReason?: string;
}

export default function PrCycleTimeScatterWidget({ boardId, config, isAdmin }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const router = useRouter();
  const search = useSearchParams();
  const { data, error } = useWidgetData<Data>(boardId, 'PR_CYCLE_TIME_SCATTER', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <ScatterChart
      points={data.points}
      xAxisLabel="merged"
      yAxisLabel="cycle hours"
      benchmarks={BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES}
      onPointClick={
        isAdmin
          ? (p) => {
              if (!p.author) return;
              openIntelligenceConsole(
                router,
                boardId,
                {
                  widgetType: 'PR_CYCLE_TIME_SCATTER',
                  config: merged,
                  filter: { dimension: 'author', value: p.author },
                },
                search?.toString() ?? ''
              );
            }
          : // A real no-op, not `undefined` — see the Props doc above. Passing
            // `undefined` here would activate ScatterChart's legacy
            // `window.open(point.href, ...)` fallback instead of doing
            // nothing.
            () => {}
      }
    />
  );
}
