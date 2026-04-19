/**
 * Autonomy permission matrix (NEW 3 V1, -tne delta).
 *
 * Spec: CEO plan NEW 3 §Blocker Resolution → A3 — Permission model.
 *
 * Upstream Paperclip has no `board_owner` / `board_member` / `board_observer`
 * roles — those are the conceptual tiers the blocker-resolution doc calls for.
 * We map them onto the existing `companyMemberships.membershipRole` enum
 * (`COMPANY_MEMBERSHIP_ROLES = ["owner", "admin", "operator", "viewer",
 * "member"]`) without expanding the enum (expansion has a much larger blast
 * radius).
 *
 * Mapping:
 * - `board_owner`    → `owner`
 * - `board_member`   → `admin`   (has write authority, not full owner)
 * - `board_observer` → `viewer` | `operator` | `member` (everything else)
 *
 * All checks are pure functions so they can be unit-tested and used both
 * inside PATCH route handlers and at the state machine entry point (where
 * CEO asymmetry is enforced — see `canPromoteAgent`).
 *
 * TODO(NEW 3 V1.1): when we extend `companyMemberships.membershipRole` with
 * board-specific tiers upstream, collapse the mapping below.
 */
import type { CompanyMembershipRole } from "../constants.js";
import type { AutonomyLevel } from "../types/autonomy.js";

/**
 * Internal canonical tier. Not persisted — derived from membershipRole at
 * check time.
 */
export type BoardTier = "board_owner" | "board_member" | "board_observer";

/** Action family for autonomy mutations. Used in audit-log details and future */
/** capability grants (not wired into `PERMISSION_KEYS` upstream enum yet). */
export const AUTONOMY_ACTIONS = [
  "autonomy.demote",
  "autonomy.promote",
  "autonomy.setFloor",
  "autonomy.editAllowlist",
  "autonomy.propose", // agent-initiated proposal — distinct from approve
] as const;
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number];

/**
 * Map the upstream `companyMemberships.membershipRole` value to our board
 * tier. Active-status check is done by the caller (handler/route) — this
 * function is purely about role → tier translation.
 */
export function resolveBoardTier(role: CompanyMembershipRole | string | null | undefined): BoardTier {
  if (role === "owner") return "board_owner";
  if (role === "admin") return "board_member";
  // operator / viewer / member → observer (no direct write authority on
  // autonomy; they can propose via agents, not mutate directly).
  return "board_observer";
}

/**
 * Whether the given tier may perform the given autonomy action on a
 * non-CEO agent. CEO-specific rules live in {@link canPromoteAgent} /
 * {@link canDemoteAgent}.
 */
export function canPerformAutonomyAction(tier: BoardTier, action: AutonomyAction): boolean {
  switch (tier) {
    case "board_owner":
      return true;
    case "board_member":
      // Every action except company-floor management.
      return action !== "autonomy.setFloor";
    case "board_observer":
      return false;
    default:
      return false;
  }
}

/**
 * Promotion authorization. CEO-specific asymmetry per Blocker Resolution:
 * promoting the CEO to autopilot (the riskiest level) requires board_owner.
 * Any board_member may promote any non-CEO agent.
 */
export function canPromoteAgent(
  tier: BoardTier,
  opts: { isCeoAgent: boolean; toLevel: AutonomyLevel },
): boolean {
  if (tier === "board_observer") return false;
  if (opts.isCeoAgent && opts.toLevel === "autopilot") {
    return tier === "board_owner";
  }
  return canPerformAutonomyAction(tier, "autonomy.promote");
}

/**
 * Demotion authorization. CEO asymmetry per Blocker Resolution: demotion
 * of the CEO (even to `gated`) can be done by any board_member as a
 * safety valve. "More than one person can hit the brakes; only the owner
 * can remove the brakes."
 */
export function canDemoteAgent(tier: BoardTier, opts: { isCeoAgent: boolean }): boolean {
  if (tier === "board_observer") return false;
  // CEO demotion — explicitly allowed to any board_member (safety valve).
  if (opts.isCeoAgent) return tier === "board_owner" || tier === "board_member";
  return canPerformAutonomyAction(tier, "autonomy.demote");
}

/** Edit allowlist: board_owner on any agent, board_member on non-CEO only. */
export function canEditAllowlist(tier: BoardTier, opts: { isCeoAgent: boolean }): boolean {
  if (tier === "board_observer") return false;
  if (opts.isCeoAgent) return tier === "board_owner";
  return canPerformAutonomyAction(tier, "autonomy.editAllowlist");
}

/** Company-floor management: owner-only. */
export function canSetCompanyFloor(tier: BoardTier): boolean {
  return tier === "board_owner";
}

/**
 * Agent self-proposal is always allowed for the agent itself — it writes
 * an `approvals` row of type `autonomy.promotion`, which still requires
 * board approval. Other agents (e.g. a CEO agent trying to promote a
 * subordinate) are NOT authorized; only the subject agent can propose
 * itself.
 */
export function canAgentProposeOwnPromotion(opts: { actorAgentId: string; targetAgentId: string }): boolean {
  return opts.actorAgentId === opts.targetAgentId;
}
