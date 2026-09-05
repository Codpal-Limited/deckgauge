import { z } from 'zod';
import type { AccessEntry } from './access.js';

/** Organization-level roles. The ceiling on any per-board grant (spec D3). */
export const ORG_ROLES = ['ADMIN', 'MEMBER', 'VIEWER'] as const;
export const OrgRoleSchema = z.enum(ORG_ROLES);
export type OrgRoleValue = (typeof ORG_ROLES)[number];

/** Ordered so a numeric comparison answers "does this role reach that one?". */
export const ORG_ROLE_RANK: Record<OrgRoleValue, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
};

export const ORG_MEMBERSHIP_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export const OrgMembershipStatusSchema = z.enum(ORG_MEMBERSHIP_STATUSES);
export type OrgMembershipStatusValue = (typeof ORG_MEMBERSHIP_STATUSES)[number];

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export const BootstrapOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().min(1).max(50).regex(SLUG_PATTERN, {
    message: 'slug must contain only lowercase letters, digits and hyphens',
  }),
});
export type BootstrapOrganizationInput = z.infer<typeof BootstrapOrganizationSchema>;

/**
 * Emails are lowercased at the boundary because OrgMembership.email is stored
 * lowercased — first-login binding must be an index hit, not a case-insensitive
 * scan (spec §5.1).
 */
export const InviteMemberSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  role: OrgRoleSchema,
});
export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  /** The requesting user's role in this organization. */
  role: OrgRoleValue;
}

/**
 * One row of the Members screen. `userId` is null while the invite is PENDING —
 * the person has been invited but has never logged in, so no User row exists yet.
 */
export interface OrgMemberDto {
  id: string;
  email: string;
  name: string | null;
  userId: string | null;
  role: OrgRoleValue;
  status: OrgMembershipStatusValue;
  invitedAt: string;
  activatedAt: string | null;
}

export const UpdateMemberRoleSchema = z.object({ role: OrgRoleSchema }).strict();
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleSchema>;

/**
 * PENDING is deliberately excluded: it is set once, by first-login binding.
 * An admin may only activate or suspend.
 *
 * `.strict()` matters here specifically: the route tries this schema and
 * `UpdateMemberRoleSchema` against the same body, so a body carrying both
 * `role` and `status` must fail *both* rather than have either schema
 * silently strip the other's key and report a partial success.
 */
export const UpdateMemberStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
  })
  .strict();
export type UpdateMemberStatusInput = z.infer<typeof UpdateMemberStatusSchema>;

/**
 * One row of the admin All-boards table (tenancy spec §5.4).
 *
 * `access` is the board's full people list in the same shape `AccessService#list`
 * returns, so `ShareDialog` and `AccessPeopleStack` consume it unmodified. It
 * travels with the row rather than being fetched per board: the table renders
 * every board in the organization, and a per-row round trip would be N requests
 * to draw one screen.
 *
 * `createdAt` is an ISO string, not a Date: this crosses an HTTP boundary and a
 * React Server Component boundary, and both serialise a Date to a string anyway
 * — typing it as one keeps the client from having to guess.
 */
export interface OrgBoardDto {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  createdAt: string;
  projectCount: number;
  access: AccessEntry[];
}

/**
 * One organization the caller may act in — what the switcher lists.
 *
 * `isActive` is which one the session currently resolves to, so the UI marks it
 * without re-deriving the precedence rules the API owns.
 */
export interface OrgMembershipOptionDto {
  organizationId: string;
  name: string;
  slug: string;
  role: OrgRoleValue;
  status: 'ACTIVE' | 'SUSPENDED';
  isActive: boolean;
}

/**
 * Body of the switch request. `.strict()` so a stray field is a 400 rather than
 * being ignored — this endpoint changes which tenant every later request reads.
 */
export const SwitchOrganizationSchema = z
  .object({ organizationId: z.string().uuid() })
  .strict();
export type SwitchOrganizationInput = z.infer<typeof SwitchOrganizationSchema>;
