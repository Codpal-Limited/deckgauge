/**
 * Focus view — the pure, provider-agnostic half.
 *
 * Everything here is unit-tested without ClickHouse and without a database. The
 * SQL builders in `apps/api` return raw rows; the meaning is applied here, which
 * is why the stage vocabulary, the class taxonomy and the precedence rules never
 * appear in a query.
 *
 * `fingerprint.js` is NOT re-exported: it imports `node:crypto`, and `apps/web`
 * pulls the package root into client components. Server code imports it by its
 * own subpath. `normaliseTitle` is pure and safe, and lives in its own module
 * for precisely that reason.
 */
export {
  attentionDaysInWindow,
  type FocusTransition,
  type FocusWindow,
} from './attention-days.js';

export {
  DEFAULT_STAGE_MAP,
  mapDeliveryStage,
  tallyDeliveryStages,
  type FocusProvider,
  type FocusStage,
  type StageMap,
  type StageTally,
} from './delivery-stage.js';

export { everEnteredWorkingState } from './ever-worked.js';

export { rollUpStages } from './roll-up-stages.js';

export {
  FOCUS_PROVIDERS,
  FocusStageSchema,
  StageMapOverridesSchema,
  mergeStageMap,
  type BucketStageLayer,
  parseStageMapOverrides,
  stageMapOverrideCount,
  unmappedObservedStates,
  type FocusStageMapSettings,
  type ObservedStates,
  type StageMapOverrides,
  type UnmappedState,
} from './stage-map-config.js';

export {
  activeDayShare,
  countWorkingDays,
  resolveMemberWindow,
  type MemberWindow,
} from './late-joiner.js';

export {
  mergeTaskSets,
  type FocusSourceTask,
  type FocusTask,
  type MergeResult,
} from './merge-task-sets.js';

export {
  FOCUS_CLASS_LABELS,
  FOCUS_MODEL_BUDGET,
  FOCUS_PROMPT_VERSION,
  FocusModelVerdictSchema,
  buildFocusPrompt,
  coerceModelVerdict,
  type FocusClassLabels,
  type FocusModelVerdict,
  type FocusPromptEpic,
  type FocusPromptTask,
} from './model-classifier.js';

export {
  AGENT_TOOL_BATCH_DEFAULT,
  listUnclassifiedTasksInputSchema,
  setFocusVerdictsInputSchema,
  type ListUnclassifiedTasksInput,
  type ListUnclassifiedTasksResultDto,
  type RejectedFocusVerdictDto,
  type SetFocusVerdictsInput,
  type SetFocusVerdictsResultDto,
} from './agent-tools.js';

export {
  attentionDaysByClass,
  attentionSharesByClass,
  countMovesInWindow,
  splitMovedParked,
  type ByClass,
  type FocusClassKey,
  type FocusMeasuredTask,
  type MovedParkedSplit,
} from './moved-or-parked.js';

export {
  FOCUS_VERDICT_REASON_MAX,
  FocusVerdictOverrideSchema,
  type FocusVerdictOverride,
} from './verdict-override.js';

export {
  resolveVerdict,
  type ClassifierVerdict,
  type FocusVerdictSourceValue,
  type ResolvedVerdict,
  type RuleVerdict,
  type VerdictInputs,
} from './resolve-verdict.js';

export {
  DEFAULT_RULES,
  FocusRuleSchema,
  matchRules,
  type FocusRule,
  type RuleCandidate,
} from './rules.js';

export {
  verifyApprovedIsNotDone,
  type ApprovedCheck,
  type ApprovedVerdict,
} from './verify-approved.js';

export { buildFocusCaveats, type CaveatInputs, type FocusCaveat } from './caveats.js';

export { normaliseTitle } from './normalise-title.js';
