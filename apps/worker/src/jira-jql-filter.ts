import type { PrismaClient } from '@deckgauge/db';
import { buildFilteredKeyJql, stripJqlOrderBy, type JiraPort } from '@deckgauge/shared';

export interface JqlFilterDeps {
  db: PrismaClient;
  adapter: Pick<JiraPort, 'fetchIssueKeys'>;
  /**
   * The Jira connection this run belongs to. **Required.**
   *
   * A Jira project key is unique per HOST, not per deployment, so two connections
   * syncing a project called `SOE` is ordinary. Without this clause the lookup
   * below matches board sources on EVERY connection with that key — another
   * tenant's rows — and then sends their `jqlFilter` text to this run's Jira host
   * as a query.
   *
   * It was optional, documented as "omitted only by callers that sync every
   * instance at once", and no such caller ever existed. **An optional tenant
   * parameter fails open and silently**: the caller that forgets it gets a wider
   * answer, no error, and a result indistinguishable from a correct one. Required
   * makes forgetting a compile error, matching `ProcessorInput.instanceId` and
   * `buildBoardReverseIndex`'s `organizationId`.
   *
   * The type is half the boundary; `undefined` and `''` both arrive past a cast or
   * a `!`, so `resolveJqlAllowLists` also refuses them at runtime.
   */
  instanceId: string;
  projectKeys: string[];
}

export interface JqlFilterError {
  boardSourceId: string;
  projectKey: string;
  message: string;
}

export interface JqlAllowLists {
  /** boardJiraSource.id → the issue keys its `jqlFilter` admits. */
  allowedKeysBySourceId: Map<string, Set<string>>;
  /** Sources whose filter could not be resolved; they must not be promoted at all. */
  skipSourceIds: Set<string>;
  errors: JqlFilterError[];
}

/**
 * Resolves each board source's `jqlFilter` into the set of issue keys it admits.
 *
 * The sync fetches issues once per Jira instance and fans them out to every
 * board source on the project, so a per-board filter cannot be pushed into that
 * shared query. Instead we ask Jira the cheap question — "which keys match this
 * filter?" — and intersect. A filter can therefore only ever narrow what the
 * board would have received; it cannot pull in issues from outside the source's
 * own project.
 *
 * A filter Jira rejects lands in `skipSourceIds` rather than being dropped: an
 * ignored filter silently syncs the whole project, which is the failure this
 * whole path exists to prevent.
 */
export async function resolveJqlAllowLists(deps: JqlFilterDeps): Promise<JqlAllowLists> {
  const { db, adapter, instanceId, projectKeys } = deps;

  // The connection boundary, checked FIRST — ahead of the empty-`projectKeys`
  // shortcut below, which would otherwise let a boundary-less caller succeed
  // whenever its run happened to have no work. A boundary that only complains
  // when there is work surfaces the caller's bug at random.
  //
  // Thrown, not degraded into an empty result: an empty `allowedKeysBySourceId`
  // with an empty `skipSourceIds` reads as "no board source carries a filter",
  // which promotes every issue in the project UNFILTERED — the exact failure this
  // module exists to prevent, and the same reasoning that makes a Jira-rejected
  // filter land in `skipSourceIds` instead of being dropped. `jiraSyncProcessor`
  // records the run as FAILED, so a caller that lost the boundary is loud rather
  // than quietly over-broad.
  if (!instanceId) {
    throw new Error(
      'resolveJqlAllowLists: instanceId is required — refusing to resolve per-board JQL filters ' +
        'across every Jira connection in the deployment (a project key is unique per host, not per deployment).',
    );
  }

  const allowedKeysBySourceId = new Map<string, Set<string>>();
  const skipSourceIds = new Set<string>();
  const errors: JqlFilterError[] = [];

  if (projectKeys.length === 0) {
    return { allowedKeysBySourceId, skipSourceIds, errors };
  }

  const rows = await db.boardJiraSource.findMany({
    where: {
      jqlFilter: { not: null },
      // Unconditional, not a spread of a conditional clause. A spread that
      // evaluates to `{}` produces a query indistinguishable from a deliberate
      // deployment-wide read, so the scoped and unscoped forms would differ only
      // in the author's intent. The guard above is what makes the unconditional
      // form safe.
      jiraProjectSync: {
        jiraInstanceId: instanceId,
        jiraProjectKey: { in: projectKeys },
      },
    },
    select: {
      id: true,
      jqlFilter: true,
      jiraProjectSync: { select: { jiraProjectKey: true } },
    },
  });

  // One Jira round-trip per distinct query: boards commonly share a filter, and
  // an unfiltered remainder (blank, or nothing but an ORDER BY) needs none at all.
  const keysByJql = new Map<string, Set<string>>();

  for (const row of rows) {
    const projectKey = row.jiraProjectSync.jiraProjectKey;
    if (row.jqlFilter === null || stripJqlOrderBy(row.jqlFilter) === '') continue;

    const jql = buildFilteredKeyJql(projectKey, row.jqlFilter);
    const cached = keysByJql.get(jql);
    if (cached) {
      allowedKeysBySourceId.set(row.id, cached);
      continue;
    }

    try {
      const keys = new Set(await adapter.fetchIssueKeys(jql));
      keysByJql.set(jql, keys);
      allowedKeysBySourceId.set(row.id, keys);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipSourceIds.add(row.id);
      errors.push({ boardSourceId: row.id, projectKey, message });
      console.error(
        `[JiraJqlFilter] Filter failed for board source ${row.id} (${projectKey}): ${message}`,
      );
    }
  }

  return { allowedKeysBySourceId, skipSourceIds, errors };
}
