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

interface Data {
  summary: {
    bot_pct: number;
    human_p50_hours: number;
    bot_p50_hours: number;
    comment_bot_pct: number;
    comment_bot_count: number;
    comment_human_count: number;
  };
  weeks: Array<{ week_start: string; bot_pct: number }>;
  emptyReason?: string;
}

function formatHours(h: number): string {
  if (!Number.isFinite(h) || h === 0) return '—';
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

export default function ReviewMixWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'REVIEW_MIX', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  const { summary, weeks } = data;
  const hasWeeklyData = weeks.length > 0;

  return (
    <div className="flex flex-col h-full w-full gap-2">
      <div className="grid grid-cols-4 gap-2 px-1">
        <KpiTile label="Bot review share" value={`${Math.round(summary.bot_pct)}%`} accent="bot" />
        <KpiTile
          label="Bot comment share"
          value={`${Math.round(summary.comment_bot_pct)}%`}
          accent="bot"
          sub={`${summary.comment_bot_count.toLocaleString()} / ${(
            summary.comment_bot_count + summary.comment_human_count
          ).toLocaleString()}`}
        />
        <KpiTile label="Human p50 pickup" value={formatHours(summary.human_p50_hours)} />
        <KpiTile label="Bot p50 pickup" value={formatHours(summary.bot_p50_hours)} accent="bot" />
      </div>
      <div className="flex-1 min-h-0">
        {hasWeeklyData ? (
          <TrendLineChart
            series={[
              {
                name: 'bot share %',
                points: weeks.map((w) => ({ x: w.week_start, y: w.bot_pct })),
                color: '#7c3aed',
              },
            ]}
            yAxisLabel="bot %"
          />
        ) : (
          <p className="text-xs text-slate-400 px-1">No reviews in the selected period.</p>
        )}
      </div>
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: string;
  accent?: 'bot';
  sub?: string;
}

function KpiTile({ label, value, accent, sub }: KpiTileProps) {
  const valueClass =
    accent === 'bot'
      ? 'text-violet-700 dark:text-violet-300'
      : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="flex flex-col items-center justify-center rounded border border-slate-200 dark:border-slate-700 py-1 px-2">
      <span className={`text-xl font-semibold tabular-nums ${valueClass}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      {sub && <span className="text-[10px] tabular-nums text-slate-400">{sub}</span>}
    </div>
  );
}
