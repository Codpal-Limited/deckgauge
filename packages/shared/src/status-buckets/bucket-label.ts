import type { StatusBucket } from './status-bucket.js';

/**
 * The five buckets in plain language.
 *
 * Here rather than in the panel because the panel is not the only reader: Team
 * Focus speaks the same five things under `FocusStage` names, and the point of
 * a shared vocabulary is that the two surfaces cannot disagree about what a
 * bucket is called. `STAGE_LABEL` in `focus-ui.tsx` is the precedent for that
 * drift costing something real.
 *
 * NO tracker word appears here, and a test enforces it. The people who read
 * this panel do not use Jira or Azure DevOps and must not have to — "business
 * pepole that need to work on this board don't know about jira/devops. We need
 * to have a clean UI/UX for them and sort this issue behind the scene."
 *
 * Colours are NOT here. A Tailwind class is not domain vocabulary, and the two
 * surfaces use different palettes on purpose (option A: Jira's grey/blue in the
 * panel, `STAGE_COLOR` in Focus).
 */
export const BUCKET_LABEL: Record<StatusBucket, string> = {
  TODO: 'Not started',
  IN_PROGRESS: 'In progress',
  WAITING_TO_SHIP: 'Waiting to ship',
  DONE: 'Done',
  // "aborted work", the owner's term, replacing "Wasted effort" (slice 1). The
  // KEY stays `ABORTED` — and `CANCELLED` in Focus, which cannot be renamed
  // because it is a stored value in every board's `FocusConfig.stageMap` JSON.
  ABORTED: 'Aborted work',
};

/**
 * One line per bucket saying what putting a status there DOES.
 *
 * Load-bearing rather than decorative. Without these the panel is five boxes
 * with no stated consequence, and the two that matter most are the pair that
 * look alike: `IN_PROGRESS` is the only bucket the timesheet counts, and
 * `WAITING_TO_SHIP` exists precisely to hold finished-but-parked work OUT of
 * that count. A reader who assumes they are synonyms will file `Ready to
 * Deploy` as work and never see the parked time the fifth bucket was added to
 * surface — "It will help us identify in the teams focus how much time things
 * are parked."
 */
export const BUCKET_HINT: Record<StatusBucket, string> = {
  TODO: 'Waiting to be picked up. No time is counted.',
  IN_PROGRESS: 'Someone is actively working on it. This is the only bucket the timesheet counts as work.',
  WAITING_TO_SHIP: 'Finished by the team but not out yet. Time here does not count as work — it shows up as parked.',
  DONE: 'Out and delivered. No time is counted.',
  ABORTED: 'Abandoned before it shipped. No time is counted, and it stays out of delivery figures.',
};
