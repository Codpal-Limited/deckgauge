'use server';

import { revalidatePath } from 'next/cache';
import {
  slugify,
  type EditionNotice,
  type OrgBoardDto,
  type OrgMemberDto,
  type OrganizationDto,
  type OrgRoleValue,
} from '@deckgauge/shared';
import { authFetch } from './api';
import { getApiUrl } from '../lib/api-server';

export type ActionResult = { ok: true } | { ok: false; error: string };

export type BootstrapState =
  | { state: 'NEEDS_BOOTSTRAP' }
  | { state: 'NO_MEMBERSHIP'; organizationName: string }
  | {
      state: 'MEMBER';
      organization: OrganizationDto;
      /**
       * Messages from the active edition, already validated and link-checked by
       * the API. Absent in Community and whenever there is nothing to say.
       */
      notices?: EditionNotice[];
    }
  | { state: 'SUSPENDED' }
  | { state: 'UNAUTHENTICATED' };

/**
 * Every mutation here RETURNS its failure rather than throwing. A server action
 * that throws reaches the client as an opaque Next.js digest with no message, so
 * the user would see "an error occurred" instead of "already invited".
 */
async function mutate(path: string, init: RequestInit): Promise<ActionResult> {
  let res: Response;
  try {
    res = await authFetch(path, init);
  } catch {
    // A rejected fetch — API unreachable, DNS, connection refused, timeout —
    // must still be REPORTED rather than thrown: a thrown server action reaches
    // the client as an opaque digest with no message, which is the one thing
    // this module exists to prevent.
    return { ok: false, error: 'NETWORK_ERROR' };
  }
  if (res.ok) return { ok: true };
  let error = `HTTP_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') error = body.error;
  } catch {
    // Non-JSON body; the status-derived code above is the best available.
  }
  return { ok: false, error };
}

export async function getBootstrapState(): Promise<BootstrapState> {
  let res: Response;
  try {
    res = await authFetch('/organization/bootstrap-state', { cache: 'no-store' });
  } catch {
    return { state: 'UNAUTHENTICATED' };
  }
  if (res.status === 403) {
    // The auth plugin answers 403 MEMBERSHIP_SUSPENDED on EVERY route, so this
    // endpoint is the only place the web layer can learn it. Collapsing it into
    // UNAUTHENTICATED left a suspended member on a blank, chrome-less page with
    // no message and no way to sign out.
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body.error === 'MEMBERSHIP_SUSPENDED') return { state: 'SUSPENDED' };
    } catch {
      // Non-JSON 403 — fall through to the unauthenticated treatment below.
    }
  }
  // 401 is the only other expected failure — the endpoint is gated on
  // AUTHENTICATED — and failing closed to the sign-in path is the safe default.
  if (!res.ok) return { state: 'UNAUTHENTICATED' };
  return (await res.json()) as BootstrapState;
}

/**
 * Deliberately a bare `fetch`, NOT `authFetch`.
 *
 * `authFetch` resolves auth headers through `getAuthHeaders`, which THROWS
 * `MissingSessionError` when there is no session. The only caller of this
 * function is `/invite`, whose entire audience is people who do not have an
 * account yet — so routing it through `authFetch` made the public invite page
 * work for signed-in users and 500 for invitees, the exact inverse of its
 * purpose. The endpoint carries the `PUBLIC` policy on the API and needs no
 * credentials.
 *
 * Failures return `null`, which the page renders as "not set up yet".
 */
export async function getPublicSummary(): Promise<{ name: string; slug: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}/organization/public-summary`, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return (await res.json()) as { name: string; slug: string };
}

export async function createOrganization(name: string): Promise<ActionResult> {
  const result = await mutate('/organizations/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug: slugify(name) }),
  });
  if (result.ok) revalidatePath('/');
  return result;
}

export async function listMembers(): Promise<OrgMemberDto[]> {
  const res = await authFetch('/organization/members', { cache: 'no-store' });
  if (!res.ok) return [];
  return (await res.json()) as OrgMemberDto[];
}

export async function inviteMember(email: string, role: OrgRoleValue): Promise<ActionResult> {
  const result = await mutate('/organization/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  if (result.ok) revalidatePath('/settings/organization/members');
  return result;
}

export async function updateMemberRole(id: string, role: OrgRoleValue): Promise<ActionResult> {
  const result = await mutate(`/organization/members/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (result.ok) revalidatePath('/settings/organization/members');
  return result;
}

export async function updateMemberStatus(
  id: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<ActionResult> {
  const result = await mutate(`/organization/members/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (result.ok) revalidatePath('/settings/organization/members');
  return result;
}

export async function removeMember(id: string): Promise<ActionResult> {
  const result = await mutate(`/organization/members/${id}`, { method: 'DELETE' });
  if (result.ok) revalidatePath('/settings/organization/members');
  return result;
}

// --- Admin All-boards table (tenancy spec §5.4) ---

/**
 * The admin All-boards inventory. Failure yields an empty list rather than a
 * throw: the page has already established the caller is an organization admin,
 * so a failure here is an outage, and an empty table with the surrounding chrome
 * intact beats a Next.js error boundary swallowing the whole settings screen.
 */
export async function listOrgBoards(): Promise<OrgBoardDto[]> {
  try {
    const res = await authFetch('/organization/boards', { cache: 'no-store' });
    if (!res.ok) return [];
    return (await res.json()) as OrgBoardDto[];
  } catch {
    return [];
  }
}

/**
 * Rename and delete go to the ORDINARY board routes, not to an
 * `/organization/boards/:id` twin — an organization ADMIN is an implicit OWNER of
 * every board in their organization, so these already admit them, and a second
 * write path would be a second place to keep every board invariant.
 *
 * `revalidatePath('/')` matters as much as the request: the board list and
 * sidebar render under `/`, and without it the App Router client cache keeps
 * serving a board this call just deleted.
 */
export async function renameOrgBoard(boardId: string, name: string): Promise<ActionResult> {
  const result = await mutate(`/boards/${boardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (result.ok) {
    revalidatePath('/');
    revalidatePath('/settings/organization/boards');
  }
  return result;
}

export async function deleteOrgBoard(boardId: string): Promise<ActionResult> {
  const result = await mutate(`/boards/${boardId}`, { method: 'DELETE' });
  if (result.ok) {
    revalidatePath('/');
    revalidatePath('/settings/organization/boards');
  }
  return result;
}
