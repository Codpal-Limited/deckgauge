import { auth } from '@/auth';

export function getApiUrl(): string {
  return process.env.API_URL ?? 'http://localhost:3001';
}

/**
 * Thrown by {@link getAuthHeaders} when no authenticated session is
 * available. The API is default-deny: sending it an unauthenticated request
 * produces a 401 far from the real cause. Throwing here, right at the source
 * of the missing credential, lets callers fail loudly (or, where a call is
 * genuinely meant to run without a session, catch this specific error and
 * say so explicitly) instead of silently degrading to an anonymous request.
 */
export class MissingSessionError extends Error {
  constructor() {
    super('No authenticated session available for this API call.');
    this.name = 'MissingSessionError';
  }
}

/**
 * Resolve the bearer-token header for a call this server makes to its own
 * API. Throws {@link MissingSessionError} instead of returning `{}` when
 * there is no session or no access token — see the class doc for why.
 * Behaviour when a session with an access token exists is unchanged.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const session = await auth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const token = (session as any)?.accessToken as string | undefined;
  if (!token) throw new MissingSessionError();
  return { Authorization: `Bearer ${token}` };
}
