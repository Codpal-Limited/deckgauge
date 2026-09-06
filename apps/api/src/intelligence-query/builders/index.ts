export { intelligenceQueryBuilders, registerBuilder } from './registry.js';

export type { WidgetSqlBuilder, BuiltSql, BuilderInputs } from './types.js';
export type { ResolvedPeriod } from './period.js';
export { resolvePeriod, resolveComparePeriods } from './period.js';

// Side-effect imports: each builder file calls registerBuilder() (defined in
// ./registry.ts) at module load. Importing them here is the only place that
// triggers registration, guaranteeing the registry is complete at startup.
// The registry lives in its own file so builders don't depend on this side-
// effect entry point — they import only from ./registry.js.
import './commits-per-dev.js';
import './merge-frequency-per-dev.js';
import './ch-completion-trend.js';
import './ch-velocity.js';
import './ch-cycle-time-trend.js';
import './ch-backlog-age.js';
import './lead-time-for-changes.js';
import './pr-cycle-time-scatter.js';
import './review-pickup-time.js';
import './pr-size-distribution.js';
import './rework-rate.js';
import './bug-rate.js';
import './iteration-planning-accuracy.js';
import './velocity-with-confidence.js';
import './initiative-risk-radar.js';
import './issues-opened-vs-closed.js';
import './wip-count.js';
import './ticket-coverage-rate.js';
import './ai-assisted-pr-pct.js';
import './review-mix.js';
import './bot-vs-human.js';
import './reviewer-participation.js';
import './review-quality-index.js';
import './review-quality-trend.js';
import './flow-throughput-cycle.js';
import './delivery-trend-annotated.js';
import './ai-adoption.js';
import './investment-allocation.js';
import './dora-metrics.js';
import './period-comparison.js';
