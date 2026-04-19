/**
 * Adapter execution scope builder (NEW 3 V1, -tne delta).
 *
 * Consumes the NEW 0-B-2 structured scope field on
 * `AdapterExecutionContext.scope` (see
 * `packages/adapter-utils/src/types.ts`). Every adapter spawn now carries
 * the agent's allowlist envelope into the adapter context instead of
 * string-parsing a freeform payloadTemplate.
 *
 * Enforcement is PRE-DISPATCH per the Blocker Resolution scope in
 * `ceo-plans/new-3-graduated-autonomy-2026-04-19.md` §Blocker Resolution:
 * - gated + empty envelope → spawn rejected (hard stop)
 * - policy + empty envelope → locked-down, everything escalates
 * - autopilot + empty envelope → role defaults (pass-through)
 *
 * Runtime mid-call enforcement is V1.1 and lives at the openclaw gateway
 * side (reject-tool-call hook); see TODOs in allowlist-matcher.ts.
 *
 * TODO(NEW 3 V1.1): when openclaw grows the reject-tool-call hook, this
 * file gains a second code path that compiles the matcher and hands the
 * compiled function through the adapter context for per-call consultation.
 */
import {
  AUTONOMY_ROLE_DEFAULTS,
  type AllowlistEnvelope,
  type AutonomyLevel,
} from "@paperclipai/shared";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { effectiveAutonomyLevel } from "./autonomy-state-machine.js";

export type AdapterContextScope = NonNullable<AdapterExecutionContext["scope"]>;

export class AdapterContextScopeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "gated_empty_envelope"
      | "invalid_permissions_shape",
  ) {
    super(message);
    this.name = "AdapterContextScopeError";
  }
}

function isEmptyEnvelope(env: AllowlistEnvelope | null | undefined): boolean {
  if (!env) return true;
  const tools = (env.allowedTools?.length ?? 0) + (env.deniedTools?.length ?? 0);
  const paths = (env.allowedPaths?.length ?? 0) + (env.deniedPaths?.length ?? 0);
  return tools === 0 && paths === 0;
}

function readEnvelope(permissions: unknown): AllowlistEnvelope {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return {};
  }
  const raw = (permissions as Record<string, unknown>).allowlist;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // Shallow copy only — we do NOT validate the envelope here (validator
  // ran at PATCH time). If the jsonb was tampered with, the matcher will
  // surface undefined-array checks as "empty".
  return raw as AllowlistEnvelope;
}

export interface BuildAdapterScopeArgs {
  /** Raw `agents.permissions` jsonb column value. */
  permissions: unknown;
  /** `agents.role` text column — drives role-default fallback. */
  role: string | null | undefined;
  /**
   * Resolved cwd for the run. Carried into `scope.workingDir` so
   * adapters can pass it to openclaw's session-spawn RPC without
   * re-deriving from the workspace record.
   */
  workingDir?: string | null;
}

export interface BuildAdapterScopeResult {
  /** Value to assign to `AdapterExecutionContext.scope`. */
  scope: AdapterContextScope | undefined;
  /** The effective autonomy level used to decide the empty-envelope behavior. */
  level: AutonomyLevel;
  /** The raw envelope extracted from permissions (may be empty). */
  envelope: AllowlistEnvelope;
}

/**
 * Compute the AdapterExecutionContext.scope for a run-spawn call.
 *
 * Pre-dispatch enforcement:
 * - `gated` + empty envelope → throws. Gated must be explicit; we refuse
 *   to spawn because there's nothing to enforce against.
 * - `policy` + empty envelope → returns a locked-down scope with empty
 *   arrays (nothing matches; matcher reports ESCALATE for everything).
 *   The spawn still proceeds (it's advisory V1), but the envelope is
 *   explicitly zero-allow.
 * - `autopilot` + empty envelope → returns scope with role defaults
 *   widened out (workingDir only, no tool/path restriction). Operator
 *   opted into trust-mode; envelope is informational.
 *
 * Non-empty envelope at any level → pass through; matcher does the work.
 */
export function buildAdapterContextScope(
  args: BuildAdapterScopeArgs,
): BuildAdapterScopeResult {
  const level = effectiveAutonomyLevel(args.permissions, args.role ?? null);
  const envelope = readEnvelope(args.permissions);

  if (isEmptyEnvelope(envelope)) {
    if (level === "gated") {
      throw new AdapterContextScopeError(
        "gated-level agent has empty allowlist envelope; spawn rejected pre-dispatch",
        "gated_empty_envelope",
      );
    }
    if (level === "policy") {
      // Locked-down: scope present but empty arrays. Matcher will
      // escalate every tool call, which is the correct behavior for
      // a mis-configured policy-level agent (plan §4.2).
      return {
        scope: {
          allowedTools: [],
          allowedPaths: [],
          deniedTools: [],
          deniedPaths: [],
          ...(args.workingDir ? { workingDir: args.workingDir } : {}),
        },
        level,
        envelope,
      };
    }
    // autopilot: fall through to defaults — role defaults don't have a
    // structured envelope yet (static map only); V1.1 will pull from a
    // role_envelope_defaults table. For now the scope only carries
    // workingDir so the adapter has somewhere to run.
    void AUTONOMY_ROLE_DEFAULTS;
    return {
      scope: args.workingDir ? { workingDir: args.workingDir } : undefined,
      level,
      envelope,
    };
  }

  // Non-empty envelope — copy through fields verbatim, including
  // workingDir override if present.
  const scope: AdapterContextScope = {};
  if (envelope.allowedTools && envelope.allowedTools.length > 0) {
    scope.allowedTools = [...envelope.allowedTools];
  }
  if (envelope.allowedPaths && envelope.allowedPaths.length > 0) {
    scope.allowedPaths = [...envelope.allowedPaths];
  }
  if (envelope.deniedTools && envelope.deniedTools.length > 0) {
    scope.deniedTools = [...envelope.deniedTools];
  }
  if (envelope.deniedPaths && envelope.deniedPaths.length > 0) {
    scope.deniedPaths = [...envelope.deniedPaths];
  }
  if (
    envelope.networkAccess === "none" ||
    envelope.networkAccess === "localhost" ||
    envelope.networkAccess === "full"
  ) {
    scope.networkAccess = envelope.networkAccess;
  }
  if (args.workingDir) {
    scope.workingDir = args.workingDir;
  }
  return { scope, level, envelope };
}
