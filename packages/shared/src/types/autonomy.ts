/**
 * Graduated Autonomy shared types (NEW 3 V1, -tne delta).
 *
 * Three-level ladder (gated → policy → autopilot) + a structured allowlist
 * envelope carried per-agent inside `agents.permissions` jsonb. A per-company
 * floor caps the maximum reachable level and lives in the new
 * `companies.autonomy_policy` jsonb column introduced by migration 0058.
 *
 * V1 is advisory / pre-dispatch only: envelope is transported to the adapter
 * at run-spawn, surfaced to the board, and checked at approval-creation time.
 * Runtime mid-call enforcement is V1.1 (see CEO plan NEW 3 §Blocker Resolution).
 *
 * TODO(NEW 3 V1.1): runtime reject-tool-call hook consumer once openclaw
 * gateway grows the primitive.
 * TODO(NEW 3 V1.1): kill-in-flight abort primitive beyond the Node AbortSignal
 * that NEW 0-B-1 already plumbs.
 */

export const AUTONOMY_LEVELS = ["gated", "policy", "autopilot"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Ordering helper — higher number = more autonomy. */
export const AUTONOMY_LEVEL_RANK: Record<AutonomyLevel, number> = {
  gated: 0,
  policy: 1,
  autopilot: 2,
};

/**
 * Structured allowlist envelope carried per-agent in
 * `agents.permissions.allowlist`.
 *
 * At `gated`: `allowedTools`/`allowedPaths` must be explicit (no wildcards
 * accepted by the validator). At `policy`: wildcards permitted inside role
 * defaults; out-of-envelope runs queue an `allowlist.exception` approval.
 * At `autopilot`: wildcards + `deniedPaths` enforced; violations log-only
 * unless repeats trigger demotion.
 */
export interface AllowlistEnvelope {
  allowedTools?: string[];
  allowedPaths?: string[];
  deniedTools?: string[];
  deniedPaths?: string[];
  maxCostUSD?: number | null;
  maxRunMinutes?: number | null;
  networkAccess?: "none" | "localhost" | "full";
}

/**
 * Derived-from-activity-log accrual counters for promotion eligibility.
 * Not persisted directly; computed by {@link graduation-signals} service.
 */
export interface GraduationSignals {
  cleanRunCount: number;
  boardRejectCount: number;
  budgetBreachCount: number;
  toolRejectionRate: number;
  humanOverrideCount: number;
  /** ISO 8601 timestamp; null if no probation window has opened. */
  probationStart: string | null;
}

/**
 * Per-company autonomy floor. Stored in new `companies.autonomy_policy`
 * jsonb column. Missing or empty policy falls back to a compat-shim read
 * derived from the legacy `requireBoardApprovalForNewAgents` boolean:
 * `{ maxLevel: requireBoard ? 'gated' : 'policy' }`.
 */
export interface AutonomyPolicy {
  /** Caps maximum autonomy any agent in the company may reach. */
  maxLevel?: AutonomyLevel;
  /** Optional company-wide envelope floor intersected with per-agent envelope. */
  companyFloorAllowlist?: AllowlistEnvelope;
  /** Whether server surfaces periodic digest proposals for promotion. */
  promotionDigestEnabled?: boolean;
}

/**
 * Role defaults mapped from `agents.role` text. Static for V1 (per CEO
 * plan §3.3 — table-backed later). Used when an agent has no explicit
 * `permissions.autonomyLevel`.
 */
export const AUTONOMY_ROLE_DEFAULTS: Record<string, AutonomyLevel> = {
  ceo: "gated",
  general: "gated",
  engineer: "gated",
  researcher: "gated",
};

/**
 * Reasons recorded on a demotion audit row (written to
 * `activity_log.details.reason`).
 */
export const AUTONOMY_DEMOTION_REASONS = [
  "manual",
  "budget_breach",
  "allowlist_violation",
  "gate_failed",
  "adapter_timeout",
  "board_rejection",
] as const;
export type AutonomyDemotionReason = (typeof AUTONOMY_DEMOTION_REASONS)[number];

/**
 * New `activity_log.action` values introduced by NEW 3. NOT promoted to
 * `LIVE_EVENT_TYPES` — clients demultiplex via the existing `activity.logged`
 * channel (§11 of V1 scope).
 */
export const AUTONOMY_ACTIVITY_ACTIONS = [
  "autonomy.promoted",
  "autonomy.demoted",
  "autonomy.proposal.created",
  "autonomy.proposal.approved",
  "autonomy.proposal.invalidated",
  "allowlist.violated",
  "allowlist.exception.approved",
] as const;
export type AutonomyActivityAction = (typeof AUTONOMY_ACTIVITY_ACTIONS)[number];
