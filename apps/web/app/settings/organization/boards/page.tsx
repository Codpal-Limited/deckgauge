import { getBootstrapState, listOrgBoards } from '../../../actions/organization';
import { isOrganizationAdmin } from '../../../lib/org-role';
import { fetchMyRole } from '../../../actions/access';
import { OrgBoardsScreen } from './OrgBoardsScreen';

export default async function OrgBoardsPage() {
  const state = await getBootstrapState();
  // The `state` clause is redundant against isOrganizationAdmin — it narrows the
  // bootstrap union, which a boolean helper cannot do.
  if (state.state !== 'MEMBER' || !isOrganizationAdmin(state)) {
    return (
      <p className="text-sm text-slate-600">
        You need to be an organization administrator to manage boards.
      </p>
    );
  }

  const boards = await listOrgBoards();
  // The caller's own User.id, needed for "Make me owner" and for the share
  // dialog's own-row handling. `fetchMyRole` is the endpoint that returns it —
  // the same way `app/page.tsx` sources it. The board id is irrelevant to the id
  // half of the answer, so the first board serves; an empty organization needs no
  // id at all.
  const me = boards[0] ? await fetchMyRole('board', boards[0].id) : { userId: null };

  return <OrgBoardsScreen boards={boards} currentUserId={me.userId} />;
}
