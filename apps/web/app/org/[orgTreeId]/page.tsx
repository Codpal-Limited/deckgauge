import { notFound } from 'next/navigation';
import { getOrgTreeOrDenied, listOrgTreeAccess } from '@/app/actions/org-trees';
import { listEmployeeBoards } from '@/app/actions/employee-boards';
import { OrgTreeToolbar } from './OrgTreeToolbar';
import { OrgTabs } from './OrgTabs';
import { OrgTreeHeaderActions } from './OrgTreeHeaderActions';

interface OrgTreePageProps {
  params: { orgTreeId: string };
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

export default async function OrgTreePage({ params }: OrgTreePageProps) {
  const result = await getOrgTreeOrDenied(params.orgTreeId);
  if (!result.ok) {
    if (result.reason === 'forbidden') return <AccessDeniedPanel />;
    notFound();
  }
  const tree = result.tree;

  const [boards, access] = await Promise.all([
    listEmployeeBoards(tree.id),
    listOrgTreeAccess(tree.id),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-gray-800">{tree.name}</h1>
        <OrgTreeHeaderActions treeId={tree.id} treeName={tree.name} initialAccess={access} />
      </div>
      <OrgTreeToolbar treeId={tree.id} lastSyncedAt={tree.lastSyncedAt} />
      <OrgTabs tree={tree} boards={boards} />
    </main>
  );
}
