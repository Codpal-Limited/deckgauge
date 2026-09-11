'use client';

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  /** Pass null/undefined for a control with no active segment. */
  value: T | null | undefined;
  onChange: (value: T) => void;
  ariaLabel?: string;
}

/** Pill-grouped single-select toggle (Week/Month/Year, Normalized/Raw, …). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg bg-slate-100 p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            // `min-h-11` below `md`: measured 28px (`px-3 py-1 text-sm`), and
            // this one component renders Week/Month/Year, Normalized/Raw and
            // Team/Role/Person across the timesheet and its report — so the
            // floor lands on three controls per page from one line. The group
            // wrapper has no fixed height, so it grows to match rather than
            // letting the buttons protrude, which is the trap `ToolbarGroup`
            // fell into.
            className={`min-h-11 rounded-md px-3 py-1 text-sm transition-all duration-150 md:min-h-0 ${
              active
                ? 'bg-white font-medium text-indigo-600 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
