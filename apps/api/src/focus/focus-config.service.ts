import type { Prisma, PrismaClient } from '@deckgauge/db';
import {
  DEFAULT_STAGE_MAP,
  mergeStageMap,
  FOCUS_PROVIDERS,
  parseStageMapOverrides,
  unmappedObservedStates,
  type ObservedStates,
  type StageMapOverrides,
  type FocusStageMapSettings,
  type UnmappedState,
} from '@deckgauge/shared';
import type { BucketStageLayer } from '@deckgauge/shared';
import { loadOrgBucketRows } from './working-states.js';
import { bucketStageLayerFrom } from './bucket-stage-layer.js';
import type { ChReadClient } from '../analytics/ch-read-scope.js';
import { getWidgetBoardScope } from '../widgets/widget-board-scope.js';
import { adoScopeFilter } from '../widgets/unions.js';

export type { FocusStageMapSettings };

export interface FocusConfigDeps {
  prisma: PrismaClient;
  clickhouse: ChReadClient;
  organizationId: string | null;
}

export class UnobservedStateError extends Error {
  constructor(readonly states: UnmappedState[]) {
    super(
      `These states are not reported by this board's sources: ${states
        .map((s) => `${s.provider}/${s.state}`)
        .join(', ')}`,
    );
    this.name = 'UnobservedStateError';
  }
}

/**
 * The distinct states a board's own sources report, straight from ClickHouse.
 *
 * Board-scoped rather than source-scoped, unlike `SourceStatusesService`: the
 * stage map is keyed by `(provider, state)` across every source on the board,
 * because that is the shape `mapDeliveryStage` indexes with.
 *
 * **What this shares with the funnel, and what it deliberately does not.** Scope
 * comes from `getWidgetBoardScope` and, for ADO, `adoScopeFilter` — the same two
 * calls `getFocusSnapshot` makes — so both read the same board. But the funnel
 * counts tasks TOUCHED IN A WINDOW (`focus-task-measures.ts`, 90 days by
 * default) and this read is ALL-TIME on purpose, so the result is a strict
 * SUPERSET of the states the widget tallies, and `unmapped` may name a state no
 * bar on screen currently counts.
 *
 * All-time is the right side to err on, because `saveFocusStageMapOverrides`
 * validates against this list: windowing it would refuse a mapping for a state
 * the board genuinely uses but has not touched this quarter, and the editor is
 * configuring a board-level map rather than a window. The direction that would
 * actually break the feature cannot happen — everything the funnel names is a
 * current status, so `Map these N states →` never leads to a missing row.
 *
 * `FINAL` is not optional here, and its absence was NOT symmetrical with the
 * above. Both tables are `ReplacingMergeTree(synced_at)`, so a bare read returns
 * superseded row versions too: a ticket that moved `QA → Done` would keep
 * contributing `QA` until a background merge, and the editor would badge it amber
 * and sort it above the states that move the bars. `focusTasksUnion` pins `FINAL`
 * on both legs for the same reason.
 *
 * A provider with no source on this board is not queried at all. Emitting a leg
 * with an empty `IN ()` would be a wasted round trip at best; the union builders
 * skip the leg for the same reason.
 */
async function readObservedStates(
  deps: FocusConfigDeps,
  boardId: string,
): Promise<ObservedStates> {
  const scope = await getWidgetBoardScope(deps.prisma, boardId, deps.organizationId);

  const runStringList = async (
    query: string,
    query_params: Record<string, unknown>,
  ): Promise<string[]> => {
    const result = await deps.clickhouse.query({ query, query_params, format: 'JSONEachRow' });
    const rows = (await result.json()) as Array<{ value?: string }>;
    // ClickHouse answers `''` for an item with no status. Such a row would be
    // stored, never match anything, and read as configured — see the `.min(1)`
    // on the override schema's KEY, which is the write side of this rule.
    return rows.map((r) => (r.value ?? '').trim()).filter((v) => v.length > 0);
  };

  const jira = scope.jiraProjectKeys.length
    ? await runStringList(
        `SELECT DISTINCT status AS value
         FROM cockpit.jira_issues FINAL
         WHERE project_key IN {jiraProjects:Array(String)}
         ORDER BY value`,
        { jiraProjects: scope.jiraProjectKeys },
      )
    : [];

  let ado: string[] = [];
  if (scope.adoProjects.length) {
    // `adoScopeFilter` rather than a bare `project IN (...)`: it is what carries
    // the org_url leg for a two-org install, and the focus task union already
    // uses it. Two different scope filters over one board is how the editor
    // would come to offer states the widget never counts.
    const params: Record<string, unknown> = {};
    const filter = adoScopeFilter(scope, params);
    ado = await runStringList(
      `SELECT DISTINCT state AS value
       FROM cockpit.ado_work_items FINAL
       WHERE ${filter}
       ORDER BY value`,
      params,
    );
  }

  return { jira, ado };
}

function settingsFrom(
  observed: ObservedStates,
  overrides: StageMapOverrides,
  buckets: BucketStageLayer,
): FocusStageMapSettings {
  // The same three layers the widgets read. `defaults` still reports what
  // SHIPS — a bucket decision is not a default and must not be shown as one —
  // and `overrides` stays the board's own, so the editor does not offer a
  // delete for a decision made elsewhere.
  const effective = mergeStageMap(overrides, buckets);
  return {
    observed,
    overrides,
    defaults: DEFAULT_STAGE_MAP,
    effective,
    unmapped: unmappedObservedStates(observed, effective),
  };
}

/** Everything the stage-map editor renders, for one board. */
export async function getFocusStageMapSettings(
  deps: FocusConfigDeps,
  boardId: string,
): Promise<FocusStageMapSettings> {
  const [observed, row, bucketRows] = await Promise.all([
    readObservedStates(deps, boardId),
    deps.prisma.focusConfig.findUnique({ where: { boardId } }),
    loadOrgBucketRows(deps.prisma, deps.organizationId),
  ]);

  // A row that does not parse falls back to the shipped default rather than
  // failing the request: the widget's job is to report the team, and the
  // fallback is visible — the unmapped-states caveat simply reappears.
  return settingsFrom(
    observed,
    parseStageMapOverrides(row?.stageMap),
    bucketStageLayerFrom(bucketRows),
  );
}

/**
 * Persist a board's overrides, refusing any state its sources do not report.
 *
 * The check is not ceremony. A mapping for a state that does not exist is
 * indistinguishable from a working one in the stored JSON, and it fails exactly
 * the way the bug this feature fixes failed: silently, with tasks still landing
 * in `NOT_STARTED` and the config looking correct. Validating against the
 * observed list means a typo is refused at the point it is made.
 *
 * The returned settings are computed from the overrides just saved, so the
 * editor can render the corrected state without a second round trip.
 */
export async function saveFocusStageMapOverrides(
  deps: FocusConfigDeps,
  boardId: string,
  overrides: StageMapOverrides,
): Promise<FocusStageMapSettings> {
  const [observed, row, bucketRows] = await Promise.all([
    readObservedStates(deps, boardId),
    deps.prisma.focusConfig.findUnique({ where: { boardId } }),
    loadOrgBucketRows(deps.prisma, deps.organizationId),
  ]);
  const stored = parseStageMapOverrides(row?.stageMap);

  // Allowed = observed NOW, plus whatever this board has already decided. The
  // second half matters: a state can go quiet — renamed upstream, or simply
  // unused this window — without the decision about it becoming wrong, and
  // refusing it would fail a save naming a state the user never touched. A state
  // in neither set has no way to have been chosen from the editor, so it is a
  // typo or a hand-written payload.
  const unobserved: UnmappedState[] = [];
  for (const provider of FOCUS_PROVIDERS) {
    const allowed = new Set([...observed[provider], ...Object.keys(stored[provider] ?? {})]);
    for (const state of Object.keys(overrides[provider] ?? {})) {
      if (!allowed.has(state)) unobserved.push({ provider, state });
    }
  }
  if (unobserved.length) throw new UnobservedStateError(unobserved);

  // Prisma's InputJsonValue does not accept an interface with optional members,
  // so the shape is narrowed here rather than typed loosely upstream — the value
  // has already been through StageMapOverridesSchema at the route boundary.
  const stageMap: Prisma.InputJsonValue = { ...overrides };
  await deps.prisma.focusConfig.upsert({
    where: { boardId },
    update: { stageMap },
    create: { boardId, stageMap },
  });

  // The bucket layer here too, or the settings this returns after a save differ
  // from the settings a fresh read produces — the editor would appear to change
  // the effective map simply by being saved. From the rows ALREADY loaded
  // above: re-fetching would be a second query for the same answer, which is
  // exactly what the funnel path has a test against.
  return settingsFrom(observed, overrides, bucketStageLayerFrom(bucketRows));
}
