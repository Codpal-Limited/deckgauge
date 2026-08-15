'use client';
import { useWidgetConfigWithBoardPeriod } from '../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from './useWidgetData';
import { WidgetErrorState } from './WidgetErrorState';
import { WidgetEmptyState } from './WidgetEmptyState';
import { ReviewQualityTable } from './ReviewQualityTable';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Data {
  coverage_pct: number | null;
  median_open_h: number | null;
  instant_pct: number | null;
  comment_pct: number | null;
  ticket_pct: number | null;
  merged_prs: number;
  emptyReason?: string;
}

export default function ReviewQualityIndexWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<Data>(boardId, 'REVIEW_QUALITY_INDEX', merged);
  if (error) return <WidgetErrorState />;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  return <ReviewQualityTable metrics={data} />;
}
