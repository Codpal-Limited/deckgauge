-- Which organization a person is currently acting in, when they hold more than
-- one (tenancy §11 precondition 2).
--
-- A PREFERENCE, not a grant. MembershipService.resolveForUser honours it only
-- when it still names a membership the caller holds and ignores it otherwise, so
-- revoking a membership takes effect without clearing this column and a value set
-- here can never widen access.
--
-- Deliberately NO foreign key. The referenced organization may be deleted, and a
-- dangling value must degrade to "ignored" — which the resolver already does —
-- rather than block the delete or cascade a surprise onto the user row. Nullable
-- with no default: NULL means "no explicit choice", which is every existing row.
ALTER TABLE "users" ADD COLUMN "active_organization_id" TEXT;

-- Nothing to backfill: every existing user holds at most one membership under the
-- one-organization cap, so the deterministic default already resolves correctly
-- for all of them.
