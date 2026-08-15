'use client';
import { TrendLineChart } from '../charts/TrendLineChart';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  sprints: Array<{
    sprint_name: string;
    completed: number;
    lower: number;
    upper: number;
  }>;
  emptyReason?: string;
}

export default function VelocityWithConfidenceWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'VELOCITY_WITH_CONFIDENCE', config);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  // Defense in depth: treat an empty sprints array as no_sprint_data even when
  // the backend forgets to set emptyReason. Without this the chart renders
  // axes with no line, which reads as a broken widget.
  if (data.emptyReason || data.sprints.length === 0) {
    return <WidgetEmptyState boardId={boardId} reason={data.emptyReason ?? 'no_sprint_data'} />;
  }
  return (
    <TrendLineChart
      yAxisLabel="issues"
      series={[
        {
          name: 'completed',
          points: data.sprints.map((s) => ({ x: s.sprint_name, y: s.completed })),
        },
      ]}
      confidenceBand={{
        lower: data.sprints.map((s) => s.lower),
        upper: data.sprints.map((s) => s.upper),
      }}
    />
  );
}
