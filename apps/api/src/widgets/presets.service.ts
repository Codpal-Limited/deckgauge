import type { PrismaClient, Prisma } from '@deckgauge/db';
import {
  NEW_WIDGET_TYPES,
  widgetIsSupportedByScope,
  type NewWidgetType,
  type WidgetScopeFlags,
} from '@deckgauge/shared';

export type PresetErrorCode = 'PRESET_ALREADY_APPLIED' | 'UNKNOWN_PRESET';

export interface PresetError extends Error {
  code: PresetErrorCode;
}

function presetError(code: PresetErrorCode, message: string): PresetError {
  const e = new Error(message) as PresetError;
  e.code = code;
  return e;
}

export interface PresetWidget {
  type: NewWidgetType;
  title: string;
  layout: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
}

export interface Preset {
  presetKey: string;
  viewName: string;
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

// Static safety net: the preset must reference every widget type the catalogue
// promised. Catches an editor adding a NEW_WIDGET_TYPES entry but forgetting
// to wire it into the auto-seeded view.
const _NEW_WIDGET_TYPES_COVERAGE_GUARD: void = (() => {
  const presetTypes = new Set(ENGINEERING_INTELLIGENCE_PRESET_V1.widgets.map((w) => w.type));
  const missing = NEW_WIDGET_TYPES.filter((t) => !presetTypes.has(t));
  if (missing.length > 0) {
    throw new Error(
      `ENGINEERING_INTELLIGENCE_PRESET_V1 is missing widgets: ${missing.join(', ')}`
    );
  }
})();

const PRESETS_BY_KEY: Record<string, Preset> = {
  [ENGINEERING_INTELLIGENCE_PRESET_V1.presetKey]: ENGINEERING_INTELLIGENCE_PRESET_V1,
};

export class PresetService {
  constructor(private readonly prisma: PrismaClient) {}

  // Idempotent on (boardId, presetKey): re-applying surfaces 409 via the
  // PRESET_ALREADY_APPLIED code so the UI can suppress duplicate banners.
  // The create-view + create-widgets pair runs in a single Prisma transaction
  // so a half-seeded preset never lingers.
  async applyPreset(
    boardId: string,
    presetKey: string
  ): Promise<{ viewId: string; widgetCount: number }> {
    const preset = PRESETS_BY_KEY[presetKey];
    if (!preset) {
      throw presetError('UNKNOWN_PRESET', `Unknown preset: ${presetKey}`);
    }

    const existing = await this.prisma.boardView.findFirst({
      where: { boardId, presetKey },
    });
    if (existing) {
      throw presetError(
        'PRESET_ALREADY_APPLIED',
        `Preset ${presetKey} is already applied to board ${boardId}`
      );
    }

    const scope = await this.readBoardScope(boardId);
    const supportedWidgets = preset.widgets.filter((w) =>
      widgetIsSupportedByScope(w.type, scope)
    );

    return this.prisma.$transaction(async (tx) => {
      const view = await tx.boardView.create({
        data: {
          boardId,
          type: 'DASHBOARD',
          name: preset.viewName,
          presetKey: preset.presetKey,
        },
      });
      if (supportedWidgets.length === 0) {
        return { viewId: view.id, widgetCount: 0 };
      }
      const created = await tx.dashboardWidget.createMany({
        data: supportedWidgets.map((w) => ({
          boardViewId: view.id,
          widgetType: w.type,
          title: w.title,
          config: w.config as Prisma.InputJsonValue,
          layout: w.layout as unknown as Prisma.InputJsonValue,
        })),
      });
      return { viewId: view.id, widgetCount: created.count };
    });
  }

  private async readBoardScope(boardId: string): Promise<WidgetScopeFlags> {
    const [jira, github, gitlab, ado] = await Promise.all([
      this.prisma.boardJiraSource.count({ where: { boardId } }),
      this.prisma.boardGitHubSource.count({ where: { boardId } }),
      this.prisma.boardGitLabSource.count({ where: { boardId } }),
      this.prisma.boardAdoSource.count({ where: { boardId } }),
    ]);
    return {
      hasJira: jira > 0,
      hasGitHub: github > 0,
      hasGitLab: gitlab > 0,
      hasAdo: ado > 0,
    };
  }
}
