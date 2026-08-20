import { getBootstrapState, listMembers } from '../../../actions/organization';
import { MembersScreen } from './MembersScreen';
import { isOrganizationAdmin } from '../../../lib/org-role';

export default async function MembersPage() {
  const state = await getBootstrapState();
  // The `state` clause is redundant against isOrganizationAdmin — it is there to
  // narrow the bootstrap union, so `state.organization` below is reachable
  // without re-deriving the role condition a boolean helper cannot narrow.
  if (state.state !== 'MEMBER' || !isOrganizationAdmin(state)) {
    return (
      <p className="text-sm text-slate-600">
        You need to be an organization administrator to manage members.
      </p>
    );
  }

  const members = await listMembers();
  return (
    <MembersScreen
      members={members}
      inviteBaseUrl={process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}
      orgSlug={state.organization.slug}
    />
  );
}
