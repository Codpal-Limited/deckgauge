'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Tier } from '@deckgauge/shared';
import { SortableTable } from '../charts/SortableTable';
import { SparklineCell } from '../charts/SparklineCell';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { openIntelligenceConsole } from '../openIntelligenceConsole';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
  // Task 13 fix round 1: the drill-through below opens the intelligence SQL
  // console, which the API gates at ADMIN. Undefined/false withholds
  // `onRowClick` entirely (not just a no-op) so SortableTable also drops the
  // pointer cursor and hover highlight — a non-admin sees no affordance, not
  // a dead click.
  isAdmin?: boolean;
}

interface Row {
  author: string;
  prs_merged: number;
  avg_per_week: number;
  trend: number[];
  tier: Tier;
}

interface Data {
  rows: Row[];
  emptyReason?: string;
}

const TIER_TEXT: Record<Tier, string> = {
  elite: 'text-emerald-700',
  high: 'text-lime-700',
  medium: 'text-amber-700',
  low: 'text-rose-700',
};

export default function MergeFrequencyPerDevWidget({ boardId, config, isAdmin }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const router = useRouter();
  const search = useSearchParams();
  const { data, error } = useWidgetData<Data>(boardId, 'MERGE_FREQUENCY_PER_DEV', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  return (
    <SortableTable<Row>
      rows={data.rows}
      defaultSortKey="prs_merged"
      onRowClick={
        isAdmin
          ? (r) =>
              openIntelligenceConsole(
                router,
                boardId,
                {
                  widgetType: 'MERGE_FREQUENCY_PER_DEV',
                  config: merged,
                  filter: { dimension: 'author', value: r.author },
                },
                search?.toString() ?? ''
              )
          : undefined
      }
      columns={[
        { key: 'author', label: 'Developer', sortable: true },
        { key: 'prs_merged', label: 'PRs', sortable: true, align: 'right' },
        {
          key: 'avg_per_week',
          label: 'Avg/wk',
          sortable: true,
          align: 'right',
          render: (r) => <span className={TIER_TEXT[r.tier]}>{r.avg_per_week.toFixed(1)}</span>,
        },
        {
          key: 'trend',
          label: 'Trend',
          render: (r) => <SparklineCell points={r.trend} showLast />,
        },
      ]}
    />
  );
}
