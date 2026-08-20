'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ACCESS_ENTITY_NOUNS,
  ACCESS_ROLE_HINTS,
  ACCESS_ROLE_LABELS,
  canManageEntity,
  type AccessEntityKind,
  type AccessEntry,
  type AccessRoleValue,
  type OrgPerson,
} from '@deckgauge/shared';
import { useEntityAccess, type EntityAccessDeps } from './useEntityAccess';

/** Owner is a promotion from the row menu, never an invitation (design D2). */
const INVITE_ROLES: AccessRoleValue[] = ['EDITOR', 'VIEWER'];
const ALL_ROLES: AccessRoleValue[] = ['OWNER', 'EDITOR', 'VIEWER'];

/** Same wording wherever an org viewer's ceiling is the reason a control is limited. */
const ORG_VIEWER_NOTE = 'Organization viewers are limited to read-only access.';

export function ShareDialog({
  kind,
  entityId,
  entityName,
  myRole,
  currentUserId,
  initialEntries,
  onClose,
  ...deps
}: {
  kind: AccessEntityKind;
  entityId: string;
  entityName: string;
  myRole: AccessRoleValue | null;
  currentUserId: string | null;
  initialEntries: AccessEntry[];
  onClose: () => void;
} & EntityAccessDeps) {
  const { entries, results, error, searchFailed, pending, refresh, search, grant, changeRole, revoke } =
    useEntityAccess({ kind, entityId, initialEntries, ...deps });

  const [query, setQuery] = useState('');
  const [inviteRole, setInviteRole] = useState<AccessRoleValue>('EDITOR');
  const [selectedPerson, setSelectedPerson] = useState<OrgPerson | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const canManage = canManageEntity(myRole);
  const noun = ACCESS_ENTITY_NOUNS[kind];

  // Refetch on open: the server payload can be minutes stale, and two owners
  // editing access at the same time is this dialog's normal case. Focus goes
  // to the search input for an owner (who can act on it) and to Close for
  // everyone else — the input never mounts for a read-only viewer, so
  // `searchRef` would otherwise be a permanent, silent no-op.
  useEffect(() => {
    refresh();
    if (canManage) {
      searchRef.current?.focus();
    } else {
      closeRef.current?.focus();
    }
  }, [refresh, canManage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * An org VIEWER cannot hold a writing grant: `effectiveBoardRole` would cap
   * them at VIEWER, so offering Member would display a role the system does not
   * honour (design D7).
   */
  const isCapped = (person: OrgPerson) => person.orgRole === 'VIEWER';

  /**
   * The ONE place a NEW grant is issued (the Invite flow), so the ceiling
   * cannot be bypassed client-side by the path that does not check it. An
   * earlier draft capped the role when a person was clicked in the results
   * list but not when the Invite button fired, which would have stored
   * EDITOR for an org VIEWER — the exact state D7 forbids.
   *
   * This does NOT cover the per-row role menu further down: an owner can
   * still pick "Member" there for an existing org-VIEWER row. That path is
   * caught server-side instead — `AccessService` refuses any grant or role
   * change whose role exceeds the target's org role
   * (`RoleExceedsOrgRoleError`, mapped to 409 `ROLE_EXCEEDS_ORG_ROLE`) — and
   * the row itself hides Member/Owner once `orgRole` marks it as capped, so
   * the dialog does not even offer a control the server will refuse.
   */
  const grantPerson = (person: OrgPerson) =>
    grant(person, isCapped(person) ? 'VIEWER' : inviteRole);

  /**
   * Clicking a result SELECTS it; Invite is the only thing that grants. Two
   * grant paths (click-to-grant and Invite) meant only one of them could be
   * exercised by a test, so a regression in the other — like Invite bypassing
   * the cap — would go uncaught. Select-then-commit makes Invite the one real
   * grant path, matching the modal this dialog replaces (pick a person, then
   * press Add).
   */
  const selectPerson = (person: OrgPerson) => {
    setSelectedPerson(person);
    setQuery(person.name);
  };

  const handleInvite = () => {
    if (!selectedPerson) return;
    grantPerson(selectedPerson);
    // Clear synchronously here, where the grant is initiated — not by
    // watching `entries` for the person to appear there. Entry membership
    // can be true for reasons unrelated to a grant just landing (the person
    // already had access before they were selected), which silently
    // un-selected them and reopened the dropdown with no explanation. If
    // this grant fails (e.g. ALREADY_HAS_ACCESS), the error banner still
    // reports it — clearing the selection doesn't hide that.
    setSelectedPerson(null);
    setQuery('');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${entityName}`}
        className="w-full max-w-lg rounded-xl bg-surface-1 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Share &ldquo;{entityName}&rdquo;</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        {canManage && (
          <div className="mb-4 flex gap-2">
            <div className="relative flex-1">
              <input
                ref={searchRef}
                type="text"
                aria-label="Add people"
                placeholder="Add people from your organization…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedPerson(null);
                  void search(e.target.value);
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              {results.length > 0 && !selectedPerson && (
                <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border bg-surface-1 shadow">
                  {results.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        onClick={() => selectPerson(person)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-2"
                      >
                        <span>
                          {person.name} <span className="text-xs text-slate-400">{person.email}</span>
                        </span>
                        {isCapped(person) && (
                          <span className="text-[10px] uppercase text-amber-600">Org viewer</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searchFailed ? (
                <p className="mt-1 text-xs text-red-500">
                  Search failed — check your connection and try again.
                </p>
              ) : (
                query.includes('@') && results.length === 0 && (
                  <p className="mt-1 text-xs text-slate-500">
                    Not in this organization — ask an admin to invite them.{' '}
                    <a href="/settings/organization/members" className="text-teal-700 underline">
                      Members settings
                    </a>
                  </p>
                )
              )}
            </div>
            <select
              aria-label="Role for new people"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as AccessRoleValue)}
              className="rounded-lg border px-2 py-2 text-sm"
            >
              {INVITE_ROLES.map((role) => (
                <option key={role} value={role} title={ACCESS_ROLE_HINTS[kind][role]}>
                  {ACCESS_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !selectedPerson}
              onClick={handleInvite}
              className="rounded-lg bg-teal-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Invite
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">People with access</h3>
        <ul className="space-y-2">
          {entries.map((entry) => {
            const isSelf = entry.userId === currentUserId;
            // Mirrors `isCapped` above, on the stored `orgRole` rather than a
            // fresh search result: an org VIEWER cannot hold a writing grant
            // (D7), so this row must not offer a role the server will refuse
            // (`RoleExceedsOrgRoleError` / 409 `ROLE_EXCEEDS_ORG_ROLE`).
            const isRowCapped = entry.orgRole === 'VIEWER';
            const rowRoles = isRowCapped ? (['VIEWER'] as AccessRoleValue[]) : ALL_ROLES;
            return (
              <li key={entry.userId} className="text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-slate-800">{entry.user.name}</span>
                    {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                    <span className="ml-2 text-xs text-slate-400">{entry.user.email}</span>
                  </div>
                  {canManage && !isSelf ? (
                    <div className="flex items-center gap-2">
                      <select
                        aria-label={`Role for ${entry.user.name}`}
                        value={entry.role}
                        onChange={(e) => changeRole(entry.userId, e.target.value as AccessRoleValue)}
                        className="rounded-lg border px-2 py-1 text-xs"
                      >
                        {rowRoles.map((role) => (
                          <option key={role} value={role} title={ACCESS_ROLE_HINTS[kind][role]}>
                            {ACCESS_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.user.name}`}
                        onClick={() => revoke(entry.userId)}
                        className="text-xs text-slate-300 hover:text-red-500"
                      >
                        ✕
                      </button>
                    </div>
                  ) : canManage && isSelf ? (
                    <select
                      aria-label={`Role for ${entry.user.name}`}
                      value={entry.role}
                      onChange={(e) => changeRole(entry.userId, e.target.value as AccessRoleValue)}
                      className="rounded-lg border px-2 py-1 text-xs"
                    >
                      {rowRoles.map((role) => (
                        <option key={role} value={role} title={ACCESS_ROLE_HINTS[kind][role]}>
                          {ACCESS_ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-slate-500">{ACCESS_ROLE_LABELS[entry.role]}</span>
                  )}
                </div>
                {canManage && isRowCapped && (
                  <p className="mt-0.5 text-[10px] text-amber-600">{ORG_VIEWER_NOTE}</p>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-4 text-xs text-slate-500">
          Organization admins can always access this {noun}.
        </p>
      </div>
    </div>
  );
}
