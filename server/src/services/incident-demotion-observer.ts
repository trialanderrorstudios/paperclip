/**
 * Incident → autonomy-demotion observer (NEW 3 V1.5, -tne delta).
 *
 * Plan §3.2 lists three demotion triggers beyond budget breach:
 * - allowlist violation outside exception envelope
 * - security gate failure from adapter
 * - manual demotion from board UI
 *
 * `budget-demotion-observer.ts` already covers the budget path. Heartbeat-
 * staleness covers `adapter_timeout`. This module covers allowlist
 * violations: the two existing emission sites (`routes/agents.ts:1797`
 * pre-dispatch hire deny, `services/heartbeat.ts:4089` runtime
 * gated-empty-envelope) write `allowlist.violated` activity rows but
 * don't currently demote. Wired here as fire-and-forget alongside the
 * existing emit so a slow demotion can't roll back the violation record.
 *
 * Idempotent: callers safe to re-fire. `sm.demote()` rank-guards.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  AUTONOMY_LEVEL_RANK,
  type AutonomyLevel,
  type AutonomyDemotionReason,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  autonomyStateMachine,
  effectiveAutonomyLevel,
} from "./autonomy-state-machine.js";

export interface IncidentObservation {
  agentId: string;
  companyId: string;
  reason: AutonomyDemotionReason;
  /** Optional run id for the audit trail. */
  runId?: string | null;
  /** Optional human-readable note appended to the audit row. */
  note?: string;
}

function oneStepDown(level: AutonomyLevel): AutonomyLevel | null {
  if (level === "autopilot") return "policy";
  if (level === "policy") return "gated";
  return null;
}

/**
 * Demote an agent one tier on a non-budget incident. Returns
 * `demoted: false` (with a `reason`) when no mutation was needed.
 *
 * Fire-and-forget at the call site — this function swallows internal
 * errors to a logger.warn so the calling activity emit can't be
 * rolled back by a downstream demotion failure.
 */
export async function observeIncidentForDemotion(
  db: Db,
  obs: IncidentObservation,
): Promise<{
  demoted: boolean;
  previousLevel?: AutonomyLevel;
  currentLevel?: AutonomyLevel;
  reason?: string;
}> {
  try {
    const row = await db
      .select({
        id: agents.id,
        role: agents.role,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.id, obs.agentId))
      .then((rows) => rows[0] ?? null);
    if (!row) return { demoted: false, reason: "agent-not-found" };

    const currentLevel = effectiveAutonomyLevel(row.permissions, row.role);
    const targetLevel = oneStepDown(currentLevel);
    if (!targetLevel) {
      return {
        demoted: false,
        previousLevel: currentLevel,
        currentLevel,
        reason: "already-at-floor",
      };
    }
    if (AUTONOMY_LEVEL_RANK[currentLevel] <= AUTONOMY_LEVEL_RANK[targetLevel]) {
      return {
        demoted: false,
        previousLevel: currentLevel,
        currentLevel,
        reason: "already-below-target",
      };
    }

    const sm = autonomyStateMachine(db);
    const result = await sm.demote({
      agentId: obs.agentId,
      targetLevel,
      reason: obs.reason,
      actor: {
        actorType: "system",
        actorId: "incident-demotion-observer",
      },
      note:
        obs.note ??
        `auto-demote from ${currentLevel} → ${targetLevel} on ${obs.reason}${obs.runId ? ` (run ${obs.runId})` : ""}`,
    });
    return {
      demoted: result.currentLevel !== result.previousLevel,
      previousLevel: result.previousLevel,
      currentLevel: result.currentLevel,
    };
  } catch (err) {
    logger.warn(
      { err, agentId: obs.agentId, reason: obs.reason },
      "incident-demotion-observer: demote failed",
    );
    return { demoted: false, reason: "demote-error" };
  }
}
