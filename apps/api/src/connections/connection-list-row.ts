/**
 * What a connection list tells the UI about ownership and provenance.
 *
 * Two fields, deliberately shaped for the screen rather than mirroring the row:
 *
 * - `isPersonal` instead of the raw `ownerUserId`. The screen needs the FACT, and
 *   publishing a user id to every member of the organization is a disclosure with
 *   no purpose. It also keeps the authorization axis out of the response entirely,
 *   so no client can start making decisions from it.
 * - `addedBy`, a display name resolved from `createdById`. Provenance only, never
 *   a gate — reusing provenance as a gate is the `connectionOwner` mistake Phase C
 *   removed. Null for rows predating the column, which is honest: nobody claims
 *   them any more, because claim-on-first-edit is gone.
 */
export interface ConnectionOwnershipFields {
  isPersonal: boolean;
  addedBy: string | null;
}

interface OwnableRow {
  ownerUserId?: string | null;
  createdBy?: { name: string | null; email: string } | null;
}

/** The creator join every provider's list must select for `addedBy` to resolve. */
export const CREATED_BY_SELECT = { select: { name: true, email: true } } as const;

export function ownershipFieldsOf(row: OwnableRow): ConnectionOwnershipFields {
  return {
    isPersonal: row.ownerUserId != null,
    // Name, then email, then null. An email is a worse label than a name but a far
    // better one than "—" when that is all we have.
    addedBy: row.createdBy?.name || row.createdBy?.email || null,
  };
}

/**
 * Strip the fields the client must not see, and add the two it needs.
 *
 * `ownerUserId` and the joined `createdBy` are removed rather than left to ride
 * along: the derived answer is the contract, and a response that carried both
 * would invite a client to reimplement the rule from the raw ids.
 */
export function withOwnershipFields<T extends OwnableRow>(
  row: T,
): Omit<T, 'ownerUserId' | 'createdBy'> & ConnectionOwnershipFields {
  const { ownerUserId: _owner, createdBy: _creator, ...rest } = row;
  return { ...rest, ...ownershipFieldsOf(row) } as Omit<T, 'ownerUserId' | 'createdBy'> &
    ConnectionOwnershipFields;
}
