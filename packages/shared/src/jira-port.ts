import { JiraEpic, JiraIssue } from "./jira-schemas";

export interface JiraPort {
  fetchEpics(projectKeys: string[]): Promise<JiraEpic[]>;
  fetchIssues(projectKeys: string[]): Promise<JiraIssue[]>;
  fetchProjectIssueTypes(projectKey: string): Promise<string[]>;
  /**
   * Issue keys matching an arbitrary JQL query — the cheapest question Jira can
   * answer (no fields beyond `key`). Used to resolve a board source's
   * `jqlFilter` into the key set the sync is allowed to promote. Rejects rather
   * than returning an empty set when Jira refuses the query, so a bad filter
   * can never be mistaken for "nothing matched".
   */
  fetchIssueKeys(jql: string): Promise<string[]>;
}
