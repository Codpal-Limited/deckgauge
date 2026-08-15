import { streamText, stepCountIs, type ToolSet } from 'ai';
import type { AdvisorHistoryMessage } from '@deckgauge/shared';
import type { LlmProvider } from './llm-provider.js';
import { loadHelpCorpus, type HelpDoc } from './help-corpus.js';
import { buildHelpTools } from './help-tools.js';
import { buildPageStateTools, type PageStateToolDeps } from './page-state-tools.js';
import { buildSourceTools, type SourceToolDeps } from './source-tools.js';
import { MAX_STEPS, MAX_TOKENS, type AdvisorRun } from './advisor.service.js';

// Distinct from the board advisor's SYSTEM prompt (advisor.service.ts): this is
// a product guide, not a read-only analyst over live board data. It may read
// this instance's own configuration for the page the user is on, but only
// through `get_page_state`, whose page and board are fixed by the route.
export const HELP_SYSTEM = [
  'You are the Deckgauge product guide, helping a user understand how Deckgauge works and how this instance is configured.',
  'Always call search_product_help first and answer from what it returns.',
  "When the question is about the user's own setup or data rather than how a feature works, also call get_page_state.",
  'If get_page_state reports available:false, say plainly that you could not check this instance and answer from the documentation — never present a default as if it were their setting.',
  'Only if the documentation and get_page_state have both failed to answer, call search_source and then read_source to check the product source code, and say in your answer that it came from the source code rather than the documentation.',
  'If the documentation does not cover the question, say plainly that it is not covered — never invent product behaviour, settings, or menu paths.',
  'Deckgauge is read-only through you: you cannot change any setting or any data.',
  'Be concise and practical, and name the screen a user should go to when there is one.',
].join(' ');

export interface AdvisorHelpAskParams {
  provider: LlmProvider;
  question: string;
  /** Human label for the page the user asked from, e.g. "Timesheet". */
  pageLabel: string;
  /** Resolver key for the page the user asked from, e.g. "timesheet". */
  pageKey: string;
  /**
   * Deps for `get_page_state`. Omitted entirely when the route has no page
   * resolver to offer (e.g. an unmapped page) — `ask` then exposes only the
   * documentation tool, rather than a `get_page_state` that would always
   * report unavailable.
   */
  /*
   * Derived from `PageStateToolDeps` rather than restated field by field: this
   * type was previously an inline structural copy and had already drifted —
   * `roadmapId` was missing from it while the route passed one, which only
   * typechecked because the route builds the object as a `const` (no excess
   * property check) and the field then reached `buildPageStateTools` through
   * the spread anyway. `pageKey` is the one field `ask` supplies itself, from
   * its own `pageKey` param, so it is the one field omitted here. `logError`
   * rides along from `PageStateToolDeps` and is forwarded verbatim — a
   * diagnostic-only seam for a resolver failure, never awaited, never
   * surfaced to the model.
   */
  pageState?: Omit<PageStateToolDeps, 'pageKey'>;
  /**
   * Deps for `search_source`/`read_source`. Omitted entirely when the operator
   * flag is off, which is what makes the switch real: an off switch that still
   * offered the tools and had them refuse every call would spend a tool round
   * trip per question to say no.
   */
  sourceLookup?: SourceToolDeps;
  history?: readonly AdvisorHistoryMessage[];
}

export class AdvisorHelpService {
  private readonly docs: readonly HelpDoc[];

  // Loaded once at construction: the corpus ships with the image and cannot
  // change at runtime, so re-reading it per question is pure overhead.
  constructor(docs: readonly HelpDoc[] = loadHelpCorpus()) {
    this.docs = docs;
  }

  ask(params: AdvisorHelpAskParams): AdvisorRun {
    // Composed in the order the prompt asks the model to use them —
    // documentation, then this instance's configuration, then the source. The
    // ordering is not load-bearing for correctness (the prompt and the tool
    // descriptions are), but a tool list that reads in the same order as the
    // instructions is one less thing for a future edit to contradict.
    const tools: ToolSet = {
      ...buildHelpTools(this.docs),
      ...(params.pageState
        ? buildPageStateTools({ ...params.pageState, pageKey: params.pageKey })
        : {}),
      ...(params.sourceLookup ? buildSourceTools(params.sourceLookup) : {}),
    };
    const result = streamText({
      model: params.provider.model,
      system: `${HELP_SYSTEM} The user is on the ${params.pageLabel} screen.`,
      tools,
      stopWhen: stepCountIs(MAX_STEPS), // hard iteration cap, reused from the board service
      maxOutputTokens: MAX_TOKENS, // per-answer budget guardrail, reused from the board service
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
