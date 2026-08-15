'use client';

import Link from 'next/link';
import { PanelEmptyState } from './PanelEmptyState';

interface OrgTreeItem {
  id: string;
  name: string;
}

interface OrgTreesPanelProps {
  orgTrees: OrgTreeItem[];
  activePath: string | null;
}

export function OrgTreesPanel({ orgTrees, activePath }: OrgTreesPanelProps) {
  if (orgTrees.length === 0) {
    return (
      <PanelEmptyState message="No org trees have been shared with you yet. Ask an owner to share one, or create a new one with the New button below." />
    );
  }

  return (
    <>
      {orgTrees.map((ot) => {
        const href = `/org/${ot.id}`;
        const active = activePath === href;
        return (
          <Link
            key={ot.id}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition ${
              active
                ? 'bg-gradient-to-r from-emerald-500 to-emerald-400 font-medium text-white shadow-sm'
                : 'text-slate-700 hover:bg-white hover:shadow-sm'
            }`}
          >
            <span className="text-base" aria-hidden="true">
              🌳
            </span>
            <span className="truncate">{ot.name}</span>
          </Link>
        );
      })}
    </>
  );
}
