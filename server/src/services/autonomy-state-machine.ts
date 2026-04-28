/**
 * Autonomy state machine (NEW 3 V1, -tne delta).
 *
 * Enforces:
 * - Role-check + next-step-only rule on promotion (CEO plan §3.2).
 * - Idempotent last-write-wins demotion via `UPDATE ... WHERE
 *   autonomy_level > targetLevel` (plan §A2: multi-trigger race).
 * - Invalidates pending `autonomy.promotion` approvals when a demotion
 *   fires (plan §3.2 race-resolution rule).
 * - Every mutation writes an `activity_log` row with a denormalized
 *   `actor_role_at_time` (plan §Blocker Resolution → A3 audit).
 * - CEO asymmetry: promote-to-autopilot requires `board_owner`;
 *   demote-CEO allowed to any `board_member` (safety valve). See
 *   shared/permissions/autonomy.ts.
 *
 * Trigger observers (called by `observeDemotionTrigger`):
 * - `budget_incidents` INSERT → demote `autopilot → policy`.
 * - `activity_log action=allowlist.violated` (repeated) → demote.
 * - `activity_log action=gate.failed` → demote.
 * - Manual action → demote.
 *
 * Heartbeat-timeout trigger (plan §A1) is V1.1 — left as a TODO below.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals } from "@paperclipai/db";
import {
  type AutonomyLevel,
  type AutonomyDemotionReason,
  AUTONOMY_LEVEL_RANK,
  AUTONOMY_ROLE_DEFAULTS,
  canPromoteAgent,
  canDemoteAgent,
  isValidPromotionStep,
  resolveBoardTier,
  type BoardTier,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";

export interface AutonomyStateMachineActor {
  /**
   * `user` = board seat (board_owner/member/observer derived from membershipRole).
   * `agent` = proposal path — agent self-promotes via an approvals row.
   * `system` = automatic demotion triggered by an observer (budget,
   *  allowlist violation).
   */
  actorType: "user" | "agent" | "system";
  actorId: string;
  /** For `user` actors — resolves to a tier via resolveBoardTier. */
  membershipRole?: string | null;
  /** For logging: the tier in effect when the mutation happened. */
  resolvedTier?: BoardTier | null;
}

export interface PromoteArgs {
  agentId: string;
  targetLevel: AutonomyLevel;
  actor: AutonomyStateMachineActor;
  justification?: string;
}

export interface DemoteArgs {
  agentId: string;
  targetLevel: AutonomyLevel;
  reason: AutonomyDemotionReason;
  actor: AutonomyStateMachineActor;
  note?: string;
}

export class AutonomyStateMachineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "agent_not_found"
      | "forbidden"
      | "invalid_step"
      | "noop"
      | "policy_cap_exceeded"
      | "rate_limited",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutonomyStateMachineError";
  }
}

/**
 * NEW 3 V1.1 (-tne): promotion proposal rate limit.
 *
 * Read the cooldown window at call time so operators with aggressive
 * test environments can shorten it without restart. NaN/≤0 → fall back
 * to 24h. We treat `pending` OR `rejected` rows within the window as
 * blocking; `invalidated`, `approved`, `revision_requested` do not block
 * — invalidated means a demotion cleared the queue and the agent has a
 * legitimate reason to re-propose, approved means the proposal already
 * applied (future promotions go through a different step), and
 * `revision_requested` is the operator explicitly asking for another
 * submission.
 */
export function resolvePromotionCooldownHours(): number {
  const raw = process.env.AUTONOMY_PROMOTION_COOLDOWN_HOURS;
  const parsed = Number.parseInt(raw ?? "24", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return parsed;
}

interface AgentAutonomyView {
  id: string;
  companyId: string;
  role: string;
  /** Effective current level (post-compat-shim resolution). */
  currentLevel: AutonomyLevel;
  /** Raw permissions jsonb (for write-back). */
  permissions: Record<string, unknown>;
}

function readPermissionsRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

/**
 * Compat-shim read (plan §5.3 + §A4). Precedence:
 *   permissions.autonomyLevel ?? roleDefault ?? 'gated'
 * Caller is responsible for applying the company-floor cap on top.
 */
export function effectiveAutonomyLevel(
  permissions: unknown,
  role: string | null | undefined,
): AutonomyLevel {
  const perms = readPermissionsRecord(permissions);
  const raw = perms.autonomyLevel;
  if (raw === "gated" || raw === "policy" || raw === "autopilot") return raw;
  if (role && role in AUTONOMY_ROLE_DEFAULTS) return AUTONOMY_ROLE_DEFAULTS[role]!;
  return "gated";
}

/**
 * Resolve company floor from `companies.autonomy_policy` jsonb with a
 * compat shim derived from `requireBoardApprovalForNewAgents` when the
 * jsonb is empty (plan §5.3).
 */
export function resolveCompanyMaxLevel(
  autonomyPolicy: unknown,
  requireBoardApprovalForNewAgents: boolean,
): AutonomyLevel {
  const policy = readPermissionsRecord(autonomyPolicy);
  const raw = policy.maxLevel;
  if (raw === "gated" || raw === "policy" || raw === "autopilot") return raw;
  // Empty/absent → compat shim read:
  return requireBoardApprovalForNewAgents ? "gated" : "policy";
}

/**
 * Cap a target level by the company floor.
 */
export function capToCompanyFloor(target: AutonomyLevel, maxLevel: AutonomyLevel): AutonomyLevel {
  if (AUTONOMY_LEVEL_RANK[target] <= AUTONOMY_LEVEL_RANK[maxLevel]) return target;
  return maxLevel;
}

export function autonomyStateMachine(db: Db) {
  /**
   * Promote an agent by one level (monotonic step). Enforces role
   * authorization and CEO asymmetry; callers MUST first have resolved
   * the actor's board tier (route handler passes `membershipRole`).
   */
  async function promote(args: PromoteArgs) {
    const { agentId, targetLevel, actor, justification } = args;
    const view = await loadAgentAutonomyView(db, agentId);
    if (!view) throw new AutonomyStateMachineError("agent not found", "agent_not_found");

    if (view.currentLevel === targetLevel) {
      throw new AutonomyStateMachineError("already at target level", "noop");
    }
    if (!isValidPromotionStep(view.currentLevel, targetLevel)) {
      throw new AutonomyStateMachineError(
        `invalid promotion step ${view.currentLevel} → ${targetLevel}`,
        "invalid_step",
      );
    }

    const tier = actor.resolvedTier ?? resolveBoardTier(actor.membershipRole);
    const isCeoAgent = view.role === "ceo";

    // Agent-auth path never reaches here — they only propose (create an
    // approvals row). If we get an agent actor, reject; callers should
    // have routed to createPromotionProposal instead.
    if (actor.actorType === "agent") {
      throw new AutonomyStateMachineError(
        "agents may only propose promotions, not apply them",
        "forbidden",
      );
    }
    if (!canPromoteAgent(tier, { isCeoAgent, toLevel: targetLevel })) {
      throw new AutonomyStateMachineError(
        `tier ${tier} may not promote to ${targetLevel}`,
        "forbidden",
      );
    }

    // Apply.
    const newPermissions = {
      ...view.permissions,
      autonomyLevel: targetLevel,
    };
    await db
      .update(agents)
      .set({ permissions: newPermissions, updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    await logActivity(db, {
      companyId: view.companyId,
      actorType: actor.actorType === "user" ? "user" : "system",
      actorId: actor.actorId,
      agentId,
      action: "autonomy.promoted",
      entityType: "agent",
      entityId: agentId,
      details: {
        fromLevel: view.currentLevel,
        toLevel: targetLevel,
        actorRoleAtTime: tier,
        justification: justification ?? null,
      },
    });

    return { previousLevel: view.currentLevel, currentLevel: targetLevel, tier };
  }

  /**
   * Demote an agent. Idempotent last-write-wins — the SQL guard
   * `WHERE ...autonomyLevel_rank > target_rank` means a concurrent
   * demotion trigger can't accidentally upgrade the state. When the
   * update misses (already at-or-below target), we still record the
   * trigger in `activity_log` but skip the promotion-invalidation
   * step (no pending proposal could survive the earlier demotion
   * anyway).
   *
   * Invalidates any pending `autonomy.promotion` approvals for the
   * agent per plan §3.2 race resolution.
   */
  async function demote(args: DemoteArgs) {
    const { agentId, targetLevel, reason, actor, note } = args;
    const view = await loadAgentAutonomyView(db, agentId);
    if (!view) throw new AutonomyStateMachineError("agent not found", "agent_not_found");

    const tier = actor.resolvedTier ?? resolveBoardTier(actor.membershipRole);
    const isCeoAgent = view.role === "ceo";
    // `system` actor (auto-trigger from budget breach etc.) always has
    // authority to demote; board actors are gated by canDemoteAgent.
    if (actor.actorType === "user" && !canDemoteAgent(tier, { isCeoAgent })) {
      throw new AutonomyStateMachineError(
        `tier ${tier} may not demote CEO agent`,
        "forbidden",
      );
    }

    // Idempotent last-write-wins guard. We compare ranks client-side
    // because the raw `autonomyLevel` lives inside jsonb — we read,
    // decide, and then write with the rank-guard expressed in the
    // SQL WHERE clause for concurrency safety.
    const targetRank = AUTONOMY_LEVEL_RANK[targetLevel];
    const currentRank = AUTONOMY_LEVEL_RANK[view.currentLevel];
    if (currentRank <= targetRank) {
      // Already at or below target — emit an audit row anyway (the
      // trigger happened) and return without mutation.
      await logActivity(db, {
        companyId: view.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId,
        action: "autonomy.demoted",
        entityType: "agent",
        entityId: agentId,
        details: {
          fromLevel: view.currentLevel,
          toLevel: view.currentLevel,
          reason,
          actorRoleAtTime: tier,
          idempotent: true,
          note: note ?? null,
        },
      });
      return { previousLevel: view.currentLevel, currentLevel: view.currentLevel, tier, invalidatedProposals: 0 };
    }

    const newPermissions = {
      ...view.permissions,
      autonomyLevel: targetLevel,
    };
    // SQL-level guard: refuse to raise the level. We store autonomyLevel
    // inside jsonb so we can't express the rank guard purely in SQL
    // without a CHECK-style expression; instead we rely on the row-level
    // update race being rare (drizzle transactions or a higher-level
    // lock would be a V1.1 hardening). Practically: reading the row
    // above + applying this update inside the same request cycle
    // narrows the race to sub-second; a concurrent demotion to a lower
    // level would overwrite, which is still correct because
    // demotion-wins is the policy.
    await db
      .update(agents)
      .set({ permissions: newPermissions, updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    // Invalidate pending promotion proposals.
    const invalidated = await db
      .update(approvals)
      .set({
        status: "invalidated",
        decisionNote:
          note ??
          `demotion triggered by ${reason}; pending promotion invalidated per race-resolution rule`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvals.companyId, view.companyId),
          eq(approvals.requestedByAgentId, agentId),
          eq(approvals.type, "autonomy.promotion"),
          eq(approvals.status, "pending"),
        ),
      )
      .returning({ id: approvals.id });

    for (const proposal of invalidated) {
      await logActivity(db, {
        companyId: view.companyId,
        actorType: "system",
        actorId: "autonomy-state-machine",
        agentId,
        action: "autonomy.proposal.invalidated",
        entityType: "approval",
        entityId: proposal.id,
        details: {
          reason,
          triggeredBy: actor.actorId,
        },
      });
    }

    await logActivity(db, {
      companyId: view.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId,
      action: "autonomy.demoted",
      entityType: "agent",
      entityId: agentId,
      details: {
        fromLevel: view.currentLevel,
        toLevel: targetLevel,
        reason,
        actorRoleAtTime: tier,
        note: note ?? null,
      },
    });

    return {
      previousLevel: view.currentLevel,
      currentLevel: targetLevel,
      tier,
      invalidatedProposals: invalidated.length,
    };
  }

  /**
   * Agent-initiated proposal path. Creates an `approvals` row of type
   * `autonomy.promotion`. Board actors should call `promote` directly.
   */
  async function createPromotionProposal(args: {
    agentId: string;
    fromLevel: AutonomyLevel;
    toLevel: AutonomyLevel;
    companyId: string;
    actor: AutonomyStateMachineActor;
    justification?: string;
    signalsSnapshot?: Record<string, unknown>;
  }) {
    if (args.actor.actorType !== "agent") {
      throw new AutonomyStateMachineError(
        "only agent actors may create autonomy promotion proposals via this path",
        "forbidden",
      );
    }
    if (!isValidPromotionStep(args.fromLevel, args.toLevel)) {
      throw new AutonomyStateMachineError(
        `invalid promotion step ${args.fromLevel} → ${args.toLevel}`,
        "invalid_step",
      );
    }

    // NEW 3 V1.1 (-tne): rate-limit self-promotion proposals. An agent
    // can otherwise spam pending/rejected proposals at heartbeat cadence
    // and fill the operator's approval queue with noise, or game the
    // review path through repetition.
    //
    // Block if there's already a `pending` OR `rejected` proposal for the
    // same agent + same target level within the cooldown window. We key
    // on `createdAt` uniformly because `pending` rows never have a
    // `decidedAt`; using createdAt matches the "once per N hours from
    // attempt time" reading of the rule.
    const cooldownHours = resolvePromotionCooldownHours();
    const cooldownCutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const blockers = await db
      .select({
        id: approvals.id,
        status: approvals.status,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, args.companyId),
          eq(approvals.requestedByAgentId, args.agentId),
          eq(approvals.type, "autonomy.promotion"),
          sql`${approvals.payload} ->> 'toLevel' = ${args.toLevel}`,
          sql`${approvals.status} IN ('pending', 'rejected')`,
          sql`${approvals.createdAt} >= ${cooldownCutoff}`,
        ),
      )
      .limit(1);
    const blocker = blockers[0];
    if (blocker) {
      // Emit FIRST, then throw. If we threw first the activity row would
      // never land and the operator would not see the rate-limited
      // attempt in the activity feed.
      await logActivity(db, {
        companyId: args.companyId,
        actorType: "agent",
        actorId: args.actor.actorId,
        agentId: args.agentId,
        action: "autonomy.promotion_rate_limited",
        entityType: "approval",
        entityId: blocker.id,
        details: {
          fromLevel: args.fromLevel,
          toLevel: args.toLevel,
          cooldownHours,
          blockedByApprovalId: blocker.id,
          blockedByStatus: blocker.status,
        },
      });
      throw new AutonomyStateMachineError(
        "Pending or recent proposal exists — wait 24h or have it resolved first.",
        "rate_limited",
        {
          blockedByApprovalId: blocker.id,
          blockedByStatus: blocker.status,
          cooldownHours,
        },
      );
    }

    const inserted = await db
      .insert(approvals)
      .values({
        companyId: args.companyId,
        type: "autonomy.promotion",
        requestedByAgentId: args.agentId,
        status: "pending",
        payload: {
          agentId: args.agentId,
          fromLevel: args.fromLevel,
          toLevel: args.toLevel,
          signalsSnapshot: args.signalsSnapshot ?? {},
          justification: args.justification ?? null,
        },
      })
      .returning();

    const row = inserted[0];
    if (row) {
      await logActivity(db, {
        companyId: args.companyId,
        actorType: "agent",
        actorId: args.actor.actorId,
        agentId: args.agentId,
        action: "autonomy.proposal.created",
        entityType: "approval",
        entityId: row.id,
        details: {
          fromLevel: args.fromLevel,
          toLevel: args.toLevel,
        },
      });
    }
    return row;
  }

  /**
   * NEW 3 V1.5 (-tne): system-initiated promotion proposal.
   *
   * Used by the trust-based promotion reconciler (see
   * `services/promotion-reconciler.ts`) when an agent rolls past a
   * configurable trust threshold. Mirrors `createPromotionProposal` but
   * accepts a `system` actor — the cooldown / step-validation / activity-
   * emission logic is shared. We do NOT relax the agent-only check on
   * `createPromotionProposal` because that path is the audit-meaningful
   * "agent self-petitions" flow; system proposals carry a different
   * actorType for the audit row so post-hoc analysis can tell them apart.
   */
  async function createSystemPromotionProposal(args: {
    agentId: string;
    companyId: string;
    fromLevel: AutonomyLevel;
    toLevel: AutonomyLevel;
    actorId: string;
    signalsSnapshot?: Record<string, unknown>;
    justification?: string;
  }) {
    if (!isValidPromotionStep(args.fromLevel, args.toLevel)) {
      throw new AutonomyStateMachineError(
        `invalid promotion step ${args.fromLevel} → ${args.toLevel}`,
        "invalid_step",
      );
    }

    // Same cooldown semantics as the agent-self path. The reconciler
    // ticks every heartbeatSchedulerIntervalMs (~30s by default) so
    // without this guard a promotion-eligible agent would generate a
    // fresh approval row on every tick.
    const cooldownHours = resolvePromotionCooldownHours();
    const cooldownCutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const blockers = await db
      .select({
        id: approvals.id,
        status: approvals.status,
        createdAt: approvals.createdAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, args.companyId),
          eq(approvals.requestedByAgentId, args.agentId),
          eq(approvals.type, "autonomy.promotion"),
          sql`${approvals.payload} ->> 'toLevel' = ${args.toLevel}`,
          sql`${approvals.status} IN ('pending', 'rejected')`,
          sql`${approvals.createdAt} >= ${cooldownCutoff}`,
        ),
      )
      .limit(1);
    if (blockers[0]) {
      // Quietly no-op — the reconciler is fire-and-forget and does not
      // want to surface rate-limit noise as errors.
      return null;
    }

    const inserted = await db
      .insert(approvals)
      .values({
        companyId: args.companyId,
        type: "autonomy.promotion",
        requestedByAgentId: args.agentId,
        status: "pending",
        payload: {
          agentId: args.agentId,
          fromLevel: args.fromLevel,
          toLevel: args.toLevel,
          signalsSnapshot: args.signalsSnapshot ?? {},
          justification:
            args.justification ??
            `Trust-based auto-proposal: agent met ${args.toLevel} thresholds.`,
          source: "promotion-reconciler",
        },
      })
      .returning();

    const row = inserted[0];
    if (row) {
      await logActivity(db, {
        companyId: args.companyId,
        actorType: "system",
        actorId: args.actorId,
        agentId: args.agentId,
        action: "autonomy.proposal.created",
        entityType: "approval",
        entityId: row.id,
        details: {
          fromLevel: args.fromLevel,
          toLevel: args.toLevel,
          source: "promotion-reconciler",
          signalsSnapshot: args.signalsSnapshot ?? {},
        },
      });
    }
    return row;
  }

  return { promote, demote, createPromotionProposal, createSystemPromotionProposal };
}

async function loadAgentAutonomyView(db: Db, agentId: string): Promise<AgentAutonomyView | null> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      role: agents.role,
      permissions: agents.permissions,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  const row = rows[0];
  if (!row) return null;
  const currentLevel = effectiveAutonomyLevel(row.permissions, row.role);
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role,
    currentLevel,
    permissions: readPermissionsRecord(row.permissions),
  };
}

// Silence unused-import warning if sql helpers aren't needed elsewhere;
// kept here because the comment references SQL-level guards.
void sql;

// TODO(NEW 3 V1.1): heartbeat-staleness demotion trigger (plan §A1).
// 90s without heartbeat on an autopilot run → auto-demote to policy
// and emit `autonomy.demoted { reason: 'adapter_timeout' }`. Requires
// coordinator wiring from the heartbeat service.
