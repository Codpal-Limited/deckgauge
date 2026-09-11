import { z } from 'zod';
import {
  DEFAULT_STAGE_MAP,
  type FocusProvider,
  type FocusStage,
  type StageMap,
} from './delivery-stage.js';

/**
 * The per-board OVERRIDE, which is not the same shape as a `StageMap`.
 *
 * A `StageMap` is total — every provider present, and `mapDeliveryStage` indexes
 * into it directly. An override is partial by design: a board that disagrees
 * with one QA state should say so in one line, not restate the shipped default
 * so it can add a line to it.
 *
 * Keeping the two types apart is the fix for a real bug. `readStageMap` used to
 * accept a stored value only if it carried BOTH provider keys and then hand it
 * to the snapshot WHOLE, so any override silently replaced every default —
 * `Done`, `In Progress` and the rest all fell through to `NOT_STARTED`, which is
 * indistinguishable from the unmapped-state problem the override exists to fix.
 */
export const FocusStageSchema = z.enum([
  'IN_PRODUCTION',
  'WAITING_TO_SHIP',
  'IN_DEVELOPMENT',
  'CANCELLED',
  'NOT_STARTED',
]);

/**
 * `.min(1)` on the KEY, not just the value.
 *
 * ClickHouse returns `''` for a work item with no state, and an empty key would
 * be accepted, stored, and then never match anything — an override that reads as
 * configured and does nothing. `source-statuses.service.ts` drops blanks on the
 * read side for the same reason; this is the write side of that rule.
 */
const StateStageRecord = z.record(z.string().min(1), FocusStageSchema);

export const StageMapOverridesSchema = z
  .object({
    jira: StateStageRecord.optional(),
    ado: StateStageRecord.optional(),
  })
  .strict();

export type StageMapOverrides = z.infer<typeof StageMapOverridesSchema>;

/** Distinct states ClickHouse currently reports for a board, per provider. */
export interface ObservedStates {
  jira: string[];
  ado: string[];
}

export interface UnmappedState {
  provider: FocusProvider;
  state: string;
}

/**
 * Everything the stage-map editor renders, for one board.
 *
 * Lives here rather than in `apps/api` so the route and the web client share one
 * declaration — the editor's whole correctness rests on `observed` being the
 * states this board really has, and two hand-kept copies of that shape is how
 * they drift.
 */
export interface FocusStageMapSettings {
  /** Distinct states this board's sources currently report, per provider. */
  observed: ObservedStates;
  /** What this board has explicitly decided. Partial. */
  overrides: StageMapOverrides;
  /** The shipped default, so the editor can show what a row falls back to. */
  defaults: StageMap;
  /** `defaults` with `overrides` layered on — what the widgets actually read. */
  effective: StageMap;
  /** Observed states the effective map still cannot place. */
  unmapped: UnmappedState[];
}

export const FOCUS_PROVIDERS: readonly FocusProvider[] = ['jira', 'ado'];

/**
 * Read a stored override, discarding anything that does not parse.
 *
 * A malformed row must not take the whole view down — the widget's job is to
 * report the team, and falling back to the shipped default is both safe and
 * visible (the unmapped-states caveat reappears).
 */
export function parseStageMapOverrides(value: unknown): StageMapOverrides {
  const parsed = StageMapOverridesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * What an organization's bucket decisions say about delivery stages, per
 * provider. Partial — only statuses somebody has actually decided.
 */
export type BucketStageLayer = Partial<Record<FocusProvider, Record<string, FocusStage>>>;

/**
 * Layer the shipped default, the organization's bucket decisions, and the
 * board's own overrides — in that order, per provider.
 *
 * THREE layers, narrowest last. The default is a guess made for everyone; a
 * bucket decision is what this organization said in the Time rules drawer, so it
 * outranks the guess; a board override is what this board said about itself, so
 * it outranks both. Each wins per STATE, so a board can disagree about `Client
 * Review` without inheriting nothing else.
 *
 * `buckets` is OPTIONAL and an organization that has decided nothing passes
 * nothing — the map is then byte-identical to the shipped default. That is the
 * same opt-in rule `activeStatuses` and the Focus working states follow, and it
 * is why this slice owes no migration: no board's funnel moves until its
 * organization decides something.
 *
 * Per PROVIDER, and that is load-bearing rather than symmetric-looking:
 * `DEFAULT_STAGE_MAP` is provider-keyed because `QA` mapped on Jira says nothing
 * about `QA` on ADO, and collapsing that here would reintroduce the defect slice
 * 2b-ii shipped — one tracker's opinion applied to another tracker's state.
 */
export function mergeStageMap(overrides: unknown, buckets?: BucketStageLayer): StageMap {
  const parsed = parseStageMapOverrides(overrides);

  return {
    jira: { ...DEFAULT_STAGE_MAP.jira, ...buckets?.jira, ...parsed.jira },
    ado: { ...DEFAULT_STAGE_MAP.ado, ...buckets?.ado, ...parsed.ado },
  };
}

/**
 * Which observed states the effective map still cannot place.
 *
 * Keyed by provider as well as name because the two providers have separate
 * vocabularies that overlap: `QA` mapped on Jira says nothing about `QA` on ADO,
 * and collapsing them would report a state as handled while it still lands in
 * `NOT_STARTED`.
 */
export function unmappedObservedStates(
  observed: ObservedStates,
  map: StageMap,
): UnmappedState[] {
  const out: UnmappedState[] = [];

  for (const provider of FOCUS_PROVIDERS) {
    for (const state of observed[provider]) {
      if (map[provider][state] === undefined) out.push({ provider, state });
    }
  }

  return out;
}

/** How many states the board has explicitly decided, for the editor's header. */
export function stageMapOverrideCount(overrides: unknown): number {
  const parsed = parseStageMapOverrides(overrides);
  return Object.keys(parsed.jira ?? {}).length + Object.keys(parsed.ado ?? {}).length;
}
