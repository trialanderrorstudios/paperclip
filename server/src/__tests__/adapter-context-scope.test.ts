/**
 * Unit tests for adapter-context-scope builder (NEW 3 V1, -tne delta).
 *
 * Covers the Gap 1 wiring: agent's `permissions.allowlist` envelope round-
 * trips into `AdapterExecutionContext.scope` at run-spawn time, with
 * pre-dispatch enforcement for the three autonomy levels.
 *
 * Placed in `server/src/__tests__/` (project convention) rather than
 * `server/src/services/__tests__/` (task-template path, which does not
 * exist).
 */
import { describe, expect, it } from "vitest";
import {
  buildAdapterContextScope,
  AdapterContextScopeError,
} from "../services/adapter-context-scope.ts";

describe("buildAdapterContextScope — round-trip", () => {
  it("copies envelope fields into scope verbatim (allowed + denied + network)", () => {
    const result = buildAdapterContextScope({
      permissions: {
        autonomyLevel: "policy",
        allowlist: {
          allowedTools: ["Read", "Grep"],
          allowedPaths: ["src/**"],
          deniedTools: ["Bash"],
          deniedPaths: ["**/.env*"],
          networkAccess: "localhost",
        },
      },
      role: "engineer",
      workingDir: "/tmp/agent-ws",
    });
    expect(result.level).toBe("policy");
    expect(result.scope).toEqual({
      allowedTools: ["Read", "Grep"],
      allowedPaths: ["src/**"],
      deniedTools: ["Bash"],
      deniedPaths: ["**/.env*"],
      networkAccess: "localhost",
      workingDir: "/tmp/agent-ws",
    });
  });

  it("includes workingDir even when envelope is non-empty (override)", () => {
    const result = buildAdapterContextScope({
      permissions: {
        autonomyLevel: "policy",
        allowlist: { allowedTools: ["Read"] },
      },
      role: "engineer",
      workingDir: "/tmp/elsewhere",
    });
    expect(result.scope?.workingDir).toBe("/tmp/elsewhere");
  });

  it("skips empty arrays so adapters don't see zero-length fields", () => {
    const result = buildAdapterContextScope({
      permissions: {
        autonomyLevel: "policy",
        allowlist: { allowedTools: ["Read"], allowedPaths: [] },
      },
      role: "engineer",
    });
    expect(result.scope?.allowedTools).toEqual(["Read"]);
    expect(result.scope).not.toHaveProperty("allowedPaths");
  });
});

describe("buildAdapterContextScope — pre-dispatch enforcement", () => {
  it("EXPLICIT gated + empty envelope → throws gated_empty_envelope", () => {
    expect(() =>
      buildAdapterContextScope({
        permissions: { autonomyLevel: "gated" },
        role: "engineer",
      }),
    ).toThrow(AdapterContextScopeError);
    try {
      buildAdapterContextScope({
        permissions: { autonomyLevel: "gated" },
        role: "engineer",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterContextScopeError);
      expect((e as AdapterContextScopeError).code).toBe("gated_empty_envelope");
    }
  });

  it("compat-shim gated (no explicit autonomyLevel) + empty envelope → pass through (no reject)", () => {
    // Legacy agent with empty permissions defaults to role=gated via
    // AUTONOMY_ROLE_DEFAULTS. Refusing to spawn would mass-break every
    // upstream-compatible deployment on upgrade. Plan §5.3 compat-shim.
    const result = buildAdapterContextScope({
      permissions: {},
      role: "engineer",
      workingDir: "/tmp/ws",
    });
    expect(result.level).toBe("gated");
    expect(result.scope).toEqual({ workingDir: "/tmp/ws" });
  });

  it("policy + empty envelope → locked-down scope (empty arrays)", () => {
    const result = buildAdapterContextScope({
      permissions: { autonomyLevel: "policy" },
      role: "engineer",
      workingDir: "/tmp/ws",
    });
    expect(result.level).toBe("policy");
    expect(result.scope).toEqual({
      allowedTools: [],
      allowedPaths: [],
      deniedTools: [],
      deniedPaths: [],
      workingDir: "/tmp/ws",
    });
  });

  it("autopilot + empty envelope → pass-through (role defaults trusted)", () => {
    const result = buildAdapterContextScope({
      permissions: { autonomyLevel: "autopilot" },
      role: "engineer",
      workingDir: "/tmp/ws",
    });
    expect(result.level).toBe("autopilot");
    // Scope carries workingDir only; no tool/path restriction.
    expect(result.scope).toEqual({ workingDir: "/tmp/ws" });
  });

  it("autopilot + empty envelope + no workingDir → undefined scope", () => {
    const result = buildAdapterContextScope({
      permissions: { autonomyLevel: "autopilot" },
      role: "engineer",
    });
    expect(result.scope).toBeUndefined();
  });
});

describe("buildAdapterContextScope — edge cases", () => {
  it("compat-shim read: empty permissions + ceo role → gated (compat-shim, does NOT throw)", () => {
    // Same compat-shim rule: no explicit autonomyLevel = legacy agent.
    const result = buildAdapterContextScope({ permissions: {}, role: "ceo" });
    expect(result.level).toBe("gated");
    expect(result.scope).toBeUndefined();
  });

  it("compat-shim read: empty permissions + engineer role → gated (compat-shim, does NOT throw)", () => {
    // Role defaults map all known roles to 'gated' per plan §3.3.
    // Without an explicit autonomyLevel, this is the legacy compat-
    // shim read — spawn proceeds with no scope.
    const result = buildAdapterContextScope({
      permissions: {},
      role: "engineer",
    });
    expect(result.level).toBe("gated");
    expect(result.scope).toBeUndefined();
  });

  it("invalid permissions shape (null) → treated as empty (compat-shim, does NOT throw)", () => {
    const result = buildAdapterContextScope({
      permissions: null,
      role: "engineer",
    });
    expect(result.level).toBe("gated");
    expect(result.scope).toBeUndefined();
  });

  it("invalid envelope type (string) → treated as empty envelope", () => {
    // Only autopilot survives empty-envelope; verify we don't explode.
    const result = buildAdapterContextScope({
      permissions: { autonomyLevel: "autopilot", allowlist: "invalid" },
      role: "engineer",
    });
    expect(result.level).toBe("autopilot");
    expect(result.scope).toBeUndefined();
  });
});
