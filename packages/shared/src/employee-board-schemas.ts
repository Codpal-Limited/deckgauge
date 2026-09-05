import { z } from 'zod';
import { OrgEmployeeDtoSchema } from './org-tree-schemas.js';
import { EmployeeBoardColumnConfigSchema, EmployeeColumnTypeSchema } from './employee-board-columns.js';

const uuid = z.string().uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const EmployeeColumnDtoSchema = z.object({
  id: uuid,
  name: z.string(),
  type: EmployeeColumnTypeSchema,
  position: z.number().int(),
  config: z.record(z.string(), z.unknown()).nullable(),
});
export type EmployeeColumnDto = z.infer<typeof EmployeeColumnDtoSchema>;

export const EmployeeBoardSummaryDtoSchema = z.object({
  id: uuid,
  orgTreeId: uuid,
  name: z.string(),
  scopeEmployeeId: uuid.nullable(),
  position: z.number().int(),
});
export type EmployeeBoardSummaryDto = z.infer<typeof EmployeeBoardSummaryDtoSchema>;

export const EmployeeBoardMemberDtoSchema = z.object({
  id: uuid,
  position: z.number().int(),
  employee: OrgEmployeeDtoSchema,
  fieldValues: z.record(z.string(), z.string()),
});
export type EmployeeBoardMemberDto = z.infer<typeof EmployeeBoardMemberDtoSchema>;

export const EmployeeGroupDtoSchema = z.object({
  id: uuid,
  name: z.string(),
  color: z.string(),
  position: z.number().int(),
  members: z.array(EmployeeBoardMemberDtoSchema),
});
export type EmployeeGroupDto = z.infer<typeof EmployeeGroupDtoSchema>;

export const EmployeeBoardDetailDtoSchema = z.object({
  id: uuid,
  orgTreeId: uuid,
  name: z.string(),
  scopeEmployeeId: uuid.nullable(),
  position: z.number().int(),
  groups: z.array(EmployeeGroupDtoSchema),
  columnConfig: EmployeeBoardColumnConfigSchema.nullable(),
  columns: z.array(EmployeeColumnDtoSchema),
});
export type EmployeeBoardDetailDto = z.infer<typeof EmployeeBoardDetailDtoSchema>;

export const CreateEmployeeBoardSchema = z.object({
  name: z.string().min(1).max(120),
  scopeEmployeeId: uuid.nullable(),
  /**
   * A personal board is exempt from both implicit-owner rules — the org-ADMIN
   * floor and D12's tree-OWNER rule — so only explicit grants admit anyone.
   * Opt-in; omitted means an ordinary shared board.
   */
  isPersonal: z.boolean().optional().default(false),
});
export type CreateEmployeeBoardInput = z.infer<typeof CreateEmployeeBoardSchema>;

export const RenameEmployeeBoardSchema = z.object({ name: z.string().min(1).max(120) });
export type RenameEmployeeBoardInput = z.infer<typeof RenameEmployeeBoardSchema>;

/**
 * Its own input, and its own route, rather than a field on the rename PATCH:
 * renaming is an editing action (EDITOR), while deciding who may READ a board is
 * not — so the two carry different policies.
 */
export const SetEmployeeBoardPersonalSchema = z.object({ isPersonal: z.boolean() });
export type SetEmployeeBoardPersonalInput = z.infer<typeof SetEmployeeBoardPersonalSchema>;

export const CreateEmployeeGroupSchema = z.object({
  name: z.string().min(1).max(120),
  color: hexColor.optional(),
});
export type CreateEmployeeGroupInput = z.infer<typeof CreateEmployeeGroupSchema>;

export const UpdateEmployeeGroupSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  color: hexColor.optional(),
});
export type UpdateEmployeeGroupInput = z.infer<typeof UpdateEmployeeGroupSchema>;

export const ReorderEmployeeGroupsSchema = z.object({
  order: z.array(z.object({ id: uuid, position: z.number().int().min(0) })),
});
export type ReorderEmployeeGroupsInput = z.infer<typeof ReorderEmployeeGroupsSchema>;

export const AddExistingMembersSchema = z.object({ orgEmployeeIds: z.array(uuid).min(1) });
export type AddExistingMembersInput = z.infer<typeof AddExistingMembersSchema>;

export const AddNewEmployeeSchema = z.object({ name: z.string().min(1), managerId: uuid.nullable() });
export type AddNewEmployeeInput = z.infer<typeof AddNewEmployeeSchema>;

export const MoveMemberSchema = z.object({ employeeGroupId: uuid, position: z.number().int().min(0) });
export type MoveMemberInput = z.infer<typeof MoveMemberSchema>;

export const SetManagerSchema = z.object({ managerId: uuid.nullable() });
export type SetManagerInput = z.infer<typeof SetManagerSchema>;

export const CreateEmployeeColumnSchema = z.object({
  name: z.string().min(1).max(120),
  type: EmployeeColumnTypeSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});
export type CreateEmployeeColumnInput = z.infer<typeof CreateEmployeeColumnSchema>;

export const UpdateEmployeeColumnSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateEmployeeColumnInput = z.infer<typeof UpdateEmployeeColumnSchema>;

export const SetEmployeeFieldValueSchema = z.object({
  employeeColumnId: uuid,
  orgEmployeeId: uuid,
  value: z.string(),
});
export type SetEmployeeFieldValueInput = z.infer<typeof SetEmployeeFieldValueSchema>;
