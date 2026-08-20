'use client';

import { useCallback, useState, useTransition } from 'react';
import type { AccessEntityKind, AccessEntry, AccessRoleValue, OrgPerson } from '@deckgauge/shared';
import { useAuthFetch } from '../../hooks/useAuthFetch';
import {
  grantAccess as defaultGrant,
  updateAccessRole as defaultUpdate,
  revokeAccess as defaultRevoke,
  fetchAccess as defaultFetch,
} from '../../actions/access';

export interface EntityAccessDeps {
  onGrant?: typeof defaultGrant;
  onUpdateRole?: typeof defaultUpdate;
  onRevoke?: typeof defaultRevoke;
  onRefetch?: typeof defaultFetch;
}

export function useEntityAccess({
  kind,
  entityId,
  initialEntries,
  onGrant = defaultGrant,
  onUpdateRole = defaultUpdate,
  onRevoke = defaultRevoke,
  onRefetch = defaultFetch,
}: {
  kind: AccessEntityKind;
  entityId: string;
  initialEntries: AccessEntry[];
} & EntityAccessDeps) {
  const authFetch = useAuthFetch();
  const [entries, setEntries] = useState<AccessEntry[]>(initialEntries);
  const [results, setResults] = useState<OrgPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  /** Server-side truth on open: two owners editing access at once is this dialog's normal case. */
  const refresh = useCallback(() => {
    startTransition(async () => {
      setEntries(await onRefetch(kind, entityId));
    });
  }, [kind, entityId, onRefetch]);

  /**
   * `authFetch` can throw (a network failure, or `MissingSessionError` mid-
   * dialog) before a `Response` ever exists, and a non-OK response (a 403 —
   * reachable once `/users/search` requires membership, or a 500) is not the
   * same thing as "no matches". Both must set `searchFailed` rather than
   * silently leaving `results` empty: an empty `results` with `searchFailed`
   * false is what "no matches" actually looks like, and `ShareDialog` tells
   * the two apart to avoid mislabelling a failed search as "not in this
   * organization" for an `@` query.
   */
  const search = useCallback(
    async (q: string) => {
      setSearchFailed(false);
      try {
        const res = await authFetch(`/users/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          setSearchFailed(true);
          setResults([]);
          return;
        }
        setResults((await res.json()) as OrgPerson[]);
      } catch {
        setSearchFailed(true);
        setResults([]);
      }
    },
    [authFetch],
  );

  const grant = useCallback(
    (person: OrgPerson, role: AccessRoleValue) => {
      setError(null);
      startTransition(async () => {
        const result = await onGrant(kind, entityId, person.id, role);
        if (!result.ok) return setError(result.error);
        setEntries((prev) => [
          ...prev.filter((e) => e.userId !== person.id),
          {
            userId: person.id,
            role: result.role,
            orgRole: person.orgRole,
            user: {
              id: person.id,
              name: person.name,
              email: person.email,
              avatarUrl: person.avatarUrl,
            },
          },
        ]);
        setResults([]);
      });
    },
    [kind, entityId, onGrant],
  );

  const changeRole = useCallback(
    (userId: string, role: AccessRoleValue) => {
      setError(null);
      startTransition(async () => {
        const result = await onUpdateRole(kind, entityId, userId, role);
        if (!result.ok) return setError(result.error);
        setEntries((prev) => prev.map((e) => (e.userId === userId ? { ...e, role } : e)));
      });
    },
    [kind, entityId, onUpdateRole],
  );

  const revoke = useCallback(
    (userId: string) => {
      setError(null);
      startTransition(async () => {
        const result = await onRevoke(kind, entityId, userId);
        if (!result.ok) return setError(result.error);
        setEntries((prev) => prev.filter((e) => e.userId !== userId));
      });
    },
    [kind, entityId, onRevoke],
  );

  return { entries, results, error, searchFailed, pending, refresh, search, grant, changeRole, revoke };
}
