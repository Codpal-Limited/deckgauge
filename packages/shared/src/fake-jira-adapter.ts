import { JiraPort, JiraIssueExistence, JiraCredentialState } from "./jira-port.js";
import { JiraEpic, JiraIssue } from "./jira-schemas.js";
import type { JiraFieldMeta } from "./jira-field-schemas.js";

export class FakeJiraAdapter implements JiraPort {
  public fixtureIssueTypesByProject: Record<string, string[]> = {};
  public fixtureKeysByJql: Record<string, string[]> = {};
  /** Keys a test has declared deleted in Jira — see {@link issueExists}. */
  public fixtureDeletedKeys: Set<string> = new Set();
  /** What a test wants the connection's credential to answer. */
  public fixtureCredentialState: JiraCredentialState = "valid";

  private readonly epicData: Record<string, JiraEpic[]> = {
    ORBIT: [
      {
        id: "epic-orbit-1",
        key: "ORBIT-1",
        projectKey: "ORBIT",
        summary: "Implement user authentication",
        description: "Set up OAuth2 and JWT-based auth for the application",
        status: "In Progress",
        assignee: "alice@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
      {
        id: "epic-orbit-2",
        key: "ORBIT-2",
        projectKey: "ORBIT",
        summary: "Build API documentation",
        description: "Create OpenAPI spec and developer guides",
        status: "Not Started",
        assignee: "bob@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-09T14:30:00Z"),
      },
      {
        id: "epic-orbit-3",
        key: "ORBIT-3",
        projectKey: "ORBIT",
        summary: "Database schema optimization",
        description: null,
        status: "Done",
        assignee: null,
        dueDate: null,
        updatedAt: new Date("2026-04-08T08:15:00Z"),
      },
    ],
    NIMBUS: [
      {
        id: "epic-nimbus-1",
        key: "NIMBUS-1",
        projectKey: "NIMBUS",
        summary: "Refactor legacy codebase",
        description: "Migrate from Express to Fastify, update middleware patterns",
        status: "In Progress",
        assignee: "charlie@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-11T11:45:00Z"),
      },
      {
        id: "epic-nimbus-2",
        key: "NIMBUS-2",
        projectKey: "NIMBUS",
        summary: "Performance improvements",
        description: "Target p99 latency under 200ms for API endpoints",
        status: "At Risk",
        assignee: "diana@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-07T16:20:00Z"),
      },
    ],
  };

  private readonly issueData: Record<string, JiraIssue[]> = {
    ORBIT: [
      {
        id: "issue-orbit-1",
        key: "ORBIT-10",
        projectKey: "ORBIT",
        epicKey: "ORBIT-1",
        summary: "Add OAuth2 support",
        description: "Integrate with Google and GitHub OAuth2 providers",
        status: "In Progress",
        assignee: "alice@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
      {
        id: "issue-orbit-2",
        key: "ORBIT-11",
        projectKey: "ORBIT",
        epicKey: "ORBIT-1",
        summary: "Implement JWT validation",
        description: "Validate JWT tokens on protected routes",
        status: "In Review",
        assignee: "bob@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-09T14:30:00Z"),
      },
      {
        id: "issue-orbit-3",
        key: "ORBIT-12",
        projectKey: "ORBIT",
        epicKey: "ORBIT-2",
        summary: "Write API endpoint docs",
        description: null,
        status: "Not Started",
        assignee: null,
        type: "Documentation",
        dueDate: null,
        updatedAt: new Date("2026-04-08T09:00:00Z"),
      },
      {
        id: "issue-orbit-4",
        key: "ORBIT-13",
        projectKey: "ORBIT",
        epicKey: null,
        summary: "Fix login page bug",
        description: "Login button unresponsive on Safari mobile",
        status: "Done",
        assignee: "alice@example.com",
        type: "Bug",
        dueDate: null,
        updatedAt: new Date("2026-04-07T13:20:00Z"),
      },
    ],
    NIMBUS: [
      {
        id: "issue-nimbus-1",
        key: "NIMBUS-10",
        projectKey: "NIMBUS",
        epicKey: "NIMBUS-1",
        summary: "Remove old middleware layer",
        description: "Strip Express middleware and replace with Fastify hooks",
        status: "In Progress",
        assignee: "charlie@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-11T11:45:00Z"),
      },
      {
        id: "issue-nimbus-2",
        key: "NIMBUS-11",
        projectKey: "NIMBUS",
        epicKey: "NIMBUS-1",
        summary: "Update test suite",
        description: null,
        status: "In Progress",
        assignee: null,
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-10T15:10:00Z"),
      },
      {
        id: "issue-nimbus-3",
        key: "NIMBUS-12",
        projectKey: "NIMBUS",
        epicKey: "NIMBUS-2",
        summary: "Add caching layer",
        description: "Redis-based response caching for GET endpoints",
        status: "Not Started",
        assignee: "diana@example.com",
        type: "Feature",
        dueDate: null,
        updatedAt: new Date("2026-04-06T12:00:00Z"),
      },
    ],
  };

  async fetchEpics(projectKeys: string[]): Promise<JiraEpic[]> {
    const result: JiraEpic[] = [];
    for (const key of projectKeys) {
      if (this.epicData[key]) {
        result.push(...this.epicData[key]);
      }
    }
    return result;
  }

  async fetchIssues(projectKeys: string[]): Promise<JiraIssue[]> {
    const result: JiraIssue[] = [];
    for (const key of projectKeys) {
      if (this.issueData[key]) {
        result.push(...this.issueData[key]);
      }
    }
    return result;
  }

  async fetchProjectIssueTypes(projectKey: string): Promise<string[]> {
    return this.fixtureIssueTypesByProject[projectKey] ?? [];
  }

  /**
   * There is no JQL engine here, so callers that need a filtered key set must
   * declare it: `fixtureKeysByJql[jql] = [...]`. An undeclared query resolves to
   * no keys, which reads as "this filter admits nothing" — the safe direction
   * for a fake, since the alternative would fake a filter that never filters.
   */
  async fetchIssueKeys(jql: string): Promise<string[]> {
    return this.fixtureKeysByJql[jql] ?? [];
  }

  /**
   * Deleted only when a test says so. A key the fixture data knows exists; any
   * other key is `unknown`, which reads as "this fake cannot say" — the same
   * refusal-to-guess as fetchIssueKeys, and the direction that cannot cause a
   * caller to mark a row deleted by accident.
   */
  async checkCredentials(): Promise<JiraCredentialState> {
    return this.fixtureCredentialState;
  }

  async issueExists(issueKey: string): Promise<JiraIssueExistence> {
    if (this.fixtureDeletedKeys.has(issueKey)) return "deleted";
    const known = [
      ...Object.values(this.epicData).flat().map((e) => e.key),
      ...Object.values(this.issueData).flat().map((i) => i.key),
    ];
    return known.includes(issueKey) ? "exists" : "unknown";
  }

  async fetchFields(): Promise<JiraFieldMeta[]> {
    return [
      { id: "reporter", name: "Reporter", custom: false, schema: { type: "user" } },
      { id: "priority", name: "Priority", custom: false, schema: { type: "priority" } },
      { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string" } },
    ];
  }
}
