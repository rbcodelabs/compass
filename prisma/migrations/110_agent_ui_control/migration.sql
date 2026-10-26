-- Agent control of the user's live UI. Purely additive.
-- DSQL: no foreign keys (application-scoped integrity), no JSON columns.
CREATE TABLE IF NOT EXISTS "ui_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "tab_id" VARCHAR(64) NOT NULL,
  "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  "current_path" VARCHAR(500),
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "ui_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "session_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "args_json" TEXT NOT NULL DEFAULT '{}',
  "status" VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  "delivered_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "result_json" TEXT,
  "error" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One live session per (user, workspace, tab): re-enabling in the same tab
-- collides and is upserted rather than accumulating shadow sessions.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_ui_sessions_user_ws_tab" ON "ui_sessions" ("user_id", "workspace_id", "tab_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_ui_sessions_user_ws_status" ON "ui_sessions" ("user_id", "workspace_id", "status");
CREATE INDEX ASYNC IF NOT EXISTS "idx_ui_commands_session_status" ON "ui_commands" ("session_id", "status", "created_at");
