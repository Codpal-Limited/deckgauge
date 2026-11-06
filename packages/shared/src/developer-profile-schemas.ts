import { z } from 'zod';

export const DeveloperProviderSchema = z.enum(['github', 'gitlab', 'ado', 'jira', 'bitbucket']);
export type DeveloperProvider = z.infer<typeof DeveloperProviderSchema>;

export const DeveloperProfileSchema = z.object({
  id: z.string().uuid(),
  provider: DeveloperProviderSchema,
  login: z.string().min(1),
  displayName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  email: z.string().email().nullable(),
  userId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeveloperProfileDto = z.infer<typeof DeveloperProfileSchema>;

export const DeveloperProfileLinkSchema = z.object({
  userId: z.string().uuid().nullable(),
});
