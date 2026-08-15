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
}

interface Data {
  weeks: Array<{ week_start: string; rework_pct: number; tier: Tier }>;
  emptyReason?: string;
}

export default function ReworkRateWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const router = useRouter();
  const search = useSearchParams();
  const { data, error } = useWidgetData<Data>(boardId, 'REWORK_RATE', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <TrendLineChart
      series={[
        {
          name: 'rework %',
          points: data.weeks.map((w) => ({ x: w.week_start, y: w.rework_pct })),
        },
      ]}
      yAxisLabel="%"
      benchmarks={BENCHMARKS_V1.REWORK_RATE}
      onPointClick={() =>
        openIntelligenceConsole(
          router,
          boardId,
          { widgetType: 'REWORK_RATE', config: merged },
          search?.toString() ?? ''
        )
      }
    />
  );
}
