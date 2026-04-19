/**
 * Zod validators for graduated autonomy (NEW 3 V1, -tne delta).
 *
 * Reject invalid transitions (skip-step promotion is forbidden — demotion
 * always allowed), bad picomatch globs, and empty envelopes at the `gated`
 * level. These all sit behind the PATCH /api/agents/:id + PATCH
 * /api/companies/:id handlers and at the state-machine entry.
 */
import { z } from "zod";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_RANK,
  AUTONOMY_DEMOTION_REASONS,
  type AutonomyLevel,
} from "../types/autonomy.js";

/**
 * Lightweight glob precompile — catches malformed patterns at the edge so
 * the client gets a 422 instead of a runtime exception inside the matcher.
 * Kept in-file to avoid a compile-time picomatch dep inside the shared
 * package (picomatch is a server-side runtime dep in server/package.json).
 * We do string-level syntax checks only.
 */
function isProbablyValidGlob(pattern: string): boolean {
  if (pattern.length === 0) return false;
  // Unbalanced braces/brackets in the pattern — picomatch still tolerates
  // some of these but refuse obvious typos at the edge.
  let braces = 0;
  let brackets = 0;
  for (const ch of pattern) {
    if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
    if (braces < 0 || brackets < 0) return false;
  }
  return braces === 0 && brackets === 0;
}

const globPattern = z
  .string()
  .trim()
  .min(1, "glob pattern must not be empty")
  .refine(isProbablyValidGlob, { message: "invalid glob pattern" });

const toolName = z.string().trim().min(1);

export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);

export const autonomyDemotionReasonSchema = z.enum(AUTONOMY_DEMOTION_REASONS);

export const allowlistEnvelopeSchema = z
  .object({
    allowedTools: z.array(toolName).optional(),
    allowedPaths: z.array(globPattern).optional(),
    deniedTools: z.array(toolName).optional(),
    deniedPaths: z.array(globPattern).optional(),
    maxCostUSD: z.number().nonnegative().nullable().optional(),
    maxRunMinutes: z.number().nonnegative().nullable().optional(),
    networkAccess: z.enum(["none", "localhost", "full"]).optional(),
  })
  .strict();

export type AllowlistEnvelope = z.infer<typeof allowlistEnvelopeSchema>;

/**
 * Envelope tied to a target autonomy level. Rejects empty envelopes at
 * `gated` (the CEO plan calls this the "must be explicit" rule in §4.2).
 */
export function envelopeForLevelSchema(level: AutonomyLevel) {
  return allowlistEnvelopeSchema.superRefine((env, ctx) => {
    if (level !== "gated") return;
    const hasAllowedTools = Array.isArray(env.allowedTools) && env.allowedTools.length > 0;
    const hasAllowedPaths = Array.isArray(env.allowedPaths) && env.allowedPaths.length > 0;
    if (!hasAllowedTools && !hasAllowedPaths) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gated-level envelope must include explicit allowedTools or allowedPaths",
      });
    }
    // No wildcards at gated — must be explicit tool/path names.
    for (const [field, values] of [
      ["allowedTools", env.allowedTools ?? []],
      ["allowedPaths", env.allowedPaths ?? []],
    ] as const) {
      for (const value of values) {
        if (/[*?[\]{}]/.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "wildcards are not permitted at gated level",
          });
        }
      }
    }
  });
}

export const autonomyPolicySchema = z
  .object({
    maxLevel: autonomyLevelSchema.optional(),
    companyFloorAllowlist: allowlistEnvelopeSchema.optional(),
    promotionDigestEnabled: z.boolean().optional(),
  })
  .strict();

export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

/**
 * Validates a promotion step. Skipping levels (gated → autopilot) is
 * rejected. Same-level or demotion delegated to {@link isAutonomyDemotion}.
 */
export function isValidPromotionStep(from: AutonomyLevel, to: AutonomyLevel): boolean {
  const fromRank = AUTONOMY_LEVEL_RANK[from];
  const toRank = AUTONOMY_LEVEL_RANK[to];
  return toRank === fromRank + 1;
}

/** Demotion = monotonically lower rank. Same-level is NOT a demotion. */
export function isAutonomyDemotion(from: AutonomyLevel, to: AutonomyLevel): boolean {
  return AUTONOMY_LEVEL_RANK[to] < AUTONOMY_LEVEL_RANK[from];
}

/**
 * Schema for the per-agent autonomy patch body applied by PATCH /api/agents/:id
 * (top-level fields, mirroring the `updateAgentPermissions` split pattern).
 * Route handler interprets `autonomyLevel` as a promotion target when it's
 * higher than current, and as direct write when lower (demotion).
 */
export const agentAutonomyPatchSchema = z
  .object({
    autonomyLevel: autonomyLevelSchema.optional(),
    allowlist: allowlistEnvelopeSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type AgentAutonomyPatch = z.infer<typeof agentAutonomyPatchSchema>;

/**
 * Payload shape for approval rows of `type = 'autonomy.promotion'`. Mirrors
 * CEO plan §6.1 — `{ agentId, fromLevel, toLevel, signalsSnapshot }`.
 */
export const autonomyPromotionApprovalPayloadSchema = z.object({
  agentId: z.string().uuid(),
  fromLevel: autonomyLevelSchema,
  toLevel: autonomyLevelSchema,
  signalsSnapshot: z.record(z.unknown()).optional(),
  justification: z.string().max(1000).optional(),
});

export type AutonomyPromotionApprovalPayload = z.infer<typeof autonomyPromotionApprovalPayloadSchema>;

/**
 * Payload shape for approval rows of `type = 'allowlist.exception'`.
 */
export const allowlistExceptionApprovalPayloadSchema = z.object({
  agentId: z.string().uuid(),
  runId: z.string().uuid().optional().nullable(),
  attemptedTool: z.string().optional(),
  attemptedPath: z.string().optional(),
  envelopeSnapshot: allowlistEnvelopeSchema.optional(),
  justification: z.string().max(1000).optional(),
});

export type AllowlistExceptionApprovalPayload = z.infer<typeof allowlistExceptionApprovalPayloadSchema>;
