/**
 * How a board resolves the Jira browse URL for its rows.
 *
 * A board can attach several Jira sources across different sites, and a `Project`
 * row records only `jiraProjectKey` — never which instance it came from — so the URL
 * has to be looked up per row rather than taken from one global instance.
 */
export interface JiraSourceLinks {
  /** jiraProjectKey -> that project's Jira site URL. Ambiguous keys are absent. */
  byProjectKey: Record<string, string>;
  /**
   * Used for rows whose project key is unmapped, which happens when a source is
   * detached after its rows synced. Non-null only when every Jira instance shares one
   * URL, i.e. when that URL is the only one the row could have come from.
   */
  fallback: string | null;
}

/** The row's own project's URL, else the fallback. Null when neither is known. */
export function resolveJiraBrowseUrl(
  links: JiraSourceLinks | undefined,
  jiraProjectKey: string | null | undefined,
): string | null {
  if (!links) return null;
  const mapped = jiraProjectKey ? links.byProjectKey[jiraProjectKey] : undefined;
  return mapped ?? links.fallback;
}

/** Whether any row on this board could resolve a Jira link — gates the Source column. */
export function hasAnyJiraLink(links: JiraSourceLinks | undefined): boolean {
  if (!links) return false;
  return links.fallback !== null || Object.keys(links.byProjectKey).length > 0;
}
