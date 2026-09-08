'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { BENCHMARKS_V1, type Tier } from '@deckgauge/shared';
import { TrendLineChart } from '../charts/TrendLineChart';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { openIntelligenceConsole } from '../openIntelligenceConsole';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
  // Task 13 fix round 1: the drill-through below opens the intelligence SQL
  // console, which the API gates at ADMIN. Undefined/false withholds
  // `onPointClick` entirely (not just a no-op) so TrendLineChart also drops
  // the pointer cursor — a non-admin sees no affordance, not a dead click.
  isAdmin?: boolean;
}

interface Data {
  weeks: Array<{ week_start: string; avg_hours: number; tier: Tier }>;
  emptyReason?: string;
}

export default function ReviewPickupTimeWidget({ boardId, config, isAdmin }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const router = useRouter();
  const search = useSearchParams();
  const { data, error } = useWidgetData<Data>(boardId, 'REVIEW_PICKUP_TIME', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <TrendLineChart
      series={[
        {
          name: 'avg hours',
          points: data.weeks.map((w) => ({ x: w.week_start, y: w.avg_hours })),
        },
      ]}
      yAxisLabel="hours"
      benchmarks={BENCHMARKS_V1.REVIEW_PICKUP_TIME}
      onPointClick={
        isAdmin
          ? () =>
              openIntelligenceConsole(
                router,
                boardId,
                { widgetType: 'REVIEW_PICKUP_TIME', config: merged },
                search?.toString() ?? ''
              )
          : undefined
      }
    />
  );
}
