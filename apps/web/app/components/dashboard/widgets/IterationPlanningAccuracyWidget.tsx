'use client';
import { TrendBarChart } from '../charts/TrendBarChart';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  sprints: Array<{
    iteration_name: string;
    completed: number;
    committed: number;
    accuracy_pct: number;
  }>;
  emptyReason?: string;
}

export default function IterationPlanningAccuracyWidget({ boardId, config }: Props) {
  const { data, error } = useWidgetData<Data>(boardId, 'ITERATION_PLANNING_ACCURACY', config);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <TrendBarChart
      yAxisLabel="%"
      targetLine={{ value: 80, label: 'Target 80%' }}
      series={[
        {
          name: 'Accuracy',
          points: data.sprints.map((s) => ({ x: s.iteration_name, y: s.accuracy_pct })),
          color: '#4f46e5',
        },
      ]}
    />
  );
}
