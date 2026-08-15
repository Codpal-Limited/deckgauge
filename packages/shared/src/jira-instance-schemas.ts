import { z } from "zod";

export const JiraInstanceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  atlassianUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKeys: z.array(z.string().min(1)),
  createdAt: z.coerce.date(),
});

export type JiraInstance = z.infer<typeof JiraInstanceSchema>;

/** What GET /jira/instances returns — token masked */
export const JiraInstancePublicSchema = JiraInstanceSchema.omit({
  apiToken: true,
}).extend({
  apiToken: z.literal("***"),
});

export type JiraInstancePublic = z.infer<typeof JiraInstancePublicSchema>;

export const CreateJiraInstanceInputSchema = z.object({
  name: z.string().trim().min(1),
  atlassianUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKeys: z.array(z.string().min(1)).default([]),
});

export type CreateJiraInstanceInput = z.infer<
  typeof CreateJiraInstanceInputSchema
>;

export const UpdateJiraInstanceInputSchema = z.object({
  name: z.string().trim().min(1).optional(),
  atlassianUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  apiToken: z.string().min(1).optional(),
  projectKeys: z.array(z.string().min(1)).optional(),
});

export type UpdateJiraInstanceInput = z.infer<
  typeof UpdateJiraInstanceInputSchema
>;

/** A machine-readable remedy attached to a failed connection test. */
export const ConnectionHintSchema = z.object({
  kind: z.literal("canonical-url"),
  suggestedUrl: z.string().url(),
});

export type ConnectionHint = z.infer<typeof ConnectionHintSchema>;
