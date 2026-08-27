-- Private employee comments (programme item 8a).
--
-- DEFAULT false, so every comment that already exists keeps exactly today's
-- visibility. Privacy is opt-in per comment; defaulting to private would
-- silently break the shared-notes workflow the feature already supports.
ALTER TABLE "org_employee_comments"
  ADD COLUMN "is_private" BOOLEAN NOT NULL DEFAULT false;

-- Both the list and the count filter on (employee, is_private), per employee, on
-- every employee-card open.
CREATE INDEX "org_employee_comments_org_employee_id_is_private_idx"
  ON "org_employee_comments"("org_employee_id", "is_private");
