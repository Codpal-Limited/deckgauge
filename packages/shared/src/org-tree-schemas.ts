import { z } from 'zod';

export const OrgProviderSchema = z.enum(['github', 'gitlab', 'ado', 'jira', 'bitbucket']);
export const OrgAliasKindSchema = z.enum(['login', 'email', 'name']);
export const EmployeeTypeSchema = z.enum(['PERMANENT', 'CONTRACTOR']);
export const TimeTypeSchema = z.enum(['FULL_TIME', 'PART_TIME']);
const HIRE_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const BoardStatSchema = z.object({
  boardId: z.string(),
  boardName: z.string(),
  contributedCode: z.boolean(),
  hasAssignment: z.boolean(),
  lastContributionAt: z.string().nullable(),
});
// Raw per-metric contribution counts for the org-tree leaderboard, tallied over
// a rolling window during org-tree sync and stored in statsJson. These are the
// inputs to the ranking; the tree-relative score/rank/tier are computed at API
// read time (see org-ranking.ts + getWithEmployees) because they depend on every
// employee in the tree. Optional/backward-compatible exactly like `heat`.
export const RankingCountsSchema = z.object({
  ticketsClosed: z.number().int().nonnegative(),
  prsMerged: z.number().int().nonnegative(),
  commitsToMain: z.number().int().nonnegative(),
  reviewComments: z.number().int().nonnegative(),
});
export type RankingCounts = z.infer<typeof RankingCountsSchema>;

export const EmployeeStatsSchema = z.object({
  boards: z.array(BoardStatSchema),
  other: z.object({
    contributedCode: z.boolean(),
    lastContributionAt: z.string().nullable(),
  }),
  // Per-ISO-week code-commit counts, oldest → newest, length HEAT_WEEKS. Drives
  // the org-chart card sparkbar. Optional: rows synced before this field shipped
  // simply have no heat until the next org-tree sync repopulates statsJson.
  heat: z.array(z.number().int().nonnegative()).optional(),
  // Raw leaderboard metric counts. Optional for the same reason as `heat`.
  ranking: RankingCountsSchema.optional(),
});
export type EmployeeStats = z.infer<typeof EmployeeStatsSchema>;

// One metric's contribution to the composite score, surfaced in the Ranking tab
// so the full arithmetic behind a rank is visible: the raw count, its 0–100
// min-max subscore across the tree, its weight, and the weighted contribution.
export const RankingMetricDetailSchema = z.object({
  raw: z.number().int().nonnegative(),
  normalized: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  weightedContribution: z.number(),
});
export type RankingMetricDetail = z.infer<typeof RankingMetricDetailSchema>;

export const RankingTierSchema = z.enum(['gold', 'silver', 'bronze', 'top10', 'top25', 'rest']);
export type RankingTier = z.infer<typeof RankingTierSchema>;

// The API-computed, tree-relative ranking attached to each employee DTO. Null
// when the employee is not ranked (vacancy, departed, or unmatched).
export const EmployeeRankingDtoSchema = z.object({
  rank: z.number().int().positive(),
  totalRanked: z.number().int().positive(),
  score: z.number(),
  tier: RankingTierSchema,
  metrics: z.object({
    ticketsClosed: RankingMetricDetailSchema,
    prsMerged: RankingMetricDetailSchema,
    commitsToMain: RankingMetricDetailSchema,
    reviewComments: RankingMetricDetailSchema,
  }),
});
export type EmployeeRankingDto = z.infer<typeof EmployeeRankingDtoSchema>;

export const OrgEmployeeAliasDtoSchema = z.object({
  id: z.string().uuid(),
  provider: OrgProviderSchema,
  kind: OrgAliasKindSchema,
  value: z.string().min(1),
});
export type OrgEmployeeAliasDto = z.infer<typeof OrgEmployeeAliasDtoSchema>;

export const OrgEmployeeDtoSchema = z.object({
  id: z.string().uuid(),
  externalId: z.string().nullable(),
  name: z.string(),
  role: z.string().nullable(),
  email: z.string().nullable(),
  managerId: z.string().uuid().nullable(),
  isVacancy: z.boolean(),
  matched: z.boolean(),
  isActive: z.boolean(),
  lastContributionAt: z.string().nullable(),
  hasAssignment: z.boolean(),
  stats: EmployeeStatsSchema.nullable(),
  // Tree-relative leaderboard position, computed by the API at read time. Null
  // when unranked (vacancy / departed / unmatched, or no ranking counts yet).
  ranking: EmployeeRankingDtoSchema.nullable(),
  aliases: z.array(OrgEmployeeAliasDtoSchema),
  employeeId: z.string().nullable(),
  businessTitle: z.string().nullable(),
  hireDate: z.string().nullable(),
  location: z.string().nullable(),
  employeeType: EmployeeTypeSchema.nullable(),
  timeType: TimeTypeSchema.nullable(),
  phone: z.string().nullable(),
  workAddress: z.string().nullable(),
  salaryCurrent: z.number().int().nullable().optional(),
  salaryCurrency: z.string().nullable().optional(),
  isDeparted: z.boolean(),
  // Stored photo, served by the access-gated `GET /api/uploads/:id` (via the web
  // proxy). Null → the UI shows initials.
  photoUrl: z.string().nullable(),
});
export type OrgEmployeeDto = z.infer<typeof OrgEmployeeDtoSchema>;

export const OrgTreeDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  lastSyncedAt: z.string().nullable(),
  employees: z.array(OrgEmployeeDtoSchema),
});
export type OrgTreeDto = z.infer<typeof OrgTreeDtoSchema>;

export const CreateOrgTreeSchema = z.object({ name: z.string().min(1).max(120) });
export const RenameOrgTreeSchema = z.object({ name: z.string().min(1).max(120) });
export const OrgEmployeeAliasInputSchema = z.object({
  provider: OrgProviderSchema,
  kind: OrgAliasKindSchema,
  value: z.string().min(1),
});

export const ImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  vacancies: z.number().int(),
  rejectedRows: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  orphanWarnings: z.array(z.string()),
  // Photos downloaded from the file's photo column (BambooHR `Photo`). Optional so
  // a client built before photos existed still parses the result.
  photos: z
    .object({
      saved: z.number().int(),
      unchanged: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
    })
    .optional(),
  photoWarnings: z.array(z.string()).optional(),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const SyncStatusSchema = z.object({
  state: z.enum(['idle', 'running']),
  lastSyncedAt: z.string().nullable(),
  matched: z.number().int(),
  total: z.number().int(),
  unmatched: z.array(z.string()),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const CreateEmployeeSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
});
export type CreateEmployeeInput = z.infer<typeof CreateEmployeeSchema>;

export const UpdateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().nullable().optional(),
});
export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeSchema>;

export const UpdateEmployeeProfileSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  employeeId: z.string().nullable().optional(),
  businessTitle: z.string().nullable().optional(),
  hireDate: z.string().regex(HIRE_DATE_REGEX).nullable().optional(),
  location: z.string().nullable().optional(),
  employeeType: EmployeeTypeSchema.nullable().optional(),
  timeType: TimeTypeSchema.nullable().optional(),
  phone: z.string().nullable().optional(),
  workAddress: z.string().nullable().optional(),
  salaryCurrent: z.number().int().min(0).nullable().optional(),
  salaryCurrency: z.string().length(3).nullable().optional(),
});
export type UpdateEmployeeProfileInput = z.infer<typeof UpdateEmployeeProfileSchema>;

export const MoveEmployeeSchema = z.object({
  managerId: z.string().uuid().nullable(),
  position: z.number().int().min(0),
});
export type MoveEmployeeInput = z.infer<typeof MoveEmployeeSchema>;
