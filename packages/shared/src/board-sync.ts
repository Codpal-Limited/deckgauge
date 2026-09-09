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

// A single board can carry tens of thousands of exclusions (20,607 on one real
// board, written in a single bulk action) — the list endpoint is paginated, and
// this is the page shape rather than a bare array. `total` is the full count for
// the board+source, independent of how many rows this page carries.
export const BoardSyncExclusionPageSchema = z.object({
  rows: z.array(BoardSyncExclusionSchema),
  total: z.number().int().min(0),
});
export type BoardSyncExclusionPage = z.infer<typeof BoardSyncExclusionPageSchema>;

// `limit`/`offset` are validated as plain positive/non-negative integers here;
// the server-side hard cap (`MAX_PAGE` in `BoardSyncExclusionService`) is what
// actually bounds the response, so a limit above the cap is not a 400 — it is
// silently capped. `source` omitted means "every source", per the "empty means
// all, never none" rule — never "no source" as "nothing".
export const ListBoardSyncExclusionsQuerySchema = z.object({
  source: SyncExclusionSourceSchema.optional(),
  limit: z.coerce.number().int().positive().default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type ListBoardSyncExclusionsQuery = z.infer<
  typeof ListBoardSyncExclusionsQuerySchema
>;

// Selective restore: an explicit id list, scoped to the caller's board (see the
// service's doc comment on `restore`).
export const RestoreBoardSyncExclusionsByIdsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type RestoreBoardSyncExclusionsByIds = z.infer<
  typeof RestoreBoardSyncExclusionsByIdsSchema
>;

// Bulk restore: "restore all N" for one board+source. Deliberately NOT an id
// list — a board can carry tens of thousands of exclusions, and forcing the
// browser to fetch and repost every id would defeat the pagination this shape
// exists alongside, and risks the Postgres 65,535 bind-parameter ceiling this
// codebase already works around elsewhere (see `sync-exclusion.ts`'s
// `CHUNK_SIZE`). The server deletes by (boardId, source) directly.
export const RestoreAllBoardSyncExclusionsSchema = z
  .object({
    source: SyncExclusionSourceSchema,
  })
  .strict();
export type RestoreAllBoardSyncExclusions = z.infer<
  typeof RestoreAllBoardSyncExclusionsSchema
>;

// The DELETE route accepts either shape — selective restore keeps working
// unchanged, and restore-all is additive.
export const RestoreBoardSyncExclusionsInputSchema = z.union([
  RestoreBoardSyncExclusionsByIdsSchema,
  RestoreAllBoardSyncExclusionsSchema,
]);
export type RestoreBoardSyncExclusionsInput = z.infer<
  typeof RestoreBoardSyncExclusionsInputSchema
>;

export const RestoreBoardSyncExclusionsResponseSchema = z.object({
  restored: z.number().int().min(0),
});
export type RestoreBoardSyncExclusionsResponse = z.infer<
  typeof RestoreBoardSyncExclusionsResponseSchema
>;
