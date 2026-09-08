'use client';
import { useWidgetConfigWithBoardPeriod } from '../../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from '../useWidgetData';
import { WidgetErrorState } from '../WidgetErrorState';
import { WidgetEmptyState } from '../WidgetEmptyState';
import {
  FocusNoData,
  StatTile,
  WidgetLoading,
  sumClasses,
  type FocusClassKey,
} from './focus-ui';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface RoadmapShare {
  shares: Record<FocusClassKey, number>;
  days: Record<FocusClassKey, number>;
  parkedDays: number;
  unclassified: number;
  total: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusRoadmapShareWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<RoadmapShare>(boardId, 'FOCUS_ROADMAP_SHARE', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  // Every class, because `shares` is computed server-side over every class. A
  // three-term total here printed "14% of attention went to roadmap" above
  // "133 of 779 attention-days" — 133/779 is 17%, so the headline contradicted
  // its own caveat, on the very widget this branch exists to fix.
  const total = sumClasses(data.days);

  // Most of the window unclassified means this percentage has no denominator
  // worth printing. Showing a confident red 0% instead — which is what happens
  // with no advisor model configured and no curated epic set — is the failure
  // the design's degradation rule exists to prevent.
  if (data.total > 0 && data.unclassified > data.total / 2) {
    return (
      <div className="flex flex-col justify-center h-full">
        <p className="text-sm text-slate-600">
          <b className="text-slate-800">
            {data.unclassified} of {data.total}
          </b>{' '}
          tasks are unclassified, so a roadmap share would be misleading.
        </p>
        <p className="text-xs text-slate-400 mt-2">
          Configure an advisor model for this organisation to classify them.
        </p>
      </div>
    );
  }

  if (total === 0) return <FocusNoData {...data} />;

  return (
    <StatTile
      value={`${data.shares.A}%`}
      label="of attention went to roadmap work"
      // Counting parked tasks would raise this figure with days during which
      // nothing happened, so the qualifier travels with the number.
      caveat={`${data.days.A} of ${total} attention-days · moved tasks only${
        data.parkedDays > 0 ? ` · ${data.parkedDays} parked days excluded` : ''
      }${data.unclassified > 0 ? ` · ${data.unclassified} unclassified` : ''}`}
      tone={data.shares.A >= 40 ? 'good' : 'bad'}
    />
  );
}

interface ShippedRatio {
  total: number;
  inProduction: number;
  unshipped: number;
  pct: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusShippedRatioWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<ShippedRatio>(boardId, 'FOCUS_SHIPPED_RATIO', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.total === 0) return <FocusNoData {...data} />;

  return (
    <StatTile
      value={`${data.pct}%`}
      label="of the work they touched shipped"
      // FEATURES, not tasks. This tile switched to `featureTaskCount` when the
      // funnel did, and it sits at y:0 in the Team Focus preset immediately
      // beside FOCUS_NEVER_MOVED, which says "tasks" and means issues. Two
      // adjacent top-row tiles labelled identically over different populations
      // is worse than an unlabelled one — it is affirmatively wrong, and the
      // `Two grains` caveat that reconciles them sits far below the fold.
      caveat={`${data.inProduction} of ${data.total} features · ${data.unshipped} merged but unshipped`}
      tone={data.pct >= 40 ? 'good' : 'bad'}
    />
  );
}

interface NeverMoved {
  neverMoved: number;
  total: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusNeverMovedWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<NeverMoved>(boardId, 'FOCUS_NEVER_MOVED', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;
  if (data.total === 0) return <FocusNoData {...data} />;

  return (
    <StatTile
      value={`${data.neverMoved} / ${data.total}`}
      label="tasks with no state change at all"
      caveat="A task can hold attention days without anyone touching it."
      tone={data.neverMoved > data.total / 4 ? 'bad' : 'neutral'}
    />
  );
}

interface EpicCoverage {
  epics: { key: string; title: string; touched: boolean; tasks: number }[];
  touched: number;
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

export function FocusEpicCoverageWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<EpicCoverage>(boardId, 'FOCUS_EPIC_COVERAGE', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  if (data.epics.length === 0) {
    // Not a zero: with no epic marked CAPEX there is no denominator, and showing
    // "0 / 0" would imply the team touched no roadmap rather than that nobody has
    // said which epics ARE the roadmap.
    //
    // The remedy is named because it exists. This message used to end "Curating
    // the set is not yet possible from the UI", which was true of the old
    // `FocusEpic` table — one reader, no writer — and is now false twice over:
    // there is no curated set, and marking an epic CAPEX is an ordinary board
    // edit (R6.10).
    return (
      <p className="text-sm text-slate-500">
        No epic on this board is marked CAPEX, so roadmap coverage has no
        denominator. Mark the epics that make up your roadmap as CAPEX on the
        board and they will appear here.
      </p>
    );
  }

  return (
    <StatTile
      value={`${data.touched} / ${data.epics.length}`}
      label="roadmap epics received any work"
      caveat={`${data.epics.length - data.touched} received nothing at all`}
      tone={data.touched > data.epics.length / 2 ? 'good' : 'warn'}
    />
  );
}
