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
    total: number;
    bot_count: number;
    human_count: number;
    bot_pct: number;
  };
  weeks: Array<{ week_start: string; total: number; bot_count: number; human_count: number }>;
  emptyReason?: string;
}

const BOT_COLOR = '#7c3aed';
const HUMAN_COLOR = '#0ea5e9';

export default function BotVsHumanWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'BOT_VS_HUMAN', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  const { summary, weeks } = data;
  const hasWeeklyData = weeks.length > 0;

  return (
    <div className="flex flex-col h-full w-full gap-2">
      <div className="grid grid-cols-3 gap-2 px-1">
        <KpiTile label="Bot share" value={`${Math.round(summary.bot_pct)}%`} accent="bot" />
        <KpiTile label="Bot commits" value={summary.bot_count.toLocaleString()} accent="bot" />
        <KpiTile
          label="Human commits"
          value={summary.human_count.toLocaleString()}
          accent="human"
        />
      </div>
      <div className="flex-1 min-h-0">
        {hasWeeklyData ? (
          <TrendLineChart
            series={[
              {
                name: 'bot',
                points: weeks.map((w) => ({ x: w.week_start, y: w.bot_count })),
                color: BOT_COLOR,
              },
              {
                name: 'human',
                points: weeks.map((w) => ({ x: w.week_start, y: w.human_count })),
                color: HUMAN_COLOR,
              },
            ]}
            yAxisLabel="commits"
          />
        ) : (
          <p className="text-xs text-slate-400 px-1">No commits in the selected period.</p>
        )}
      </div>
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: string;
  accent?: 'bot' | 'human';
}

function KpiTile({ label, value, accent }: KpiTileProps) {
  const valueClass =
    accent === 'bot'
      ? 'text-violet-700 dark:text-violet-300'
      : accent === 'human'
        ? 'text-sky-700 dark:text-sky-300'
        : 'text-slate-800 dark:text-slate-100';
  return (
    <div className="flex flex-col items-center justify-center rounded border border-slate-200 dark:border-slate-700 py-1 px-2">
      <span className={`text-xl font-semibold tabular-nums ${valueClass}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}
