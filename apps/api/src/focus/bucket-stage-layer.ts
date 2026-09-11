import {
  StatusBucketSchema,
  bucketToFocusStage,
  type BucketStageLayer,
  type FocusStage,
} from '@deckgauge/shared';

/** The columns this needs from `SourceStatusBucket`. */
export interface BucketRow {
  provider: string;
  status: string;
  bucket: string;
}

/** Prisma's enum spelling → the two providers `StageMap` actually has. */
const PROVIDER_KEY: Record<string, 'jira' | 'ado'> = { JIRA: 'jira', ADO: 'ado' };

/**
 * Stored bucket decisions, as a delivery-stage layer for `mergeStageMap`.
 *
 * Per PROVIDER, because `SourceStatusBucket.provider` is the only thing keeping
 * one tracker's answer off another's states — `QA` decided on Jira says nothing
 * about `QA` on ADO, and collapsing that is the defect slice 2b-ii shipped.
 *
 * GITHUB rows are dropped. That enum has three members and `StageMap` has two;
 * `DEFAULT_STAGE_MAP` has no github key, so such a decision has nowhere to go
 * and forcing it into one of the others would be inventing an answer.
 *
 * A status whose rows DISAGREE is dropped too, and that is a deliberate refusal
 * rather than an oversight. Decisions are stored per source, so one name is many
 * rows; the panel decides once per name so they agree in practice, but nothing
 * in the schema enforces it. Taking the last row would move a board's funnel on
 * the strength of row order. Dropping it falls back to the shipped default and
 * leaves the unmapped-state caveat available to say so.
 */
export function bucketStageLayerFrom(rows: readonly BucketRow[]): BucketStageLayer {
  // A missing entry means "not seen yet"; a stage means "seen, and every row so
  // far agreed"; `CONFLICT` means "seen again and disagreed". `CONFLICT` is a
  // Symbol, so `prior !== stage` holds for every later row — including one that
  // agrees with the first — and a conflict can never be un-set.
  const CONFLICT = Symbol('conflict');
  const seen: Record<'jira' | 'ado', Map<string, FocusStage | typeof CONFLICT>> = {
    jira: new Map(),
    ado: new Map(),
  };

  for (const row of rows) {
    const key = PROVIDER_KEY[row.provider];
    if (!key) continue;
    // `parse`, not a cast, and the precedent is explicit in
    // `org-tree-status-pool.service.ts`: "this is where a schema edit on one
    // side would otherwise pass silently". Concretely, a cast plus a new
    // `StatusBucket` member makes `bucketToFocusStage` return `undefined`, the
    // layer writes `{ [status]: undefined }`, and `mergeStageMap`'s spread
    // creates an OWN key holding `undefined` — which DELETES the shipped
    // default for that status rather than falling back to it, dropping the
    // state to `NOT_STARTED` and reporting it as unmapped.
    const parsedBucket = StatusBucketSchema.safeParse(row.bucket);
    if (!parsedBucket.success) continue;
    const stage = bucketToFocusStage(parsedBucket.data);
    const prior = seen[key].get(row.status);
    if (prior === undefined) seen[key].set(row.status, stage);
    else if (prior !== stage) seen[key].set(row.status, CONFLICT);
  }

  const out: BucketStageLayer = { jira: {}, ado: {} };
  for (const key of ['jira', 'ado'] as const) {
    for (const [status, stage] of seen[key]) {
      if (stage !== CONFLICT) out[key]![status] = stage;
    }
  }
  return out;
}
