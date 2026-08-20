'use client';

import { useEffect, useState } from 'react';
import type { AccessEntityKind, AccessEntry, AccessRoleValue } from '@deckgauge/shared';
import { canManageEntity } from '@deckgauge/shared';
import { fetchAccess, fetchMyRole } from '../../actions/access';
import { AccessPeopleStack } from './AccessPeopleStack';
import { ShareDialog } from './ShareDialog';

/**
 * The people stack, the Share button and the dialog, for any entity — fetching
 * the caller's role and the access list on the client.
 *
 * Board and org tree get theirs from a server component, which is better: the
 * dialog opens with data already in hand. This exists for the three surfaces
 * where the entity id is only known client-side — the active org-tree board, and
 * a roadmap or comparison rendered inside a client page — and it keeps them from
 * being three near-identical copies of the same effect.
 *
 * Fails closed: a failed `my-role` leaves the role null, which renders the stack
 * read-only and hides Share.
 */
export function EntityShareControls({
  kind,
  entityId,
  entityName,
  nounLabel,
  className = 'flex items-center gap-2',
}: {
  kind: AccessEntityKind;
  entityId: string;
  entityName: string;
  /** Prefix for the stack's aria-label, e.g. "Roadmap access: 3 people". */
  nounLabel: string;
  className?: string;
}) {
  const [myRole, setMyRole] = useState<AccessRoleValue | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [entries, setEntries] = useState<AccessEntry[]>([]);
  const [showShare, setShowShare] = useState(false);

  // Refetch whenever the entity changes, and clear first: a stale people stack
  // from the previously-open entity is worse than an empty one.
  useEffect(() => {
    let cancelled = false;
    setShowShare(false);
    setEntries([]);
    setMyRole(null);
    void Promise.all([fetchMyRole(kind, entityId), fetchAccess(kind, entityId)])
      .then(([role, access]) => {
        if (cancelled) return;
        setMyRole(role.role);
        setCurrentUserId(role.userId);
        setEntries(access);
      })
      .catch(() => {
        // Fail closed: no role, no entries, no Share button.
      });
    return () => {
      cancelled = true;
    };
  }, [kind, entityId]);

  return (
    <div className={className}>
      <AccessPeopleStack
        entries={entries}
        nounLabel={nounLabel}
        onOpen={() => setShowShare(true)}
      />

      {canManageEntity(myRole) && (
        <button
          type="button"
          onClick={() => setShowShare(true)}
          className="rounded-md bg-teal-600 px-2.5 py-1 text-[13px] font-medium text-white hover:bg-teal-700"
        >
          Share
        </button>
      )}

      {showShare && (
        <ShareDialog
          kind={kind}
          entityId={entityId}
          entityName={entityName}
          myRole={myRole}
          currentUserId={currentUserId}
          initialEntries={entries}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
