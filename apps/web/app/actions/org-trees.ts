'use server';

import type {
  OrgTreeDto,
  SyncStatus,
  ImportResult,
  OrgEmployeeAliasDto,
  OrgEmployeeDto,
  CreateEmployeeInput,
  UpdateEmployeeProfileInput,
  MoveEmployeeInput,
} from '@deckgauge/shared';
import { revalidatePath } from 'next/cache';
import { apiRequest, authFetch } from './api';

// Mirrors OrgEmployeeAliasInputSchema from @deckgauge/shared without importing zod.
export interface OrgEmployeeAliasInput {
  provider: 'github' | 'gitlab' | 'ado' | 'jira';
  kind: 'login' | 'email' | 'name';
  value: string;
}

// Mirrors activity response interfaces from the API without importing zod.
export interface ActivityItem {
  id: string;
  title: string;
  subtitle: string;
  timestamp: string;
  url: string | null;
}

export interface EmployeeActivity {
  commits: ActivityItem[];
  pullRequests: ActivityItem[];
  assignedIssues: ActivityItem[];
}

// ---------------------------------------------------------------------------
// Org Trees
// ---------------------------------------------------------------------------

export async function listOrgTrees(): Promise<OrgTreeDto[]> {
  try {
    const res = await apiRequest('/org-trees');
    return (await res.json()) as OrgTreeDto[];
  } catch {
    return [];
  }
}

export async function getOrgTree(id: string): Promise<OrgTreeDto | null> {
  try {
    const res = await apiRequest(`/org-trees/${id}`);
    return (await res.json()) as OrgTreeDto;
  } catch {
    return null;
  }
}

export type GetOrgTreeResult =
  | { ok: true; tree: OrgTreeDto }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Like {@link getOrgTree}, but distinguishes "tree doesn't exist" (404) from
 * "tree exists but the caller lacks OrgTreeAccess on it" (403) — `getOrgTree`
 * collapses both into `null`, which is right for callers that only need a
 * tree-or-nothing (e.g. the status-rules page picking "the first tree"), but
 * wrong for the org-tree page itself: a 403 there must render an explanatory
 * "ask an owner to share it" panel, not a generic 404.
 */
export async function getOrgTreeOrDenied(id: string): Promise<GetOrgTreeResult> {
  try {
    const res = await authFetch(`/org-trees/${id}`);
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (!res.ok) return { ok: false, reason: 'not_found' };
    const tree = (await res.json()) as OrgTreeDto;
    return { ok: true, tree };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
}

export async function createOrgTree(name: string): Promise<OrgTreeDto> {
  const res = await apiRequest('/org-trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return (await res.json()) as OrgTreeDto;
}

export async function renameOrgTree(id: string, name: string): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-trees/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function deleteOrgTree(id: string): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-trees/${id}`, { method: 'DELETE' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function triggerOrgTreeSync(id: string): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-trees/${id}/sync`, { method: 'POST' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function getOrgTreeSyncStatus(id: string): Promise<SyncStatus | null> {
  try {
    const res = await apiRequest(`/org-trees/${id}/sync-status`);
    return (await res.json()) as SyncStatus;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function importOrgChart(
  id: string,
  formData: FormData,
): Promise<ImportResult> {
  // Multipart upload — do NOT set Content-Type; the browser/fetch sets the
  // correct multipart/form-data boundary automatically.
  const res = await apiRequest(`/org-trees/${id}/import`, {
    method: 'POST',
    body: formData,
  });
  return (await res.json()) as ImportResult;
}

// ---------------------------------------------------------------------------
// Employee Aliases
// ---------------------------------------------------------------------------

export async function addEmployeeAlias(
  employeeId: string,
  input: OrgEmployeeAliasInput,
): Promise<OrgEmployeeAliasDto> {
  const res = await apiRequest(`/org-employees/${employeeId}/aliases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json()) as OrgEmployeeAliasDto;
}

export async function deleteEmployeeAlias(aliasId: string): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-employee-aliases/${aliasId}`, { method: 'DELETE' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Employee CRUD + Move
// ---------------------------------------------------------------------------

export async function createEmployee(
  orgTreeId: string,
  input: CreateEmployeeInput,
): Promise<OrgEmployeeDto> {
  const res = await apiRequest(`/org-trees/${orgTreeId}/employees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json()) as OrgEmployeeDto;
}

export async function updateEmployee(
  employeeId: string,
  input: UpdateEmployeeProfileInput,
): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-employees/${employeeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function deleteEmployee(employeeId: string): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/org-employees/${employeeId}`, { method: 'DELETE' });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function moveEmployee(
  employeeId: string,
  input: MoveEmployeeInput,
): Promise<OrgEmployeeDto> {
  const res = await apiRequest(`/org-employees/${employeeId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json()) as OrgEmployeeDto;
}

// ---------------------------------------------------------------------------
// Employee Activity
// ---------------------------------------------------------------------------

export async function getEmployeeActivity(employeeId: string): Promise<EmployeeActivity> {
  try {
    const res = await apiRequest(`/org-employees/${employeeId}/activity`);
    return (await res.json()) as EmployeeActivity;
  } catch {
    return { commits: [], pullRequests: [], assignedIssues: [] };
  }
}

// ---------------------------------------------------------------------------
// Sharing (OrgTreeAccess)
// ---------------------------------------------------------------------------

// Mirrors OrgTreeAccessRoleSchema from @deckgauge/shared without importing zod.
export type OrgTreeAccessRole = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface OrgTreeAccessEntry {
  id: string;
  orgTreeId: string;
  userId: string;
  role: OrgTreeAccessRole;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
}

/**
 * Reads `body.error` off an API error response, falling back to `fallback`
 * when the body has no error, isn't JSON, or (as on a 400 Zod failure) carries
 * a flattened validation object instead of a string. Grant/update/revoke each
 * need this so a real API message — notably the 409 last-owner text — reaches
 * the caller intact instead of a generic "failed" string.
 */
async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error : fallback;
  } catch {
    return fallback;
  }
}

export async function listOrgTreeAccess(orgTreeId: string): Promise<OrgTreeAccessEntry[]> {
  try {
    const res = await authFetch(`/org-trees/${orgTreeId}/access`);
    if (!res.ok) return [];
    return (await res.json()) as OrgTreeAccessEntry[];
  } catch {
    return [];
  }
}

export type GrantOrgTreeAccessResult =
  | { ok: true; data: OrgTreeAccessEntry }
  | { ok: false; error: string };

/**
 * POST /org-trees/:id/access. Never throws — a thrown server action surfaces
 * only an opaque digest in production, hiding the API's real error (e.g. the
 * 404 "User not found" or a 409 last-owner message). Returns a result union
 * instead so the modal can render the real text.
 */
export async function grantOrgTreeAccess(
  orgTreeId: string,
  userId: string,
  role: OrgTreeAccessRole,
): Promise<GrantOrgTreeAccessResult> {
  try {
    const res = await authFetch(`/org-trees/${orgTreeId}/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    });
    if (!res.ok) {
      return { ok: false, error: await extractErrorMessage(res, 'Failed to grant access') };
    }
    const data = (await res.json()) as OrgTreeAccessEntry;
    revalidatePath(`/org/${orgTreeId}`);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to grant access' };
  }
}

export type UpdateOrgTreeAccessResult =
  | { ok: true; data: OrgTreeAccessEntry }
  | { ok: false; error: string };

/**
 * PATCH /org-trees/:id/access/:userId. The 409 last-owner-demotion message
 * must reach the caller intact — that is the whole point of this returning a
 * result union instead of throwing.
 */
export async function updateOrgTreeAccessRole(
  orgTreeId: string,
  userId: string,
  role: OrgTreeAccessRole,
): Promise<UpdateOrgTreeAccessResult> {
  try {
    const res = await authFetch(`/org-trees/${orgTreeId}/access/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      return { ok: false, error: await extractErrorMessage(res, 'Failed to update role') };
    }
    const data = (await res.json()) as OrgTreeAccessEntry;
    revalidatePath(`/org/${orgTreeId}`);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to update role' };
  }
}

export type RevokeOrgTreeAccessResult = { ok: true } | { ok: false; error: string };

/**
 * DELETE /org-trees/:id/access/:userId. Idempotent on the API side (204 even
 * when no such entry exists) but still 409s when the target is the tree's
 * last owner — that message must reach the caller intact, hence the result
 * union rather than a thrown error.
 */
export async function revokeOrgTreeAccess(
  orgTreeId: string,
  userId: string,
): Promise<RevokeOrgTreeAccessResult> {
  try {
    const res = await authFetch(`/org-trees/${orgTreeId}/access/${userId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      return { ok: false, error: await extractErrorMessage(res, 'Failed to revoke access') };
    }
    revalidatePath(`/org/${orgTreeId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to revoke access' };
  }
}
