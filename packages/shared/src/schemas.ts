import { z } from "zod/v4";

export const BoardSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  description: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Board = z.infer<typeof BoardSchema>;

export const CreateBoardInputSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().max(500).optional(),
});

export type CreateBoardInput = z.infer<typeof CreateBoardInputSchema>;

export const UpdateBoardInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().max(500).nullish(),
});

export type UpdateBoardInput = z.infer<typeof UpdateBoardInputSchema>;

export const ProjectStatusEnum = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "AT_RISK",
  "BLOCKED",
  "DONE",
]);

export type ProjectStatus = z.infer<typeof ProjectStatusEnum>;

export const CostClassificationEnum = z.enum(['CAPEX', 'OPEX']);
export type CostClassification = z.infer<typeof CostClassificationEnum>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  assignee: z.string().default(""),
  // Field keys a human has edited; sync skips them until reverted.
  overriddenFields: z.array(z.string()).default([]),
  // Pre-edit synced value per dirty key — the value revert restores. The client
  // needs it to label the revert affordance ("synced value was …").
  preOverrideValues: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ProjectStatusEnum,
  description: z.string().nullable().default(null),
  boardId: z.string().uuid().nullable().default(null),
  groupId: z.string().uuid().nullable().default(null),
  ownerId: z.string().uuid().nullable().default(null),
  statusId: z.string().uuid().nullable().default(null),
  order: z.number().nullable().default(null),
  jiraKey: z.string().nullable().default(null),
  githubIssueId: z.string().nullable().default(null),
  githubRepoFullName: z.string().nullable().default(null),
  adoWorkItemId: z.number().int().nullable().default(null),
  adoProject: z.string().nullable().default(null),
  startDate: z.coerce.date().nullable().default(null),
  endDate: z.coerce.date().nullable().default(null),
  dueDate: z.coerce.date().nullable().default(null),
  durationCode: z.string().nullable().default(null),
  costClassification: CostClassificationEnum.nullable().default(null),
  // Recruitment: OrgEmployee this candidate row was onboarded as (null until onboarded).
  onboardedEmployeeId: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const GroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  position: z.number().int().min(0),
  color: z.string().default("#6C6CFF"),
  boardId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type Group = z.infer<typeof GroupSchema>;

export const CreateGroupInputSchema = z.object({
  name: z.string().trim().min(1),
  boardId: z.string().uuid(),
});

export type CreateGroupInput = z.infer<typeof CreateGroupInputSchema>;

export const UpdateGroupInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export type UpdateGroupInput = z.infer<typeof UpdateGroupInputSchema>;

export const ReorderGroupsInputSchema = z.array(
  z.object({
    id: z.string().uuid(),
    position: z.number().int().min(0),
  }),
);

export type ReorderGroupsInput = z.infer<typeof ReorderGroupsInputSchema>;
