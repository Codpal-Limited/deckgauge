import { JiraPort, JiraIssueExistence, JiraCredentialState } from "./jira-port";
import { JiraEpic, JiraIssue } from "./jira-schemas";
import type { JiraFieldMeta } from "./jira-field-schemas";

export class FakeJiraAdapter implements JiraPort {
  public fixtureIssueTypesByProject: Record<string, string[]> = {};
  public fixtureKeysByJql: Record<string, string[]> = {};
  /** Keys a test has declared deleted in Jira — see {@link issueExists}. */
  public fixtureDeletedKeys: Set<string> = new Set();
  /** What a test wants the connection's credential to answer. */
  public fixtureCredentialState: JiraCredentialState = "valid";

  private readonly epicData: Record<string, JiraEpic[]> = {
    BWAY: [
      {
        id: "epic-bway-1",
        key: "BWAY-1",
        projectKey: "BWAY",
        summary: "Implement user authentication",
        description: "Set up OAuth2 and JWT-based auth for the application",
        status: "In Progress",
        assignee: "alice@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
      {
        id: "epic-bway-2",
        key: "BWAY-2",
        projectKey: "BWAY",
        summary: "Build API documentation",
        description: "Create OpenAPI spec and developer guides",
        status: "Not Started",
        assignee: "bob@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-09T14:30:00Z"),
      },
      {
        id: "epic-bway-3",
        key: "BWAY-3",
        projectKey: "BWAY",
        summary: "Database schema optimization",
        description: null,
        status: "Done",
        assignee: null,
        dueDate: null,
        updatedAt: new Date("2026-04-08T08:15:00Z"),
      },
    ],
    DOS: [
      {
        id: "epic-dos-1",
        key: "DOS-1",
        projectKey: "DOS",
        summary: "Refactor legacy codebase",
        description: "Migrate from Express to Fastify, update middleware patterns",
        status: "In Progress",
        assignee: "charlie@example.com",
        dueDate: null,
        updatedAt: new Date("2026-04-11T11:45:00Z"),
      },
      {
        id: "epic-dos-2",
        key: "DOS-2",
        projectKey: "DOS",
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
    BWAY: [
      {
        id: "issue-bway-1",
        key: "BWAY-10",
        projectKey: "BWAY",
        epicKey: "BWAY-1",
        summary: "Add OAuth2 support",
        description: "Integrate with Google and GitHub OAuth2 providers",
        status: "In Progress",
        assignee: "alice@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
      {
        id: "issue-bway-2",
        key: "BWAY-11",
        projectKey: "BWAY",
        epicKey: "BWAY-1",
        summary: "Implement JWT validation",
        description: "Validate JWT tokens on protected routes",
        status: "In Review",
        assignee: "bob@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-09T14:30:00Z"),
      },
      {
        id: "issue-bway-3",
        key: "BWAY-12",
        projectKey: "BWAY",
        epicKey: "BWAY-2",
        summary: "Write API endpoint docs",
        description: null,
        status: "Not Started",
        assignee: null,
        type: "Documentation",
        dueDate: null,
        updatedAt: new Date("2026-04-08T09:00:00Z"),
      },
      {
        id: "issue-bway-4",
        key: "BWAY-13",
        projectKey: "BWAY",
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
    DOS: [
      {
        id: "issue-dos-1",
        key: "DOS-10",
        projectKey: "DOS",
        epicKey: "DOS-1",
        summary: "Remove old middleware layer",
        description: "Strip Express middleware and replace with Fastify hooks",
        status: "In Progress",
        assignee: "charlie@example.com",
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-11T11:45:00Z"),
      },
      {
        id: "issue-dos-2",
        key: "DOS-11",
        projectKey: "DOS",
        epicKey: "DOS-1",
        summary: "Update test suite",
        description: null,
        status: "In Progress",
        assignee: null,
        type: "Task",
        dueDate: null,
        updatedAt: new Date("2026-04-10T15:10:00Z"),
      },
      {
        id: "issue-dos-3",
        key: "DOS-12",
        projectKey: "DOS",
        epicKey: "DOS-2",
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
