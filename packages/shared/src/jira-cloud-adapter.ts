import { JiraPort, JiraIssueExistence, JiraCredentialState } from "./jira-port.js";
import { JiraEpic, JiraIssue } from "./jira-schemas.js";
import { JiraConfig } from "./jira-config-schema.js";
import { extractPlainText } from './adf-to-plain-text.js';
import { JiraFieldMetaSchema, type JiraFieldMeta } from "./jira-field-schemas.js";

export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraAuthError";
  }
}

export class JiraCircuitOpenError extends Error {
  constructor(message: string = "Jira circuit breaker is open") {
    super(message);
    this.name = "JiraCircuitOpenError";
  }
}

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssueResponse[];
}

interface JiraIssueResponse {
  id: string;
  key: string;
  fields: {
    project: { key: string };
    summary: string;
    status: { name: string };
    assignee?: { emailAddress: string } | null;
    updated: string;
    duedate?: string | null;
    [key: string]: unknown;
  };
}

/** What a project lookup could establish about the caller's view of a project. */
type JiraProjectVisibility = "visible" | "unavailable" | "unknown";

/**
 * The project key an issue key belongs to. Jira project keys are alphanumeric
 * and carry no hyphen, so everything before the LAST hyphen is the project.
 * Anything that is not shaped like an issue key yields null, and a null is never
 * corroborated into a deletion.
 */
function projectKeyOf(issueKey: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(issueKey.trim());
  return match?.[1] ?? null;
}

/**
 * The fields every sync has always requested, regardless of the board's
 * field mappings. Shared by the request builder and the `extra` filter so
 * the two agree on what "baseline" means — a field in this list is never
 * duplicated into `extra`.
 */
const BASELINE_FIELDS = [
  "summary",
  "description",
  "status",
  "assignee",
  "issuetype",
  "updated",
  "customfield_10014",
  "project",
  "duedate",
] as const;

export class JiraCloudAdapter implements JiraPort {
  private config: JiraConfig;
  private delayFn: (ms: number) => Promise<void>;
  private consecutiveFailures: number = 0;
  private circuitOpen: boolean = false;
  private readonly circuitThreshold: number = 3;

  constructor(config: JiraConfig, delayFn?: (ms: number) => Promise<void>) {
    this.config = config;
    this.delayFn = delayFn || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  private getBasicAuthHeader(): string {
    const credentials = `${this.config.email}:${this.config.apiToken}`;
    return `Basic ${Buffer.from(credentials).toString("base64")}`;
  }

  async fetchEpics(projectKeys: string[], extraFields: string[] = []): Promise<JiraEpic[]> {
    const jql = this.buildJql(projectKeys, true);
    return this.fetchPaginated(
      jql,
      (issue) => this.mapToEpic(issue, extraFields),
      this.fieldsFor(extraFields),
    );
  }

  async fetchIssues(projectKeys: string[], extraFields: string[] = []): Promise<JiraIssue[]> {
    const jql = this.buildJql(projectKeys, false);
    return this.fetchPaginated(
      jql,
      (issue) => this.mapToIssue(issue, extraFields),
      this.fieldsFor(extraFields),
    );
  }

  async fetchIssueKeys(jql: string): Promise<string[]> {
    return this.fetchPaginated(jql, (issue) => issue.key, ["key"]);
  }

  /**
   * Deduped: a mapped field may coincide with a baseline one (someone can map
   * "duedate" as its own column), and Jira should not be asked twice.
   */
  private fieldsFor(extraFields: string[] = []): string[] {
    return Array.from(new Set([...BASELINE_FIELDS, ...extraFields]));
  }

  /**
   * Attaches only the requested extras, and only those Jira actually
   * returned. A mapped custom field that Jira does not send back (deleted,
   * or the issue type does not carry it) stays absent from `extra` rather
   * than becoming `null` — that distinction is what lets the promote step
   * tell "Jira didn't send this" from "Jira sent an empty value".
   */
  private extraFrom(
    fields: Record<string, unknown>,
    extraFields: string[],
  ): Record<string, unknown> | undefined {
    if (extraFields.length === 0) return undefined;
    const extra: Record<string, unknown> = {};
    for (const id of extraFields) {
      if (fields[id] !== undefined) extra[id] = fields[id];
    }
    return extra;
  }

  /**
   * One issue, one request, no retries: a 404 is the answer, not a failure.
   *
   * Jira answers 404 both for a deleted issue and for one this connection may no
   * longer see (issue-level security, a move into a restricted project) — the
   * response body is identical, so the two are indistinguishable and both read
   * as `deleted`. An issue MOVED to another project keeps resolving by its old
   * key, so a move alone answers 200 / `exists`.
   *
   * Every other outcome is `unknown` rather than an exception: the caller uses
   * this to decide whether to mark a board row deleted, and an outage must never
   * be able to do that. An open circuit answers `unknown` for the same reason.
   */
  /**
   * Whether this connection's credential still authenticates.
   *
   * `/myself` rather than anything a sync already calls, because Jira serves an
   * expired token ANONYMOUSLY on the sync's endpoints: `/search/jql` answers 200
   * with an empty result set and `GET /issue/{key}` answers 404, so a dead
   * credential is indistinguishable from an empty project and a deleted issue.
   * `/myself` requires a user and answers 401 when there is not one.
   *
   * Anything other than a definite answer about the credential is `unknown` —
   * an outage must never be reported as an expired token.
   */
  /**
   * Corroboration memos, deliberately per ADAPTER INSTANCE — one is built per
   * sync run, so these answer once a run rather than once a key. A board
   * draining a deletion backlog probes up to 200 keys in a run; paying two extra
   * requests each would be a self-inflicted rate limit.
   */
  private credentialMemo: Promise<JiraCredentialState> | null = null;
  private projectMemos = new Map<string, Promise<JiraProjectVisibility>>();

  async checkCredentials(): Promise<JiraCredentialState> {
    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
        method: "GET",
        headers: {
          Authorization: this.getBasicAuthHeader(),
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      if (res.ok) return "valid";
      if (res.status === 401 || res.status === 403) return "invalid";
      return "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timeout);
    }
  }

  async issueExists(issueKey: string): Promise<JiraIssueExistence> {
    if (this.circuitOpen) return "unknown";

    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=key`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.getBasicAuthHeader(),
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      if (res.ok) return "exists";
      // A 404 is the ambiguous answer, never the final one — see confirmDeletion.
      if (res.status === 404) return this.confirmDeletion(issueKey);
      return "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Whether a 404 on an issue may be read as "deleted".
   *
   * Jira words two very different situations identically — "Issue does not exist
   * or you do not have permission to see it" — and answers 404 for both. It does
   * so for a deleted issue, for an issue hidden by an issue-level security
   * scheme, for a project that has been archived or taken out of view, and for
   * an EXPIRED CREDENTIAL, which Jira serves anonymously on this endpoint rather
   * than rejecting. On 2026-08-19 the last of those turned 392 live board rows
   * black.
   *
   * So the 404 is corroborated before it is believed: the credential must still
   * authenticate (`/myself`, the endpoint that does answer 401), and the issue's
   * project must still be visible to it. Anything less is `unknown`, which
   * leaves board rows exactly as they are.
   *
   * The deliberate cost: deleting an entire Jira project no longer blacks out
   * its board rows, because the project check cannot then tell "you deleted the
   * project" from "you lost sight of it". Those rows simply stop updating, which
   * is the recoverable half of the trade.
   */
  private async confirmDeletion(issueKey: string): Promise<JiraIssueExistence> {
    this.credentialMemo ??= this.checkCredentials();
    if ((await this.credentialMemo) !== "valid") return "unknown";

    const projectKey = projectKeyOf(issueKey);
    if (projectKey === null) return "unknown";
    if (!this.projectMemos.has(projectKey)) {
      this.projectMemos.set(projectKey, this.projectVisibility(projectKey));
    }
    return (await this.projectMemos.get(projectKey)) === "visible" ? "deleted" : "unknown";
  }

  /** Whether this credential can still see a project at all. */
  private async projectVisibility(projectKey: string): Promise<JiraProjectVisibility> {
    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
        method: "GET",
        headers: {
          Authorization: this.getBasicAuthHeader(),
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      if (res.ok) return "visible";
      if (res.status === 404 || res.status === 403) return "unavailable";
      return "unknown";
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildJql(projectKeys: string[], isEpic: boolean): string {
    const projectList = projectKeys.map((key) => `"${key}"`).join(", ");
    if (isEpic) {
      return `issuetype = Epic AND project in (${projectList})`;
    }
    return `project in (${projectList}) AND issuetype != Epic`;
  }

  private async fetchPaginated<T>(
    jql: string,
    mapper: (issue: JiraIssueResponse) => T,
    fields: string[] = this.fieldsFor(),
  ): Promise<T[]> {
    if (this.circuitOpen) {
      throw new JiraCircuitOpenError();
    }

    const results: T[] = [];
    const maxResults = 100;
    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");

    // Try new POST /search/jql endpoint first (Atlassian CHANGE-2046)
    let useNewApi = true;
    let nextPageToken: string | null = null;

    try {
      // First request to check if new API is available
      console.log(`[JiraAdapter] POST /search/jql for: ${jql}`);
      const testUrl = `${baseUrl}/rest/api/3/search/jql`;
      console.log(`[JiraAdapter] Fetching ${testUrl}...`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const testRes = await fetch(testUrl, {
        method: "POST",
        headers: {
          Authorization: this.getBasicAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jql, maxResults, fields }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      console.log(`[JiraAdapter] Response: ${testRes.status}`);

      if (testRes.ok) {
        const data = await testRes.json();
        console.log(`[JiraAdapter] Got ${(data.issues || []).length} issues, nextPage: ${!!data.nextPageToken}`);
        results.push(...(data.issues || []).map(mapper));
        nextPageToken = data.nextPageToken || null;
      } else if (testRes.status === 401 || testRes.status === 403) {
        throw new JiraAuthError(`Jira authentication failed (${testRes.status})`);
      } else {
        useNewApi = false;
      }
    } catch (err) {
      if (err instanceof JiraAuthError) throw err;
      useNewApi = false;
    }

    if (useNewApi) {
      // Continue paginating with nextPageToken
      while (nextPageToken) {
        const url = `${baseUrl}/rest/api/3/search/jql`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: this.getBasicAuthHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jql,
            maxResults,
            fields,
            nextPageToken,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) break;
        const data = await res.json();
        results.push(...(data.issues || []).map(mapper));
        nextPageToken = data.nextPageToken || null;
      }
      return results;
    }

    // Fallback: legacy GET /search endpoint
    let startAt = 0;
    let total = Infinity;
    while (startAt < total) {
      const response = await this.makeRequest<JiraSearchResponse>(
        `/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}`,
      );
      total = response.total;
      results.push(...response.issues.map(mapper));
      startAt += maxResults;
    }
    return results;
  }

  private async makeRequest<T>(path: string): Promise<T> {
    const url = `${this.config.atlassianUrl}${path}`;
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.getBasicAuthHeader(),
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status === 401 || response.status === 403) {
          throw new JiraAuthError(`Jira authentication failed (${response.status})`);
        }

        if (!response.ok) {
          // Retry on 5xx errors, fail immediately on other errors
          if (response.status >= 500) {
            lastError = new Error(`Jira API request failed: ${response.status}`);
            // Only sleep if we have more retries
            if (attempt < maxRetries) {
              const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
              await this.delayFn(delayMs);
            }
            continue;
          }
          throw new Error(`Jira API request failed: ${response.status}`);
        }

        // Success - reset the consecutive failure counter
        this.consecutiveFailures = 0;
        return response.json() as Promise<T>;
      } catch (error) {
        // If it's an auth error, throw immediately without retrying
        if (error instanceof JiraAuthError) {
          throw error;
        }
        // For other errors, save them and retry if we have attempts left
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
          await this.delayFn(delayMs);
        }
      }
    }

    // All retries exhausted - increment consecutive failures and check circuit
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.circuitThreshold) {
      this.circuitOpen = true;
    }

    throw lastError || new Error("Unknown error after retries");
  }

  /**
   * Jira serves `duedate` as a bare `YYYY-MM-DD` (no time, no zone). Parsing an
   * empty or absent value yields an Invalid Date, which Prisma would reject, so
   * guard rather than trusting the cast.
   */
  private parseJiraDueDate(raw: unknown): Date | null {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private mapToEpic(issue: JiraIssueResponse, extraFields: string[] = []): JiraEpic {
    return {
      id: issue.id,
      key: issue.key,
      projectKey: issue.fields.project.key,
      summary: issue.fields.summary,
      description: extractPlainText(issue.fields.description) ?? null,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.emailAddress || null,
      dueDate: this.parseJiraDueDate(issue.fields.duedate),
      updatedAt: new Date(issue.fields.updated),
      extra: this.extraFrom(issue.fields as Record<string, unknown>, extraFields),
    };
  }

  private mapToIssue(issue: JiraIssueResponse, extraFields: string[] = []): JiraIssue {
    // Extract Epic Link from customfields (Jira Cloud uses customfield_10000 or similar)
    // For now, we'll support both the Epic Link field and customfield patterns
    let epicKey: string | null = null;
    const fields = issue.fields as Record<string, unknown>;
    const epicField = fields.customfield_10014 as Record<string, unknown> | null | undefined;
    if (epicField?.key) {
      epicKey = epicField.key as string;
    }

    const issueTypeObj = fields.issuetype as unknown as { name: string } | undefined;
    return {
      id: issue.id,
      key: issue.key,
      projectKey: issue.fields.project.key,
      epicKey,
      summary: issue.fields.summary,
      description: extractPlainText(issue.fields.description) ?? null,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.emailAddress || null,
      type: issueTypeObj?.name || "Task",
      dueDate: this.parseJiraDueDate(issue.fields.duedate),
      updatedAt: new Date(issue.fields.updated),
      extra: this.extraFrom(fields, extraFields),
    };
  }

  async fetchProjectIssueTypes(projectKey: string): Promise<string[]> {
    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.getBasicAuthHeader(),
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new JiraAuthError(
        `Jira authentication failed (${response.status})`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Jira /project/${projectKey} returned ${response.status}`,
      );
    }

    const data = (await response.json()) as {
      issueTypes?: Array<{ name: string }>;
    };
    const names = (data.issueTypes ?? []).map((t) => t.name);
    return [...new Set(names)].sort();
  }

  /**
   * `GET /rest/api/3/field` — every field in the instance.
   *
   * Entries that fail to parse are dropped rather than rejecting the list:
   * Jira ships occasional descriptors with no `id`, and one malformed entry
   * must not cost the user their whole field picker.
   */
  async fetchFields(): Promise<JiraFieldMeta[]> {
    const baseUrl = this.config.atlassianUrl.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/rest/api/3/field`, {
      headers: {
        Authorization: this.getBasicAuthHeader(),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Jira field discovery failed: ${res.status}`);
    }
    const raw = (await res.json()) as unknown[];
    const fields: JiraFieldMeta[] = [];
    for (const entry of raw) {
      const parsed = JiraFieldMetaSchema.safeParse(entry);
      if (parsed.success) fields.push(parsed.data);
    }
    return fields;
  }

  resetCircuit(): void {
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
  }
}
