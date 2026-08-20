'use client';

import { useState } from 'react';
import type { AccessEntry, AccessRoleValue } from '@deckgauge/shared';
import { canManageEntity } from '@deckgauge/shared';
import { AccessPeopleStack } from '../sharing/AccessPeopleStack';
import { ShareDialog } from '../sharing/ShareDialog';

interface BoardSharePillProps {
  boardId: string;
  boardName: string;
  userRole?: AccessRoleValue | null;
  currentUserId?: string | null;
  boardAccess?: AccessEntry[];
}

/**
 * Who is here, and the way to add someone — one bordered group instead of two
 * neighbouring controls. Sharing is board(OWNER) (`PUT /boards/:id/access`), so
 * a member sees only the avatars, which stay clickable as a read-only roster.
 */
export function BoardSharePill({
  boardId,
  boardName,
  userRole,
  currentUserId,
  boardAccess,
}: BoardSharePillProps) {
  const [isOpen, setIsOpen] = useState(false);
  const canShare = canManageEntity(userRole ?? null);
  const entries = boardAccess ?? [];

  // Nothing to show and nothing to offer — don't leave an empty frame behind.
  if (entries.length === 0 && !canShare) return null;

  return (
    <>
      <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-surface-1 pl-1.5 pr-1.5 shadow-sm">
        <AccessPeopleStack entries={entries} nounLabel="Board" onOpen={() => setIsOpen(true)} />
        {canShare && (
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
          >
            Share
          </button>
        )}
      </div>

      {isOpen && (
        <ShareDialog
          kind="board"
          entityId={boardId}
          entityName={boardName}
          myRole={userRole ?? null}
          currentUserId={currentUserId ?? null}
          initialEntries={entries}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
