-- Personal manager boards (programme item 8b).
--
-- DEFAULT false, so every board that already exists keeps exactly today's
-- visibility: reachable through the org-ADMIN floor and D12's tree-OWNER rule.
-- Only a board explicitly marked personal opts out of both.
ALTER TABLE "employee_boards"
  ADD COLUMN "is_personal" BOOLEAN NOT NULL DEFAULT false;
