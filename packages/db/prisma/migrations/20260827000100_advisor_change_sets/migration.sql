-- Advisor change-sets: a proposed, human-approvable batch of board edits.
--
-- `ops` and `preview` are jsonb rather than a child table because both are
-- only ever read as a whole, in order, for one change-set at a time.
CREATE TYPE "advisor_change_set_status" AS ENUM (
  'PENDING', 'APPLIED', 'DISCARDED', 'STALE', 'EXPIRED'
);

CREATE TABLE "advisor_change_sets" (
  "id"                 TEXT NOT NULL,
  "board_id"           TEXT NOT NULL,
  -- Stored, not derived from board_id: the tenant predicate must be on the row
  -- itself so every read can filter on it (TENANCY-PROGRAMME 5a).
  "organization_id"    TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "status"             "advisor_change_set_status" NOT NULL DEFAULT 'PENDING',
  "summary"            TEXT NOT NULL,
  "ops"                JSONB NOT NULL,
  "preview"            JSONB NOT NULL,
  "expires_at"         TIMESTAMP(3) NOT NULL,
  "applied_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advisor_change_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "advisor_change_sets_board_id_status_idx"
  ON "advisor_change_sets"("board_id", "status");
CREATE INDEX "advisor_change_sets_created_by_user_id_status_idx"
  ON "advisor_change_sets"("created_by_user_id", "status");
CREATE INDEX "advisor_change_sets_organization_id_idx"
  ON "advisor_change_sets"("organization_id");

ALTER TABLE "advisor_change_sets"
  ADD CONSTRAINT "advisor_change_sets_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "advisor_change_sets"
  ADD CONSTRAINT "advisor_change_sets_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
