'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deleteComparison, renameComparison, type ComparisonSummary } from '../../../actions/comparison';
import { ShareDialog } from '../../sharing/ShareDialog';
import { fetchAccess, fetchMyRole } from '../../../actions/access';
import type { AccessEntry, AccessRoleValue } from '@deckgauge/shared';
import { PanelEmptyState } from './PanelEmptyState';

interface ComparisonsPanelProps {
  comparisons: ComparisonSummary[];
  activePath: string | null;
}

export function ComparisonsPanel({ comparisons, activePath }: ComparisonsPanelProps) {
  /**
   * WHICH comparison the dialog is open for — an id, never a boolean. A sidebar
   * of rows sharing one dialog is exactly where a boolean ends up sharing the
   * wrong entity.
   */
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareRole, setShareRole] = useState<AccessRoleValue | null>(null);
  const [shareUserId, setShareUserId] = useState<string | null>(null);
  const [shareEntries, setShareEntries] = useState<AccessEntry[]>([]);

  async function openShare(c: ComparisonSummary) {
    setMenuId(null);
    setShareId(c.id);
    setShareRole(null);
    setShareEntries([]);
    // Fails closed: if either fetch rejects the dialog opens read-only.
    const [role, access] = await Promise.all([
      fetchMyRole('comparison', c.id),
      fetchAccess('comparison', c.id),
    ]).catch(() => [{ role: null, userId: null }, [] as AccessEntry[]] as const);
    setShareRole(role.role);
    setShareUserId(role.userId);
    setShareEntries(access);
  }
  const router = useRouter();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuId(null);
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuId(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [menuId]);

  const handleRename = (c: ComparisonSummary) => {
    setMenuId(null);
    const name = window.prompt('Rename comparison', c.name);
    if (name && name.trim() && name.trim() !== c.name) {
      startTransition(async () => {
        await renameComparison(c.id, name.trim());
        router.refresh();
      });
    }
  };

  const handleDelete = (c: ComparisonSummary) => {
    setMenuId(null);
    if (!window.confirm(`Delete comparison "${c.name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      await deleteComparison(c.id);
      // Leave the deleted comparison's page if we're on it.
      if (activePath === `/comparison/${c.id}`) router.push('/');
      else router.refresh();
    });
  };

  if (comparisons.length === 0) {
    return (
      <PanelEmptyState message="No comparisons yet. Create one with the New button below." />
    );
  }

  return (
    <>
      {comparisons.map((c) => {
        const href = `/comparison/${c.id}`;
        const active = activePath === href;
        return (
          <div key={c.id} className="group relative">
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 pr-8 text-sm transition ${
                active
                  ? 'bg-gradient-to-r from-indigo-500 to-violet-500 font-medium text-white shadow-sm'
                  : 'text-slate-700 hover:bg-white hover:shadow-sm'
              }`}
            >
              <span className="text-base" aria-hidden="true">
                ⚖️
              </span>
              <span className="truncate">{c.name}</span>
              {c.memberCount > 0 && (
                <span
                  className={`ml-auto shrink-0 text-[11px] tabular-nums ${
                    active ? 'text-white/70' : 'text-slate-400'
                  }`}
                >
                  {c.memberCount}
                </span>
              )}
            </Link>

            <button
              type="button"
              aria-label={`${c.name} menu`}
              onClick={() => setMenuId(menuId === c.id ? null : c.id)}
              className={`absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 transition ${
                active
                  ? 'text-white/70 hover:bg-white/20 hover:text-white'
                  : 'text-slate-400 opacity-0 hover:bg-slate-100 hover:text-slate-600 group-hover:opacity-100'
              }`}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M10 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm0 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" />
              </svg>
            </button>

            {menuId === c.id && (
              <div
                ref={menuRef}
                role="menu"
                className="absolute right-1 top-8 z-50 w-32 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Share ${c.name}`}
                  className="w-full px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => void openShare(c)}
                >
                  Share
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => handleRename(c)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
                  onClick={() => handleDelete(c)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}

      {shareId && (
        <ShareDialog
          kind="comparison"
          entityId={shareId}
          entityName={comparisons.find((c) => c.id === shareId)?.name ?? 'comparison'}
          myRole={shareRole}
          currentUserId={shareUserId}
          initialEntries={shareEntries}
          onClose={() => setShareId(null)}
        />
      )}
    </>
  );
}
