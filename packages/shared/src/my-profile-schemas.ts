import { z } from 'zod';

/** One org-chart row that matches the signed-in person's email. Never salary. */
export const MyOrgChartEntrySchema = z.object({
  orgTreeId: z.string(),
  orgTreeName: z.string(),
  employeeId: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  businessTitle: z.string().nullable(),
  employeeDisplayId: z.string().nullable(),
  email: z.string().nullable(),
  location: z.string().nullable(),
  phone: z.string().nullable(),
  hireDate: z.string().nullable(),
  manager: z.object({ id: z.string(), name: z.string() }).nullable(),
  directReports: z.number().int().nonnegative(),
  photoUrl: z.string().nullable(),
  isDeparted: z.boolean(),
});
export type MyOrgChartEntry = z.infer<typeof MyOrgChartEntrySchema>;

export const MyProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  organization: z
    .object({ id: z.string(), name: z.string(), role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']) })
    .nullable(),
  orgChart: z.array(MyOrgChartEntrySchema),
});
export type MyProfile = z.infer<typeof MyProfileSchema>;

export const AvatarResultSchema = z.object({ avatarUrl: z.string().nullable() });
export type AvatarResult = z.infer<typeof AvatarResultSchema>;

/** Largest profile photo accepted, in bytes. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
