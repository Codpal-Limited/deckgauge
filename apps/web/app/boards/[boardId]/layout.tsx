import { BoardUnifiedTabsHost } from '../../components/tabs/BoardUnifiedTabsHost';
import { getBootstrapState } from '../../actions/organization';
import { isOrganizationAdmin } from '../../lib/org-role';

export default async function BoardSubLayout(
  props: {
    children: React.ReactNode;
    params: Promise<{ boardId: string }>;
  }
) {
  const params = await props.params;

  const {
    children
  } = props;

  // Task 13: the Intelligence tab opens the SQL console, which the API now
  // gates at `ADMIN` (see routes.ts's file-header comment for why — the
  // console's scoping has three known privilege-escalation bypasses and this
  // is a mitigation, not a fix). `isOrganizationAdmin` is the existing
  // presentation-only admin signal this app already uses to hide the
  // Members/Connections settings tabs from non-admins; reused here rather
  // than inventing a second one. It does not see the API's other two
  // break-glass admin sources (an instance break-glass flag or a Keycloak
  // realm role), so an admin by one of those alone would still see this tab
  // hidden — acceptable for a presentation gate the API enforces regardless.
  const orgState = await getBootstrapState();
  const isAdmin = isOrganizationAdmin(orgState);

  return (
    <>
      <BoardUnifiedTabsHost boardId={params.boardId} isAdmin={isAdmin} />
      {children}
    </>
  );
}
