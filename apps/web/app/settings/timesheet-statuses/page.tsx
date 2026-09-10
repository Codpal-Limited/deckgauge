import Link from 'next/link';
import { listOrgTrees } from '../../actions/org-trees';
import { fetchOrgTreeTimesheetConfig } from '../../actions/org-tree-timesheet';
import { DailyCapForm } from './DailyCapForm';

export const dynamic = 'force-dynamic';

export default async function TimesheetStatusesPage(props: {
  searchParams: Promise<{ tree?: string }>;
}) {
  const searchParams = await props.searchParams;
  const trees = await listOrgTrees();
  const selectedTree = trees.find((t) => t.id === searchParams.tree) ?? trees[0] ?? null;

  if (!selectedTree) {
    return <p className="text-sm text-slate-500">No org trees found. Create one first.</p>;
  }

  // Only the cap now. Deciding which statuses count as work moved to the Time
  // rules drawer on the Timesheet page, where the numbers it changes are on
  // screen while you change them — and where it can no longer disagree with the
  // bucket map, because the drawer's save DERIVES the counted list rather than
  // taking one typed in here.
  const config = await fetchOrgTreeTimesheetConfig(selectedTree.id);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {trees.map((t) => (
          <Link
            key={t.id}
            href={`/settings/timesheet-statuses?tree=${t.id}`}
            className={`rounded px-3 py-1 text-sm ${
              t.id === selectedTree.id
                ? 'bg-indigo-500 text-white'
                : 'border border-slate-200 text-slate-600'
            }`}
          >
            {t.name}
          </Link>
        ))}
      </div>

      <DailyCapForm
        key={selectedTree.id}
        orgTreeId={selectedTree.id}
        initialDailyCapHours={config?.dailyCapHours ?? null}
        configured={config !== null}
      />

      <p className="border-t border-slate-100 pt-4 text-sm text-slate-500">
        Deciding what each status means now lives on the{' '}
        <Link href="/timesheet" className="text-indigo-600 underline">
          Timesheet
        </Link>{' '}
        page — open <span className="font-medium text-slate-700">Time rules</span> there.
      </p>
    </div>
  );
}
