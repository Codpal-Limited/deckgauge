import { z } from 'zod';

export const GranularitySchema = z.enum(['day', 'week', 'month']);
export const TimesheetModeSchema = z.enum(['normalized', 'raw']);
const ProviderSchema = z.enum(['jira', 'ado', 'github']);
export const ClassificationDtoSchema = z.enum(['CAPEX', 'OPEX', 'Unclassified']);

export const TimesheetGridQuerySchema = z.object({
  orgTreeId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  granularity: GranularitySchema,
  mode: TimesheetModeSchema.default('normalized'),
});
export type TimesheetGridQuery = z.infer<typeof TimesheetGridQuerySchema>;

export const CapexReportQuerySchema = TimesheetGridQuerySchema.extend({
  groupBy: z.enum(['team', 'role', 'person']).optional(),
});
export type CapexReportQuery = z.infer<typeof CapexReportQuerySchema>;

export const EpicBreakdownQuerySchema = z.object({
  orgTreeId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  mode: TimesheetModeSchema.default('normalized'),
  // Page size (epics by hours, descending). Omit for all. Capped so a single
  // page can't drag the whole (potentially 500+ epic) leaderboard into the browser.
  limit: z.coerce.number().int().positive().max(500).optional(),
  // 0-based offset into the ranked list, for paging. Omit → start at the top.
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type EpicBreakdownQuery = z.infer<typeof EpicBreakdownQuerySchema>;

export const IntervalsQuerySchema = z.object({
  orgTreeId: z.string().uuid(),
  issueKey: z.string().min(1),
  employeeId: z.string().uuid(),
  from: z.string().datetime(),
  to: z.string().datetime(),
});
export type IntervalsQuery = z.infer<typeof IntervalsQuerySchema>;

export const TimesheetTaskDtoSchema = z.object({
  issueKey: z.string(),
  provider: ProviderSchema,
  classification: ClassificationDtoSchema,
  seconds: z.number(),
  title: z.string().nullable(),
});
export type TimesheetTaskDto = z.infer<typeof TimesheetTaskDtoSchema>;
export const TimesheetCellDtoSchema = z.object({
  bucketKey: z.string(),
  seconds: z.number(),
  tasks: z.array(TimesheetTaskDtoSchema),
});
export type TimesheetCellDto = z.infer<typeof TimesheetCellDtoSchema>;
export const TimesheetEmployeeRowSchema = z.object({
  employeeId: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  managerId: z.string().nullable(),
  cells: z.array(TimesheetCellDtoSchema),
});
export type TimesheetEmployeeRow = z.infer<typeof TimesheetEmployeeRowSchema>;
export const UnmatchedRowSchema = z.object({
  assignee: z.string(),
  provider: ProviderSchema,
  seconds: z.number(),
});
export const TimesheetGridResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  granularity: GranularitySchema,
  mode: TimesheetModeSchema,
  buckets: z.array(z.string()),
  employees: z.array(TimesheetEmployeeRowSchema),
  unmatched: z.array(UnmatchedRowSchema),
});
export type TimesheetGridResponse = z.infer<typeof TimesheetGridResponseSchema>;

export const ReportBucketSchema = z.object({
  bucketKey: z.string(),
  capexSeconds: z.number(),
  opexSeconds: z.number(),
  unclassifiedSeconds: z.number(),
});
export const ReportGroupSchema = z.object({
  group: z.string(),
  capexSeconds: z.number(),
  opexSeconds: z.number(),
  unclassifiedSeconds: z.number(),
  capexPct: z.number(),
});
export const CapexReportResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: z.object({
    capexSeconds: z.number(),
    opexSeconds: z.number(),
    unclassifiedSeconds: z.number(),
    capexPct: z.number(),
  }),
  byBucket: z.array(ReportBucketSchema),
  byGroup: z.array(ReportGroupSchema),
});
export type CapexReportResponse = z.infer<typeof CapexReportResponseSchema>;

export const EpicEmployeeRowSchema = z.object({
  employeeId: z.string(),
  name: z.string(),
  totalSeconds: z.number(),
  capexSeconds: z.number(),
  opexSeconds: z.number(),
  unclassifiedSeconds: z.number(),
});
export type EpicEmployeeRow = z.infer<typeof EpicEmployeeRowSchema>;

export const EpicRowSchema = z.object({
  epicKey: z.string(),
  provider: ProviderSchema,
  title: z.string().nullable(),
  /** Deep link to the epic in its source system (Jira/ADO); null if unknown. */
  url: z.string().nullable(),
  classification: ClassificationDtoSchema,
  totalSeconds: z.number(),
  capexSeconds: z.number(),
  opexSeconds: z.number(),
  unclassifiedSeconds: z.number(),
  /** Per-developer breakdown of the epic's hours, sorted by hours descending. */
  byEmployee: z.array(EpicEmployeeRowSchema),
});
export type EpicRow = z.infer<typeof EpicRowSchema>;

export const EpicBreakdownResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  epics: z.array(EpicRowSchema),
  // Total distinct epics in the window before offset/limit — lets the UI render
  // "showing 1–25 of N" and know when there are more pages to fetch.
  total: z.number(),
});
export type EpicBreakdownResponse = z.infer<typeof EpicBreakdownResponseSchema>;

export const IntervalDtoSchema = z.object({
  provider: ProviderSchema,
  status: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

/** One status the issue sat in. `counted` mirrors the grid engine's predicate. */
export const TimelineSegmentDtoSchema = z.object({
  status: z.string(),
  category: z.string().nullable(),
  startMs: z.number(),
  endMs: z.number(),
  counted: z.boolean(),
});
export type TimelineSegmentDto = z.infer<typeof TimelineSegmentDtoSchema>;

/**
 * Per-status rollup. `wallMs` is ELAPSED time in the status, never hours
 * attributed to the engineer — see the note on `StatusDuration` in
 * `timesheet/issue-timeline.ts` for why the two must stay separate.
 */
export const StatusDurationDtoSchema = z.object({
  status: z.string(),
  wallMs: z.number(),
  visits: z.number(),
  counted: z.boolean(),
});
export type StatusDurationDto = z.infer<typeof StatusDurationDtoSchema>;

export const IssueEpicDtoSchema = z.object({
  key: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
});
export type IssueEpicDto = z.infer<typeof IssueEpicDtoSchema>;

/**
 * Drill-down detail for one issue on one engineer's row.
 *
 * Everything past `intervals` is ADDITIVE — the first three fields keep the
 * exact shape and meaning they had before the drawer was rebuilt, so a client
 * reading only those is unaffected.
 *
 * Note what is NOT here: hours attributed to the engineer. That number comes
 * out of the grid engine (normalized across concurrent tickets, then daily
 * capped) and the caller already holds it for the cell it clicked; recomputing
 * it here would risk two answers to one question. `inProgressMs` below is
 * elapsed counted-status time, which is a different and honestly-labelled
 * quantity.
 */
export const IntervalsResponseSchema = z.object({
  issueKey: z.string(),
  employeeId: z.string(),
  intervals: z.array(IntervalDtoSchema),
  provider: ProviderSchema.nullable(),
  title: z.string().nullable(),
  /** Deep link into Jira/ADO; null when the source's base URL is unknown. */
  url: z.string().nullable(),
  issueType: z.string().nullable(),
  reporter: z.string().nullable(),
  assignee: z.string().nullable(),
  priority: z.string().nullable(),
  storyPoints: z.number().nullable(),
  sprint: z.string().nullable(),
  epic: IssueEpicDtoSchema.nullable(),
  openedAtMs: z.number().nullable(),
  resolvedAtMs: z.number().nullable(),
  currentStatus: z.string().nullable(),
  /** Elapsed ms in statuses that counted, across the whole issue history. */
  inProgressMs: z.number(),
  /** Full status history, chronological, spanning the issue's whole life. */
  timeline: z.array(TimelineSegmentDtoSchema),
  byStatus: z.array(StatusDurationDtoSchema),
});
export type IntervalsResponse = z.infer<typeof IntervalsResponseSchema>;

export const StatusRuleDtoSchema = z.object({
  id: z.string(),
  scope: z.enum(['ROLE', 'EMPLOYEE']),
  role: z.string().nullable(),
  employeeId: z.string().nullable(),
  inProgressStatuses: z.array(z.string()),
});
export type StatusRuleDto = z.infer<typeof StatusRuleDtoSchema>;

export const PutStatusRulesSchema = z.object({
  rules: z.array(
    z.object({
      scope: z.enum(['ROLE', 'EMPLOYEE']),
      role: z.string().nullable(),
      employeeId: z.string().nullable(),
      inProgressStatuses: z.array(z.string()),
    }),
  ),
});
export type PutStatusRules = z.infer<typeof PutStatusRulesSchema>;

// Per-day working-hours cap (hours). null = use the engine default (8h); 0 = uncapped.
const DailyCapHoursSchema = z.number().min(0).max(24).nullable();

export const OrgTreeTimesheetConfigDtoSchema = z.object({
  activeStatuses: z.array(z.string()),
  dailyCapHours: DailyCapHoursSchema,
});
export type OrgTreeTimesheetConfigDto = z.infer<typeof OrgTreeTimesheetConfigDtoSchema>;

/**
 * Each field is OPTIONAL and omitting one means "leave it as it is".
 *
 * `activeStatuses` became optional when the Time rules drawer took over
 * deciding statuses. That drawer DERIVES the list from the bucket map, so the
 * only other writer of this row — the daily-cap form — must be able to save the
 * cap without restating a status list; echoing back a list it read on page load
 * would clobber whatever the drawer derived in between. Two writers, disjoint
 * fields.
 *
 * `.refine`, because "every field optional" would otherwise accept `{}` and
 * report a malformed request as a successful save. An empty body is not "leave
 * everything alone"; it is a caller bug.
 */
export const PutOrgTreeTimesheetConfigSchema = z
  .object({
    activeStatuses: z.array(z.string()).optional(),
    // null = use the engine default (8h); 0 = uncapped.
    dailyCapHours: DailyCapHoursSchema.optional(),
  })
  .refine((v) => v.activeStatuses !== undefined || v.dailyCapHours !== undefined, {
    message: 'set activeStatuses, dailyCapHours, or both',
  });
export type PutOrgTreeTimesheetConfig = z.infer<typeof PutOrgTreeTimesheetConfigSchema>;
