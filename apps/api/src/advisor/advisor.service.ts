import { streamText, stepCountIs } from 'ai';
import type { AdvisorHistoryMessage, EffectiveBoardRole } from '@deckgauge/shared';
import { buildAdvisorTools, type AdvisorToolDeps } from './tools.js';
import type { LlmProvider } from './llm-provider.js';
import { stepsForProvider, toolsForProvider } from './local-tier.js';
import type { BoardScope } from '../intelligence/board-scope.js';

// Hard iteration cap on the agentic loop (tool-call round trips per answer).
export const MAX_STEPS = 6;
// Per-answer output token budget guardrail.
export const MAX_TOKENS = 4000;

/**
 * Deliberately describes only what the tools can actually do.
 *
 * It used to say "read-only analyst" that "cannot change anything" — on the
 * exact surface that now hands an EDITOR `propose_board_changes`. A prompt that
 * contradicts the toolset is the shape that makes a model either refuse a
 * capability it has or narrate a proposal as a completed change.
 *
 * One prompt for both roles, stated as a conditional ("if a tool is offered"),
 * because `buildAdvisorTools` composes the toolset by the caller's board role:
 * a VIEWER never sees `propose_board_changes` at all, so promising them the
 * capability would be the same lie in the other direction. The last two
 * sentences mirror the tool's own description rather than restating it in
 * different words, so the two cannot drift into disagreeing.
 */
const SYSTEM = [
  'You are the Deckgauge Advisor, an analyst for one engineering board.',
  'Answer questions by calling the provided tools to fetch real numbers — never invent metrics.',
  'You can only read data for the current board, and you cannot change the board yourself.',
  'If a tool for proposing board changes is offered to you, it only creates a proposal a human must',
  'approve in Deckgauge — so never claim a change has been made; report the preview and say it is',
  'waiting for their approval. If no such tool is offered, you cannot propose changes at all: say so.',
  'Ground every claim in a tool result, cite the concrete numbers, and end with one concrete next step.',
].join(' ');

export interface AdvisorAskParams {
  provider: LlmProvider;
  /**
   * The board the request was authorized against, from the route param — never
   * the request body (`advisor.routes.ts` already rejects a body/param
   * mismatch) and never the model.
   */
  boardId: string;
  /**
   * The caller's effective board role, resolved by the route AFTER
   * authorization (`AccessService.getEffectiveRole`) — never from the model,
   * the request body, or a header. `buildAdvisorTools` uses it to compose the
   * toolset, so this is what keeps a board VIEWER from being offered
   * `propose_board_changes` on a route whose own floor is only VIEWER.
   */
  role: EffectiveBoardRole;
  scope: BoardScope;
  question: string;
  widgetType?: string;
  /**
   * Prior turns of this conversation, oldest first, already capped by the
   * client's `buildHistoryForAsk`. Replayed as real conversation turns rather
   * than pasted into the prompt so the model treats a previous answer as its
   * own words, which is what makes "why?" and "break that down" work.
   */
  history?: readonly AdvisorHistoryMessage[];
}

export interface AdvisorRun {
  textStream: AsyncIterable<string>;
  toolCalls: Promise<Array<{ name: string }>>;
}

export class AdvisorService {
  constructor(private readonly deps: AdvisorToolDeps) {}

  ask(params: AdvisorAskParams): AdvisorRun {
    // Weak local models are unreliable multi-tool callers, so the Ollama tier gets
    // one tool — the team overview, which answers the most common question — and a
    // lower step ceiling. Rich providers are unaffected.
    const tools = toolsForProvider(
      params.provider,
      buildAdvisorTools(this.deps, {
        boardId: params.boardId,
        scope: params.scope,
        role: params.role,
      }),
      ['get_team_overview'],
    );
    const focus = params.widgetType ? ` The user is looking at the ${params.widgetType} widget.` : '';
    const result = streamText({
      model: params.provider.model,
      system: SYSTEM + focus,
      tools,
      stopWhen: stepCountIs(stepsForProvider(params.provider)), // hard iteration cap, lower for local
      maxOutputTokens: MAX_TOKENS, // per-answer budget guardrail
      messages: [
        ...(params.history ?? []).map((turn) => ({ role: turn.role, content: turn.text })),
        { role: 'user' as const, content: params.question },
      ],
    });
    return {
      textStream: result.textStream,
      toolCalls: Promise.resolve(result.toolCalls).then((calls) =>
        calls.map((c) => ({ name: c.toolName })),
      ),
    };
  }
}
