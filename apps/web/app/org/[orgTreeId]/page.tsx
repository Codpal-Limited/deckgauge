import { notFound } from 'next/navigation';
import { getOrgTreeOrDenied } from '@/app/actions/org-trees';
import { fetchAccess, fetchMyRole } from '@/app/actions/access';
import { listEmployeeBoards } from '@/app/actions/employee-boards';
import { OrgTreeToolbar } from './OrgTreeToolbar';
import { OrgTabs } from './OrgTabs';
import { OrgTreeHeaderActions } from './OrgTreeHeaderActions';

interface OrgTreePageProps {
  params: Promise<{ orgTreeId: string }>;
}

/**
 * Explanatory panel for a 403 on this tree — deliberately not an error
 * boundary. Distinct from the org-tree-list empty state and from the
 * analytics-role denial on the Timesheet/Report tabs: this one is fixable by
 * any existing OWNER granting access, not by an administrator.
 */
function AccessDeniedPanel() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 text-center">
      <h1 className="text-lg font-semibold text-gray-800">You don&apos;t have access</h1>
      <p className="mt-2 text-sm text-gray-500">
        You don&apos;t have access to this org tree. Ask an owner to share it with you.
      </p>
    </main>
  );
}

export default async function OrgTreePage(props: OrgTreePageProps) {
  const params = await props.params;
  const result = await getOrgTreeOrDenied(params.orgTreeId);
  if (!result.ok) {
    if (result.reason === 'forbidden') return <AccessDeniedPanel />;
    notFound();
  }
  const tree = result.tree;

  // One round of parallel fetches, as before. `fetchMyRole` fails closed — a
  // non-OK response yields { role: null, userId: null }, which renders the
  // header read-only rather than offering controls that then 403.
  const [boards, access, { role: myRole, userId: currentUserId }] = await Promise.all([
    listEmployeeBoards(tree.id),
    fetchAccess('orgTree', tree.id),
    fetchMyRole('orgTree', tree.id),
  ]);

  return (
    // No width cap of its own: the app shell already caps page content at
    // 1400px. An inner cap here (added when this page only held the org chart)
    // left the employee board — which sizes to its own columns — wider than the
    // page header it sits under.
    <main className="py-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-gray-800">{tree.name}</h1>
        <OrgTreeHeaderActions
          treeId={tree.id}
          treeName={tree.name}
          myRole={myRole}
          currentUserId={currentUserId}
          initialAccess={access}
        />
      </div>
      <OrgTreeToolbar treeId={tree.id} lastSyncedAt={tree.lastSyncedAt} />
      <OrgTabs tree={tree} boards={boards} treeRole={myRole} />
    </main>
  );
}
