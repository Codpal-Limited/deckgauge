import { streamText, stepCountIs } from 'ai';
import type { AdvisorHistoryMessage } from '@deckgauge/shared';
import { buildAdvisorTools, type AdvisorToolDeps } from './tools.js';
import type { LlmProvider } from './llm-provider.js';
import { stepsForProvider, toolsForProvider } from './local-tier.js';
import type { BoardScope } from '../intelligence/board-scope.js';

// Hard iteration cap on the agentic loop (tool-call round trips per answer).
export const MAX_STEPS = 6;
// Per-answer output token budget guardrail.
export const MAX_TOKENS = 4000;

const SYSTEM = [
  'You are the Deckgauge Advisor, a read-only analyst for one engineering board.',
  'Answer questions by calling the provided tools to fetch real numbers — never invent metrics.',
  'You can only read data for the current board; you cannot change anything.',
  'Ground every claim in a tool result, cite the concrete numbers, and end with one concrete next step.',
].join(' ');

export interface AdvisorAskParams {
  provider: LlmProvider;
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
      buildAdvisorTools(this.deps, params.scope),
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
