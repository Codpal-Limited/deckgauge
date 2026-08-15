'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import {
  fetchComparisonMembers,
  setComparisonMembers,
  fetchSelectableBoards,
  type BoardSummary,
  type ComparisonMember,
} from '../../actions/comparison';
import { BoardPeriodProvider } from '../dashboard/BoardPeriodProvider';
import { BoardPeriodPicker } from '../dashboard/BoardPeriodPicker';
import { ComparisonBoardPicker } from './ComparisonBoardPicker';
import CompareReviewQualityWidget from '../dashboard/widgets/CompareReviewQualityWidget';
import CompareFlowWidget from '../dashboard/widgets/CompareFlowWidget';
import CompareDeliveryWidget from '../dashboard/widgets/CompareDeliveryWidget';
import WidgetHelpButton from '../dashboard/WidgetHelpButton';

interface Props {
  comparisonId: string; // passed to widgets as their boardId slot; the comparison API dispatches on it
  canEdit: boolean;
}

const COMPARISON_WIDGETS = [
  {
    type: 'COMPARE_REVIEW_QUALITY',
    title: 'Compare: Review Quality',
    Component: CompareReviewQualityWidget,
  },
  { type: 'COMPARE_FLOW', title: 'Compare: Flow', Component: CompareFlowWidget },
  { type: 'COMPARE_DELIVERY', title: 'Compare: Delivery', Component: CompareDeliveryWidget },
] as const;

export default function ComparisonCanvas({ comparisonId, canEdit }: Props) {
  const [members, setMembers] = useState<ComparisonMember[]>([]);
  const [allBoards, setAllBoards] = useState<BoardSummary[]>([]);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const [m, boards] = await Promise.all([
      fetchComparisonMembers(comparisonId),
      fetchSelectableBoards(),
    ]);
    setMembers(m);
    setAllBoards(boards);
  }, [comparisonId]);

  useEffect(() => {
    load();
  }, [load]);

  const persist = useCallback(
    (boardIds: string[]) => {
      startTransition(async () => {
        const next = await setComparisonMembers(comparisonId, boardIds);
        setMembers(next);
      });
    },
    [comparisonId]
  );

  const handleAdd = useCallback(
    (id: string) => persist([...members.map((m) => m.boardId), id]),
    [members, persist]
  );
  const handleRemove = useCallback(
    (id: string) => persist(members.map((m) => m.boardId).filter((b) => b !== id)),
    [members, persist]
  );

  // The comparison widgets take the fixed comparison id as their boardId and
  // read the persisted member set server-side, so neither their boardId nor their
  // config changes when a board is added/removed — leaving useWidgetData with no
  // reason to re-fetch. Key the widgets on the current member set so React remounts
  // (and thus re-fetches) them the moment the set changes, instead of showing stale
  // boards until a page refresh.
  const memberKey = useMemo(() => members.map((m) => m.boardId).join(','), [members]);

  return (
    <BoardPeriodProvider>
      <div className="p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ComparisonBoardPicker
            allBoards={allBoards}
            members={members}
            canEdit={canEdit}
            onAdd={handleAdd}
            onRemove={handleRemove}
            disabled={isPending}
          />
          <BoardPeriodPicker />
        </div>

        {members.length < 2 ? (
          <p className="text-sm text-slate-500 py-8 text-center">
            Add at least two boards to compare.
          </p>
        ) : (
          <div className="space-y-4">
            {COMPARISON_WIDGETS.map(({ type, title, Component }) => (
              <div
                key={title}
                className="flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
                  <h3 className="text-sm font-semibold text-slate-700 truncate">{title}</h3>
                  <WidgetHelpButton widgetType={type} title={title} />
                </div>
                <div className="p-4 overflow-auto min-h-[360px]">
                  {/* The comparison id occupies the widget's boardId slot; the
                      comparison API dispatches on it and fans out per board. */}
                  <Component key={memberKey} boardId={comparisonId} config={{}} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </BoardPeriodProvider>
  );
}
