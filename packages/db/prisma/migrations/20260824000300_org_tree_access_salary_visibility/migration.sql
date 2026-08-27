-- Salary visibility as a grant (programme item 9).
--
-- DEFAULT false, and the API treats it as ADDITIVE to the existing admin path
-- (SALARY_ADMIN_IMPLICIT), so nobody loses visibility they have today. Making the
-- grant exclusive is a deliberate follow-up decision, not a side effect of this
-- migration: it would silently remove a payroll-adjacent column from every admin.
ALTER TABLE "org_tree_access"
  ADD COLUMN "can_view_salary" BOOLEAN NOT NULL DEFAULT false;
