import { listOrgTrees } from '../../actions/org-trees';
import { fetchCapexReportForTree } from '../../actions/timesheet';
import { resolveWindow } from '../lib/timesheet-ui';
import { ReportView } from '../components/ReportView';
import { TimesheetTabs } from '../components/TimesheetTabs';

export default async function TimesheetReportPage() {
  const trees = await listOrgTrees();
  const orgTrees = trees.map((t) => ({ id: t.id, name: t.name }));
  const initialOrgTreeId = orgTrees[0]?.id ?? '';
  const anchorIso = new Date().toISOString();
  const w = resolveWindow(anchorIso, 'month');

  // See timesheet/page.tsx's identical comment: a 403 must reach ReportView as
  // `initialForbidden` and a 401 as `initialUnauthenticated`, not collapse
  // into the same `initialReport: null` a real fetch failure produces — nor
  // into each other, since their remedies differ.
  const capexResult = initialOrgTreeId
    ? await fetchCapexReportForTree({
        orgTreeId: initialOrgTreeId,
        from: w.from,
        to: w.to,
        granularity: w.granularity,
        mode: 'normalized',
      })
    : null;
  const initialReport = capexResult?.ok ? capexResult.data : null;
  const initialForbidden = capexResult != null && !capexResult.ok && capexResult.reason === 'forbidden';
  const initialUnauthenticated =
    capexResult != null && !capexResult.ok && capexResult.reason === 'unauthenticated';

  return (
    <main className="mx-auto max-w-7xl p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold text-slate-800">Timesheet</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          CapEx / OpEx time allocation across the org, by engineer and period.
        </p>
      </header>
      <TimesheetTabs />
      {orgTrees.length === 0 ? (
        <p className="text-sm text-slate-500">
          No org tree found. Import one under Org Trees to populate the report.
        </p>
      ) : (
        <ReportView
          orgTrees={orgTrees}
          initialReport={initialReport}
          initialOrgTreeId={initialOrgTreeId}
          anchorIso={anchorIso}
          initialForbidden={initialForbidden}
          initialUnauthenticated={initialUnauthenticated}
        />
      )}
    </main>
  );
}
