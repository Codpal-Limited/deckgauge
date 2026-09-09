'use client';
import { FOCUS_CLASS_LABELS } from '@deckgauge/shared';

/**
 * Shared presentation for the Team Focus widgets.
 *
 * The class colours are one step darker than the app's existing chart tokens
 * (`#22c55e`/`#f59e0b`). Those two fail colourblind separation — ΔE 5.7 under
 * protanopia — and roadmap-versus-defect is the single most important
 * distinction on this view, so a protanopic reader would misread the headline.
 * The 600 steps of the same Tailwind ramp pass contrast and clear the CVD
 * floor, and every segment is direct-labelled as secondary encoding.
 */
export const CLASS_COLOR = {
  A: '#16a34a',
  B: '#d97706',
  C: '#e11d48',
  // Slate-600, deliberately the only low-chroma member. A, B and C name what
  // the work IS; UNCLASSIFIED names the ABSENCE of a judgement, so it reads as
  // the least specific swatch rather than competing as a fourth kind of work.
  // Same 600 step, and every segment is direct-labelled, so hue is never the
  // sole encoding. This was class D's swatch and the reasoning fits better here:
  // D at least asserted "not roadmap", where this asserts nothing at all.
  UNCLASSIFIED: '#475569',
} as const;

/**
 * A, B and C come from `@deckgauge/shared` because the advisor's PROMPT defines
 * the classes with the same words — two copies drift, and the drift is invisible:
 * the model classifies against one definition while this page explains another,
 * and every number still adds up.
 *
 * UNCLASSIFIED is added here and only here. It is not a class the model may
 * return (`FocusModelVerdictSchema` refuses it), so the shared record — which is
 * the prompt's input — must not contain it.
 */
export const CLASS_LABEL = {
  ...FOCUS_CLASS_LABELS,
  UNCLASSIFIED: 'Unclassified',
} as const;

/**
 * The class order, derived from CLASS_LABEL rather than written out again.
 *
 * Every chart here used to carry its own `['A', 'B', 'C']` literal. Those are
 * invisible to the typechecker — adding D to the shared union left them all
 * compiling and silently dropping the new class out of the legend, the bars and
 * the totals. Deriving the list means a class cannot be half-added.
 */
export const CLASS_KEYS = Object.keys(CLASS_LABEL) as (keyof typeof CLASS_LABEL)[];

/**
 * The one-character form for the ledger's CL column.
 *
 * A, B and C are their own letters; UNCLASSIFIED has none, so it shows `?` —
 * which is what the ledger already displayed for it, as a hard-coded ternary
 * beside a hard-coded grey. Typed over every key so a class added later cannot
 * render an empty badge.
 */
export const CLASS_GLYPH: Record<FocusClassKey, string> = {
  A: 'A',
  B: 'B',
  C: 'C',
  UNCLASSIFIED: '?',
};

/**
 * How a class names itself in the ledger's filter row.
 *
 * A, B and C prefix their letter because the ledger's CL column shows that
 * letter and the pill is what teaches the reader to read it. UNCLASSIFIED has no
 * letter, so prefixing its key gives "UNCLASSIFIED · Unclassified" — the label
 * alone is the whole name.
 */
export function classPillLabel(c: FocusClassKey): string {
  return c.length === 1 ? `${c} · ${CLASS_LABEL[c]}` : CLASS_LABEL[c];
}

/**
 * Compact forms for dense rows, where the full labels do not fit.
 *
 * A total record rather than a lowercased `CLASS_LABEL`: rendering the full
 * labels put `24% roadmap / capex · 48% opex · 28% internal technical` at 10px
 * into a `w-56` column. Typed over every key so a new class cannot be silently
 * missing a short form.
 */
export const CLASS_SHORT_LABEL: Record<FocusClassKey, string> = {
  A: 'roadmap',
  B: 'opex',
  C: 'internal',
  UNCLASSIFIED: 'unclassified',
};

/**
 * Total across every class.
 *
 * One function rather than a `.A + .B + .C` at each call site. Three separate
 * copies of that expression survived the first pass of adding class D: one
 * scaled a bar whose segments included D (overflowing the track to 1000% and
 * clipping the new class out of sight), and one was the denominator under a
 * percentage computed over all four (printing 14% above "133 of 779", which is
 * 17%). Neither is visible to the typechecker, so the fix is to have one place
 * that can be wrong.
 */
export function sumClasses(byClass: Record<FocusClassKey, number>): number {
  return CLASS_KEYS.reduce((n, c) => n + byClass[c], 0);
}

/**
 * `CANCELLED` is the one NEUTRAL in this set, deliberately: abandoned work
 * should not compete chromatically with the four live outcomes.
 *
 * **Two neutrals live in this file now, and they are not the same swatch.**
 * `CLASS_COLOR.D` is slate-600, this is slate-500 — adjacent steps, which would
 * read as an inconsistency if it were one. They belong to different scales that
 * never share a chart: D is the least specific KIND of work, CANCELLED is the
 * outcome where work stopped. Each is the low-chroma member of its own set, and
 * each was measured against that set rather than against the other.
 *
 * Slate-500 was MEASURED against the floor this file's header describes, not
 * assumed. Worst-case ΔE2000 against the other four: **22.8 under protanopia,
 * 21.4 under deuteranopia, 16.6 in normal vision** — roughly 3x the ~7.6 that
 * the `#22c55e`/`#f59e0b` pair named above scores under protanopia, which is the
 * separation this file calls a failure. It is also 4.76:1 on white, clearing
 * WCAG AA for the small label text.
 *
 * The obvious alternative was worse in a way no eyeball would catch: stone-600
 * (`#57534e`) scores ΔE2000 **4.2** against `NOT_STARTED` under protanopia —
 * less separable than the pair this palette was rebuilt to fix.
 *
 * (Noted while measuring, and NOT fixed here: `IN_PRODUCTION` at 3.30:1 and
 * `IN_DEVELOPMENT` at 3.19:1 both fall short of WCAG AA for small text on white.
 * Pre-existing, and re-picking the published four is a separate decision.)
 */
export const STAGE_COLOR = {
  IN_PRODUCTION: '#16a34a',
  WAITING_TO_SHIP: '#4f46e5',
  IN_DEVELOPMENT: '#d97706',
  CANCELLED: '#64748b',
  NOT_STARTED: '#e11d48',
} as const;

/**
 * `CANCELLED` reads as "Aborted work", not "Cancelled".
 *
 * `Cancelled` would name the source STATE; the segment exists to name the
 * FINDING — effort spent on work that never reached production. Only tasks
 * somebody actually worked on land here; a ticket cancelled before anyone
 * touched it leaves the widget's population entirely.
 *
 * It read "Wasted effort" until 2026-09-09. Same finding, less verdict: the
 * team did the work asked of it, and calling their output waste blames them for
 * a decision taken above them. The KEY stays `CANCELLED` — it is a stored value
 * in every board's `FocusConfig.stageMap`, so renaming it would be a data
 * migration to change a word nobody reads.
 */
export const STAGE_LABEL = {
  IN_PRODUCTION: 'In production',
  WAITING_TO_SHIP: 'Waiting to ship',
  IN_DEVELOPMENT: 'In development',
  CANCELLED: 'Aborted work',
  NOT_STARTED: 'Not started / stalled',
} as const;

export type FocusStageKey = keyof typeof STAGE_LABEL;
export type FocusClassKey = keyof typeof CLASS_LABEL;

export function WidgetLoading() {
  return <p className="text-sm text-slate-400">Loading…</p>;
}

export interface FocusEmptyProps {
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
}

/**
 * What to render when a Focus widget has nothing to draw.
 *
 * The reason this exists rather than each widget printing "No tasks in this
 * window": a board whose sync has never run, or has silently degraded, returns
 * zero rows and is otherwise indistinguishable from a team that did nothing.
 * Reporting the second when the first is true is the single failure this view
 * is built to avoid, and it is the sentence R6.12 forbids.
 *
 * So an empty result is only ever described as a quiet window when we can see
 * that the sources have actually synced.
 */
export function FocusNoData({ taskCount, sourcesLastSyncedAt }: FocusEmptyProps) {
  if (taskCount !== 0) {
    return <p className="text-sm text-slate-400">Nothing to show for this window.</p>;
  }

  if (!sourcesLastSyncedAt) {
    return (
      <div className="text-sm text-slate-600">
        <p className="font-medium">This board&apos;s sources have never completed a sync.</p>
        <p className="text-xs text-slate-500 mt-1">
          No conclusion can be drawn about the team from an empty result — there is nothing to
          read yet.
        </p>
      </div>
    );
  }

  return (
    <div className="text-sm text-slate-600">
      <p>No tasks were touched in this window.</p>
      <p className="text-xs text-slate-500 mt-1">
        Sources last synced {sourcesLastSyncedAt}. If that date looks stale, the window may be
        empty because the sync stopped, not because the work did.
      </p>
    </div>
  );
}

/**
 * A headline figure with its supporting detail.
 *
 * `caveat` is not decoration: every big number on this view carries the thing
 * that qualifies it, so the figure and its limits are read together rather than
 * the figure alone being quoted.
 */
export function StatTile({
  value,
  label,
  caveat,
  tone = 'neutral',
}: {
  value: string;
  label: string;
  caveat?: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'bad'
          ? 'text-rose-600'
          : 'text-slate-800';

  return (
    <div className="flex flex-col justify-center h-full">
      <p className={`text-4xl font-semibold tabular-nums leading-none ${color}`}>{value}</p>
      <p className="text-sm text-slate-600 mt-2">{label}</p>
      {caveat && <p className="text-xs text-slate-400 mt-1">{caveat}</p>}
    </div>
  );
}

/** Legend for every class. Always rendered, so identity is never colour alone. */
export function ClassLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      {CLASS_KEYS.map((c) => (
        <span key={c} className="flex items-center gap-1.5">
          <i
            aria-hidden
            className="w-2.5 h-2.5 rounded-sm inline-block"
            style={{ background: CLASS_COLOR[c] }}
          />
          {CLASS_LABEL[c]}
        </span>
      ))}
    </div>
  );
}

/** A stacked bar of per-class days, each segment direct-labelled. */
export function ClassBar({
  attention,
  max,
}: {
  attention: Record<FocusClassKey, number>;
  max: number;
}) {
  const total = sumClasses(attention);
  if (total === 0) return <span className="text-xs text-slate-400">no recorded attention</span>;

  return (
    <div className="flex gap-px h-5 rounded overflow-hidden" role="img" aria-label={`${total} days`}>
      {CLASS_KEYS.map((c) => {
        const value = attention[c];
        if (value <= 0) return null;
        const pct = (value / Math.max(max, 1)) * 100;
        return (
          <div
            key={c}
            title={`${CLASS_LABEL[c]}: ${value} days`}
            style={{ width: `${pct}%`, background: CLASS_COLOR[c] }}
            className="flex items-center justify-center text-[10px] font-semibold text-white"
          >
            {pct > 6 ? value : ''}
          </div>
        );
      })}
    </div>
  );
}
