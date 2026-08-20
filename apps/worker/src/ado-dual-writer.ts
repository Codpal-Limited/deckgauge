// apps/worker/src/ado-dual-writer.ts
import type { ChClient, ChClientFactory } from './jira-dual-writer.js';
import type { DeveloperProfileSink } from './developer-profile-sink.js';
import type { AzureDevOpsWorkItem } from '@deckgauge/shared';

// The dual-writer stays tenant-agnostic: it receives an already-bound client and
// never sees an organizationId. Binding happens one level up, in the handler's
// per-instance loop (see ChClientFactory).
export type { ChClient, ChClientFactory };

export interface AdoDualWritePayload {
  workItems: ReadonlyArray<Record<string, unknown>>;
  transitions: ReadonlyArray<Record<string, unknown>>;
  pullRequests: ReadonlyArray<Record<string, unknown>>;
}

export async function writeAdoToClickHouse(
  ch: ChClient,
  payload: AdoDualWritePayload,
  profileSink?: DeveloperProfileSink,
): Promise<void> {
  if (payload.workItems.length > 0) await ch.insertRows('ado_work_items', payload.workItems);
  if (payload.transitions.length > 0) await ch.insertRows('ado_transitions', payload.transitions);
  if (payload.pullRequests.length > 0)
    await ch.insertRows('ado_pull_requests', payload.pullRequests);

  // P8.5 — fan out unique PR author logins to the DeveloperProfile sink.
  // ADO PR rows (per ado-pr-adapter.ts) expose `created_by_login` (stable
  // uniqueName/displayName fallback) and `created_by_name` (display name).
  // We skip work items since their `assigned_to` field is a display string
  // without a clean login. Idempotent via (provider, login) unique index.
  if (profileSink) {
    const seen = new Set<string>();
    for (const row of payload.pullRequests) {
      const login = pickString(row, 'created_by_login') ?? pickString(row, 'author_login');
      if (!login) continue;
      await upsertOnce(profileSink, seen, {
        provider: 'ado',
        login,
        displayName: pickString(row, 'created_by_name') ?? login,
        avatarUrl: null,
        email: null,
      });
    }
  }
}

function pickString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function upsertOnce(
  sink: DeveloperProfileSink,
  seen: Set<string>,
  input: {
    provider: 'ado';
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
    email: string | null;
  },
): Promise<void> {
  const key = `${input.provider}:${input.login}`;
  if (seen.has(key)) return;
  seen.add(key);
  await sink.upsertOnSync(input);
}

// ──────────────────────────────────────────────────────────────────────────────
// Basic-shape dual-write (P4.6): the AzureDevOpsPort adapter used by
// azure-devops-sync.processor returns only the thin `AzureDevOpsWorkItem`
// shape — no PRs, no transitions, no rich field set. The richer `AdoPrPort`
// used by ado-intelligence-sync.handler fetches PR data separately. This
// helper lets the basic processor still dual-write its work items into the
// matching `ado_work_items` ClickHouse table. ReplacingMergeTree merges the
// rows with any richer data future intelligence handlers may write into the
// same table, using the same column mapping the original backfill used.

export interface AdoBasicDualWritePayload {
  workItems: ReadonlyArray<Record<string, unknown>>;
  transitions?: ReadonlyArray<Record<string, unknown>>;
}

export async function writeAdoBasicToClickHouse(
  ch: ChClient,
  payload: AdoBasicDualWritePayload,
): Promise<void> {
  if (payload.workItems.length > 0) await ch.insertRows('ado_work_items', payload.workItems);
  if (payload.transitions && payload.transitions.length > 0) {
    await ch.insertRows('ado_transitions', payload.transitions);
  }
}

// ClickHouse DateTime input wants 'YYYY-MM-DD HH:MM:SS' (no ms, no trailing Z).
function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtOrNull(d: Date | null | undefined): string | null {
  return d ? fmt(d) : null;
}

export function mapAdoToClickHouseRows(input: {
  workItems: ReadonlyArray<AzureDevOpsWorkItem>;
  orgUrl: string;
  project: string;
  instanceId: string;
}): Array<Record<string, unknown>> {
  return input.workItems.map((w) => ({
    id: `${input.orgUrl}/${input.project}#${w.adoId}`,
    ado_id: w.adoId,
    org_url: input.orgUrl,
    project: input.project,
    area_path: w.areaPath ?? '',
    iteration_path: w.iterationPath ?? '',
    work_item_type: w.type,
    title: w.title,
    description: w.description ?? '',
    state: w.state,
    reason: null,
    priority: null,
    assigned_to: w.assignedTo ?? null,
    assigned_to_email: null,
    created_by: null,
    changed_by: null,
    parent_ado_id: w.adoParentId ?? null,
    story_points: null,
    remaining_work: null,
    completed_work: null,
    tags: [],
    sprint_name: null,
    sprint_path: null,
    custom_fields: '{}',
    created_at: fmt(w.createdAt),
    updated_at: fmt(w.changedAt),
    closed_at: fmtOrNull(w.closedAt),
    instance_id: input.instanceId,
  }));
}
