'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AccessEntry, AccessRoleValue } from '@deckgauge/shared';
import { canManageEntity } from '@deckgauge/shared';
import { renameOrgTree, deleteOrgTree } from '../../actions/org-trees';
import { AccessPeopleStack } from '../../components/sharing/AccessPeopleStack';
import { ShareDialog } from '../../components/sharing/ShareDialog';

interface OrgTreeHeaderActionsProps {
  treeId: string;
  treeName: string;
  myRole: AccessRoleValue | null;
  currentUserId: string | null;
  initialAccess?: AccessEntry[];
}

export function OrgTreeHeaderActions({
  treeId,
  treeName,
  myRole,
  currentUserId,
  initialAccess = [],
}: OrgTreeHeaderActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showShare, setShowShare] = useState(false);

  // All three actions are orgTree(OWNER) routes — rename, delete and manage
  // access sit in the same tier (design §4), so one predicate governs all three
  // rather than three that can drift apart. A null role fails closed: the page
  // renders read-only rather than offering controls that 403.
  const canManage = canManageEntity(myRole);

  async function handleRename() {
    const next = window.prompt('Rename org tree', treeName);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === treeName) return;
    setBusy(true);
    const res = await renameOrgTree(treeId, name);
    setBusy(false);
    if (res.ok) router.refresh();
    else window.alert('Rename failed. Please try again.');
  }

  async function handleDelete() {
    const confirmed = window.confirm(
      `Delete org tree "${treeName}"?\n\n` +
        'This permanently removes all employees, identity aliases, and this tree\'s ' +
        'timesheet configuration. Synced hours data is not deleted, but the timesheet ' +
        'for this tree will no longer be available. This cannot be undone.',
    );
    if (!confirmed) return;
    setBusy(true);
    const res = await deleteOrgTree(treeId);
    if (res.ok) {
      router.push('/');
      router.refresh();
    } else {
      setBusy(false);
      window.alert('Delete failed. Please try again.');
    }
  }

  return (
    <div className="flex items-center gap-2">
      {/* Who is on this tree — visible to anyone with access (design D6). The
          dialog it opens renders read-only for a non-owner. */}
      <AccessPeopleStack
        entries={initialAccess}
        nounLabel="Org tree"
        onOpen={() => setShowShare(true)}
      />

      {canManage && (
        <>
          <button
            type="button"
            onClick={() => setShowShare(true)}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-60 md:min-h-0"
          >
            Share
          </button>
          <button
            type="button"
            onClick={handleRename}
            disabled={busy}
            className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-60"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-red-200 bg-surface-1 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 md:min-h-0"
          >
            Delete
          </button>
        </>
      )}

      {showShare && (
        <ShareDialog
          kind="orgTree"
          entityId={treeId}
          entityName={treeName}
          myRole={myRole}
          currentUserId={currentUserId}
          initialEntries={initialAccess}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
