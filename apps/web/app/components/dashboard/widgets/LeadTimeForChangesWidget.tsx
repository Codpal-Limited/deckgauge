'use client';
import { BENCHMARKS_V1, type LeadTimeSource, type Tier } from '@deckgauge/shared';
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
  weeks: Array<{ week_start: string; p50_hours: number; tier: Tier }>;
  leadTimeSource?: LeadTimeSource;
  emptyReason?: string;
}

// Says where the line ENDS. Stopping at merge leaves out the release queue, so a
// merge-measured line reads shorter than DORA's definition; the reader needs to
// know which one they are looking at before comparing it with anything.
const ENDPOINT_CAPTION: Record<LeadTimeSource, string> = {
  deployments: 'PR opened → production deploy',
  merge_proxy:
    'PR opened → merge (no production deploys recorded, so release wait is not included)',
  mixed: 'PR opened → production deploy where the repository records deploys, merge elsewhere',
};

export default function LeadTimeForChangesWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'LEAD_TIME_FOR_CHANGES', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <div>
      <p className="px-1 pb-1 text-[11px] text-slate-500">
        {ENDPOINT_CAPTION[data.leadTimeSource ?? 'merge_proxy']}
      </p>
      <TrendLineChart
        series={[
          {
            name: 'p50 hours',
            points: data.weeks.map((w) => ({ x: w.week_start, y: w.p50_hours })),
          },
        ]}
        yAxisLabel="hours"
        benchmarks={BENCHMARKS_V1.LEAD_TIME_FOR_CHANGES}
      />
    </div>
  );
}
