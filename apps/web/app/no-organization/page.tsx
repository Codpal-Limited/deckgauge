import { getBootstrapState } from '../actions/organization';

export default async function NoOrganizationPage() {
  const state = await getBootstrapState();
  const name = state.state === 'NO_MEMBERSHIP' ? state.organizationName : 'this Deckgauge';

  return (
    <div className="mx-auto mt-24 max-w-md space-y-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">You are not a member yet</h1>
      <p className="text-sm text-slate-600">
        This Deckgauge belongs to <strong>{name}</strong>. Ask an administrator to invite you,
        then sign in again with the same email address.
      </p>
      <a href="/api/auth/signout" className="inline-block text-sm text-teal-700 underline">
        Sign out
      </a>
    </div>
  );
}
