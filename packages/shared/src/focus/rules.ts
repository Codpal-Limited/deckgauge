import { z } from 'zod';
import type { FocusClassKey } from './moved-or-parked.js';
import type { RuleVerdict } from './resolve-verdict.js';

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

export const FocusRuleSchema = z.object({
  id: z.string().min(1),
  order: z.number().int(),
  field: z.enum(['epicKey', 'title', 'description']),
  /**
   * Validated here rather than at match time. A rule with a broken pattern must
   * be rejected when someone saves it, not throw halfway through classifying a
   * window and abort the whole render.
   */
  pattern: z.string().refine(isValidRegex, { message: 'pattern is not a valid regular expression' }),
  class: z.enum(['A', 'B', 'C']),
  reasonTemplate: z.string().min(1),
});

export type FocusRule = z.infer<typeof FocusRuleSchema>;

export interface RuleCandidate {
  title: string;
  description: string | null;
  epicKey: string | null;
}

/**
 * Rule 0 is the epic link, and it is the only free, exact classifier we have:
 * if the source says this task belongs to an epic the board curated as roadmap
 * scope, no keyword guess and no model call can improve on that.
 *
 * Everything after it is a keyword heuristic over the C bucket, where the
 * reference report's own reasons were most repetitive — refactors, tooling,
 * dependency bumps, naming alignment. B is deliberately sparse: "is this a
 * customer-visible defect" is a judgement, and guessing it from keywords is how
 * a classification stops being defensible.
 */
export const DEFAULT_RULES: FocusRule[] = [
  {
    id: 'epic-link',
    order: 0,
    field: 'epicKey',
    pattern: '.+',
    class: 'A',
    reasonTemplate: 'Linked to roadmap epic {match}.',
  },
  {
    id: 'kw/refactor',
    order: 10,
    field: 'title',
    pattern: 'namespace alignment|pure refactor|rename (indexes|columns|namespace)',
    class: 'C',
    reasonTemplate: 'Refactor or naming alignment — no roadmap outcome stated.',
  },
  {
    id: 'kw/tooling',
    order: 20,
    field: 'title',
    pattern: 'swagger|pipeline|docker|nuget|dependency|local dev|ci build',
    class: 'C',
    reasonTemplate: 'Build, dependency or developer tooling.',
  },
  {
    id: 'kw/test-debt',
    order: 30,
    field: 'title',
    pattern: 'write tests|test coverage|flaky test',
    class: 'C',
    reasonTemplate: 'Test debt — internal technical work.',
  },
];

/**
 * First matching rule wins, by `order`.
 *
 * An invalid pattern is skipped rather than thrown, because a rule set is
 * configuration and one bad row must not take a whole window's classification
 * down with it. The schema is what stops bad rows being saved in the first
 * place; this is the belt to that pair of braces.
 */
export function matchRules(
  task: RuleCandidate,
  rules: readonly FocusRule[],
  roadmapEpics: ReadonlySet<string>,
): RuleVerdict | null {
  const ordered = [...rules].sort((a, b) => a.order - b.order);

  for (const rule of ordered) {
    if (rule.field === 'epicKey') {
      if (task.epicKey && roadmapEpics.has(task.epicKey)) {
        return {
          class: rule.class as FocusClassKey,
          epicKey: task.epicKey,
          reason: rule.reasonTemplate.replace('{match}', task.epicKey),
          ruleId: rule.id,
        };
      }
      continue;
    }

    const haystack = rule.field === 'title' ? task.title : (task.description ?? '');
    if (!isValidRegex(rule.pattern)) continue;

    const match = new RegExp(rule.pattern, 'i').exec(haystack);
    if (!match) continue;

    return {
      class: rule.class as FocusClassKey,
      epicKey: task.epicKey && roadmapEpics.has(task.epicKey) ? task.epicKey : null,
      reason: rule.reasonTemplate.replace('{match}', match[0]),
      ruleId: rule.id,
    };
  }

  return null;
}
