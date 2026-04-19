import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    // NEW 3 V1 (-tne): index for graduation-signals 30-day per-agent scans.
    // Added by migration 0058_tne_autonomy_graduation.sql.
    agentCreatedActionIdx: index("activity_log_agent_created_action_idx").on(
      table.agentId,
      desc(table.createdAt),
      table.action,
    ),
  }),
);
