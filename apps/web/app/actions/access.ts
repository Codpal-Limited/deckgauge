'use server';

import type { AccessEntityKind, AccessEntry, AccessRoleValue, MyRole } from '@deckgauge/shared';
import { MyRoleSchema } from '@deckgauge/shared';
import { authFetch } from './api';
import { MissingSessionError } from '../lib/api-server';
import { ENTITY_PATHS } from '../components/sharing/entity-paths';

/**
 * Server actions RETURN failures rather than throwing them: a thrown error in a
 * server action reaches the client as an opaque digest, so the dialog could only
 * ever say "something went wrong" — losing exactly the messages that matter here
 * (last owner, not in this organization).
 */
export type AccessActionResult =
  | { ok: true; role: AccessRoleValue }
  | { ok: false; error: string };

export type RevokeActionResult = { ok: true } | { ok: false; error: string };

const MESSAGES: Record<string, string> = {
  LAST_OWNER: 'This is the last owner — make someone else an owner first.',
  ALREADY_HAS_ACCESS: 'That person already has access.',
  CONCURRENT_UPDATE: 'Someone else changed access at the same time. Try again.',
  ROLE_EXCEEDS_ORG_ROLE: 'That person is an organization viewer, so they can only be given Viewer access.',
};

const SESSION_EXPIRED_ERROR = 'Your session has expired — reload the page and try again.';

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : '';
    return MESSAGES[code] ?? (code || fallback);
  } catch {
    return fallback;
  }
}

/**
 * `authFetch` can throw before a `Response` ever exists — `getAuthHeaders`
 * throws `MissingSessionError` when a session expires mid-dialog, and
 * `fetch` itself can reject on a network failure. Every server action below
 * must return its result union rather than let either propagate past the
 * server-action boundary as an opaque digest.
 */
function toActionError(err: unknown, fallback: string): string {
  return err instanceof MissingSessionError ? SESSION_EXPIRED_ERROR : fallback;
}

/**
 * Fails CLOSED: a non-OK response yields no role, which renders the entity
 * read-only. The previous board page hardcoded OWNER for any logged-in visitor
 * instead (design §1.2).
 */
export async function fetchMyRole(
  kind: AccessEntityKind,
  entityId: string,
): Promise<MyRole | { role: null; userId: null }> {
  try {
    const res = await authFetch(`/${ENTITY_PATHS[kind]}/${entityId}/my-role`, { cache: 'no-store' });
    if (!res.ok) return { role: null, userId: null };
    const parsed = MyRoleSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : { role: null, userId: null };
  } catch {
    return { role: null, userId: null };
  }
}

export async function fetchAccess(
  kind: AccessEntityKind,
  entityId: string,
): Promise<AccessEntry[]> {
  try {
    const res = await authFetch(`/${ENTITY_PATHS[kind]}/${entityId}/access`, { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()) as AccessEntry[];
  } catch {
    return [];
  }
}

export async function grantAccess(
  kind: AccessEntityKind,
  entityId: string,
  userId: string,
  role: AccessRoleValue,
): Promise<AccessActionResult> {
  try {
    const res = await authFetch(`/${ENTITY_PATHS[kind]}/${entityId}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    });
    if (!res.ok) return { ok: false, error: await readError(res, 'Could not share this.') };
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: toActionError(err, 'Could not share this.') };
  }
}

export async function updateAccessRole(
  kind: AccessEntityKind,
  entityId: string,
  userId: string,
  role: AccessRoleValue,
): Promise<AccessActionResult> {
  try {
    const res = await authFetch(`/${ENTITY_PATHS[kind]}/${entityId}/access/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) return { ok: false, error: await readError(res, 'Could not change that role.') };
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: toActionError(err, 'Could not change that role.') };
  }
}

export async function revokeAccess(
  kind: AccessEntityKind,
  entityId: string,
  userId: string,
): Promise<RevokeActionResult> {
  try {
    const res = await authFetch(`/${ENTITY_PATHS[kind]}/${entityId}/access/${userId}`, {
      method: 'DELETE',
    });
    if (!res.ok) return { ok: false, error: await readError(res, 'Could not remove that person.') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toActionError(err, 'Could not remove that person.') };
  }
}
