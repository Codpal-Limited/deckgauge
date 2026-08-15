'use client';
import { BENCHMARKS_V1, type Tier } from '@deckgauge/shared';
import { SparklineCell } from '../charts/SparklineCell';
import { TierLegend } from '../charts/TierLegend';
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
  tier: Tier;
  emptyReason?: string;
}

const TIER_TEXT: Record<Tier, string> = {
  elite: 'text-emerald-700',
  high: 'text-lime-700',
  medium: 'text-amber-700',
  low: 'text-rose-700',
};

export default function TicketCoverageRateWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'TICKET_COVERAGE_RATE', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div className="flex flex-col items-center justify-center h-full gap-1">
      <p className={`text-3xl font-semibold tabular-nums ${TIER_TEXT[data.tier]}`}>
        {Math.round(data.current_pct)}%
      </p>
      <SparklineCell points={data.trend} width={120} height={28} />
      <TierLegend config={BENCHMARKS_V1.TICKET_COVERAGE_RATE!} currentValue={data.current_pct} />
    </div>
  );
}
