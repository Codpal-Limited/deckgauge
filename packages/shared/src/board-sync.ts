import { z } from 'zod';

// `reauthorize` is distinct from `expired` on purpose: the credential is still
// valid, but the identity provider behind it wants an interactive re-auth
// (Entra `AADSTS…`, GitHub SAML enforcement). Issuing a fresh token does not
// fix that, so the two states must not share the same "expired" copy.
export const SourceHealthStateSchema = z.enum([
  'valid',
  'expired',
  'reauthorize',
  'unreachable',
]);
export type SourceHealthState = z.infer<typeof SourceHealthStateSchema>;

export const BoardSourceHealthSchema = z.object({
  provider: z.enum(['jira', 'github', 'ado', 'gitlab']),
  instanceId: z.string(),
  label: z.string(),
  state: SourceHealthStateSchema,
  error: z.string().optional(),
});
export type BoardSourceHealth = z.infer<typeof BoardSourceHealthSchema>;

export const BoardSourceHealthResponseSchema = z.object({
  sources: z.array(BoardSourceHealthSchema),
  hasExpired: z.boolean(),
});
export type BoardSourceHealthResponse = z.infer<typeof BoardSourceHealthResponseSchema>;

export const BoardSyncEnqueueResponseSchema = z.object({
  boardId: z.string().uuid(),
  enqueued: z.object({
    jira: z.number().int().min(0),
    github: z.number().int().min(0),
    ado: z.number().int().min(0),
    gitlab: z.number().int().min(0),
  }),
  expired: z.array(BoardSourceHealthSchema).default([]),
});
export type BoardSyncEnqueueResponse = z.infer<
  typeof BoardSyncEnqueueResponseSchema
>;

export const BoardSyncStatusResponseSchema = z.object({
  status: z.enum(['IDLE', 'RUNNING']),
  finishedAt: z.string().datetime().nullable(),
  sourceCount: z.number().int().min(0),
});
export type BoardSyncStatusResponse = z.infer<
  typeof BoardSyncStatusResponseSchema
>;

// ---------------- Sync exclusions ----------------
// Deleting a synced row records a `BoardSyncExclusion`, which every promote
// service filters out of all future syncs. That is deliberate — a deleted row
// must not reappear — but without a way to list and undo it, a bulk delete
// silently blacklists work items forever. These shapes back the "Excluded
// items" block on the board Sources page.

export const SyncExclusionSourceSchema = z.enum(['JIRA', 'GITHUB', 'ADO', 'GITLAB']);
export type SyncExclusionSource = z.infer<typeof SyncExclusionSourceSchema>;

export const BoardSyncExclusionSchema = z.object({
  id: z.string().uuid(),
  source: SyncExclusionSourceSchema,
  /** Provider-native identifier: Jira issue key, ADO work-item id, GitHub issue id. */
  externalId: z.string(),
  excludedAt: z.string().datetime(),
  excludedBy: z.string().nullable(),
});
export type BoardSyncExclusion = z.infer<typeof BoardSyncExclusionSchema>;

export const BoardSyncExclusionListResponseSchema = z.array(BoardSyncExclusionSchema);
export type BoardSyncExclusionListResponse = z.infer<
  typeof BoardSyncExclusionListResponseSchema
>;

export const RestoreBoardSyncExclusionsInputSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});
export type RestoreBoardSyncExclusionsInput = z.infer<
  typeof RestoreBoardSyncExclusionsInputSchema
>;

export const RestoreBoardSyncExclusionsResponseSchema = z.object({
  restored: z.number().int().min(0),
});
export type RestoreBoardSyncExclusionsResponse = z.infer<
  typeof RestoreBoardSyncExclusionsResponseSchema
>;
