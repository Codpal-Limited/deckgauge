'use client';
import { TrendLineChart } from '../charts/TrendLineChart';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface TrendPoint {
  period: string;
  coverage_pct: number | null;
  comment_pct: number | null;
  sample: number;
}

interface Data {
  trend: TrendPoint[];
  emptyReason?: string;
}

export default function ReviewQualityTrendWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'REVIEW_QUALITY_TREND', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  const { trend } = data;
  const hasTrend = trend.length > 0;

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-1 min-h-0">
        {hasTrend ? (
          <TrendLineChart
            series={[
              {
                name: 'coverage %',
                points: trend.map((t) => ({ x: t.period, y: t.coverage_pct ?? 0 })),
                color: '#10b981',
              },
              {
                name: 'comment %',
                points: trend.map((t) => ({ x: t.period, y: t.comment_pct ?? 0 })),
                color: '#f59e0b',
              },
            ]}
            yAxisLabel="%"
          />
        ) : (
          <p className="text-xs text-slate-400 px-1">No review data in the selected period.</p>
        )}
      </div>
    </div>
  );
}
