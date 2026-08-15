import { z } from 'zod';

// Jira project keys are letters/digits/underscore starting with a letter (e.g.
// PT, JD, JMPT). Stored and compared UPPERCASE; input is trimmed + uppercased.
const projectKey = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Invalid Jira project key'));

// Accept any string a Date can parse (the UI sends 'YYYY-MM-DD'); reject junk.
const cutoffDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'Invalid cutoff date',
});

export const CreateRetiredJiraProjectInputSchema = z.object({
  projectKey,
  cutoffDate,
  note: z.string().max(500).nullish(),
});

export const UpdateRetiredJiraProjectInputSchema = z.object({
  cutoffDate: cutoffDate.optional(),
  note: z.string().max(500).nullish(),
});

export const RetiredJiraProjectDtoSchema = z.object({
  projectKey: z.string(),
  cutoffDate: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateRetiredJiraProjectInput = z.infer<typeof CreateRetiredJiraProjectInputSchema>;
export type UpdateRetiredJiraProjectInput = z.infer<typeof UpdateRetiredJiraProjectInputSchema>;
export type RetiredJiraProjectDto = z.infer<typeof RetiredJiraProjectDtoSchema>;
