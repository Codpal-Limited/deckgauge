-- The issue keys a board Jira source's `jql_filter` admits, resolved by the
-- worker on every sync and read by the intelligence path.
--
-- Absence of rows for a source means NO RESTRICTION (the source has no filter),
-- never "no issues" — so this migration is a no-op for every existing row, and
-- the 9 sources that already carry a filter are populated by syncing each of
-- their boards once (POST /boards/:boardId/sync), which is the same path that
-- keeps them current afterwards.
CREATE TABLE board_jira_source_keys (
  -- TEXT, not UUID: board_jira_sources.id is `String @default(uuid())` with no
  -- @db.Uuid, and this schema uses @db.Uuid NOWHERE. A UUID column here cannot
  -- carry an FK to a TEXT column — Postgres refuses it as incompatible types.
  board_jira_source_id TEXT NOT NULL,
  issue_key            TEXT NOT NULL,
  resolved_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT board_jira_source_keys_pkey PRIMARY KEY (board_jira_source_id, issue_key),
  CONSTRAINT board_jira_source_keys_source_fkey
    FOREIGN KEY (board_jira_source_id) REFERENCES board_jira_sources(id) ON DELETE CASCADE
);

CREATE INDEX board_jira_source_keys_source_idx
  ON board_jira_source_keys (board_jira_source_id);
