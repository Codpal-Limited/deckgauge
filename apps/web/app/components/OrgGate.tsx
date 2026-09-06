import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getBootstrapState } from '../actions/organization';
import { AppChrome } from './AppChrome';
import { EditionNoticeBar } from './EditionNoticeBar';

/** Rendered without app chrome. `/invite` is additionally reachable with no account. */
const CHROMELESS = ['/invite', '/welcome', '/no-organization'];

function isChromeless(pathname: string): boolean {
  // Exact-or-segment, not a bare prefix: a future `/welcome-back` route must not
  // be mistaken for an onboarding screen.
  return CHROMELESS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Decides which door the caller is at, and therefore whether the app chrome
 * renders at all.
 *
 * The gate and the chrome decision are deliberately the same decision in one
 * place: /invite, /welcome and /no-organization must render standalone, and the
 * alternative — a second root layout — would mean moving every existing page
 * into a route group.
 *
 * The guard runs in both directions. A member who lands on /welcome is sent back
 * to the app, because a bookmarked or stale URL would otherwise present a
 * create-organization form that can only ever answer 409.
 */
export async function OrgGate({
  children,
  activeBoardId,
}: {
  children: ReactNode;
  activeBoardId: string | null;
}) {
  // `headers()` is async as of Next 15. Sync access still works there behind a
  // deprecation warning, which is why this read has not been failing — but it
  // is removed in Next 16, and `app/layout.tsx` and `app/page.tsx` already use
  // the awaited form for `cookies()`.
  const pathname = (await headers()).get('x-pathname') ?? '/';
  const state = await getBootstrapState();

  if (state.state === 'MEMBER') {
    // The onboarding screens no longer apply — a bookmarked /welcome would
    // otherwise show a form that can only answer 409.
    if (isChromeless(pathname)) redirect('/');
    // Inside the chrome and above the page, so an edition's message is visible on
    // every screen rather than only on a settings page nobody visits. Renders
    // nothing at all when there is nothing to say, which is always the case in
    // Community.
    return (
      <AppChrome activeBoardId={activeBoardId}>
        <EditionNoticeBar notices={state.notices} />
        {children}
      </AppChrome>
    );
  }

  if (state.state === 'SUSPENDED') {
    // An administrative block on the identity, so it must be explained wherever
    // the person lands. Before this branch existed a suspended member got a
    // blank, chrome-less page with no message and no way to sign out — the
    // suspend button shipped without defining what its target sees.
    return (
      <div className="mx-auto mt-24 max-w-md space-y-4 p-6 text-center">
        <h1 className="text-2xl font-semibold">Your access has been suspended</h1>
        <p className="text-sm text-slate-600">
          An administrator has suspended your access to this organization. Contact them if you
          think this is a mistake.
        </p>
        <a href="/api/auth/signout" className="inline-block text-sm text-teal-700 underline">
          Sign out
        </a>
      </div>
    );
  }

  // Not a member. `/invite` must render for every one of these states: an
  // account-less visitor, a deployment with no organization yet, and — the case
  // that matters most — someone who signed in with an email that does not match
  // their invite, who needs to READ the page rather than be redirected off it.
  if (pathname === '/invite' || pathname.startsWith('/invite/')) return <>{children}</>;

  if (state.state === 'UNAUTHENTICATED') return <>{children}</>;

  if (state.state === 'NEEDS_BOOTSTRAP') {
    if (pathname === '/welcome') return <>{children}</>;
    redirect('/welcome');
  }

  if (state.state === 'NO_MEMBERSHIP') {
    if (pathname === '/no-organization') return <>{children}</>;
    redirect('/no-organization');
  }

  // Exhaustiveness fallback. Rendering bare is the safe default for a state this
  // function does not know about: redirecting an unrecognised state would send
  // someone in a loop they cannot see or escape.
  return <>{children}</>;
}
