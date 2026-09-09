import { z } from 'zod';

/**
 * Bumped whenever the prompt or the class definitions change. Stored on every
 * model verdict, so a verdict produced by an older prompt is identifiable and
 * can be re-run rather than silently trusted.
 */
export const FOCUS_PROMPT_VERSION = 'v1';

/**
 * How many tasks one advisor run may send to the model.
 *
 * Shared because the API enforces it and the UI states it. Two copies drift, and
 * the drift shows up as a button promising one thing while the run does another
 * — on the one number in this feature that is about money.
 */
export const FOCUS_MODEL_BUDGET = 200;

export const FocusModelVerdictSchema = z.object({
  id: z.string().min(1),
  class: z.enum(['A', 'B', 'C']),
  epicKey: z.string().nullable(),
  /** Max matches `focus_verdicts.reason`, VARCHAR(400). */
  reason: z.string().min(1).max(400),
});

export type FocusModelVerdict = z.infer<typeof FocusModelVerdictSchema>;

export interface FocusPromptTask {
  id: string;
  title: string;
  description: string | null;
  type: string;
  repo: string | null;
}

export interface FocusPromptEpic {
  key: string;
  title: string;
}

export type FocusClassLabels = Record<'A' | 'B' | 'C', string>;

/**
 * What A, B and C mean, in the words the product uses.
 *
 * Lives here rather than in the web app because BOTH the prompt and the ledger
 * need them, and two copies drift silently: the model would classify against one
 * definition while the page explains another, with every number still adding up.
 * `focus-ui.tsx` builds its own `CLASS_LABEL` on top of this by adding the
 * UNCLASSIFIED entry, which the model may not return.
 *
 * UNCLASSIFIED is deliberately absent. `FocusModelVerdictSchema` does not accept
 * it — "no classifier could reach this" is a fact about the pipeline, not a
 * judgement the model gets to make about its own answer.
 */
export const FOCUS_CLASS_LABELS: FocusClassLabels = {
  A: 'Roadmap / CAPEX',
  B: 'OPEX',
  C: 'Internal technical',
};

/**
 * Drop an epic key the model invented.
 *
 * Models hallucinate plausible-looking keys, and an accepted one puts a task
 * into the coverage of an epic nobody worked on — which is precisely the number
 * this view exists to report honestly. The class and the reason survive; only
 * the unverifiable attribution is discarded.
 */
export function coerceModelVerdict(
  verdict: FocusModelVerdict,
  roadmapEpics: ReadonlySet<string>,
): FocusModelVerdict {
  if (verdict.epicKey === null || roadmapEpics.has(verdict.epicKey)) return verdict;
  return { ...verdict, epicKey: null };
}

export function buildFocusPrompt(
  tasks: readonly FocusPromptTask[],
  epics: readonly FocusPromptEpic[],
  labels: FocusClassLabels,
): string {
  const epicList = epics.map((e) => `  ${e.key}  ${e.title}`).join('\n');
  const taskList = tasks
    .map((t) => {
      const parts = [`${t.id}: ${t.title}`, `  type: ${t.type}`];
      if (t.repo) parts.push(`  repo: ${t.repo}`);
      if (t.description) parts.push(`  description: ${t.description}`);
      return parts.join('\n');
    })
    .join('\n\n');

  return `You are classifying engineering tasks for a delivery report that goes to
senior leadership and will be challenged. Classify what each task SAYS IT DOES,
not what it might belong to.

Classes:
  A — ${labels.A}. Delivers one of the roadmap epics below, or is unambiguously
      part of a tracked programme named in the task.
  B — ${labels.B}. A customer-visible bug, a performance defect, or a one-off
      operational request. Necessary work that keeps the platform standing
      without advancing it.
  C — ${labels.C}. Refactoring, flag removal, tooling, test debt, CI and
      pipeline configuration, developer environments, database indexes, naming
      alignment. No roadmap outcome stated on the task.

Roadmap epics (the ONLY valid values for epicKey):
${epicList}

Rules:
  - Return epicKey null unless the task clearly advances one of the epics listed
    above. Do not guess a key, and do not invent one that is not on that list.
  - reason is one sentence, under 400 characters, stating why. It is printed
    next to the task so anyone can challenge the call.
  - Return one object per task, for every task, and nothing else.

Answer as JSON: [{ "id": string, "class": "A"|"B"|"C", "epicKey": string|null,
"reason": string }]

Tasks:

${taskList}`;
}
