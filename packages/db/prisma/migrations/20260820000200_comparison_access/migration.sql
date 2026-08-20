-- Comparisons gain a tiered ACL, replacing creator-only access (design D15).
-- NOTE the enum name: Prisma maps BoardAccessRole to snake_case in Postgres, so
-- "BoardAccessRole" does not exist there.
CREATE TABLE "comparison_access" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "board_access_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comparison_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "comparison_access_comparison_id_user_id_key"
    ON "comparison_access"("comparison_id", "user_id");
CREATE INDEX "comparison_access_comparison_id_idx" ON "comparison_access"("comparison_id");
CREATE INDEX "comparison_access_user_id_idx" ON "comparison_access"("user_id");

ALTER TABLE "comparison_access"
    ADD CONSTRAINT "comparison_access_comparison_id_fkey"
    FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comparison_access"
    ADD CONSTRAINT "comparison_access_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- MANDATORY BACKFILL (design §9). Every existing comparison becomes unreachable
-- the moment the policy stops being creator-only, unless its creator is written
-- in as an OWNER first.
--
-- The join to "users" is not decoration: created_by has an index but no foreign
-- key, so a comparison whose creator row was deleted would otherwise violate
-- comparison_access_user_id_fkey and abort the whole migration. Such a
-- comparison is already orphaned; it stays unreachable and gets counted after.
INSERT INTO "comparison_access" ("id", "comparison_id", "user_id", "role", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."id", c."created_by", 'OWNER', NOW(), NOW()
  FROM "comparisons" c
  JOIN "users" u ON u."id" = c."created_by"
ON CONFLICT ("comparison_id", "user_id") DO NOTHING;
