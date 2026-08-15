'use server';

import type {
  StatusRuleDto,
  TimesheetGridResponse,
  IntervalsResponse,
  CapexReportResponse,
  EpicBreakdownResponse,
} from '@deckgauge/shared';
import { revalidatePath } from 'next/cache';
import { apiRequest, authFetch } from './api';

// Mirrors the PUT status-rules rule shape from @deckgauge/shared without importing zod.
export interface StatusRuleInput {
  scope: 'ROLE' | 'EMPLOYEE';
  role: string | null;
  employeeId: string | null;
  inProgressStatuses: string[];
}

export async function fetchStatusRules(): Promise<StatusRuleDto[]> {
  try {
    const res = await apiRequest('/timesheet/status-rules');
    return (await res.json()) as StatusRuleDto[];
  } catch {
    return [];
  }
}

export async function saveStatusRules(rules: StatusRuleInput[]): Promise<StatusRuleDto[]> {
  const res = await apiRequest('/timesheet/status-rules', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
  revalidatePath('/timesheet/status-rules');
  return (await res.json()) as StatusRuleDto[];
}

export interface GridQueryArgs {
  orgTreeId: string;
  from: string;
  to: string;
  granularity: 'day' | 'week' | 'month';
  mode: 'normalized' | 'raw';
}

export interface IntervalsQueryArgs {
  orgTreeId: string;
  issueKey: string;
  employeeId: string;
  from: string;
  to: string;
}

export async function fetchIntervals(q: IntervalsQueryArgs): Promise<IntervalsResponse> {
  const params = new URLSearchParams({ orgTreeId: q.orgTreeId, issueKey: q.issueKey, employeeId: q.employeeId, from: q.from, to: q.to });
  try {
    const res = await apiRequest(`/timesheet/intervals?${params.toString()}`);
    return (await res.json()) as IntervalsResponse;
  } catch {
    return { issueKey: q.issueKey, employeeId: q.employeeId, intervals: [] };
  }
}

export interface ReportQueryArgs {
  orgTreeId: string;
  from: string;
  to: string;
  granularity: 'day' | 'week' | 'month';
  mode: 'normalized' | 'raw';
  groupBy?: 'team' | 'role' | 'person';
}

export interface EpicBreakdownQueryArgs {
  orgTreeId: string;
  from: string;
  to: string;
  mode: 'normalized' | 'raw';
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Org-tree-scoped fetches that distinguish a 401 and a 403
// ---------------------------------------------------------------------------
//
// `/timesheet/grid`, `/timesheet/capex-report`, and `/timesheet/epic-breakdown`
// require BOTH the analytics realm role AND VIEWER on the named org tree (see
// apps/api/src/timesheet/timesheet.routes.ts's TIMESHEET_TREE policy). These
// three are the ONLY way this app reads them.
//
// Each previously had a swallowing twin (`fetchTimesheetGrid`,
// `fetchCapexReport`, `fetchEpicBreakdown`) that collapsed every failure —
// including a 403 — into `null`, so a permissions denial rendered the exact
// same "the analytics backend may be unavailable" copy as a real
// ClickHouse/Node-heap outage: a denied user had no way to tell "wait for
// infra" apart from "ask an admin for the analytics role, or an owner to
// share this tree", and picked the wrong remedy. Those twins are deleted, not
// merely unused: exported from a `'use server'` module they were live
// server-action endpoints, reachable regardless of whether any component
// called them.
//
// The rule: a read of these three routes goes through a variant that reports
// WHY it failed. Do not reintroduce a `Promise<T | null>` wrapper around them.
//
// 401 is kept separate from 403 for the same reason 403 is kept separate from
// everything else: the remedy differs. A 403 means "ask an admin for the
// analytics role, or an owner to share this tree"; a 401 means "your session
// expired — sign in again". Folding 401 into `unknown` renders an expired
// session as an infra incident and sends the user to the wrong remedy, which
// is the exact defect this block exists to prevent, one status code over.
//
// The rule for anything added here later: a status whose remedy is different
// gets its own reason. `unknown` is for failures the user can do nothing about.

export type TimesheetDenialReason = 'forbidden' | 'unauthenticated' | 'unknown';

export type TimesheetForbiddenResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: TimesheetDenialReason };

export async function fetchTimesheetGridForTree(
  q: GridQueryArgs,
): Promise<TimesheetForbiddenResult<TimesheetGridResponse>> {
  const params = new URLSearchParams({
    orgTreeId: q.orgTreeId,
    from: q.from,
    to: q.to,
    granularity: q.granularity,
    mode: q.mode,
  });
  try {
    const res = await authFetch(`/timesheet/grid?${params.toString()}`);
    if (res.status === 401) return { ok: false, reason: 'unauthenticated' };
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (!res.ok) return { ok: false, reason: 'unknown' };
    return { ok: true, data: (await res.json()) as TimesheetGridResponse };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

export async function fetchCapexReportForTree(
  q: ReportQueryArgs,
): Promise<TimesheetForbiddenResult<CapexReportResponse>> {
  const params = new URLSearchParams({
    orgTreeId: q.orgTreeId,
    from: q.from,
    to: q.to,
    granularity: q.granularity,
    mode: q.mode,
  });
  if (q.groupBy) params.set('groupBy', q.groupBy);
  try {
    const res = await authFetch(`/timesheet/capex-report?${params.toString()}`);
    if (res.status === 401) return { ok: false, reason: 'unauthenticated' };
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (!res.ok) return { ok: false, reason: 'unknown' };
    return { ok: true, data: (await res.json()) as CapexReportResponse };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

export async function fetchEpicBreakdownForTree(
  q: EpicBreakdownQueryArgs,
): Promise<TimesheetForbiddenResult<EpicBreakdownResponse>> {
  const params = new URLSearchParams({
    orgTreeId: q.orgTreeId,
    from: q.from,
    to: q.to,
    mode: q.mode,
  });
  if (q.limit != null) params.set('limit', String(q.limit));
  if (q.offset != null) params.set('offset', String(q.offset));
  try {
    const res = await authFetch(`/timesheet/epic-breakdown?${params.toString()}`);
    if (res.status === 401) return { ok: false, reason: 'unauthenticated' };
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (!res.ok) return { ok: false, reason: 'unknown' };
    return { ok: true, data: (await res.json()) as EpicBreakdownResponse };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}
