'use server';

import { revalidatePath } from 'next/cache';
import type { OrgTreeTimesheetConfigDto } from '@deckgauge/shared';
import { apiRequest } from './api';
import {
  OrgTreeStatusBucketsResultSchema,
  PooledStatusSchema,
  type OrgTreeStatusBucketsResult,
  type PooledStatus,
} from '@deckgauge/shared';

/**
 * Every status the tree's people have been in, with what it currently MEANS.
 *
 * Consumed by the Time rules drawer, which replaced `ActiveStatusPicker`.
 */
export async function fetchOrgTreeStatusPool(orgTreeId: string): Promise<PooledStatus[]> {
  try {
    const res = await apiRequest(`/org-trees/${orgTreeId}/timesheet-status-pool`);
    // `parse`, not a cast. The cast that stood here is what let this function's
    // only test go on asserting a `string[]` the API can no longer produce —
    // the shape was never checked at runtime, so the stale test still passed.
    return PooledStatusSchema.array().parse(await res.json());
  } catch {
    return [];
  }
}

export async function fetchOrgTreeTimesheetConfig(
  orgTreeId: string,
): Promise<OrgTreeTimesheetConfigDto | null> {
  try {
    const res = await apiRequest(`/org-trees/${orgTreeId}/timesheet-config`);
    return (await res.json()) as OrgTreeTimesheetConfigDto | null;
  } catch {
    return null;
  }
}

/**
 * Save what each status MEANS, and get back the statuses that now count.
 *
 * The BUCKETS endpoint, not `timesheet-config`. Both write `activeStatuses` and
 * only this one DERIVES it — routing a bucket save through the older endpoint
 * would send an arbitrary list and lose the derivation that is the whole
 * guarantee of the write path.
 *
 * Unlike the fetches above this does NOT swallow its error. A failed read can
 * degrade to an empty picker, but a failed write that reports success would
 * leave the operator believing the hours had moved.
 */
export async function saveOrgTreeStatusBuckets(
  orgTreeId: string,
  decisions: PooledStatus[],
): Promise<OrgTreeStatusBucketsResult> {
  const res = await apiRequest(`/org-trees/${orgTreeId}/timesheet-status-buckets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions }),
  });
  // `parse`, not a cast — see `OrgTreeStatusBucketsResultSchema`.
  const parsed = OrgTreeStatusBucketsResultSchema.parse(await res.json());
  // A bucket save changes the numbers on the timesheet and on the org page, not
  // only inside the drawer. Without these the operator saves, closes the panel
  // and reads the old hours.
  revalidatePath('/timesheet');
  revalidatePath(`/org/${orgTreeId}`);
  revalidatePath('/settings/timesheet-statuses');
  return parsed;
}

/**
 * Save the per-day hours cap, and NOTHING else.
 *
 * Names only `dailyCapHours`, because the config row now has two writers with
 * disjoint fields: the Time rules drawer derives `activeStatuses`, this owns
 * the cap. Restating a status list here would send the one the page read on
 * load and clobber whatever the drawer derived in between — the double-writer
 * the slice-2b-iii review asked slice 2c to close.
 *
 * `null` is SENT, not omitted. Omitting the field means "leave the cap as it
 * is"; `null` means "use the engine default", which is the opposite of leaving
 * it. `0` is a third thing again — uncapped.
 */
export async function saveOrgTreeDailyCap(
  orgTreeId: string,
  dailyCapHours: number | null,
): Promise<OrgTreeTimesheetConfigDto> {
  const res = await apiRequest(`/org-trees/${orgTreeId}/timesheet-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyCapHours }),
  });
  revalidatePath('/settings/timesheet-statuses');
  return (await res.json()) as OrgTreeTimesheetConfigDto;
}
