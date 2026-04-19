/**
 * Allowlist envelope check helper (NEW 3 V1, -tne delta).
 *
 * Thin wrapper over {@link compileAllowlistMatcher} that takes a declared
 * surface (lists of tools + paths) and aggregates the per-input match
 * results into a single ALLOW / ESCALATE / DENY verdict. Used at
 * approval-creation time (Gap 2) so the pre-dispatch enforcement surface
 * is expressed as a single call instead of an ad-hoc loop at each caller.
 *
 * Why not reshape the matcher itself:
 * - `compileAllowlistMatcher` is compile-once-per-spawn on the runtime
 *   hot path (see allowlist-matcher.ts §P2 perf observation). Keep its
 *   surface per-input so the eventual V1.1 reject-tool-call hook can
 *   consume it unchanged.
 * - This helper is explicitly the APPROVAL-TIME aggregation surface.
 *
 * Aggregation rule:
 * 1. Any DENIED tool/path → DENY (at autopilot this is the explicit-deny
 *    branch; at gated/policy this flags out-of-envelope, treated as
 *    blocking).
 * 2. Otherwise any ESCALATE tool/path → ESCALATE (auto-approve blocked,
 *    queue an allowlist.exception approval).
 * 3. Otherwise → ALLOW.
 */
import {
  compileAllowlistMatcher,
  type AllowlistMatchResult,
} from "./allowlist-matcher.js";
import type {
  AllowlistEnvelope,
  AutonomyLevel,
} from "@paperclipai/shared";

export type EnvelopeCheckVerdict =
  | { kind: "allow" }
  | {
      kind: "escalate";
      reason: "out-of-envelope";
      violations: EnvelopeViolation[];
    }
  | {
      kind: "deny";
      reason: "explicit-deny" | "not-in-allowlist";
      violations: EnvelopeViolation[];
    };

export interface EnvelopeViolation {
  kind: "tool" | "path";
  value: string;
  result: AllowlistMatchResult;
}

export interface CheckEnvelopeArgs {
  level: AutonomyLevel;
  envelope: AllowlistEnvelope;
  declaredTools?: string[];
  declaredPaths?: string[];
}

/**
 * Check a declared surface against an envelope at a given autonomy
 * level. Returns a single aggregated verdict.
 *
 * Callers typically branch on the verdict:
 * - `allow` → auto-approve the approval row (policy/autopilot) or
 *   continue to board review (gated).
 * - `escalate` → create an `allowlist.exception` approval with status
 *   `pending`, attach the violations list to the payload.
 * - `deny` → immediate reject + emit `allowlist.violated` activity
 *   row; optionally trigger observer for demotion on repeat.
 */
export function checkDeclaredSurfaceAgainstEnvelope(
  args: CheckEnvelopeArgs,
): EnvelopeCheckVerdict {
  const matcher = compileAllowlistMatcher(args.level, args.envelope);
  const violations: EnvelopeViolation[] = [];

  const tools = args.declaredTools ?? [];
  for (const tool of tools) {
    const result = matcher.matchTool(tool);
    if (result.kind !== "allowed") {
      violations.push({ kind: "tool", value: tool, result });
    }
  }
  const paths = args.declaredPaths ?? [];
  for (const p of paths) {
    const result = matcher.matchPath(p);
    if (result.kind !== "allowed") {
      violations.push({ kind: "path", value: p, result });
    }
  }

  if (violations.length === 0) return { kind: "allow" };

  // Hard deny wins over escalate. Mirrors plan §4.2 ("explicit deny
  // always wins over allow").
  const denied = violations.filter((v) => v.result.kind === "denied");
  if (denied.length > 0) {
    // Pick the reason from the first denied violation — both are blocking.
    const first = denied[0]!.result as Extract<
      AllowlistMatchResult,
      { kind: "denied" }
    >;
    return { kind: "deny", reason: first.reason, violations };
  }
  return { kind: "escalate", reason: "out-of-envelope", violations };
}
