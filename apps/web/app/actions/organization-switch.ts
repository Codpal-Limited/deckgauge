'use server';

import type { OrgMembershipOptionDto } from '@deckgauge/shared';
import { authFetch } from './api';

/**
 * The organizations the caller may act in. Returns `[]` on any failure — the
 * switcher renders nothing rather than a broken menu.
 */
export async function fetchSwitchableOrganizations(): Promise<OrgMembershipOptionDto[]> {
  try {
    const res = await authFetch('/organization/switchable', { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { organizations?: OrgMembershipOptionDto[] };
    return body.organizations ?? [];
  } catch {
    return [];
  }
}

export type SwitchResult = { ok: true } | { ok: false; error: string };

/**
 * Records the caller's choice.
 *
 * Returns a result union rather than throwing: a thrown server action surfaces
 * only an opaque digest in production, which would hide the one message that
 * matters here — that the organization is not one they hold.
 */
export async function switchOrganization(organizationId: string): Promise<SwitchResult> {
  try {
    const res = await authFetch('/organization/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    });
    if (res.status === 404) {
      return { ok: false, error: 'That organization is no longer available to you.' };
    }
    if (!res.ok) return { ok: false, error: 'Could not switch organization. Please try again.' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not switch organization. Please try again.' };
  }
}
