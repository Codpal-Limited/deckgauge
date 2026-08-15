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
  current_pct: number;
  trend: number[];
  emptyReason?: string;
}

export default function AiAssistedPrPctWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'AI_ASSISTED_PR_PCT', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1">
      <p className="text-3xl font-semibold text-indigo-700 tabular-nums">
        {Math.round(data.current_pct)}%
      </p>
      <SparklineCell points={data.trend} width={120} height={28} />
      <p className="text-xs text-slate-500">of merged PRs flagged AI-assisted</p>
    </div>
  );
}
