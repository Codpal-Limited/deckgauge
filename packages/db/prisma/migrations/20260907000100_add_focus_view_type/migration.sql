-- Team Focus board view.
--
-- Additive only: existing board_view_type values and every row using them are
-- untouched. Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction
-- provided the new value is not itself used in the same transaction, which is
-- why this migration adds the value and nothing else.
ALTER TYPE "board_view_type" ADD VALUE IF NOT EXISTS 'focus';
