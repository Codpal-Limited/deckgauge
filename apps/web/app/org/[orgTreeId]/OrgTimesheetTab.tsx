'use client';

import { useEffect, useState } from 'react';
import type { TimesheetGridResponse, CapexReportResponse } from '@deckgauge/shared';
import { fetchTimesheetGridForTree, fetchCapexReportForTree } from '../../actions/timesheet';
import { resolveWindow } from '../../timesheet/lib/timesheet-ui';
import { TimesheetView } from '../../timesheet/components/TimesheetView';
import { ReportView } from '../../timesheet/components/ReportView';

interface OrgTimesheetTabProps {
  treeId: string;
  treeName: string;
  variant: 'grid' | 'report';
}

/**
 * Embeds the timesheet grid or CapEx report as a tab on the org tree page,
 * scoped to a single tree. The heavy initial fetch runs on mount (i.e. only
 * when the tab is opened, since OrgTabs mounts panels lazily), mirroring the
 * self-loading pattern used by the board views.
 */
export function OrgTimesheetTab({ treeId, treeName, variant }: OrgTimesheetTabProps) {
  const [anchorIso] = useState(() => new Date().toISOString());
  const [grid, setGrid] = useState<TimesheetGridResponse | null>(null);
  const [report, setReport] = useState<CapexReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // `/timesheet/grid` and `/timesheet/capex-report` require BOTH the analytics
  // realm role AND VIEWER on this tree. A 403 here can mean either is missing
  // — see fetchTimesheetGridForTree's doc — so the copy below deliberately
  // names only the piece that is always an administrator action (the realm
  // role), never asserting the tree-access half of the cause.
  // A 401 is tracked separately: an expired session and a missing grant send
  // the user to different remedies, so they must not share one flag.
  const [denied, setDenied] = useState<'forbidden' | 'unauthenticated' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const w = resolveWindow(anchorIso, 'month');
    setLoading(true);
    setDenied(null);
    const request =
      variant === 'grid'
        ? fetchTimesheetGridForTree({
            orgTreeId: treeId,
            from: w.from,
            to: w.to,
            granularity: w.granularity,
            mode: 'normalized',
          }).then((res) => {
            if (cancelled) return;
            if (res.ok) setGrid(res.data);
            else if (res.reason !== 'unknown') setDenied(res.reason);
          })
        : fetchCapexReportForTree({
            orgTreeId: treeId,
            from: w.from,
            to: w.to,
            granularity: w.granularity,
            mode: 'normalized',
          }).then((res) => {
            if (cancelled) return;
            if (res.ok) setReport(res.data);
            else if (res.reason !== 'unknown') setDenied(res.reason);
          });
    request.finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [treeId, variant, anchorIso]);

  if (loading) {
    return <div className="py-8 text-center text-gray-400">Loading timesheet…</div>;
  }

  if (denied) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        {denied === 'unauthenticated'
          ? 'Your session has expired — sign in again to view this tab.'
          : 'Analytics is limited to accounts with the analytics role.'}
      </div>
    );
  }

  const orgTrees = [{ id: treeId, name: treeName }];

  return variant === 'grid' ? (
    <TimesheetView
      orgTrees={orgTrees}
      initialData={grid}
      initialOrgTreeId={treeId}
      anchorIso={anchorIso}
      hideTreePicker
    />
  ) : (
    <ReportView
      orgTrees={orgTrees}
      initialReport={report}
      initialOrgTreeId={treeId}
      anchorIso={anchorIso}
      hideTreePicker
    />
  );
}
