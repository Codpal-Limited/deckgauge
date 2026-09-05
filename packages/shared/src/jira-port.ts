import { JiraEpic, JiraIssue } from "./jira-schemas.js";
import type { JiraFieldMeta } from "./jira-field-schemas.js";

/**
 * What a single existence probe could establish about an issue key.
 * `unknown` is load-bearing: it is what a Jira outage, a rejected credential or
 * a network failure returns, and callers must treat it as "changed nothing".
 */
export type JiraIssueExistence = "exists" | "deleted" | "unknown";

/**
 * What a credential check could establish about the connection itself.
 * `unknown` covers an outage or a network failure — anything that is not a
 * definite answer from Jira about the credential.
 */
export type JiraCredentialState = "valid" | "invalid" | "unknown";

export interface JiraPort {
  fetchEpics(projectKeys: string[], extraFields?: string[]): Promise<JiraEpic[]>;
  fetchIssues(projectKeys: string[], extraFields?: string[]): Promise<JiraIssue[]>;
  fetchProjectIssueTypes(projectKey: string): Promise<string[]>;
  /**
   * Issue keys matching an arbitrary JQL query — the cheapest question Jira can
   * answer (no fields beyond `key`). Used to resolve a board source's
   * `jqlFilter` into the key set the sync is allowed to promote. Rejects rather
   * than returning an empty set when Jira refuses the query, so a bad filter
   * can never be mistaken for "nothing matched".
   */
  fetchIssueKeys(jql: string): Promise<string[]>;
  /**
   * Whether one issue key still resolves in Jira. Answers the question a
   * project-wide fetch cannot: an issue absent from the fetched payload may have
   * been deleted, or may merely have stopped matching a board's filter.
   *
   * Optional so the many hand-built JiraPort doubles keep compiling; callers
   * skip deletion detection entirely when an adapter does not implement it.
   */
  issueExists?(issueKey: string): Promise<JiraIssueExistence>;
  /**
   * Whether the connection's credential still authenticates.
   *
   * Needed because Jira does NOT reject an expired API token on the endpoints a
   * sync uses — it serves them anonymously instead. A search then answers 200
   * with an empty result set and a single-issue GET answers 404, both
   * indistinguishable from "the project is empty" and "the issue is gone". Only
   * an endpoint that requires a user (`/myself`) answers 401 and tells the
   * truth, so the question has to be asked separately.
   *
   * Optional, like `issueExists`, so hand-built JiraPort doubles keep compiling.
   */
  checkCredentials?(): Promise<JiraCredentialState>;
  /**
   * Every field defined in the Jira instance, system and custom alike.
   *
   * Optional for the same reason `issueExists` and `checkCredentials` are: the
   * many hand-built JiraPort doubles across the test suite must keep compiling.
   * Callers treat its absence as "discovery unavailable", not as an error.
   */
  fetchFields?(): Promise<JiraFieldMeta[]>;
}
