import type { PrismaClient, Prisma } from '@deckgauge/db';
import {
  ALL_PRESETS,
  ENGINEERING_INTELLIGENCE_PRESET_V1,
  TEAM_FOCUS_PRESET_V1,
  widgetIsSupportedByScope,
  type Preset,
  type PresetWidget,
  type WidgetScopeFlags,
} from '@deckgauge/shared';

/**
 * The preset DEFINITIONS live in `@deckgauge/shared`; this file owns only the
 * Prisma and HTTP half.
 *
 * They moved because `packages/db`'s demo seeder needs them and cannot import
 * from `apps/api`. It previously carried a hand-written four-widget subset of
 * the Engineering Intelligence preset and nothing at all for Team Focus, so a
 * seeded demo showed 4 of 26 widgets and no Focus view. Re-exported here so
 * every existing call site and test keeps working unchanged.
 */
export {
  ALL_PRESETS,
  ENGINEERING_INTELLIGENCE_PRESET_V1,
  TEAM_FOCUS_PRESET_V1,
  type Preset,
  type PresetWidget,
};

export type PresetErrorCode = 'PRESET_ALREADY_APPLIED' | 'UNKNOWN_PRESET';

export interface PresetError extends Error {
  code: PresetErrorCode;
}

function presetError(code: PresetErrorCode, message: string): PresetError {
  const e = new Error(message) as PresetError;
  e.code = code;
  return e;
}

// DERIVED from ALL_PRESETS, not enumerated. That list's whole claim is that a
// new preset is wired in "by being added to ONE list" — and this lookup was the
// third consumer, quietly requiring a second edit. A preset absent from here is
// UNKNOWN_PRESET: the banner offers it and applying it 400s.
const PRESETS_BY_KEY: Record<string, Preset> = Object.fromEntries(
  ALL_PRESETS.map((p) => [p.presetKey, p])
);

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
          type: preset.viewType ?? 'DASHBOARD',
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
