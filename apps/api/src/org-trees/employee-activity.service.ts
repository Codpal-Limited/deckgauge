import type { ChReadClient } from '../analytics/ch-read-scope.js';
import { isEmptyIdentities, type EmployeeIdentities } from '@deckgauge/shared';

export const ACTIVITY_LIMIT = 10;

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

type Category = 'commits' | 'pullRequests' | 'assignedIssues';

interface Source {
  category: Category;
  // Each query selects: id String, title String, subtitle String, ts String, url String
  sql: (limit: number) => string;
}

// Identity predicates reused across sources. `{logins:Array(String)}` etc. are
// bound via query_params; `has(arr, x)` is false for empty arrays.
const BY_LOGIN = `has({logins:Array(String)}, author_login)`;
const BY_AUTHOR_EMAIL = `has({emails:Array(String)}, lower(author_email))`;
const BY_AUTHOR_NAME = `has({names:Array(String)}, lower(author_name))`;

const SOURCES: Source[] = [
  {
    category: 'commits',
    sql: (n) => `SELECT sha id, message_subject title, repo_full_name subtitle,
      toString(committed_at) ts,
      concat('https://github.com/', repo_full_name, '/commit/', sha) url
      FROM github_commits FINAL
      WHERE ${BY_LOGIN} OR ${BY_AUTHOR_EMAIL}
      ORDER BY committed_at DESC LIMIT ${n}`,
  },
  {
    category: 'commits',
    sql: (n) => `SELECT sha id, message_subject title, repo_name subtitle,
      toString(committed_at) ts, '' url
      FROM ado_commits FINAL
      WHERE ${BY_AUTHOR_NAME} OR ${BY_AUTHOR_EMAIL}
      ORDER BY committed_at DESC LIMIT ${n}`,
  },
  {
    category: 'pullRequests',
    sql: (n) => `SELECT toString(number) id, title, repo_full_name subtitle,
      toString(created_at) ts,
      concat('https://github.com/', repo_full_name, '/pull/', toString(number)) url
      FROM github_pull_requests FINAL
      WHERE ${BY_LOGIN}
      ORDER BY created_at DESC LIMIT ${n}`,
  },
  {
    category: 'pullRequests',
    sql: (n) => `SELECT toString(pr_id) id, title, concat(project, '/', repo_name) subtitle,
      toString(created_at) ts, '' url
      FROM ado_pull_requests FINAL
      WHERE has({logins:Array(String)}, created_by_login) OR has({names:Array(String)}, lower(created_by_name))
      ORDER BY created_at DESC LIMIT ${n}`,
  },
  {
    category: 'assignedIssues',
    sql: (n) => `SELECT key id, summary title, project_key subtitle,
      toString(updated_at) ts, concat(instance_url, '/browse/', key) url
      FROM jira_issues FINAL
      WHERE has({emails:Array(String)}, lower(assignee_email)) OR has({names:Array(String)}, lower(assignee))
      ORDER BY updated_at DESC LIMIT ${n}`,
  },
  {
    category: 'assignedIssues',
    sql: (n) => `SELECT toString(ado_id) id, title, project subtitle,
      toString(updated_at) ts, '' url
      FROM ado_work_items FINAL
      WHERE has({names:Array(String)}, lower(assigned_to)) OR has({emails:Array(String)}, lower(assigned_to_email))
      ORDER BY updated_at DESC LIMIT ${n}`,
  },
  {
    category: 'assignedIssues',
    sql: (n) => `SELECT toString(number) id, title, repo_full_name subtitle,
      toString(updated_at) ts,
      concat('https://github.com/', repo_full_name, '/issues/', toString(number)) url
      FROM github_issues FINAL
      WHERE has({logins:Array(String)}, assignee_login)
      ORDER BY updated_at DESC LIMIT ${n}`,
  },
];

interface RawRow {
  id: string;
  title: string;
  subtitle: string;
  ts: string;
  url: string;
}

export class EmployeeActivityService {
  constructor(private readonly ch: ChReadClient) {}

  /**
   * Union the employee's alias logins with GitHub logins learned from
   * github_commits. GitHub PR and issue rows are matched by `author_login` /
   * `assignee_login` only — those tables carry no email and a null display name —
   * so an employee identified purely by email/name (no login alias, e.g. a
   * directory-synced tree) never matched their own PRs even though their commits
   * matched (the commit source also matches by email). github_commits carries both
   * login and email/name, so we bridge: any login that committed under one of the
   * employee's emails/names is theirs. Degrades to the alias logins on query error.
   */
  private async expandGithubLogins(ids: EmployeeIdentities): Promise<string[]> {
    if (ids.emails.length === 0 && ids.names.length === 0) return ids.logins;
    try {
      const res = await this.ch.query({
        query: `SELECT DISTINCT author_login FROM github_commits
          WHERE author_login != ''
          AND (has({emails:Array(String)}, lower(author_email))
               OR has({names:Array(String)}, lower(author_name)))`,
        query_params: { emails: ids.emails, names: ids.names },
        format: 'JSONEachRow',
      });
      const rows = (await res.json()) as Array<{ author_login: string }>;
      return [...new Set([...ids.logins, ...rows.map((r) => r.author_login)])];
    } catch {
      return ids.logins;
    }
  }

  async forEmployee(
    ids: EmployeeIdentities,
    limit: number = ACTIVITY_LIMIT,
  ): Promise<EmployeeActivity> {
    const empty: EmployeeActivity = { commits: [], pullRequests: [], assignedIssues: [] };
    if (isEmptyIdentities(ids)) return empty;

    const logins = await this.expandGithubLogins(ids);
    const params = { logins, emails: ids.emails, names: ids.names };
    const buckets: Record<Category, ActivityItem[]> = {
      commits: [],
      pullRequests: [],
      assignedIssues: [],
    };

    await Promise.all(
      SOURCES.map(async (source) => {
        try {
          const res = await this.ch.query({
            query: source.sql(limit),
            query_params: params,
            format: 'JSONEachRow',
          });
          const rows = (await res.json()) as RawRow[];
          for (const r of rows) {
            buckets[source.category].push({
              id: r.id,
              title: r.title,
              subtitle: r.subtitle,
              timestamp: r.ts,
              url: r.url ? r.url : null,
            });
          }
        } catch {
          // ClickHouse unreachable or a table missing — degrade to empty for
          // this source; never break the drawer.
        }
      }),
    );

    const cap = (items: ActivityItem[]) =>
      [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);

    return {
      commits: cap(buckets.commits),
      pullRequests: cap(buckets.pullRequests),
      assignedIssues: cap(buckets.assignedIssues),
    };
  }
}
