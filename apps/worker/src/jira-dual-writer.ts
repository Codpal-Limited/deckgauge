import type { DeveloperProfileSink } from './developer-profile-sink.js';

export interface ChClient {
  insertRows(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
}

export interface JiraDualWritePayload {
  issues: ReadonlyArray<Record<string, unknown>>;
  transitions: ReadonlyArray<Record<string, unknown>>;
  worklogs: ReadonlyArray<Record<string, unknown>>;
}

export async function writeJiraToClickHouse(
  ch: ChClient,
  payload: JiraDualWritePayload,
  profileSink?: DeveloperProfileSink,
): Promise<void> {
  if (payload.issues.length > 0) await ch.insertRows('jira_issues', payload.issues);
  if (payload.transitions.length > 0) await ch.insertRows('jira_transitions', payload.transitions);
  if (payload.worklogs.length > 0) await ch.insertRows('jira_worklogs', payload.worklogs);

  // P8.5 — fan out unique author logins to the DeveloperProfile sink. The Jira
  // row shape exposes the display-name in `assignee` / `reporter` and the
  // email in `assignee_email`. Some basic-shape rows also carry `assignee_login`
  // / `reporter_login` — prefer those when present so we key by stable login.
  // Idempotent via (provider, login) unique index.
  if (profileSink) {
    const seen = new Set<string>();
    for (const row of payload.issues) {
      const assigneeLogin =
        pickString(row, 'assignee_login') ?? pickString(row, 'assignee');
      const assigneeEmail = pickString(row, 'assignee_email');
      const reporterLogin =
        pickString(row, 'reporter_login') ?? pickString(row, 'reporter');
      if (assigneeLogin) {
        await upsertOnce(profileSink, seen, {
          provider: 'jira',
          login: assigneeLogin,
          displayName: pickString(row, 'assignee') ?? assigneeLogin,
          avatarUrl: null,
          email: assigneeEmail,
        });
      }
      if (reporterLogin) {
        await upsertOnce(profileSink, seen, {
          provider: 'jira',
          login: reporterLogin,
          displayName: pickString(row, 'reporter') ?? reporterLogin,
          avatarUrl: null,
          email: null,
        });
      }
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
    provider: 'jira';
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
// Row mapping: basic JiraPort shape → ClickHouse jira_issues row.
//
// The basic JiraPort adapter (used by jira-sync.processor) returns only summary
// metadata — no transitions, no worklogs, no story_points/labels/sprints/etc.
// The richer JiraIntelligencePort (used by jira-intelligence-sync.handler) fetches
// all of that and writes directly. This helper exists so the processor can still
// dual-write its basic data into the same jira_issues table using safe defaults
// for missing fields, using the same column mapping the original backfill used.

export interface BasicJiraEpic {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: string | null;
  status: string;
  assignee: string | null;
  updatedAt: Date;
}

export interface BasicJiraIssue {
  id: string;
  key: string;
  projectKey: string;
  epicKey: string | null;
  summary: string;
  description: string | null;
  status: string;
  assignee: string | null;
  type: string;
  updatedAt: Date;
}

// ClickHouse DateTime input wants 'YYYY-MM-DD HH:MM:SS' (no ms, no trailing Z).
function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function mapJiraToClickHouseRows(input: {
  epics: ReadonlyArray<BasicJiraEpic>;
  issues: ReadonlyArray<BasicJiraIssue>;
  instanceUrl?: string;
}): Array<Record<string, unknown>> {
  const instanceUrl = input.instanceUrl ?? '';
  const epicLookup = new Map(input.epics.map((e) => [e.key, e]));

  const epicRows = input.epics.map((e) => ({
    id: e.id,
    key: e.key,
    project_key: e.projectKey,
    project_name: '',
    issue_type: 'Epic',
    parent_key: null,
    epic_key: null,
    epic_summary: null,
    summary: e.summary,
    description: e.description ?? '',
    priority: 'None',
    labels: [],
    components: [],
    fix_versions: [],
    assignee: e.assignee ?? null,
    assignee_email: null,
    reporter: null,
    status: e.status,
    status_category: 'Unknown',
    resolution: null,
    story_points: null,
    original_estimate_s: null,
    time_spent_s: null,
    sprint_id: null,
    sprint_name: null,
    sprint_state: null,
    created_at: fmt(e.updatedAt),
    updated_at: fmt(e.updatedAt),
    resolved_at: null,
    due_date: null,
    custom_fields: '{}',
    instance_url: instanceUrl,
  }));

  const issueRows = input.issues.map((i) => ({
    id: i.id,
    key: i.key,
    project_key: i.projectKey,
    project_name: '',
    issue_type: i.type,
    parent_key: null,
    epic_key: i.epicKey ?? null,
    epic_summary: i.epicKey ? epicLookup.get(i.epicKey)?.summary ?? null : null,
    summary: i.summary,
    description: i.description ?? '',
    priority: 'None',
    labels: [],
    components: [],
    fix_versions: [],
    assignee: i.assignee ?? null,
    assignee_email: null,
    reporter: null,
    status: i.status,
    status_category: 'Unknown',
    resolution: null,
    story_points: null,
    original_estimate_s: null,
    time_spent_s: null,
    sprint_id: null,
    sprint_name: null,
    sprint_state: null,
    created_at: fmt(i.updatedAt),
    updated_at: fmt(i.updatedAt),
    resolved_at: null,
    due_date: null,
    custom_fields: '{}',
    instance_url: instanceUrl,
  }));

  return [...epicRows, ...issueRows];
}
