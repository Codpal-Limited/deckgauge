'use client';
import { TrendBarChart } from '../charts/TrendBarChart';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  weeks: Array<{ week_start: string; bugs: number; other: number }>;
  emptyReason?: string;
}

export default function BugRateWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'BUG_RATE', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <TrendBarChart
      layout="grouped"
      yAxisLabel="issues"
      series={[
        {
          name: 'Bugs',
          points: data.weeks.map((w) => ({ x: w.week_start, y: w.bugs })),
          color: '#f43f5e',
        },
        {
          name: 'Other',
          points: data.weeks.map((w) => ({ x: w.week_start, y: w.other })),
          color: '#94a3b8',
        },
      ]}
    />
  );
}
