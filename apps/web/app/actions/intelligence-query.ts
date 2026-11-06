'use server';

import { apiRequest, authFetch } from './api';
import type { IntelligenceSchema, IntelligenceSqlResponse } from '@deckgauge/shared';

export async function fetchIntelligenceSchema(boardId: string): Promise<IntelligenceSchema> {
  const res = await apiRequest(`/boards/${boardId}/intelligence/schema`);
  return res.json();
}

export interface FetchIntelligenceSqlArgs {
  boardId: string;
  widget: string;
  config?: string; // base64url-encoded JSON
  filter?: string; // '<dimension>:<value>'
}

export async function fetchIntelligenceSql(
  args: FetchIntelligenceSqlArgs,
): Promise<IntelligenceSqlResponse> {
  const qs = new URLSearchParams({ widget: args.widget });
  if (args.config) qs.set('config', args.config);
  if (args.filter) qs.set('filter', args.filter);
  const res = await apiRequest(`/boards/${args.boardId}/intelligence/sql?${qs}`);
  return res.json();
}

export interface IntelligenceQueryRow {
  [column: string]: unknown;
}

export interface RunIntelligenceQueryOk {
  ok: true;
  rows: IntelligenceQueryRow[];
  ms: number;
  scope: { github: string[]; jira: string[]; ado: string[]; gitlab: string[]; bitbucket: string[] };
  truncated: boolean;
  executedSql: string;
}

export interface RunIntelligenceQueryErr {
  ok: false;
  status: number;
  error: string;
  code: string;
}

export type RunIntelligenceQueryResult = RunIntelligenceQueryOk | RunIntelligenceQueryErr;

export async function runIntelligenceQuery(
  boardId: string,
  sql: string,
): Promise<RunIntelligenceQueryResult> {
  const res = await authFetch(`/boards/${boardId}/intelligence/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) {
    let error = 'Unknown error';
    let code = 'UNKNOWN';
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') error = body.error;
      if (typeof body?.code === 'string') code = body.code;
    } catch {
      // body was not JSON; keep defaults
    }
    return { ok: false, status: res.status, error, code };
  }
  const body = await res.json();
  return { ok: true, ...body };
}
