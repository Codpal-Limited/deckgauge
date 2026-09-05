// EI-008 — JiraIntelligenceAdapter (peer to JiraCloudAdapter for analytics fetches).

import { chDate, chDateTime, chDateTimeRequired } from './clickhouse-datetime.js';

export interface JiraIntelligenceFetchOpts {
  projectKeys: string[];
  since?: Date;
  pageSize?: number;
  maxPages?: number;
  // When provided, each page is handed to onBatch as it is fetched and is NOT
  // accumulated in the returned arrays. This keeps peak memory bounded to a
  // single page — mirrors the ADO streaming sync — so large projects don't OOM
  // the worker. When omitted, all pages are accumulated and returned (legacy).
  onBatch?: (batch: { issues: JiraIssueRow[]; transitions: JiraTransitionRow[] }) => Promise<void>;
}

export interface JiraIssueRow {
  id: string;
  key: string;
  project_key: string;
  project_name: string;
  issue_type: string;
  parent_key: string | null;
  epic_key: string | null;
  epic_summary: string | null;
  summary: string;
  description: string;
  priority: string;
  labels: string[];
  components: string[];
  fix_versions: string[];
  assignee: string | null;
  assignee_email: string | null;
  reporter: string | null;
  status: string;
  status_category: string;
  resolution: string | null;
  story_points: number | null;
  original_estimate_s: number | null;
  time_spent_s: number | null;
  sprint_id: string | null;
  sprint_name: string | null;
  sprint_state: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  due_date: string | null;
  custom_fields: string;
  instance_url: string;
}

export interface JiraTransitionRow {
  id: string;
  issue_key: string;
  project_key: string;
  issue_type: string;
  assignee: string | null;
  from_status: string;
  from_category: string;
  to_status: string;
  to_category: string;
  transitioned_by: string | null;
  transitioned_at: string;
  time_in_prev_status_s: number;
}

export interface JiraWorklogRow {
  id: string;
  issue_key: string;
  project_key: string;
  author: string;
  author_email: string | null;
  time_spent_s: number;
  started_at: string;
  created_at: string;
}

export interface JiraIntelligencePort {
  fetchIssuesWithChangelog(opts: JiraIntelligenceFetchOpts): Promise<{
    issues: JiraIssueRow[];
    transitions: JiraTransitionRow[];
  }>;
  fetchWorklogs(issueKey: string, projectKey: string): Promise<JiraWorklogRow[]>;
}

interface JiraIntelligenceAdapterConfig {
  atlassianUrl: string;
  email: string;
  apiToken: string;
  fetchFn?: typeof fetch;
}

interface RawSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: RawIssue[];
}

interface RawIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    issuetype?: { name: string };
    priority?: { name: string };
    labels?: string[];
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter?: { displayName: string } | null;
    status?: { name: string; statusCategory?: { name: string } };
    resolution?: { name: string } | null;
    project?: { key: string; name: string };
    parent?: { key: string };
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    duedate?: string | null;
    timeoriginalestimate?: number | null;
    timespent?: number | null;
  };
  changelog?: {
    histories: Array<{
      id?: string;
      author?: { displayName: string };
      created: string;
      items: Array<{ field: string; fromString: string | null; toString: string | null }>;
    }>;
  };
}

interface RawWorklogResponse {
  worklogs: Array<{
    id: string;
    author: { displayName: string; emailAddress?: string };
    timeSpentSeconds: number;
    started: string;
    created: string;
  }>;
}

function plain(text: unknown): string {
  if (typeof text === 'string') return text;
  if (text == null) return '';
  try {
    return JSON.stringify(text);
  } catch {
    return '';
  }
}

function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

function statusCategoryOf(category?: { name: string }): string {
  return category?.name ?? 'Unknown';
}

export interface ExtractedSprint {
  id: string | null;
  name: string;
  state: string | null;
}

// A Jira Cloud sprint object as it appears inside the (tenant-specific) sprint
// custom field. `boardId` is the discriminator: only sprint objects carry it,
// so it lets us tell the sprint field apart from other object-valued custom
// fields without hardcoding a field id.
interface RawSprint {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  boardId?: unknown;
}

function isSprintObject(v: unknown): v is RawSprint & { name: string; state: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string' && typeof o.state === 'string' && 'boardId' in o;
}

// Jira exposes sprints via a custom field whose numeric id varies per tenant
// (customfield_10020 on many instances, customfield_10021 on Acme, …), so we
// locate it by shape rather than by id. The field's value is an array of sprint
// objects; an issue carried across sprints lists them oldest-first, so the last
// element is the current/most-recent sprint — the one Jira's own board surfaces
// and the one we attribute the issue's completion to. State is lowercased so it
// matches the `sprint_state = 'closed'` filter used by the planning-accuracy and
// velocity builders (Jira Server returns 'CLOSED', Cloud returns 'closed').
export function extractSprint(fields: Record<string, unknown>): ExtractedSprint | null {
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('customfield_')) continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    const sprints = value.filter(isSprintObject);
    if (sprints.length === 0) continue;
    const latest = sprints[sprints.length - 1]!;
    return {
      id: latest.id != null ? String(latest.id) : null,
      name: latest.name,
      state: latest.state.toLowerCase(),
    };
  }
  return null;
}

export class JiraIntelligenceAdapter implements JiraIntelligencePort {
  private readonly baseUrl: string;
  private readonly authHeaderValue: string;
  private readonly atlassianUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: JiraIntelligenceAdapterConfig) {
    this.baseUrl = cfg.atlassianUrl.replace(/\/+$/, '');
    this.atlassianUrl = this.baseUrl;
    this.authHeaderValue = basicAuth(cfg.email, cfg.apiToken);
    this.doFetch = cfg.fetchFn ?? fetch;
  }

  async fetchIssuesWithChangelog(opts: JiraIntelligenceFetchOpts): Promise<{
    issues: JiraIssueRow[];
    transitions: JiraTransitionRow[];
  }> {
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 200;
    const keys = opts.projectKeys.map((k) => `"${k}"`).join(',');
    const sinceJql = opts.since
      ? ` AND updated >= "${opts.since.toISOString().replace('T', ' ').replace(/\..*$/, '')}"`
      : '';
    const jql = `project IN (${keys})${sinceJql} ORDER BY updated DESC`;

    const issues: JiraIssueRow[] = [];
    const transitions: JiraTransitionRow[] = [];

    // Atlassian deprecated GET /rest/api/3/search in May 2025 (returns 410 Gone).
    // Replacement: POST /rest/api/3/search/jql with cursor pagination via
    // nextPageToken, plus JQL + expand + fields in the JSON body.
    let nextPageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const url = `${this.baseUrl}/rest/api/3/search/jql`;
      const body: Record<string, unknown> = {
        jql,
        maxResults: pageSize,
        expand: 'changelog',
        fields: ['*all'],
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;

      const resp = await this.doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeaderValue,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`Jira ${resp.status} ${resp.statusText} for ${url}`);
      const json = (await resp.json()) as RawSearchResponse & {
        nextPageToken?: string;
        isLast?: boolean;
      };
      if (!Array.isArray(json.issues) || json.issues.length === 0) break;

      const pageIssues: JiraIssueRow[] = [];
      const pageTransitions: JiraTransitionRow[] = [];
      for (const raw of json.issues) {
        pageIssues.push(this.transformIssue(raw));
        for (const tr of this.transformTransitions(raw)) {
          pageTransitions.push(tr);
        }
      }
      if (opts.onBatch) {
        // Streaming mode: flush this page and drop it — peak memory stays at one page.
        await opts.onBatch({ issues: pageIssues, transitions: pageTransitions });
      } else {
        issues.push(...pageIssues);
        transitions.push(...pageTransitions);
      }
      if (json.isLast || !json.nextPageToken) break;
      nextPageToken = json.nextPageToken;
    }
    return { issues, transitions };
  }

  async fetchWorklogs(issueKey: string, projectKey: string): Promise<JiraWorklogRow[]> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`;
    const resp = await this.jira<RawWorklogResponse>(url);
    return resp.worklogs.map((w) => ({
      id: w.id,
      issue_key: issueKey,
      project_key: projectKey,
      author: w.author.displayName,
      author_email: w.author.emailAddress ?? null,
      time_spent_s: w.timeSpentSeconds,
      started_at: chDateTimeRequired(w.started),
      created_at: chDateTimeRequired(w.created),
    }));
  }

  private async jira<T>(url: string): Promise<T> {
    const resp = await this.doFetch(url, {
      headers: {
        Authorization: this.authHeaderValue,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`Jira ${resp.status} ${resp.statusText} for ${url}`);
    return (await resp.json()) as T;
  }

  private transformIssue(raw: RawIssue): JiraIssueRow {
    const f = raw.fields;
    const customFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith('customfield_')) customFields[k] = v;
    }
    const storyPointsRaw = f['customfield_10016'];
    const sprint = extractSprint(f);
    return {
      id: raw.id,
      key: raw.key,
      project_key: f.project?.key ?? '',
      project_name: f.project?.name ?? '',
      issue_type: f.issuetype?.name ?? 'Unknown',
      parent_key: f.parent?.key ?? null,
      epic_key: typeof f['customfield_10014'] === 'string' ? (f['customfield_10014'] as string) : null,
      epic_summary: null,
      summary: f.summary ?? '',
      description: plain(f.description),
      priority: f.priority?.name ?? 'None',
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name),
      fix_versions: (f.fixVersions ?? []).map((v) => v.name),
      assignee: f.assignee?.displayName ?? null,
      assignee_email: f.assignee?.emailAddress ?? null,
      reporter: f.reporter?.displayName ?? null,
      status: f.status?.name ?? 'Unknown',
      status_category: statusCategoryOf(f.status?.statusCategory),
      resolution: f.resolution?.name ?? null,
      story_points: typeof storyPointsRaw === 'number' ? storyPointsRaw : null,
      original_estimate_s: f.timeoriginalestimate ?? null,
      time_spent_s: f.timespent ?? null,
      sprint_id: sprint?.id ?? null,
      sprint_name: sprint?.name ?? null,
      sprint_state: sprint?.state ?? null,
      created_at: chDateTimeRequired(f.created),
      updated_at: chDateTimeRequired(f.updated),
      resolved_at: chDateTime(f.resolutiondate),
      due_date: chDate(f.duedate),
      custom_fields: JSON.stringify(customFields),
      instance_url: this.atlassianUrl,
    };
  }

  private transformTransitions(raw: RawIssue): JiraTransitionRow[] {
    if (!raw.changelog?.histories) return [];
    const out: JiraTransitionRow[] = [];
    const issueType = raw.fields.issuetype?.name ?? 'Unknown';
    const projectKey = raw.fields.project?.key ?? '';
    const assignee = raw.fields.assignee?.displayName ?? null;
    let prevTime = Date.parse(raw.fields.created ?? '');

    const sorted = [...raw.changelog.histories].sort(
      (a, b) => Date.parse(a.created) - Date.parse(b.created),
    );

    for (const h of sorted) {
      for (const item of h.items) {
        if (item.field !== 'status') continue;
        const transitionedAtMs = Date.parse(h.created);
        const fromStatus = item.fromString ?? 'Unknown';
        const toStatus = item.toString ?? 'Unknown';
        out.push({
          id: `${raw.key}_${Math.floor(transitionedAtMs / 1000)}`,
          issue_key: raw.key,
          project_key: projectKey,
          issue_type: issueType,
          assignee,
          from_status: fromStatus,
          from_category: 'Unknown',
          to_status: toStatus,
          to_category: 'Unknown',
          transitioned_by: h.author?.displayName ?? null,
          transitioned_at: chDateTimeRequired(h.created),
          time_in_prev_status_s:
            !Number.isNaN(prevTime) && !Number.isNaN(transitionedAtMs)
              ? Math.max(0, Math.floor((transitionedAtMs - prevTime) / 1000))
              : 0,
        });
        prevTime = transitionedAtMs;
      }
    }
    return out;
  }
}

export class FakeJiraIntelligenceAdapter implements JiraIntelligencePort {
  constructor(
    private readonly seed: {
      issues: JiraIssueRow[];
      transitions: JiraTransitionRow[];
      worklogs?: Record<string, JiraWorklogRow[]>;
    },
  ) {}
  async fetchIssuesWithChangelog(_opts: JiraIntelligenceFetchOpts) {
    return { issues: this.seed.issues, transitions: this.seed.transitions };
  }
  async fetchWorklogs(issueKey: string, _projectKey: string) {
    return this.seed.worklogs?.[issueKey] ?? [];
  }
}
