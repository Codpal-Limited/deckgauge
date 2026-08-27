import Link from 'next/link';
import type { ReactNode } from 'react';
import { getBootstrapState } from '../actions/organization';
import { isOrganizationAdmin } from '../lib/org-role';

// Notifications are a PERSONAL setting, so it sits in the base tabs every
// member sees — unlike the three below, which are organization administration.
const BASE_TABS = [
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/timesheet-statuses', label: 'Timesheet Statuses' },
];

// All three tabs lead to organization administration. `Connections` points at
// the connection catalog on /sources — creating, editing, deleting, testing and
// reconnecting an instance, plus the ADO production config, all require the
// organization ADMIN role. /sources itself is not admin-only (its project-sync
// and retired-project sections are open to members, who reach them from a
// board's Sources tab); it is the catalog this tab advertises that is.
// `Boards` is the All-boards table: every board the organization owns, including
// boards the admin holds no grant on and so cannot reach from their own sidebar.
const ADMIN_TABS = [
  { href: '/settings/organization/members', label: 'Members' },
  { href: '/settings/organization/boards', label: 'Boards' },
  { href: '/sources', label: 'Connections' },
];

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  // Presentation only — the pages and the API both gate on the organization
  // ADMIN role. But a tab whose advertised capability a member cannot use is a
  // dead end worth not showing in the first place.
  const state = await getBootstrapState();
  const tabs = isOrganizationAdmin(state) ? [...BASE_TABS, ...ADMIN_TABS] : BASE_TABS;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <nav className="mb-6 flex gap-2 border-b border-slate-200">
        {tabs.map((t) => (
          <Link key={t.href} href={t.href} className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900">
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </main>
  );
}
