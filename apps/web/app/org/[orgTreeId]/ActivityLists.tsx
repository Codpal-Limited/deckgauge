'use client';

import type { ActivityItem, EmployeeActivity } from '../../actions/org-trees';

function ActivityEntry({ item }: { item: ActivityItem }) {
  const date = item.timestamp.slice(0, 10);

  return (
    <li className="border-t border-slate-100 px-3 py-2 first:border-t-0 hover:bg-slate-50">
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="block break-words text-sm text-indigo-600 hover:underline"
        >
          {item.title}
        </a>
      ) : (
        <span className="block break-words text-sm text-slate-700">{item.title}</span>
      )}
      <p className="mt-0.5 break-words text-xs text-slate-400">
        {item.subtitle ? (
          <>
            <span>{item.subtitle}</span>
            <span className="px-1" aria-hidden="true">
              &middot;
            </span>
          </>
        ) : null}
        <span>{date}</span>
      </p>
    </li>
  );
}

function ActivitySection({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: ActivityItem[];
  emptyText: string;
}) {
  return (
    <section className="mb-5">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">{emptyText}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-slate-200">
          {items.map((it) => (
            <ActivityEntry key={`${title}-${it.id}`} item={it} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ActivityLists({ activity }: { activity: EmployeeActivity }) {
  return (
    <div>
      <ActivitySection title="Pull requests" items={activity.pullRequests} emptyText="No pull requests." />
      <ActivitySection title="Commits" items={activity.commits} emptyText="No commits." />
      <ActivitySection title="Assigned issues" items={activity.assignedIssues} emptyText="No assigned issues." />
    </div>
  );
}
