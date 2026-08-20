import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { NextAuthRequest } from 'next-auth';
import { auth } from '@/auth';
import { isAuthorized } from './lib/is-authorized';

/**
 * Reachable without an account.
 *
 * `/login` is here for a reason that is easy to lose: this handler redirects
 * unauthenticated callers TO `/login`, so if `/login` itself were treated as
 * private it would redirect to itself forever and nobody could ever sign in.
 * NextAuth's built-in version carried the same guard (`pathname !== signInPage`);
 * it was dropped when that redirect was reimplemented here, and the loop it
 * caused is what `middleware.test.ts` now pins.
 *
 * `/invite` shows an invitee which organization they were invited to and sends
 * them to Keycloak, so demanding a session first would make the link useless to
 * exactly the people it exists for.
 */
const PUBLIC_PATHS = ['/login', '/invite'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * `x-pathname` exists because a server layout cannot read the current path, and
 * `OrgGate` needs it to avoid redirecting to the page it is already on.
 */
function withPathname(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-pathname', req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

/**
 * Supplying a handler to `auth()` makes NextAuth's own unauthorized redirect
 * unreachable — `callbacks.authorized` still runs, but its boolean return is
 * discarded, and only a `Response` is honoured. So this handler performs that
 * redirect itself, reusing the SAME `isAuthorized` predicate the callback
 * delegates to rather than re-deriving the rule.
 *
 * Exported (rather than inlined into `auth(...)`) so tests can call it
 * directly with a constructed request instead of mocking NextAuth's wrapper.
 */
export function handleRequest(req: NextAuthRequest) {
  const { pathname, search } = req.nextUrl;

  if (!isPublic(pathname) && !isAuthorized(req.auth)) {
    const url = new URL('/login', req.url);
    url.searchParams.set('callbackUrl', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  return withPathname(req);
}

export default auth(handleRequest);

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon\\.png).*)'],
};
