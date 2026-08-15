'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { renameOrgTree, deleteOrgTree, type OrgTreeAccessEntry } from '../../actions/org-trees';
import { ShareOrgTreeModal } from '../../components/ShareOrgTreeModal';

interface OrgTreeHeaderActionsProps {
  treeId: string;
  treeName: string;
  initialAccess?: OrgTreeAccessEntry[];
}

export function OrgTreeHeaderActions({
  treeId,
  treeName,
  initialAccess = [],
}: OrgTreeHeaderActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showShare, setShowShare] = useState(false);

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
      <button
        type="button"
        onClick={() => setShowShare(true)}
        disabled={busy}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
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
        className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
      >
        Delete
      </button>
      {showShare && (
        <ShareOrgTreeModal
          orgTreeId={treeId}
          members={initialAccess}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
