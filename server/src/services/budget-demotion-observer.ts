/**
 * Budget-incident → autonomy-demotion observer (NEW 3 V1, -tne delta).
 *
 * Plan §3.2 auto-trigger: a budget breach (existing `budget_incidents`
 * INSERT) should auto-demote an agent at `autopilot` or `policy` one
 * level down (autopilot → policy, policy → gated).
 *
 * V1 scope:
 * - scopeType='agent' → direct demotion of that agent.
 * - scopeType='company' | 'project' → V1.1 TODO. Fan-out requires
 *   enumerating autopilot/policy agents scoped to the company or project
 *   and demoting each. Left out to keep Gap 4 atomic and to avoid
 *   accidentally demoting the whole company on a single cost event.
 *
 * Idempotent: callers are safe to re-fire. `sm.demote()` uses a rank
 * guard and emits an audit row even when the mutation is a no-op, so
 * observing the same incident twice produces at most two audit rows
 * and exactly one level change.
 *
 * Post-transaction: the caller invokes this AFTER the budgetIncidents
 * INSERT resolves. A slow or failing demotion MUST NOT roll back the
 * incident record. This is wired as fire-and-forget on the budget-
 * service side; errors are logged but swallowed.
 *
 * TODO(NEW 3 V1.1): fan-out for company/project scope.
 * TODO(NEW 3 V1.1): heartbeat-staleness demotion trigger (plan §A1).
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  AUTONOMY_LEVEL_RANK,
  type AutonomyLevel,
} from "@paperclipai/shared";
import {
  autonomyStateMachine,
  effectiveAutonomyLevel,
} from "./autonomy-state-machine.js";

export interface BudgetIncidentObservation {
  incidentId: string;
  companyId: string;
  scopeType: string;
  scopeId: string;
  thresholdType: "soft" | "hard";
}

/**
 * Compute the one-step demotion target. Returns null when the agent is
 * already at the bottom (gated) — idempotent; re-firing is a no-op.
 */
function oneStepDown(level: AutonomyLevel): AutonomyLevel | null {
  if (level === "autopilot") return "policy";
  if (level === "policy") return "gated";
  return null;
}

/**
 * Observe a freshly-inserted `budget_incidents` row and demote the
 * affected agent one level if it's currently at `autopilot` or `policy`.
 * Safe to call after the incident INSERT resolves; not inside the
 * incident transaction.
 */
export async function observeBudgetIncidentForDemotion(
  db: Db,
  obs: BudgetIncidentObservation,
): Promise<{ demoted: boolean; previousLevel?: AutonomyLevel; currentLevel?: AutonomyLevel; reason?: string }> {
  if (obs.scopeType !== "agent") {
    // V1: only agent-scoped incidents drive direct demotion. Company/
    // project-scoped fan-out is V1.1.
    return { demoted: false, reason: "non-agent-scope" };
  }

  const row = await db
    .select({
      id: agents.id,
      role: agents.role,
      permissions: agents.permissions,
    })
    .from(agents)
    .where(eq(agents.id, obs.scopeId))
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

  // Rank guard: don't demote if already at or below target — this
  // mirrors the state machine's own idempotent rule, but the extra
  // early return here saves a round trip on the hot path.
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
    agentId: obs.scopeId,
    targetLevel,
    reason: "budget_breach",
    actor: {
      actorType: "system",
      actorId: "budget-incident-observer",
    },
    note: `auto-demote from ${currentLevel} → ${targetLevel} on budget incident ${obs.incidentId}`,
  });
  return {
    demoted: result.currentLevel !== result.previousLevel,
    previousLevel: result.previousLevel,
    currentLevel: result.currentLevel,
  };
}
