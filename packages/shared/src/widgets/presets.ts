import { NEW_WIDGET_TYPES, type NewWidgetType } from '../widget-types.js';

export interface PresetWidget {
  type: NewWidgetType;
  title: string;
  layout: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
}

export interface Preset {
  presetKey: string;
  viewName: string;
  /**
   * The view type the preset creates. Defaults to DASHBOARD, which is what
   * every preset was before a second one existed.
   *
   * This is not cosmetic: a preset whose widgets only render on a FOCUS view
   * would seed them onto a DASHBOARD and draw nothing, with no error anywhere.
   */
  viewType?: 'DASHBOARD' | 'FOCUS';
  widgets: PresetWidget[];
}

// Auto-applied to new boards (Phase G) and offered as an opt-in banner to
// existing boards (Phase E). Layout follows a 12-column grid:
//
//   row 0  : three at-a-glance KPIs (WIP, ticket coverage, AI %)
//   row 1+ : flow + planning analytics
//   row 4+ : PR-level drill-downs
//   row 5+ : quality + initiative health
//
// The layout uses x/y/w/h cells that the existing widget grid already
// understands; no new layout primitives are needed.
export const ENGINEERING_INTELLIGENCE_PRESET_V1: Preset = {
  presetKey: 'engineering-intelligence-v1',
  viewName: 'Engineering Intelligence',
  widgets: [
    { type: 'WIP_COUNT',                   title: 'Work in Progress',         layout: { x: 0, y: 0,  w: 4, h: 2 }, config: { weeks: 12 } },
    { type: 'TICKET_COVERAGE_RATE',        title: 'Ticket Coverage',          layout: { x: 4, y: 0,  w: 4, h: 2 }, config: { weeks: 12 } },
    { type: 'AI_ASSISTED_PR_PCT',          title: 'AI-Assisted PRs',          layout: { x: 8, y: 0,  w: 4, h: 2 }, config: { weeks: 12 } },
    { type: 'LEAD_TIME_FOR_CHANGES',       title: 'Lead Time for Changes',    layout: { x: 0, y: 2,  w: 6, h: 4 }, config: { weeks: 12 } },
    { type: 'VELOCITY_WITH_CONFIDENCE',    title: 'Velocity',                 layout: { x: 6, y: 2,  w: 6, h: 4 }, config: { sprints: 8 } },
    { type: 'ISSUES_OPENED_VS_CLOSED',     title: 'Issues Opened vs Closed',  layout: { x: 0, y: 6,  w: 6, h: 4 }, config: { weeks: 12 } },
    { type: 'ITERATION_PLANNING_ACCURACY', title: 'Planning Accuracy',        layout: { x: 6, y: 6,  w: 6, h: 4 }, config: { sprints: 8 } },
    { type: 'PR_CYCLE_TIME_SCATTER',       title: 'PR Cycle Time',            layout: { x: 0, y: 10, w: 8, h: 4 }, config: { weeks: 8 } },
    { type: 'PR_SIZE_DISTRIBUTION',        title: 'PR Size Distribution',     layout: { x: 8, y: 10, w: 4, h: 4 }, config: { weeks: 12 } },
    { type: 'REVIEW_PICKUP_TIME',          title: 'Review Pickup Time',       layout: { x: 0, y: 14, w: 4, h: 4 }, config: { weeks: 12 } },
    { type: 'BUG_RATE',                    title: 'Bug Rate',                 layout: { x: 4, y: 14, w: 4, h: 4 }, config: { weeks: 12 } },
    { type: 'REWORK_RATE',                 title: 'Rework Rate',              layout: { x: 8, y: 14, w: 4, h: 4 }, config: { weeks: 12 } },
    { type: 'MERGE_FREQUENCY_PER_DEV',     title: 'Merge Frequency / Dev',    layout: { x: 0, y: 18, w: 8, h: 5 }, config: { weeks: 8 } },
    { type: 'INITIATIVE_RISK_RADAR',       title: 'Initiative Risk Radar',    layout: { x: 8, y: 18, w: 4, h: 5 }, config: { horizon_days: 90 } },
    { type: 'REVIEW_MIX',                  title: 'Review Mix (Bot vs Human)', layout: { x: 0, y: 23, w: 6, h: 4 }, config: { weeks: 12 } },
    { type: 'BOT_VS_HUMAN',                title: 'Bot vs Human (Authorship)', layout: { x: 6, y: 23, w: 6, h: 4 }, config: { weeks: 12 } },
    { type: 'COMMITS_PER_DEV',             title: 'Commits per Developer',     layout: { x: 0, y: 27, w: 12, h: 5 }, config: { weeks: 12 } },
    { type: 'REVIEWER_PARTICIPATION',      title: 'Reviewer Participation',    layout: { x: 0, y: 32, w: 8, h: 5 }, config: { weeks: 12 } },
    { type: 'REVIEW_QUALITY_INDEX',        title: 'Review Quality Index',      layout: { x: 0, y: 37, w: 6, h: 5 }, config: { weeks: 12 } },
    { type: 'AI_ADOPTION',                 title: 'AI Adoption',               layout: { x: 6, y: 37, w: 6, h: 5 }, config: { weeks: 12, bucket: 'month' } },
    { type: 'REVIEW_QUALITY_TREND',        title: 'Review Quality Trend',      layout: { x: 0, y: 42, w: 12, h: 8 }, config: { weeks: 12 } },
    { type: 'FLOW_THROUGHPUT_CYCLE',       title: 'Flow: Throughput & Cycle',  layout: { x: 0, y: 50, w: 12, h: 6 }, config: { weeks: 12, maxAgeDays: 90 } },
    { type: 'DELIVERY_TREND_ANNOTATED',    title: 'Delivery Trend',            layout: { x: 0, y: 56, w: 12, h: 6 }, config: { weeks: 12 } },
    { type: 'INVESTMENT_ALLOCATION',       title: 'Investment Allocation',     layout: { x: 0, y: 62, w: 6, h: 4 }, config: { days: 90 } },
    { type: 'DORA_METRICS',                title: 'DORA Metrics',              layout: { x: 6, y: 62, w: 6, h: 4 }, config: { weeks: 12 } },
    { type: 'PERIOD_COMPARISON',        title: 'Period-over-Period',        layout: { x: 0, y: 66, w: 12, h: 6 }, config: {} },
  ],
};


// Team Focus. A separate preset rather than more rows on the Engineering
// Intelligence view, because it answers a different question — where a team's
// attention went and how much of it shipped — and mixing the two would put
// PR-cycle charts next to a classification ledger.
//
//   row 0  : the four headline figures
//   row 2  : attention split beside the delivery funnel
//   row 7  : the focus map, full width
//   row 13 : person by person
//   row 18 : board coverage beside classification provenance
//   row 23 : the ledger, then the generated caveats
export const TEAM_FOCUS_PRESET_V1: Preset = {
  presetKey: 'team-focus-v1',
  viewName: 'Team Focus',
  viewType: 'FOCUS',
  widgets: [
    { type: 'FOCUS_ROADMAP_SHARE',   title: 'Roadmap Focus',        layout: { x: 0, y: 0,  w: 3,  h: 2 }, config: { days: 90 } },
    { type: 'FOCUS_SHIPPED_RATIO',   title: 'Landed in Production', layout: { x: 3, y: 0,  w: 3,  h: 2 }, config: { days: 90 } },
    { type: 'FOCUS_NEVER_MOVED',     title: 'Never Moved',          layout: { x: 6, y: 0,  w: 3,  h: 2 }, config: { days: 90 } },
    { type: 'FOCUS_EPIC_COVERAGE',   title: 'Roadmap Epics Touched', layout: { x: 9, y: 0,  w: 3,  h: 2 }, config: { days: 90 } },
    { type: 'FOCUS_ATTENTION_SPLIT', title: 'Where the Attention Went', layout: { x: 0, y: 2,  w: 7,  h: 5 }, config: { days: 90 } },
    { type: 'FOCUS_DELIVERY_FUNNEL', title: 'Where the Work Ended Up',  layout: { x: 7, y: 2,  w: 5,  h: 5 }, config: { days: 90 } },
    { type: 'FOCUS_MAP',             title: 'Focus Map',            layout: { x: 0, y: 7,  w: 12, h: 6 }, config: { days: 90 } },
    { type: 'FOCUS_SCORECARD',       title: 'Person by Person',     layout: { x: 0, y: 13, w: 12, h: 5 }, config: { days: 90 } },
    { type: 'FOCUS_BOARD_COVERAGE',  title: 'Board Elements Worked On', layout: { x: 0, y: 18, w: 7,  h: 5 }, config: { days: 90 } },
    { type: 'FOCUS_PROVENANCE',      title: 'How Work Was Classified',  layout: { x: 7, y: 18, w: 5,  h: 5 }, config: { days: 90 } },
    { type: 'FOCUS_LEDGER',          title: 'Every Task, and Why',  layout: { x: 0, y: 23, w: 12, h: 7 }, config: { days: 90 } },
    { type: 'FOCUS_CAVEATS',         title: 'Method & Caveats',     layout: { x: 0, y: 30, w: 12, h: 5 }, config: { days: 90 } },
  ],
};

/**
 * Every preset, in the order a board's views should be created.
 *
 * Exists so a new preset is wired into the coverage guard, the demo seeder and
 * the opt-in banner by being added to ONE list. Before this, the seeder in
 * `packages/db` carried a hand-written four-widget subset of the first preset
 * and no trace of the second — the drift this list makes impossible.
 */
export const ALL_PRESETS: readonly Preset[] = [
  ENGINEERING_INTELLIGENCE_PRESET_V1,
  TEAM_FOCUS_PRESET_V1,
];

// Static safety net: the presets must between them reference every widget type
// the catalogue promised. Catches an editor adding a NEW_WIDGET_TYPES entry but
// forgetting to wire it into an auto-seeded view.
const _NEW_WIDGET_TYPES_COVERAGE_GUARD: void = (() => {
  // Across ALL presets, not one. A widget type belongs to exactly one preset,
  // and the guard's purpose is that no catalogued type is left unreachable —
  // not that every preset carries every type.
  const presetTypes = new Set(ALL_PRESETS.flatMap((p) => p.widgets.map((w) => w.type)));
  const missing = NEW_WIDGET_TYPES.filter((t) => !presetTypes.has(t));
  if (missing.length > 0) {
    throw new Error(`No preset seeds widget types: ${missing.join(', ')}`);
  }
})();
