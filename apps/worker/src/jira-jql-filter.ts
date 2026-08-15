import type { PrismaClient } from '@deckgauge/db';
import { buildFilteredKeyJql, stripJqlOrderBy, type JiraPort } from '@deckgauge/shared';

export interface JqlFilterDeps {
  db: PrismaClient;
  adapter: Pick<JiraPort, 'fetchIssueKeys'>;
  /** Restricts the lookup to one Jira connection. Omitted only by callers that sync every instance at once. */
  instanceId?: string;
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

  const allowedKeysBySourceId = new Map<string, Set<string>>();
  const skipSourceIds = new Set<string>();
  const errors: JqlFilterError[] = [];

  if (projectKeys.length === 0) {
    return { allowedKeysBySourceId, skipSourceIds, errors };
  }

  const rows = await db.boardJiraSource.findMany({
    where: {
      jqlFilter: { not: null },
      jiraProjectSync: {
        ...(instanceId ? { jiraInstanceId: instanceId } : {}),
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
