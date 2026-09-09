import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import {
  FOCUS_CLASS_LABELS,
  buildFocusPrompt,
  type FocusClassLabels,
  type FocusPromptEpic,
  type FocusPromptTask,
} from '@deckgauge/shared';
import { inferenceLock } from '../advisor/inference-lock.js';

export interface FocusModelClassifierOptions {
  /**
   * A resolved model, not an `AdvisorConfigInput`.
   *
   * The route resolves the provider; this takes the result. That is what lets a
   * test inject a fake without reaching through `resolveProvider` into the
   * Anthropic or Ollama SDKs — there is no capability for a live model, and a
   * suite that needed one could not run in CI.
   */
  model: LanguageModel;
  /** The ONLY epic keys the model may attribute work to. */
  epics: readonly FocusPromptEpic[];
  /** Defaults to the product's own words for A, B and C. */
  labels?: FocusClassLabels;
  /**
   * Called when the PROVIDER fails — a timeout, a 429, a reset connection, a
   * rejected key.
   *
   * Returning `[]` and saying nothing would make a broken API key look like a
   * model that classified nothing: "classified 0" with no explanation anywhere
   * on the page. The run still completes and still saves what it earned; this is
   * how the reason reaches the person who pressed the button.
   */
  onProviderError?: (err: unknown) => void;
}

/**
 * Strip a fenced code block, if the answer came wrapped in one.
 *
 * Models emit these unprompted and often. Without this, `JSON.parse` throws on a
 * batch of perfectly good verdicts and the whole batch is discarded as
 * malformed — an expensive way to learn nothing.
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * The adapter between `ClassificationDeps.classifyWithModel` and a real LLM.
 *
 * This is the piece that was missing: the prompt, the response schema, the
 * version, the provider and the lock all shipped with the Focus view and none of
 * them had a caller.
 *
 * **It runs inside `inferenceLock`,** which is the reason it exists here rather
 * than as a bare `generateText` at the seam. The conversational advisor shares
 * that lock, and `inference-lock.ts` states what losing it costs: on a small box
 * two concurrent inferences is not "twice as slow", it is two failures.
 *
 * **It never throws — and that covers the PROVIDER failing, not only a
 * malformed answer.** This claim was wrong once: the `generateText` call sat
 * outside the `try`, so a timeout, a 429 or a rejected key propagated, which is
 * the likeliest failure this feature has. Both are inside now.
 *
 * Why it matters more than it looks: `classifyTasks` calls `saveVerdicts` ONCE,
 * after the whole batch loop. A throw on batch five therefore discards the 160
 * verdicts batches one to four had already been paid for. Returning `[]` leaves
 * those tasks UNCLASSIFIED — counted and visible, exactly as `classifyResidue`
 * already treats a malformed verdict — and the run keeps what it earned.
 *
 * A provider failure is reported through `onProviderError` rather than
 * swallowed, so the button can say why nothing was classified.
 */
export function createFocusModelClassifier(
  opts: FocusModelClassifierOptions,
): (tasks: FocusPromptTask[]) => Promise<unknown[]> {
  const labels = opts.labels ?? FOCUS_CLASS_LABELS;

  return async (tasks) => {
    const prompt = buildFocusPrompt(tasks, opts.epics, labels);

    let text: string;
    try {
      // Inside the try, deliberately. A rejection here does not wedge the queue:
      // `inferenceLock` advances its tail with `result.catch(() => undefined)`
      // and runs the next entry on both settle paths, so the conversational
      // advisor sharing the lock is unaffected by a failed batch.
      ({ text } = await inferenceLock.run(() => generateText({ model: opts.model, prompt })));
    } catch (err) {
      opts.onProviderError?.(err);
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(unfence(text));
      // A non-array is as unusable as unparseable text, and for the same reason:
      // `classifyResidue` iterates the result. Returning it would throw there
      // instead, one stack frame further from the cause.
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
}
