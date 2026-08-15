'use client';
import { SparklineCell } from '../charts/SparklineCell';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  current: number;
  trend: number[];
  emptyReason?: string;
}

export default function WipCountWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'WIP_COUNT', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <p className="text-3xl font-semibold text-slate-900 tabular-nums">{data.current}</p>
      <SparklineCell points={data.trend} width={120} height={32} />
      <p className="text-xs text-slate-500 mt-1">items in progress</p>
    </div>
  );
}
