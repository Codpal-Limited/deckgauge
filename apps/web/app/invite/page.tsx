import { getPublicSummary } from '../actions/organization';

/**
 * Public landing page for an invite link. Renders with no app chrome and no
 * session — the visitor may have no account at all.
 *
 * The organization name comes from the API, NEVER from `searchParams.org`.
 * Rendering caller-supplied text here would turn any invite link into a
 * phishing template ("You've been invited to Payroll Admin"). The parameter is
 * accepted so the link shape survives into multi-org, where it will select which
 * organization to join, and is otherwise unused.
 *
 * The link grants nothing on its own: membership is created only when the
 * caller's verified Keycloak email matches a PENDING invite.
 */
export default async function InvitePage({
  searchParams: _searchParams,
}: {
  searchParams: { org?: string };
}) {
  const org = await getPublicSummary();

  if (!org) {
    return (
      <div className="mx-auto mt-24 max-w-md space-y-4 p-6 text-center">
        <h1 className="text-2xl font-semibold">Nothing to join yet</h1>
        <p className="text-sm text-slate-600">
          This Deckgauge has not been set up yet. Ask whoever runs it to create the organization
          first.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md space-y-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Join {org.name}</h1>
      <p className="text-sm text-slate-600">
        Sign in — or create an account — using the email address you were invited with. You will
        join automatically.
      </p>
      <a
        href="/api/auth/signin"
        className="inline-block rounded bg-teal-600 px-4 py-2 text-white"
      >
        Sign in or create account
      </a>
    </div>
  );
}
