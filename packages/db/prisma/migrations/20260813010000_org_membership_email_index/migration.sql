-- resolveForUser() looks up a PENDING invite by email alone, with no
-- organizationId to narrow on, so none of the compound indexes can be seeked.
-- Without this, every request from a user who has no bound membership yet
-- full-scans org_memberships.
CREATE INDEX "org_memberships_email_idx" ON "org_memberships"("email");
