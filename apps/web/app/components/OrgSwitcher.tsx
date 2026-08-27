'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OrgMembershipOptionDto } from '@deckgauge/shared';
import { fetchSwitchableOrganizations, switchOrganization } from '../actions/organization-switch';

/**
 * Lets someone who belongs to more than one organization choose which they are
 * acting in (tenancy §11 precondition 2).
 *
 * **Renders nothing at all when there is nothing to choose** — one organization,
 * or the list could not be loaded. That is the common case by far: under the
 * one-organization cap nobody has a second membership, and a switcher offering a
 * single option is worse than no switcher.
 *
 * A switch changes which tenant every subsequent request reads, so it is a
 * `router.refresh()` and not a client-side state change: everything on screen was
 * fetched for the previous organization.
 */
export function OrgSwitcher() {
  const router = useRouter();
  const [options, setOptions] = useState<OrgMembershipOptionDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSwitchableOrganizations()
      .then((orgs) => {
        if (!cancelled) setOptions(orgs);
      })
      .catch(() => {
        // Fails closed to "no switcher": a menu that cannot list reliably is
        // worse than one that is absent.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (options.length < 2) return null;

  async function choose(organizationId: string) {
    setError(null);
    setBusy(true);
    const result = await switchOrganization(organizationId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div role="group" aria-label="Switch organization">
      <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Organization
      </div>
      {options.map((o) => (
        <button
          key={o.organizationId}
          type="button"
          disabled={busy || o.isActive}
          aria-current={o.isActive ? 'true' : undefined}
          aria-label={`Switch to ${o.name}`}
          onClick={() => void choose(o.organizationId)}
          className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-slate-700 hover:bg-surface-2 disabled:cursor-default"
        >
          <span className="truncate">{o.name}</span>
          {o.isActive ? (
            <span className="ml-2 text-[10px] uppercase text-teal-700">Current</span>
          ) : o.status === 'SUSPENDED' ? (
            // Shown rather than hidden: otherwise "why can I not see Acme any
            // more?" is unanswerable from the UI.
            <span className="ml-2 text-[10px] uppercase text-amber-600">Suspended</span>
          ) : null}
        </button>
      ))}
      {error && (
        <p role="alert" className="px-4 py-1 text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="mx-2 my-1 border-t border-slate-100" />
    </div>
  );
}
