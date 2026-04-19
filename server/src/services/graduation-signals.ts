/**
 * Derived graduation signals (NEW 3 V1, -tne delta).
 *
 * Computes the accrual counters that drive promotion proposals from the
 * existing `activity_log` table, filtered to the last 30 days per the
 * CEO plan's promotion criteria (§3.2). Depends on the `activity_log`
 * `(agent_id, created_at DESC, action)` index added by migration 0058.
 *
 * 60s server-side cache per agentId (plan §P1). Read path stays O(1)
 * for dashboard list views; write path amortizes through the cache
 * invalidation that happens automatically by letting the TTL expire —
 * we don't want to invalidate on every activity_log row or the cache
 * becomes useless.
 *
 * TODO(NEW 3 V1.1): materialize a `graduation_summary` row in
 * `agent_runtime_state` updated by a post-activity-log trigger. For V1
 * the 60s in-memory cache is sufficient.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { GraduationSignals } from "@paperclipai/shared";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  value: GraduationSignals;
  expiresAt: number;
}

/**
 * Action values that contribute to clean-run accrual. These are emitted
 * by the heartbeat-run loop on successful completion. Kept broad (any
 * non-failure run counts toward cleanRunCount) and narrow (the explicit
 * rejection/breach actions contribute to negative signals).
 */
const CLEAN_RUN_ACTIONS = new Set([
  "heartbeat.run.succeeded",
  "agent.run_completed",
]);

const BOARD_REJECT_ACTIONS = new Set([
  "approval.rejected",
  "approval.revision_requested",
]);

const BUDGET_BREACH_ACTIONS = new Set([
  "budget.incident_opened",
  "budget.hard_limit",
]);

const ALLOWLIST_VIOLATION_ACTIONS = new Set(["allowlist.violated"]);

const HUMAN_OVERRIDE_ACTIONS = new Set([
  "agent.paused",
  "heartbeat.run.cancelled",
]);

/**
 * Counters surfaced by the raw query. Aggregated into GraduationSignals
 * below.
 */
interface RawCounts {
  cleanRunCount: number;
  boardRejectCount: number;
  budgetBreachCount: number;
  allowlistViolationCount: number;
  humanOverrideCount: number;
  totalRuns: number;
  oldestActivityAt: string | null;
}

/**
 * Factory — binds a Db handle and returns the public interface plus the
 * in-memory cache. Cache is module-scoped in the returned closure so
 * each server process has a single cache.
 */
export function graduationSignalsService(
  db: Db,
  opts: { now?: () => number } = {},
) {
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  async function computeSignals(agentId: string): Promise<GraduationSignals> {
    const since = new Date(now() - THIRTY_DAYS_MS);
    // One query, all rows in the 30-day window for this agent — server
    // aggregates in-process. Total rows bounded by activity per agent;
    // if volumes grow, V1.1 should move this into a SQL aggregation.
    const rows = await db
      .select({ action: activityLog.action, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(eq(activityLog.agentId, agentId), gte(activityLog.createdAt, since)));

    const counts: RawCounts = {
      cleanRunCount: 0,
      boardRejectCount: 0,
      budgetBreachCount: 0,
      allowlistViolationCount: 0,
      humanOverrideCount: 0,
      totalRuns: 0,
      oldestActivityAt: null,
    };
    for (const row of rows) {
      if (CLEAN_RUN_ACTIONS.has(row.action)) counts.cleanRunCount += 1;
      if (BOARD_REJECT_ACTIONS.has(row.action)) counts.boardRejectCount += 1;
      if (BUDGET_BREACH_ACTIONS.has(row.action)) counts.budgetBreachCount += 1;
      if (ALLOWLIST_VIOLATION_ACTIONS.has(row.action)) counts.allowlistViolationCount += 1;
      if (HUMAN_OVERRIDE_ACTIONS.has(row.action)) counts.humanOverrideCount += 1;
      if (
        CLEAN_RUN_ACTIONS.has(row.action) ||
        row.action === "heartbeat.run.failed" ||
        row.action === "heartbeat.run.timed_out"
      ) {
        counts.totalRuns += 1;
      }
      const iso = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
      if (counts.oldestActivityAt === null || iso < counts.oldestActivityAt) {
        counts.oldestActivityAt = iso;
      }
    }

    const toolRejectionRate =
      counts.totalRuns > 0 ? counts.allowlistViolationCount / counts.totalRuns : 0;

    return {
      cleanRunCount: counts.cleanRunCount,
      boardRejectCount: counts.boardRejectCount,
      budgetBreachCount: counts.budgetBreachCount,
      toolRejectionRate,
      humanOverrideCount: counts.humanOverrideCount,
      probationStart: counts.oldestActivityAt,
    };
  }

  async function getSignals(agentId: string): Promise<GraduationSignals> {
    const entry = cache.get(agentId);
    const nowMs = now();
    if (entry && entry.expiresAt > nowMs) {
      return entry.value;
    }
    const value = await computeSignals(agentId);
    cache.set(agentId, { value, expiresAt: nowMs + CACHE_TTL_MS });
    return value;
  }

  /** Test / manual helper — force recompute and seed the cache. */
  function invalidate(agentId?: string) {
    if (agentId) cache.delete(agentId);
    else cache.clear();
  }

  return { getSignals, computeSignals, invalidate };
}

// Re-export for convenience.
export type { GraduationSignals };

// Test helper: silence unused-import warning when sql helper isn't touched.
void sql;
