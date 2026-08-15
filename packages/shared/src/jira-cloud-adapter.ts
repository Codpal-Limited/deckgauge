import { JiraPort } from "./jira-port";
import { JiraEpic, JiraIssue } from "./jira-schemas";
import { JiraConfig } from "./jira-config-schema";
import { extractPlainText } from './adf-to-plain-text';

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
    [key: string]: unknown;
  };
}

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

  async fetchEpics(projectKeys: string[]): Promise<JiraEpic[]> {
    const jql = this.buildJql(projectKeys, true);
    return this.fetchPaginated(jql, (issue) => this.mapToEpic(issue));
  }

  async fetchIssues(projectKeys: string[]): Promise<JiraIssue[]> {
    const jql = this.buildJql(projectKeys, false);
    return this.fetchPaginated(jql, (issue) => this.mapToIssue(issue));
  }

  async fetchIssueKeys(jql: string): Promise<string[]> {
    return this.fetchPaginated(jql, (issue) => issue.key, "key");
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
    fieldsCsv = "summary,description,status,assignee,issuetype,updated,customfield_10014,project"
  ): Promise<T[]> {
    if (this.circuitOpen) {
      throw new JiraCircuitOpenError();
    }

    const results: T[] = [];
    const maxResults = 100;
    const fields = fieldsCsv;
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
        body: JSON.stringify({ jql, maxResults, fields: fields.split(",") }),
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
            fields: fields.split(","),
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

  private mapToEpic(issue: JiraIssueResponse): JiraEpic {
    return {
      id: issue.id,
      key: issue.key,
      projectKey: issue.fields.project.key,
      summary: issue.fields.summary,
      description: extractPlainText(issue.fields.description) ?? null,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.emailAddress || null,
      updatedAt: new Date(issue.fields.updated),
    };
  }

  private mapToIssue(issue: JiraIssueResponse): JiraIssue {
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
      updatedAt: new Date(issue.fields.updated),
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

  resetCircuit(): void {
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
  }
}
