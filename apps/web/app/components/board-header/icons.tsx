/**
 * Inline stroke icons for the board action bar.
 *
 * The app carries no icon dependency, so these follow the same shape as the
 * hand-rolled SVGs elsewhere (`SearchBar`, `ThemeToggle`): 24-box viewport,
 * `currentColor`, sized by the caller through `className`.
 */

const BASE = 'h-4 w-4';

function Svg({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className ?? BASE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function SearchIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

export function FilterIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 5h16l-6.2 7.4V19l-3.6-2v-4.6z" />
    </Svg>
  );
}

export function SortIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 7h11M4 12h8M4 17h5" />
      <path d="M18 9l3-3 3 3" transform="translate(-3 3)" />
    </Svg>
  );
}

export function ColumnsIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M15 4.5v15" />
    </Svg>
  );
}

export function SparkleIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </Svg>
  );
}

export function RefreshIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M20 11a8 8 0 10-2.6 5.9" />
      <path d="M20 4.5V11h-6" />
    </Svg>
  );
}

export function PencilIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 20h4l10-10-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  );
}

export function TextIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 6h16M4 11h16M4 16h10" />
    </Svg>
  );
}

export function BoltIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M13 3L5 13.5h5.5L10 21l8-10.5h-5.5z" />
    </Svg>
  );
}

export function TrashIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </Svg>
  );
}

export function BellIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M18 16v-5a6 6 0 10-12 0v5l-1.5 2h15zM10 21h4" />
    </Svg>
  );
}

export function WarningIcon({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  );
}
