import { z } from 'zod';

/** Hard caps on the replayed transcript. Both bind; whichever hits first wins. */
export const ADVISOR_HISTORY_MAX_MESSAGES = 20;
export const ADVISOR_HISTORY_MAX_CHARS = 8000;

/**
 * Longest single STORED turn — an answer we write to Postgres, which is
 * generous on purpose.
 *
 * Deliberately NOT the bound on a REPLAYED turn: a message being worth
 * keeping in a transcript says nothing about how much of it we are willing to
 * ship back through the org's provider API key on every subsequent question.
 * That budget is `ADVISOR_HISTORY_MAX_CHARS`, and the history schema below
 * uses it.
 */
export const ADVISOR_MESSAGE_MAX_CHARS = 20_000;

/**
 * Longest single QUESTION a client may ask, on any ask route.
 *
 * Deliberately far below `ADVISOR_MESSAGE_MAX_CHARS`, for the same reason that
 * constant is not the replay budget: an inbound question goes straight out
 * through the org's provider API key, so it is spend, not storage. Named and
 * shared rather than repeated inline — the board route and the help route drifted
 * to 2,000 and 20,000 respectively while nothing pinned them together.
 */
export const ADVISOR_QUESTION_MAX_CHARS = 2_000;

/** Longest session title. One dropdown row is one line. */
export const ADVISOR_TITLE_MAX_CHARS = 60;

/**
 * Turns the first question of a session into its list-row title. Whitespace is
 * collapsed because the dropdown renders one line per session, and a question
 * pasted with newlines would otherwise blow the row height out.
 *
 * Lives here rather than in the API service because BOTH sides derive it: the
 * server when it titles a session on its first appended message, and the panel
 * optimistically at `ASK_START`. Two implementations meant the panel header and
 * the history dropdown disagreed about the same session until a reload.
 */
export function deriveSessionTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat.length <= ADVISOR_TITLE_MAX_CHARS) return flat;
  return `${flat.slice(0, ADVISOR_TITLE_MAX_CHARS - 1)}…`;
}

export const advisorMessageRoleSchema = z.enum(['user', 'assistant']);
export type AdvisorMessageRole = z.infer<typeof advisorMessageRoleSchema>;

export const advisorHistoryMessageSchema = z.object({
  role: advisorMessageRoleSchema,
  text: z.string().min(1).max(ADVISOR_HISTORY_MAX_CHARS),
});
export type AdvisorHistoryMessage = z.infer<typeof advisorHistoryMessageSchema>;

/**
 * Trims a stored transcript down to what we're willing to replay with the next
 * question.
 *
 * Walks from the newest end backwards so the most relevant turns always
 * survive, drops only WHOLE messages (a half-sentence of a prior answer is
 * worse than no answer at all), then restores chronological order.
 *
 * Two deliberate edge behaviours:
 * - A single message that alone exceeds the character budget is DROPPED, even
 *   when it is the newest one and the result is an empty history. A stored
 *   turn may be up to `ADVISOR_MESSAGE_MAX_CHARS`, far above this budget, and
 *   the server enforces the budget as a hard limit — so keeping such a message
 *   "rather than returning nothing" would fail the whole ask with a 400
 *   instead of merely answering without context.
 * - A leading assistant turn is dropped, because trimming can land mid-exchange
 *   and an answer whose question was trimmed away reads as an unprompted claim.
 */
export function buildHistoryForAsk(
  messages: readonly AdvisorHistoryMessage[],
): AdvisorHistoryMessage[] {
  const newestFirst: AdvisorHistoryMessage[] = [];
  let chars = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (newestFirst.length >= ADVISOR_HISTORY_MAX_MESSAGES) break;
    if (chars + message.text.length > ADVISOR_HISTORY_MAX_CHARS) break;
    newestFirst.push(message);
    chars += message.text.length;
  }

  const chronological = [...newestFirst].reverse();
  const firstUserTurn = chronological.findIndex((message) => message.role === 'user');
  if (firstUserTurn === -1) return [];
  return firstUserTurn === 0 ? chronological : chronological.slice(firstUserTurn);
}

/** Which page the user was on when they asked. Drives starters and, later, live state. */
export const advisorPageContextSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});

export type AdvisorPageContextDto = z.infer<typeof advisorPageContextSchema>;

/**
 * Rejects a history transcript that exceeds, in aggregate, the replay
 * budget. `advisorHistoryMessageSchema` only caps each message
 * INDEPENDENTLY at `ADVISOR_HISTORY_MAX_CHARS` — nothing stopped an
 * authenticated VIEWER from POSTing 20 (the message-count cap) maximum-length
 * turns of history per ask onto the org's provider API key, over and over.
 * Shared by every ask-shaped schema below so the bound can't drift between
 * them.
 */
function checkHistoryCharBudget(
  ctx: z.RefinementCtx,
  history: readonly AdvisorHistoryMessage[],
): void {
  const chars = history.reduce((total, message) => total + message.text.length, 0);
  if (chars <= ADVISOR_HISTORY_MAX_CHARS) return;
  ctx.addIssue({
    // `custom` rather than `too_big`: the latter's payload shape differs
    // between zod major versions, and nothing here needs to introspect it.
    code: 'custom',
    path: ['history'],
    message: `history must total at most ${ADVISOR_HISTORY_MAX_CHARS} characters`,
  });
}

export const advisorAskRequestSchema = z
  .object({
    boardId: z.string().min(1),
    question: z.string().min(1).max(ADVISOR_QUESTION_MAX_CHARS),
    widgetType: z.string().optional(), // pre-scopes the answer to a widget when opened from one
    pageContext: advisorPageContextSchema.optional(),
    // Client-assembled and client-capped (see `buildHistoryForAsk`). The
    // server validates the SHAPE and the SIZE, but not the content: a user can
    // only ever poison their own conversation, and the tools stay board-scoped
    // and read-only regardless.
    history: z.array(advisorHistoryMessageSchema).max(ADVISOR_HISTORY_MAX_MESSAGES).default([]),
  })
  // The size half of that — see `checkHistoryCharBudget`. The character
  // budget has to bind here too, or it is a client-side courtesy rather than
  // a limit.
  .superRefine((value, ctx) => checkHistoryCharBudget(ctx, value.history));
export type AdvisorAskRequest = z.infer<typeof advisorAskRequestSchema>;

/**
 * An off-board product-help question. Deliberately a separate shape from
 * `advisorAskRequestSchema`: there is no board scope to speak of, and
 * `boardId` here is an OPTIONAL hint for live state (Phase 2), never the
 * thing that authorizes the request.
 */
export const advisorHelpAskRequestSchema = z
  .object({
    question: z.string().min(1).max(ADVISOR_QUESTION_MAX_CHARS),
    pageContext: advisorPageContextSchema,
    boardId: z.string().min(1).optional(),
    // Same status as `boardId` above: an OPTIONAL hint for the standalone
    // Roadmap entity's live state, never the thing that authorizes the
    // request. The route must still verify it through `RoadmapService.getRole`
    // — a board's `hasBoardAccess` does not govern a standalone roadmap.
    roadmapId: z.string().min(1).optional(),
    history: z.array(advisorHistoryMessageSchema).max(ADVISOR_HISTORY_MAX_MESSAGES).optional(),
  })
  // Same aggregate-size gap as `advisorAskRequestSchema` above, and the same
  // fix — this schema will be what a future help-ask route parses against,
  // so it carries the identical bound rather than relying on the per-message
  // cap alone.
  .superRefine((value, ctx) => checkHistoryCharBudget(ctx, value.history ?? []));

export type AdvisorHelpAskRequest = z.infer<typeof advisorHelpAskRequestSchema>;

export const advisorAppendMessageSchema = z.object({
  role: advisorMessageRoleSchema,
  text: z.string().min(1).max(ADVISOR_MESSAGE_MAX_CHARS),
  toolCalls: z.array(z.string()).max(50).default([]),
});
export type AdvisorAppendMessageInput = z.infer<typeof advisorAppendMessageSchema>;

/** One row in the panel's history dropdown. */
export interface AdvisorSessionSummaryDto {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface AdvisorSessionMessageDto {
  id: string;
  role: AdvisorMessageRole;
  text: string;
  toolCalls: string[];
  createdAt: string;
}

export interface AdvisorSessionTranscriptDto {
  id: string;
  title: string;
  updatedAt: string;
  messages: AdvisorSessionMessageDto[];
}

export const advisorConfigSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('anthropic'), apiKey: z.string().min(1), model: z.string().min(1) }),
  z.object({ provider: z.literal('ollama'), baseUrl: z.string().url(), model: z.string().min(1) }),
]);
export type AdvisorConfigInput = z.infer<typeof advisorConfigSchema>;

/**
 * Body for `PUT /advisor/config/source-lookup` — the operator switch for the
 * Advisor's `search_source`/`read_source` tools.
 *
 * A separate schema rather than a field added to `advisorConfigSchema`: that
 * schema is the request body for `PUT /advisor/config` AND
 * `POST /advisor/config/test`, and it is a discriminated union on `provider`
 * whose members are provider credentials. Adding an unrelated boolean to it
 * would change both of those contracts and the settings form that posts them.
 *
 * `enabled` has no default on purpose: a PUT that forgot the field is a 400,
 * not a silent enable of a feature the operator may have meant to switch off.
 */
export const advisorSourceLookupSchema = z.object({ enabled: z.boolean() });
export type AdvisorSourceLookupInput = z.infer<typeof advisorSourceLookupSchema>;
