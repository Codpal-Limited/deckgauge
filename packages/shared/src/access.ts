import { z } from 'zod';
import { OrgRoleSchema } from './org';

/**
 * Per-entity grant roles. Mirrors `BoardAccessRole` and `RoadmapAccessRole` in
 * packages/db, whose members are identical — see spec §7.2 for why that needs no
 * enum migration. Declared here as a literal union, following `ORG_ROLES`, so
 * packages/shared stays free of a dependency on the Prisma client.
 */
export const ACCESS_ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const;
export const AccessRoleSchema = z.enum(ACCESS_ROLES);
export type AccessRoleValue = (typeof ACCESS_ROLES)[number];

/** Ordered so a numeric comparison answers "does this role reach that one?". */
export const ACCESS_ROLE_RANK: Record<AccessRoleValue, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/** Every shareable entity (spec §1). Phases B–D add no kinds; they are all here. */
export const ACCESS_ENTITY_KINDS = [
  'board',
  'orgTree',
  'employeeBoard',
  'roadmap',
  'comparison',
] as const;
export type AccessEntityKind = (typeof ACCESS_ENTITY_KINDS)[number];

/**
 * Monday's vocabulary (spec D1): the stored role is `EDITOR`, the word a person
 * reads is "Member". One map, so five surfaces cannot drift.
 */
export const ACCESS_ROLE_LABELS: Record<AccessRoleValue, string> = {
  OWNER: 'Owner',
  EDITOR: 'Member',
  VIEWER: 'Viewer',
};

/** The noun for dialog copy: `Share "X"` / `Organization admins can always access this {noun}.` */
export const ACCESS_ENTITY_NOUNS: Record<AccessEntityKind, string> = {
  board: 'board',
  orgTree: 'org tree',
  employeeBoard: 'board',
  roadmap: 'roadmap',
  comparison: 'comparison',
};

/**
 * What each role can actually do — spec §4, which derives these from the route
 * inventory. These strings are a promise about enforcement; if a route changes
 * tier, the matching hint is wrong and must change with it.
 */
export const ACCESS_ROLE_HINTS: Record<AccessEntityKind, Record<AccessRoleValue, string>> = {
  board: {
    OWNER: 'Full control, including sharing and deleting the board',
    EDITOR: 'Can add and edit items, groups and columns',
    VIEWER: 'Can read the board but not change it',
  },
  orgTree: {
    OWNER: 'Full control, including sharing, renaming and the org source',
    EDITOR: 'Can import, sync and edit employees',
    VIEWER: 'Can read the chart, timesheet and report',
  },
  employeeBoard: {
    OWNER: 'Full control, including sharing and deleting this board',
    EDITOR: 'Can add and edit rows, groups and columns',
    VIEWER: 'Can read this board but not change it',
  },
  roadmap: {
    OWNER: 'Full control, including sharing and deleting the roadmap',
    EDITOR: 'Can edit items, groups, schedules and which boards feed it',
    VIEWER: 'Can read the roadmap but not change it',
  },
  comparison: {
    OWNER: 'Full control, including sharing and deleting the comparison',
    EDITOR: 'Can rename it and change which boards are compared',
    VIEWER: 'Can read the comparison but not change it',
  },
};

/**
 * A person the caller may grant access to: an ACTIVE member of their own
 * organization. `orgRole` travels with them so the dialog can enforce the
 * ceiling (spec D7) without a second round trip.
 */
export const OrgPersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  orgRole: OrgRoleSchema,
});
export type OrgPerson = z.infer<typeof OrgPersonSchema>;

/**
 * One row of "people with access". Deliberately carries no `keycloakId` (spec D5).
 *
 * `orgRole` is the target's organization role — `null` only when the caller
 * has no organization context to join through (pre-bootstrap/break-glass) or
 * the target's membership could not be resolved. It lets the dialog enforce
 * the ceiling (spec D7) on the per-row menu the same way the invite row
 * already does, without a second round trip per row.
 */
export const AccessEntrySchema = z.object({
  userId: z.string().uuid(),
  role: AccessRoleSchema,
  orgRole: OrgRoleSchema.nullable(),
  user: z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  }),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

export const GrantAccessSchema = z.object({
  userId: z.string().uuid(),
  role: AccessRoleSchema,
});
export type GrantAccessInput = z.infer<typeof GrantAccessSchema>;

export const UpdateAccessRoleSchema = z.object({ role: AccessRoleSchema });
export type UpdateAccessRoleInput = z.infer<typeof UpdateAccessRoleSchema>;

/**
 * The caller's own effective role, plus their local `User.id` — which the web
 * layer cannot otherwise learn, because `session.user.id` is the Keycloak
 * subject (spec D5).
 */
export const MyRoleSchema = z.object({
  role: AccessRoleSchema.nullable(),
  userId: z.string().uuid(),
});
export type MyRole = z.infer<typeof MyRoleSchema>;

/**
 * Can this effective role change the entity's contents?
 *
 * An ALLOWLIST, deliberately — never `role !== 'VIEWER'`. The effective role is
 * `null` whenever a role lookup fails or the caller holds no grant, and
 * `null !== 'VIEWER'` is `true`, so the negative form silently grants edit
 * affordances on failure. That exact inversion shipped twice in one slice
 * before this helper existed.
 */
export function canEditEntity(role: AccessRoleValue | null): boolean {
  return role === 'OWNER' || role === 'EDITOR';
}

/**
 * Can this effective role manage the entity itself — share it, delete it,
 * promote/demote other people's access? Board-level EDITOR reaches
 * `canEditEntity` but not this; only OWNER does.
 */
export function canManageEntity(role: AccessRoleValue | null): boolean {
  return role === 'OWNER';
}
