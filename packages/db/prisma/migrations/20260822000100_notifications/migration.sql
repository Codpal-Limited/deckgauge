-- In-app notifications (programme item 7). IN-APP ONLY: email and push are out
-- of scope per VP-Cockpit-PRD.md:84 and planning/REQUIREMENTS.md:41.
--
-- The type name is the MAPPED, lower-snake one. Raw SQL here must not use the
-- Prisma model-side name ("NotificationKind") — an earlier migration in this
-- repo did exactly that, failed, and left a `_prisma_migrations` row with
-- finished_at NULL that had to be deleted by hand before it could be re-applied.
CREATE TYPE "notification_kind" AS ENUM ('MENTION');

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    -- Not redundant with user_id: under multi-org one user holds memberships in
    -- several organizations, so a list that ignored this would mix tenants.
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "kind" "notification_kind" NOT NULL,
    "project_comment_id" TEXT,
    "org_employee_comment_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
    -- Exactly one subject. "Neither" is a row that can never render; "both" is
    -- ambiguous about what clicking it should open.
    CONSTRAINT "notifications_one_subject" CHECK (
        (("project_comment_id" IS NOT NULL)::int + ("org_employee_comment_id" IS NOT NULL)::int) = 1
    )
);

-- The bell's two queries: unread-for-me, and the newest-N listing.
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
CREATE INDEX "notifications_organization_id_idx" ON "notifications"("organization_id");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting the person who mentioned you must not delete
-- the fact that you were mentioned.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CASCADE on both subjects: a notification whose comment is gone can only
-- render as a dead link, and this way no delete route has to remember.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_comment_id_fkey"
    FOREIGN KEY ("project_comment_id") REFERENCES "project_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_employee_comment_id_fkey"
    FOREIGN KEY ("org_employee_comment_id") REFERENCES "org_employee_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
