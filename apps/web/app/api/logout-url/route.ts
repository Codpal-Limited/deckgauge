import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

/**
 * Builds Keycloak's RP-initiated (federated) logout URL server-side.
 *
 * The browser cannot build it: the issuer is a per-deployment value, and reading
 * NEXT_PUBLIC_KEYCLOAK_ISSUER in a client component freezes it into the bundle at
 * build time. Every image therefore shipped the build machine's Keycloak
 * (localhost:8080), so a self-hosted install on any other port sent its id_token
 * to the wrong realm and got "Invalid parameter: id_token_hint" — while its own
 * SSO session stayed alive ("you are already logged in" on the next sign-in).
 *
 * Reading KEYCLOAK_ISSUER here instead means one image works on any port.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const origin = new URL(request.url).origin;
  // Where sign-out lands. Defaults to this app's own sign-in page; the public
  // demo overrides it to the commercial site, which is a DIFFERENT origin and so
  // cannot be derived from the request. Not hard-coded either — a self-hosted
  // install must not eject its users to our marketing site.
  //
  // Keycloak has to be told separately: `post_logout_redirect_uri` is validated
  // against the client's `post.logout.redirect.uris`, and an origin missing from
  // that list is refused with "Invalid redirect uri" however correct this value
  // is. Both ends read POST_LOGOUT_REDIRECT_URL — see
  // scripts/post-logout-redirect-uris.sh.
  //
  // Trimmed because `docker compose` passes an unset variable through as "",
  // which would otherwise build an empty `post_logout_redirect_uri=`.
  const configured = process.env.POST_LOGOUT_REDIRECT_URL?.trim();
  const postLogoutRedirectUri = configured || `${origin}/login`;
  const issuer = process.env.KEYCLOAK_ISSUER;

  // No federated logout configured (or the session is unreadable): clearing the
  // local session and landing on /login is still a correct, if partial, sign-out.
  if (!issuer) return NextResponse.json({ url: postLogoutRedirectUri });

  let idToken: string | undefined;
  try {
    idToken = (await auth())?.idToken;
  } catch {
    return NextResponse.json({ url: postLogoutRedirectUri });
  }

  const params = new URLSearchParams();
  if (idToken) {
    // Skips Keycloak's logout-confirmation prompt.
    params.set('id_token_hint', idToken);
  } else if (process.env.KEYCLOAK_CLIENT_ID) {
    params.set('client_id', process.env.KEYCLOAK_CLIENT_ID);
  }

  // Keycloak rejects post_logout_redirect_uri ("Missing parameters: id_token_hint")
  // unless the hint or the client id identifies the client. Without either, let
  // Keycloak show its own confirm-and-done page rather than an error page.
  if ([...params.keys()].length > 0) {
    params.set('post_logout_redirect_uri', postLogoutRedirectUri);
  }

  const query = params.toString();
  return NextResponse.json({
    url: `${issuer}/protocol/openid-connect/logout${query ? `?${query}` : ''}`,
  });
}
