'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/timesheet', label: 'Grid' },
  { href: '/timesheet/report', label: 'Report' },
];

export function TimesheetTabs() {
  const pathname = usePathname();
  return (
    <nav className="mb-4 flex gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`inline-flex min-h-11 items-center px-3 py-2 text-sm md:min-h-0 ${pathname === t.href ? 'border-b-2 border-indigo-500 font-medium text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
