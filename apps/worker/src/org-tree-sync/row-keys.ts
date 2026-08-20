/**
 * Row keys that join a work item in ClickHouse to the board row promoted from it.
 *
 * Both sides of that join must agree exactly, and they are written far apart — the
 * ClickHouse projections live in `org-sync-aggregator.ts`, the Postgres side in
 * `board-reverse-index.ts`. A mismatch does not fail loudly; it silently resolves
 * every assignment to no board, which reads as "this person has no work" rather than
 * as a bug. Keeping both sides on these builders is what makes that testable.
 *
 * The shapes mirror how the promote services already store the ids:
 *   - Jira  `Project.jiraKey`        = the bare issue key (e.g. "RDRR-731")
 *   - ADO   `Project.adoProject` + `Project.adoWorkItemId`, joined as "project#id" —
 *           the same convention `classification-mirror.ts` uses. ADO work-item ids are
 *           only unique within a project, so a bare id lets two projects cross-credit
 *           each other's boards. Note this scopes by PROJECT, not organization:
 *           `Project` carries no ADO org column, so two connected orgs sharing a
 *           project name would still collide (none do today).
 *   - GitHub `Project.githubIssueId` = "owner/repo#number", built by
 *           `github-sync.processor.ts` when it promotes an issue.
 */

export const jiraRowKey = (issueKey: string): string => issueKey;

export const adoRowKey = (project: string, workItemId: number | string): string =>
  `${project}#${workItemId}`;

export const githubRowKey = (repoFullName: string, issueNumber: number | string): string =>
  `${repoFullName}#${issueNumber}`;
