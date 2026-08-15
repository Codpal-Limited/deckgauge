CREATE TABLE "advisor_sessions" (
  "id"         TEXT NOT NULL,
  "board_id"   TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "title"      TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "advisor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "advisor_messages" (
  "id"         TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "role"       TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "tool_calls" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "advisor_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "advisor_sessions_user_id_board_id_updated_at_idx"
  ON "advisor_sessions"("user_id", "board_id", "updated_at");

CREATE INDEX "advisor_messages_session_id_created_at_idx"
  ON "advisor_messages"("session_id", "created_at");

ALTER TABLE "advisor_sessions"
  ADD CONSTRAINT "advisor_sessions_board_id_fkey"
  FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "advisor_sessions"
  ADD CONSTRAINT "advisor_sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "advisor_messages"
  ADD CONSTRAINT "advisor_messages_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "advisor_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
