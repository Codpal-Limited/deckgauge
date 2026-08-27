import { z } from 'zod/v4';

export const EmployeeCommentSchema = z.object({
  id: z.string().uuid(),
  orgEmployeeId: z.string().uuid(),
  content: z.unknown(),
  authorName: z.string().min(1),
  authorAvatar: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
  /**
   * Author-only when true (org-tree privacy D2). Present in the DTO so the UI can
   * mark it, and `authorId` alongside it so the UI knows whose it is — only the
   * author may flip the flag.
   */
  isPrivate: z.boolean().default(false),
  authorId: z.string().uuid().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type EmployeeComment = z.infer<typeof EmployeeCommentSchema>;

export const CreateEmployeeCommentInputSchema = z.object({
  content: z.unknown().refine((val) => val !== null && val !== undefined, {
    message: 'Content is required',
  }),
  // Opt-in per comment: existing behaviour is public, and defaulting to private
  // would silently break the shared-notes workflow.
  isPrivate: z.boolean().optional().default(false),
  authorName: z.string().min(1).default('VP'),
  uploadIds: z.array(z.string()).optional().default([]),
});

export type CreateEmployeeCommentInput = z.infer<typeof CreateEmployeeCommentInputSchema>;

export const UpdateEmployeeCommentInputSchema = z
  .object({
    content: z.unknown().optional(),
    pinned: z.boolean().optional(),
    /** Only the author may change this — enforced in the service, not here. */
    isPrivate: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.content !== undefined || data.pinned !== undefined || data.isPrivate !== undefined,
    { message: 'At least one field must be provided' },
  );

export type UpdateEmployeeCommentInput = z.infer<typeof UpdateEmployeeCommentInputSchema>;
