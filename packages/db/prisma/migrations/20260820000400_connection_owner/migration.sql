-- Connection ownership. NULL = organization-wide, a user id = personal.
--
-- Existing rows stay NULL: every connection that exists today was created under
-- the admin-only regime introduced by Phase C and already feeds shared boards,
-- so organization-wide is both the safe default and the correct one. Nothing
-- changes behaviour for any board on deploy.
--
-- ON DELETE RESTRICT, not SET NULL: SET NULL would turn a personal connection
-- into an organization-wide one when a user row is deleted, which publishes that
-- user's stored credential to the whole organization. CASCADE would be
-- destructive in the other direction, silently deleting a leaver's board sync
-- configuration. No API route deletes a user today -- the only deletion in that
-- area is DELETE /organization/members/:membershipId, which removes a MEMBERSHIP
-- and leaves the user row intact -- so RESTRICT costs nothing now and fails
-- loudly at development time if user deletion is ever added.
ALTER TABLE jira_instances         ADD COLUMN owner_user_id TEXT NULL
  REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE github_instances       ADD COLUMN owner_user_id TEXT NULL
  REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE azure_devops_instances ADD COLUMN owner_user_id TEXT NULL
  REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE gitlab_instances       ADD COLUMN owner_user_id TEXT NULL
  REFERENCES users(id) ON DELETE RESTRICT;

-- (organization_id, owner_user_id) is the shape every visibility query uses:
-- the tenant predicate ANDed with "organization-wide OR mine".
CREATE INDEX jira_instances_org_owner_idx
  ON jira_instances (organization_id, owner_user_id);
CREATE INDEX github_instances_org_owner_idx
  ON github_instances (organization_id, owner_user_id);
CREATE INDEX azure_devops_instances_org_owner_idx
  ON azure_devops_instances (organization_id, owner_user_id);
CREATE INDEX gitlab_instances_org_owner_idx
  ON gitlab_instances (organization_id, owner_user_id);
