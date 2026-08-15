CREATE TABLE "org_tree_access" (
  "id"          TEXT NOT NULL,
  "org_tree_id" TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "role"        "board_access_role" NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "org_tree_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_tree_access_org_tree_id_user_id_key"
  ON "org_tree_access" ("org_tree_id", "user_id");
CREATE INDEX "org_tree_access_org_tree_id_idx" ON "org_tree_access" ("org_tree_id");
CREATE INDEX "org_tree_access_user_id_idx" ON "org_tree_access" ("user_id");

ALTER TABLE "org_tree_access" ADD CONSTRAINT "org_tree_access_org_tree_id_fkey"
  FOREIGN KEY ("org_tree_id") REFERENCES "org_trees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_tree_access" ADD CONSTRAINT "org_tree_access_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
