'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { BENCHMARKS_V1, type Tier } from '@deckgauge/shared';
import { ScatterChart } from '../charts/ScatterChart';
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
  points: Array<{
    x: string;
    y: number;
    label: string;
    href: string;
    tier: Tier;
    author?: string;
  }>;
  emptyReason?: string;
}

export default function PrCycleTimeScatterWidget({ boardId, config }: Props) {
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
      onPointClick={(p) => {
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
      }}
    />
  );
}
