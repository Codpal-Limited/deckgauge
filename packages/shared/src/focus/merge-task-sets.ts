import { normaliseTitle } from './normalise-title.js';

/** A task as one source system reports it. */
export interface FocusSourceTask {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date;
  state: string;
  assignee: string | null;
}

/** One task after both systems have been reconciled into a single row. */
export interface FocusTask {
  /** Jira key where there is one, otherwise the Azure DevOps id. */
  id: string;
  jiraId: string | null;
  adoId: string | null;
  title: string;
  description: string | null;
  /** Earliest creation across the pair — see `mergeTaskSets`. */
  originAt: Date;
  state: string;
  assignee: string | null;
  provider: 'jira' | 'ado' | 'both';
}

export interface MergeResult {
  rows: FocusTask[];
  mergedPairs: number;
}

function fromJira(t: FocusSourceTask): FocusTask {
  return {
    id: t.id,
    jiraId: t.id,
    adoId: null,
    title: t.title,
    description: t.description,
    originAt: t.createdAt,
    state: t.state,
    assignee: t.assignee,
    provider: 'jira',
  };
}

function fromAdo(t: FocusSourceTask): FocusTask {
  return {
    id: t.id,
    jiraId: null,
    adoId: t.id,
    title: t.title,
    description: t.description,
    originAt: t.createdAt,
    state: t.state,
    assignee: t.assignee,
    provider: 'ado',
  };
}

/**
 * Reconcile the two source systems into one task list.
 *
 * A team that migrated mid-window has its work split across both: on the
 * reference window Jira alone found 47 tasks and both systems together found
 * 105, with 51 items having no Jira twin at all. Counting one system under-reports
 * by half; counting both without merging double-counts everything that crossed.
 *
 * Pairing is on the NORMALISED title, because the two systems share no id.
 *
 * On a merged row:
 * - the **Jira key** is the id, since that is what people can click through to;
 * - the **earliest** creation date wins. A bulk migration stamps every imported
 *   ticket with the migration date, so the Jira date is an import artifact and
 *   the ADO one is the truth. This is what reveals tasks 500–900 days old;
 * - the **Jira state** wins, because post-migration Jira is the live system and
 *   the ADO twin is frozen wherever it was abandoned.
 *
 * Each ADO row is claimed at most once. Two Jira rows that normalise alike must
 * not both take the same twin — that would double-count one task's attention.
 */
export function mergeTaskSets(jira: FocusSourceTask[], ado: FocusSourceTask[]): MergeResult {
  const adoByTitle = new Map<string, FocusSourceTask[]>();
  for (const t of ado) {
    const key = normaliseTitle(t.title);
    const bucket = adoByTitle.get(key);
    if (bucket) bucket.push(t);
    else adoByTitle.set(key, [t]);
  }

  const claimed = new Set<string>();
  const rows: FocusTask[] = [];
  let mergedPairs = 0;

  for (const j of jira) {
    const twin = adoByTitle.get(normaliseTitle(j.title))?.find((t) => !claimed.has(t.id));
    if (!twin) {
      rows.push(fromJira(j));
      continue;
    }
    claimed.add(twin.id);
    mergedPairs += 1;
    rows.push({
      ...fromJira(j),
      adoId: twin.id,
      originAt: twin.createdAt < j.createdAt ? twin.createdAt : j.createdAt,
      description: j.description ?? twin.description,
      provider: 'both',
    });
  }

  for (const t of ado) {
    if (!claimed.has(t.id)) rows.push(fromAdo(t));
  }

  return { rows, mergedPairs };
}
