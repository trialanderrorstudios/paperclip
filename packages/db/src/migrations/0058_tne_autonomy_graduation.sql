-- NEW 3 V1 (-tne): graduated autonomy + structured allowlist envelope.
--
-- Adds one new jsonb column `companies.autonomy_policy` for the per-company
-- autonomy floor (maxLevel + optional company-wide allowlist floor + digest
-- toggle). Defaults to `{}` so existing rows keep working — a compat shim
-- in the server read path synthesizes an effective policy from the legacy
-- `require_board_approval_for_new_agents` boolean when this column is empty.
--
-- Per-agent autonomy state (level + envelope + graduation signals) rides
-- inside the existing `agents.permissions` jsonb column — NO new column on
-- `agents` (Option A per plan §5.1: minimal fork surface, clean rebase).
--
-- Adds an index on `activity_log (agent_id, created_at DESC, action)` for
-- the derived graduation-signals query (scans last-30-days by agent_id).
-- Only skipped if already present (IF NOT EXISTS).
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "autonomy_policy" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_agent_created_action_idx"
  ON "activity_log" USING btree ("agent_id", "created_at" DESC, "action");
