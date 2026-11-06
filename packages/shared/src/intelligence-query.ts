import { z } from 'zod';

// Preset values for the board-level period picker (see design spec §4.2).
export const periodPresetSchema = z.enum(['7d', '14d', '30d', '90d']);
export type PeriodPreset = z.infer<typeof periodPresetSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Discriminated union of the three states the board period picker can be in:
// - none: no override; widgets fall back to their own per-widget defaults.
// - preset: a days count derived from a 7/14/30/90 preset.
// - custom: an explicit ISO-date from/to range.
export const boardPeriodSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('preset'), days: z.number().int().positive() }),
  z.object({ mode: z.literal('custom'), from: isoDate, to: isoDate }),
]);
export type BoardPeriod = z.infer<typeof boardPeriodSchema>;

// Maps the four documented preset values to their numeric day count.
export function presetToDays(p: PeriodPreset): number {
  switch (p) {
    case '7d':
      return 7;
    case '14d':
      return 14;
    case '30d':
      return 30;
    case '90d':
      return 90;
  }
}

// Server-rendered schema payload for the intelligence console.
// `tables` is the column catalog for source types the board is connected to;
// `scope` is the verbatim list of source identifiers the board can read.
export const intelligenceSchemaSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(z.object({ name: z.string(), type: z.string() })),
    }),
  ),
  scope: z.object({
    repos: z.array(z.string()),
    jiraProjectKeys: z.array(z.string()),
    adoProjects: z.array(z.string()),
    gitlabProjectPaths: z.array(z.string()),
    bitbucketRepoFullNames: z.array(z.string()),
  }),
});
export type IntelligenceSchema = z.infer<typeof intelligenceSchemaSchema>;

// Response payload for GET /boards/:id/intelligence/sql — the verbatim SQL the
// widget service would have executed, plus the bound parameters.
export const intelligenceSqlResponseSchema = z.object({
  sql: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type IntelligenceSqlResponse = z.infer<typeof intelligenceSqlResponseSchema>;
