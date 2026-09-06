import Link from 'next/link';
import { listOrgTrees } from '../../actions/org-trees';
import {
  fetchOrgTreeStatusPool,
  fetchOrgTreeTimesheetConfig,
} from '../../actions/org-tree-timesheet';
import { ActiveStatusPicker } from './ActiveStatusPicker';

export const dynamic = 'force-dynamic';

export default async function TimesheetStatusesPage(
  props: {
    searchParams: Promise<{ tree?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const trees = await listOrgTrees();
  const selectedTree = trees.find((t) => t.id === searchParams.tree) ?? trees[0] ?? null;

  if (!selectedTree) {
    return <p className="text-sm text-slate-500">No org trees found. Create one first.</p>;
  }

  const [pool, config] = await Promise.all([
    fetchOrgTreeStatusPool(selectedTree.id),
    fetchOrgTreeTimesheetConfig(selectedTree.id),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        Pick the statuses that mean active work for this org tree. The timesheet will show and count
        only time spent in these statuses; everything else (Blocked, Code Review, …) is hidden.
      </p>

      <div className="flex flex-wrap gap-2">
        {trees.map((t) => (
          <Link
            key={t.id}
            href={`/settings/timesheet-statuses?tree=${t.id}`}
            className={`rounded px-3 py-1 text-sm ${
              t.id === selectedTree.id ? 'bg-indigo-500 text-white' : 'border border-slate-200 text-slate-600'
            }`}
          >
            {t.name}
          </Link>
        ))}
      </div>

      <ActiveStatusPicker
        key={selectedTree.id}
        orgTreeId={selectedTree.id}
        pool={pool}
        initialSelected={config?.activeStatuses ?? []}
        initialDailyCapHours={config?.dailyCapHours ?? null}
      />
    </div>
  );
}
