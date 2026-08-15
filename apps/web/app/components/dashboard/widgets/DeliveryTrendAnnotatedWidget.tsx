'use client';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { CHART_TOOLTIP } from '../charts/chartTheme';
import {
  AnnotationLayer,
  type AnnotationEvent,
  type AnnotationPeak,
} from '../charts/AnnotationLayer';
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
  sample: number;
}

interface Data {
  series: SeriesPoint[];
  peak: AnnotationPeak | null;
  events: AnnotationEvent[];
  emptyReason?: string;
}

// Custom composed chart (not the shared TrendLineChart) so calendar-event
// bands + the peak marker can be layered in without changing a component
// several other widgets already depend on.
export default function DeliveryTrendAnnotatedWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'DELIVERY_TREND_ANNOTATED', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.series.length === 0)
    return (
      <p className="text-xs text-slate-400 px-1">No delivered items in the selected period.</p>
    );

  return (
    <div className="h-full w-full flex flex-col">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data.series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="period" tick={{ fontSize: 11 }} />
          <YAxis
            tick={{ fontSize: 11 }}
            label={{ value: 'delivered', angle: -90, position: 'insideLeft', fontSize: 11 }}
          />
          <Tooltip {...CHART_TOOLTIP} />
          <AnnotationLayer
            events={data.events}
            peak={data.peak}
            periods={data.series.map((p) => p.period)}
          />
          <Line type="monotone" dataKey="delivered" stroke="#4f46e5" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
