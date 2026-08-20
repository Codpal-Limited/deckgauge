-- Each board inside an org tree becomes its own sharing decision (design D12).
CREATE TABLE "employee_board_access" (
    "id" TEXT NOT NULL,
    "employee_board_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "board_access_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_board_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employee_board_access_employee_board_id_user_id_key"
    ON "employee_board_access"("employee_board_id", "user_id");
CREATE INDEX "employee_board_access_employee_board_id_idx"
    ON "employee_board_access"("employee_board_id");
CREATE INDEX "employee_board_access_user_id_idx"
    ON "employee_board_access"("user_id");

ALTER TABLE "employee_board_access"
    ADD CONSTRAINT "employee_board_access_employee_board_id_fkey"
    FOREIGN KEY ("employee_board_id") REFERENCES "employee_boards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_board_access"
    ADD CONSTRAINT "employee_board_access_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- MANDATORY BACKFILL (design §9).
--
-- Today an org-tree EDITOR can edit every board in the tree, because all 13
-- employee-board routes are gated by orgTree(...). D12 ends that. Without this
-- backfill, everyone holding a tree grant loses their boards the moment the
-- policy moves — so this copies each tree grant down onto every board in that
-- tree, at the SAME role. Effective access on merge day is unchanged for
-- everyone; the separation governs decisions made from then on.
--
-- Org-tree OWNERs are covered twice over: by this backfill, and by D12's
-- implicit rule in the policy layer. That redundancy is deliberate — the
-- implicit rule must not be the only thing standing between an owner and their
-- own boards.
INSERT INTO "employee_board_access" ("id", "employee_board_id", "user_id", "role", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    eb."id",
    ota."user_id",
    ota."role",
    NOW(),
    NOW()
FROM "employee_boards" eb
JOIN "org_tree_access" ota ON ota."org_tree_id" = eb."org_tree_id"
ON CONFLICT ("employee_board_id", "user_id") DO NOTHING;
