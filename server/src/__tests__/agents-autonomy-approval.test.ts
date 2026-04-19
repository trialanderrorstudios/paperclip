/**
 * Integration tests for the NEW 3 V1 Gap 2 matcher-branch behavior at
 * the hire-approval surface.
 *
 * Tests the pure `checkDeclaredSurfaceAgainstEnvelope` helper (Gap 2's
 * decision engine) directly for all three branches + verifies that the
 * picomatch-based matcher composes correctly with the autonomy level
 * rules from plan §4.2.
 *
 * Placed in `server/src/__tests__/` (project convention). Full route-
 * level supertest integration for the hire handler is heavy — the three
 * branches live in a 10-line block of route logic, and each branch's
 * I/O is dominated by the matcher. Unit coverage of the helper + the
 * existing autonomy-state-machine suite + autonomy-compat-shim regression
 * cover the surface that Gap 2 actually introduces.
 */
import { describe, expect, it } from "vitest";
import { checkDeclaredSurfaceAgainstEnvelope } from "../services/allowlist-check.ts";

describe("checkDeclaredSurfaceAgainstEnvelope — ALLOW branch", () => {
  it("returns allow when declared tools fit the envelope (policy level)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: {
        allowedTools: ["Read", "Grep", "Bash"],
        allowedPaths: ["src/**"],
      },
      declaredTools: ["Read", "Bash"],
      declaredPaths: ["src/server/agents.ts"],
    });
    expect(verdict.kind).toBe("allow");
  });

  it("returns allow when no declared surface to check (empty declares)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: { allowedTools: ["Read"] },
    });
    expect(verdict.kind).toBe("allow");
  });

  it("autopilot + wildcard-envelope + unknown tool → allow (trust default)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "autopilot",
      envelope: { allowedTools: ["Read"] },
      declaredTools: ["SomeOtherTool"],
    });
    expect(verdict.kind).toBe("allow");
  });
});

describe("checkDeclaredSurfaceAgainstEnvelope — ESCALATE branch", () => {
  it("returns escalate at policy when declared tool not in allowlist", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: { allowedTools: ["Read"] },
      declaredTools: ["Bash"],
    });
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind === "escalate") {
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]).toMatchObject({ kind: "tool", value: "Bash" });
    }
  });

  it("returns escalate at policy when declared path not in allowedPaths", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: { allowedPaths: ["src/**"] },
      declaredPaths: ["/etc/passwd"],
    });
    expect(verdict.kind).toBe("escalate");
  });

  it("collects all out-of-envelope violations (multiple)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: { allowedTools: ["Read"], allowedPaths: ["src/**"] },
      declaredTools: ["Bash", "Edit"],
      declaredPaths: ["/etc/hosts"],
    });
    expect(verdict.kind).toBe("escalate");
    if (verdict.kind === "escalate") {
      expect(verdict.violations).toHaveLength(3);
    }
  });
});

describe("checkDeclaredSurfaceAgainstEnvelope — DENY branch", () => {
  it("returns deny when declared tool hits explicit deniedTools (autopilot)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "autopilot",
      envelope: {
        allowedTools: ["Read", "Bash"],
        deniedTools: ["Bash"],
      },
      declaredTools: ["Read", "Bash"],
    });
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("explicit-deny");
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]).toMatchObject({ kind: "tool", value: "Bash" });
    }
  });

  it("returns deny when declared path hits deniedPaths (autopilot)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "autopilot",
      envelope: { deniedPaths: ["**/.env*"] },
      declaredPaths: ["src/.env.production"],
    });
    expect(verdict.kind).toBe("deny");
  });

  it("deny wins over escalate (mixed violations)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: {
        allowedTools: ["Read"],
        deniedTools: ["DeleteEverything"],
      },
      declaredTools: ["Read", "UnknownTool", "DeleteEverything"],
    });
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("explicit-deny");
      // Both violations captured (UnknownTool and DeleteEverything).
      expect(verdict.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("gated level: everything not in envelope is denied (not-in-allowlist)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "gated",
      envelope: { allowedTools: ["Read"] },
      declaredTools: ["Bash"],
    });
    expect(verdict.kind).toBe("deny");
    if (verdict.kind === "deny") {
      expect(verdict.reason).toBe("not-in-allowlist");
    }
  });
});

describe("checkDeclaredSurfaceAgainstEnvelope — empty envelope composition", () => {
  it("policy + empty envelope + declared tool → escalate (locked-down)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "policy",
      envelope: {},
      declaredTools: ["Read"],
    });
    expect(verdict.kind).toBe("escalate");
  });

  it("autopilot + empty envelope + declared tool → allow (trust defaults)", () => {
    const verdict = checkDeclaredSurfaceAgainstEnvelope({
      level: "autopilot",
      envelope: {},
      declaredTools: ["Read"],
    });
    expect(verdict.kind).toBe("allow");
  });
});
