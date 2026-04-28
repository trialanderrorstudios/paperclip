/**
 * Trust-based promotion reconciler (NEW 3 V1.5, -tne delta).
 *
 * Walks active agents at heartbeat-tick cadence and, for each one, checks
 * whether their trust score + clean-streak crosses a configurable promotion
 * threshold for the next-tier-up. When eligible, enqueues an
 * `autonomy.promotion` approval — operator must approve, this NEVER auto-
 * promotes. Demotion is handled by sibling observers (`incident-demotion-
 * observer.ts`, `budget-demotion-observer.ts`, `heartbeat.demoteStaleHeartbeats`).
 *
 * Threshold defaults (overridable via env, read at call time so dev
 * environments can shorten without restart):
 * - gated → policy:    trustScore >= 90 AND cleanStreak >= 7 runs
 * - policy → autopilot: trustScore >= 95 AND cleanStreak >= 30 runs
 *
 * "cleanStreak" is run-count, not days — that's what `trustService` already
 * exports and "7 clean runs" is a stronger signal than "7 days that may
 * have had zero runs." Operators who want a calendar-day metric can read
 * the activity_log timeline on the agent detail surface.
 *
 * Cooldown: the state machine's `createSystemPromotionProposal` reuses the
 * same `AUTONOMY_PROMOTION_COOLDOWN_HOURS` window the agent-self path
 * uses (default 24h). So a single eligible agent triggers at most one
 * system proposal per day even though the reconciler ticks every ~30s.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { type AutonomyLevel, AUTONOMY_LEVEL_RANK } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import {
  autonomyStateMachine,
  AutonomyStateMachineError,
  capToCompanyFloor,
  effectiveAutonomyLevel,
  resolveCompanyMaxLevel,
} from "./autonomy-state-machine.js";
import { trustService } from "./trust.js";

const RECONCILER_ACTOR_ID = "promotion-reconciler";

interface PromotionThreshold {
  trustScore: number;
  cleanStreak: number;
}

interface ResolvedThresholds {
  /** gated → policy */
  tier1: PromotionThreshold;
  /** policy → autopilot */
  tier2: PromotionThreshold;
}

/**
 * Read thresholds from env at call time. Mirrors
 * `resolvePromotionCooldownHours()` pattern. Falls back to the
 * task-spec defaults on missing/invalid input.
 */
export function resolvePromotionThresholds(): ResolvedThresholds {
  const parseInt = (raw: string | undefined, fallback: number): number => {
    const v = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    tier1: {
      trustScore: parseInt(process.env.AUTONOMY_PROMOTION_TRUST_TIER1, 90),
      cleanStreak: parseInt(process.env.AUTONOMY_PROMOTION_STREAK_TIER1, 7),
    },
    tier2: {
      trustScore: parseInt(process.env.AUTONOMY_PROMOTION_TRUST_TIER2, 95),
      cleanStreak: parseInt(process.env.AUTONOMY_PROMOTION_STREAK_TIER2, 30),
    },
  };
}

function nextTierUp(level: AutonomyLevel): AutonomyLevel | null {
  if (level === "gated") return "policy";
  if (level === "policy") return "autopilot";
  return null;
}

function thresholdForTarget(
  target: AutonomyLevel,
  thresholds: ResolvedThresholds,
): PromotionThreshold | null {
  if (target === "policy") return thresholds.tier1;
  if (target === "autopilot") return thresholds.tier2;
  return null;
}

export interface PromotionReconcilerTickResult {
  checked: number;
  proposalsCreated: number;
  skipped: number;
}

/**
 * One reconciler pass. Wired into the heartbeat scheduler interval (see
 * `server/src/index.ts:setInterval(... heartbeatSchedulerIntervalMs)`).
 */
export async function runPromotionReconcilerTick(
  db: Db,
): Promise<PromotionReconcilerTickResult> {
  const thresholds = resolvePromotionThresholds();
  const sm = autonomyStateMachine(db);
  const trust = trustService(db);

  // Walk companies first so we can read their floor once per company.
  const companyRows = await db
    .select({
      id: companies.id,
      autonomyPolicy: companies.autonomyPolicy,
      requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    })
    .from(companies);

  let checked = 0;
  let proposalsCreated = 0;
  let skipped = 0;

  for (const company of companyRows) {
    const floor = resolveCompanyMaxLevel(
      company.autonomyPolicy ?? {},
      company.requireBoardApprovalForNewAgents ?? true,
    );
    const trustSnapshot = await trust.getCompanyTrust(company.id);
    const trustByAgent = new Map<string, { trustScore: number; cleanStreak: number }>();
    for (const a of trustSnapshot.agents) {
      trustByAgent.set(a.agentId, {
        trustScore: a.trustScore,
        cleanStreak: a.cleanStreak,
      });
    }

    const companyAgents = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        status: agents.status,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.companyId, company.id));

    for (const agent of companyAgents) {
      if (
        agent.status === "paused" ||
        agent.status === "terminated" ||
        agent.status === "pending_approval"
      ) {
        skipped += 1;
        continue;
      }

      const currentLevel = effectiveAutonomyLevel(agent.permissions, agent.role);
      const target = nextTierUp(currentLevel);
      if (!target) {
        // Already at autopilot; no further promotion possible.
        skipped += 1;
        continue;
      }

      // Company floor cap: don't propose promotions the floor would
      // reject anyway (the operator would see an unactionable approval).
      const cappedTarget = capToCompanyFloor(target, floor);
      if (AUTONOMY_LEVEL_RANK[cappedTarget] <= AUTONOMY_LEVEL_RANK[currentLevel]) {
        skipped += 1;
        continue;
      }

      const threshold = thresholdForTarget(target, thresholds);
      if (!threshold) {
        skipped += 1;
        continue;
      }

      const score = trustByAgent.get(agent.id);
      if (!score) {
        skipped += 1;
        continue;
      }

      checked += 1;

      if (
        score.trustScore < threshold.trustScore ||
        score.cleanStreak < threshold.cleanStreak
      ) {
        skipped += 1;
        continue;
      }

      try {
        const created = await sm.createSystemPromotionProposal({
          agentId: agent.id,
          companyId: agent.companyId,
          fromLevel: currentLevel,
          toLevel: target,
          actorId: RECONCILER_ACTOR_ID,
          signalsSnapshot: {
            trustScore: score.trustScore,
            cleanStreak: score.cleanStreak,
            threshold,
            evaluatedAt: new Date().toISOString(),
          },
        });
        if (created) proposalsCreated += 1;
        else skipped += 1; // cooldown blocked the proposal
      } catch (err) {
        if (err instanceof AutonomyStateMachineError) {
          // invalid_step / etc. — recoverable, keep going.
          skipped += 1;
          continue;
        }
        logger.warn(
          { err, agentId: agent.id, companyId: agent.companyId },
          "promotion-reconciler: createSystemPromotionProposal failed",
        );
        skipped += 1;
      }
    }
  }

  return { checked, proposalsCreated, skipped };
}
