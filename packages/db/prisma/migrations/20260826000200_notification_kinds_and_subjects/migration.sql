-- The full trigger set (notification system design §3, §5.1).
--
-- The type name is the MAPPED, lower-snake one — raw SQL must not use the Prisma
-- model-side name ("NotificationKind"), which fails 42704 and leaves a
-- _prisma_migrations row with finished_at NULL to clean up by hand.
--
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction; the new
-- values simply cannot be USED in the same transaction, and nothing here does.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_ASSIGNED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_STATUS_CHANGED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_DUE_DATE_CHANGED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_COMMENT_ADDED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_DUE_SOON';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ITEM_OVERDUE';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ENTITY_SHARED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ACCESS_ROLE_CHANGED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ORG_MEMBER_INVITED';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'AUTOMATION_NOTIFY';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'DIGEST';

ALTER TABLE "notifications"
  ADD COLUMN "project_id"      TEXT,
  ADD COLUMN "share_kind"      TEXT,
  ADD COLUMN "share_entity_id" TEXT,
  ADD COLUMN "payload"         JSONB,
  ADD COLUMN "digest_id"       TEXT,
  ADD COLUMN "digest_pending"  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SetNull, not Cascade: deleting a summary must not delete the events it
-- summarised.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digest_id_fkey"
  FOREIGN KEY ("digest_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Was "exactly one of two comment subjects". Every kind added here points
-- somewhere else, and a DIGEST summary points nowhere at all — which is the only
-- reason "no subject" is legal.
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_one_subject";

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_at_most_one_subject" CHECK (
    (("project_comment_id" IS NOT NULL)::int
   + ("org_employee_comment_id" IS NOT NULL)::int
   + ("project_id" IS NOT NULL)::int
   + ("share_entity_id" IS NOT NULL)::int) <= 1
);

-- Half a pair is a row that can never resolve: the kind without the id, or an id
-- with no idea which table it belongs to.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_share_pair" CHECK (
    ("share_kind" IS NULL) = ("share_entity_id" IS NULL)
);

-- A row must never be its own digest: the release job walks digest_id, and a
-- self-reference would make the summary expand into itself.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_digest_not_self" CHECK (
    "digest_id" IS NULL OR "digest_id" <> "id"
);

-- The release job's query: this user's pending rows, oldest first.
CREATE INDEX "notifications_user_id_digest_pending_created_at_idx"
  ON "notifications"("user_id", "digest_pending", "created_at");
