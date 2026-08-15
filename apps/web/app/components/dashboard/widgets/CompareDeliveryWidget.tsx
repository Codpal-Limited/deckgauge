'use client';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import { AnnotationLayer, type AnnotationEvent } from '../charts/AnnotationLayer';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import {
  CompareScorecardTable,
  boardColor,
  fmtNum,
  type ComparabilityFlag,
  type ScorecardRow,
} from './comparison-shared';

interface Props {
  boardId: string; // carries the comparison id
  config: Record<string, unknown>;
}

interface SeriesPoint {
  period: string;
  delivered: number;
  sample: number;
}

interface Board {
  boardId: string;
  boardName: string;
  effectiveDevHeadcount: number | null;
  series: SeriesPoint[];
  peak: { period: string; value: number } | null;
}

interface Data {
  boards: Board[];
  events: AnnotationEvent[];
  comparability: {
    delivered: ComparabilityFlag;
  };
}

// Merge every board's series into wide rows keyed by period so recharts can
// draw one Line per board over a shared categorical x-axis.
function mergeRows(boards: Board[]): {
  rows: Array<Record<string, string | number>>;
  periods: string[];
} {
  const periods = Array.from(
    new Set(boards.flatMap((b) => b.series.map((s) => s.period)))
  ).sort();
  const rows = periods.map((period) => {
    const row: Record<string, string | number> = { period };
    for (const b of boards) {
      const pt = b.series.find((s) => s.period === period);
      row[b.boardName] = pt ? pt.delivered : 0;
    }
    return row;
  });
  return { rows, periods };
}

export default function CompareDeliveryWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'COMPARE_DELIVERY', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.boards.length === 0)
    return (
      <p className="text-sm text-slate-500 p-2">Add boards to compare using the board picker.</p>
    );

  const { boards, events, comparability } = data;
  const { rows: chartRows, periods } = mergeRows(boards);
  const columns = boards.map((b) => ({ boardId: b.boardId, boardName: b.boardName }));

  const summaryRows: ScorecardRow[] = [
    {
      key: 'delivered',
      label: 'Items delivered (total)',
      direction: 'higher_is_better',
      flag: comparability.delivered,
      cells: boards.map((b) => fmtNum(b.series.reduce((n, s) => n + s.delivered, 0))),
    },
  ];

  return (
    <div className="flex flex-col h-full w-full gap-3">
      <div className="flex-1 min-h-0">
        {periods.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chartRows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="period" tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                label={{ value: 'delivered', angle: -90, position: 'insideLeft', fontSize: 11 }}
              />
              <Tooltip {...CHART_TOOLTIP} />
              <Legend />
              {/* Shared freeze/calendar overlay across all boards' series. */}
              <AnnotationLayer events={events} peak={null} periods={periods} />
              {boards.map((b, i) => (
                <Line
                  key={b.boardId}
                  type="monotone"
                  dataKey={b.boardName}
                  stroke={boardColor(i)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-400 px-1">No delivered items in the selected period.</p>
        )}
      </div>
      <div className="shrink-0">
        <CompareScorecardTable columns={columns} rows={summaryRows} />
      </div>
    </div>
  );
}
