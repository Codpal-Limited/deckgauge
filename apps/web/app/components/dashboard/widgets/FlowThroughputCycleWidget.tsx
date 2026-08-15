'use client';
import { ComboBarLineChart } from '../charts/ComboBarLineChart';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface SeriesPoint {
  period: string;
  delivered: number;
  cycle_days: number | null;
  sample: number;
  flagged: boolean;
}

interface Data {
  series: SeriesPoint[];
  emptyReason?: string;
}

export default function FlowThroughputCycleWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'FLOW_THROUGHPUT_CYCLE', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <ComboBarLineChart
      points={data.series.map((s) => ({
        label: s.period,
        delivered: s.delivered,
        cycleDays: s.cycle_days,
        flagged: s.flagged,
      }))}
    />
  );
}
