/**
 * Allowlist matcher (NEW 3 V1, -tne delta).
 *
 * Compiles picomatch patterns once per run-spawn and returns a cheap
 * boolean matcher that the adapter context carries into the agent's
 * execution. Per the CEO plan §P2 perf observation, per-call compile is
 * 10-100µs; at 1000 tool calls per run that's 10-100ms wasted. One
 * compile per spawn, thousands of calls per spawn — net win.
 *
 * V1 scope (per Blocker Resolution):
 * - ADVISORY at openclaw side. Matcher result is surfaced to the board
 *   and used at approval-creation time to decide whether to auto-approve
 *   a run (policy-level) or queue an `allowlist.exception` (violations).
 * - Runtime mid-call reject-tool-call hook is V1.1.
 *
 * Semantics (matches CEO plan §4.2):
 * - `gated`: envelope must be explicit (no wildcards). Empty envelope is
 *   rejected by the validator. Matcher returns `denied` for anything
 *   that isn't in the explicit list.
 * - `policy`: wildcards permitted. Matches inside envelope → `allowed`;
 *   outside → `escalate` (queue an approval).
 * - `autopilot`: wildcards + deniedPaths. Explicit deny always wins
 *   over allow. Violations are `warn` unless repeats surface.
 *
 * TODO(NEW 3 V1.1): wire an openclaw-side reject hook that consults this
 * matcher for mid-run tool calls. Currently the matcher is consumed only
 * at spawn time / approval-creation time.
 */
import picomatch from "picomatch";
import type { AllowlistEnvelope, AutonomyLevel } from "@paperclipai/shared";

export type AllowlistMatchResult =
  | { kind: "allowed" }
  | { kind: "denied"; reason: "not-in-allowlist" | "explicit-deny" }
  | { kind: "escalate"; reason: "out-of-envelope" };

/**
 * Compiled matcher returned once per run-spawn. Call `matchTool` /
 * `matchPath` per invocation; picomatch compile cost amortizes across
 * the whole run.
 */
export interface CompiledAllowlistMatcher {
  level: AutonomyLevel;
  matchTool: (tool: string) => AllowlistMatchResult;
  matchPath: (path: string) => AllowlistMatchResult;
  /** Used by callers that need to inspect the raw envelope for audit. */
  envelope: AllowlistEnvelope;
}

function compilePatterns(patterns: string[] | undefined): ((input: string) => boolean) | null {
  if (!patterns || patterns.length === 0) return null;
  // picomatch returns a matcher function; we pass an array so a single
  // input is tested against the union of patterns.
  return picomatch(patterns, { dot: true });
}

/**
 * Compile the per-spawn matcher. Call once per run-spawn.
 *
 * @param level  Agent's effective autonomy level at spawn time (after
 *               intersecting with company floor).
 * @param envelope The effective envelope — agent-level envelope composed
 *               with role defaults and any company-floor envelope. Composing
 *               happens upstream of this call.
 */
export function compileAllowlistMatcher(
  level: AutonomyLevel,
  envelope: AllowlistEnvelope,
): CompiledAllowlistMatcher {
  const allowTools = compilePatterns(envelope.allowedTools);
  const denyTools = compilePatterns(envelope.deniedTools);
  const allowPaths = compilePatterns(envelope.allowedPaths);
  const denyPaths = compilePatterns(envelope.deniedPaths);

  const isEmptyEnvelope =
    (envelope.allowedTools?.length ?? 0) === 0 &&
    (envelope.allowedPaths?.length ?? 0) === 0 &&
    (envelope.deniedTools?.length ?? 0) === 0 &&
    (envelope.deniedPaths?.length ?? 0) === 0;

  function evaluate(
    input: string,
    allow: ((input: string) => boolean) | null,
    deny: ((input: string) => boolean) | null,
  ): AllowlistMatchResult {
    // Explicit deny always wins over allow (plan §4.1).
    if (deny && deny(input)) return { kind: "denied", reason: "explicit-deny" };

    // Empty envelope: per plan §4.2 composition rule —
    // a policy-level agent with an empty envelope is effectively gated;
    // at autopilot, empty envelope means "trust role defaults", but since
    // composition happens upstream, if this matcher is called with an
    // empty envelope we treat all as escalate (policy) or allowed (autopilot).
    if (isEmptyEnvelope) {
      if (level === "autopilot") return { kind: "allowed" };
      if (level === "policy") return { kind: "escalate", reason: "out-of-envelope" };
      // gated: reject. Validator should have already blocked this at edge.
      return { kind: "denied", reason: "not-in-allowlist" };
    }

    if (allow && allow(input)) return { kind: "allowed" };

    // Not explicitly allowed:
    // - gated → denied (must be in envelope)
    // - policy → escalate (queue an allowlist.exception approval)
    // - autopilot → allowed (wildcards trusted; deniedPaths handles the
    //   explicit "don't touch this" case already evaluated above)
    if (level === "gated") return { kind: "denied", reason: "not-in-allowlist" };
    if (level === "policy") return { kind: "escalate", reason: "out-of-envelope" };
    return { kind: "allowed" };
  }

  return {
    level,
    envelope,
    matchTool: (tool: string) => evaluate(tool, allowTools, denyTools),
    matchPath: (path: string) => evaluate(path, allowPaths, denyPaths),
  };
}
