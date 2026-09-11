'use client';

interface PeriodNavigatorProps {
  label: string;
  onPrev: () => void;
  onNext: () => void;
}

/** ‹ Period › navigator with a live, centred date label (Tempo-style). */
export function PeriodNavigator({ label, onPrev, onNext }: PeriodNavigatorProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-white">
      <button
        type="button"
        aria-label="previous period"
        onClick={onPrev}
        // Measured 27x36 — under on BOTH axes, so this needs `min-w-11` as
        // well as `min-h-11`. A chevron glyph gives the button almost no
        // intrinsic width. The label between the two is a `<span>`, not a
        // control, and `items-center` keeps it centred as they grow.
        className="min-h-11 min-w-11 rounded-l-lg px-2.5 py-1.5 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 md:min-h-0 md:min-w-0"
      >
        ‹
      </button>
      <span className="min-w-[9rem] select-none px-2 text-center text-sm font-medium tabular-nums text-slate-700">
        {label}
      </span>
      <button
        type="button"
        aria-label="next period"
        onClick={onNext}
        className="min-h-11 min-w-11 rounded-r-lg px-2.5 py-1.5 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 md:min-h-0 md:min-w-0"
      >
        ›
      </button>
    </div>
  );
}
