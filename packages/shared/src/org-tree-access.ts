import { z } from 'zod';

export const OrgTreeAccessRoleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);

export const GrantOrgTreeAccessSchema = z.object({
  userId: z.string().uuid(),
  role: OrgTreeAccessRoleSchema,
});

export const UpdateOrgTreeAccessSchema = z.object({
  role: OrgTreeAccessRoleSchema,
});

export type GrantOrgTreeAccess = z.infer<typeof GrantOrgTreeAccessSchema>;
export type UpdateOrgTreeAccess = z.infer<typeof UpdateOrgTreeAccessSchema>;
