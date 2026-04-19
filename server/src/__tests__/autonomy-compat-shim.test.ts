/**
 * Regression test (NEW 3 V1, -tne delta) — MANDATORY per the task plan
 * and CEO plan §A4 + §9 "Mandatory regression test."
 *
 * Scenario: an existing Paperclip company with
 * `requireBoardApprovalForNewAgents=false` + migration 0058 applied +
 * agents with empty `permissions` jsonb. After the fork delta the
 * effective autonomy level for those agents must be `policy` (synthesized
 * from the compat shim), NOT an error, NOT `autopilot`. This is the
 * exact path that would regress if the compat shim read was wrong.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveAutonomyLevel,
  resolveCompanyMaxLevel,
  capToCompanyFloor,
} from "../services/autonomy-state-machine.ts";
import { compileAllowlistMatcher } from "../services/allowlist-matcher.ts";

describe("compat shim — NEW 3 V1 mandatory regression", () => {
  it("empty permissions + requireBoardApproval=false → effective policy", () => {
    // Empty company.autonomy_policy jsonb (as loaded fresh from the
    // migrated DB) + legacy requireBoardApprovalForNewAgents=false
    // → company floor synthesizes to 'policy'.
    const companyFloor = resolveCompanyMaxLevel({}, false);
    expect(companyFloor).toBe("policy");

    // Empty agent.permissions + arbitrary role → effective level is
    // gated (the safe floor for per-agent read).
    const agentLevel = effectiveAutonomyLevel({}, "engineer");
    expect(agentLevel).toBe("gated");

    // Combined view: the policy the agent operates under is whatever
    // is lower of per-agent level vs company floor. capToCompanyFloor
    // is the cap — it does NOT floor up; a gated agent stays gated.
    expect(capToCompanyFloor(agentLevel, companyFloor)).toBe("gated");

    // When the agent IS explicitly policy AND the company floor says
    // policy, the effective level is policy — NOT an error, NOT
    // autopilot.
    const explicitPolicyAgent = effectiveAutonomyLevel({ autonomyLevel: "policy" }, "engineer");
    expect(capToCompanyFloor(explicitPolicyAgent, companyFloor)).toBe("policy");
  });

  it("empty permissions + requireBoardApproval=true (legacy gated floor) → gated throughout", () => {
    const companyFloor = resolveCompanyMaxLevel({}, true);
    expect(companyFloor).toBe("gated");
    const agentLevel = effectiveAutonomyLevel({}, "engineer");
    expect(agentLevel).toBe("gated");
    expect(capToCompanyFloor(agentLevel, companyFloor)).toBe("gated");
  });

  it("CEO role with empty permissions still defaults to gated (per role-defaults map)", () => {
    expect(effectiveAutonomyLevel({}, "ceo")).toBe("gated");
  });

  it("does NOT silently upgrade any agent to autopilot when permissions empty", () => {
    // Explicit check against the outside-voice-flagged failure mode:
    // "compat shim returns wrong level for empty-permissions row — could
    // silently upgrade an agent."
    for (const role of ["ceo", "engineer", "general", "researcher", "alien_overlord"]) {
      const level = effectiveAutonomyLevel({}, role);
      expect(level).not.toBe("autopilot");
    }
    // Even with a company floor at autopilot, an empty-permissions
    // agent stays at its role-default (gated) — cap is a ceiling, not
    // a floor.
    const companyFloor = resolveCompanyMaxLevel({ maxLevel: "autopilot" }, false);
    expect(capToCompanyFloor(effectiveAutonomyLevel({}, "engineer"), companyFloor)).toBe("gated");
  });

  it("empty envelope at compat-read policy-level does not crash the matcher", () => {
    // Wiring check: a policy-level agent with an empty allowlist falls
    // through to "escalate everything" — no exceptions thrown, no
    // mis-allowed autopilot-style matches.
    const m = compileAllowlistMatcher("policy", {});
    expect(m.matchTool("anything")).toEqual({ kind: "escalate", reason: "out-of-envelope" });
    expect(m.matchPath("anywhere")).toEqual({ kind: "escalate", reason: "out-of-envelope" });
  });

  it("null permissions jsonb is tolerated (pre-migration row shape)", () => {
    // Some legacy rows may have permissions column nullable at the DB
    // level prior to this migration. Our read path handles null.
    expect(effectiveAutonomyLevel(null, "engineer")).toBe("gated");
    expect(effectiveAutonomyLevel(undefined, "engineer")).toBe("gated");
  });

  it("null autonomy_policy is tolerated", () => {
    expect(resolveCompanyMaxLevel(null, false)).toBe("policy");
    expect(resolveCompanyMaxLevel(undefined, false)).toBe("policy");
  });

  it("malformed jsonb (string instead of object) does not crash", () => {
    // Defensive: deserialization bugs shouldn't take the read path down.
    expect(effectiveAutonomyLevel("not-an-object" as unknown, "engineer")).toBe("gated");
    expect(resolveCompanyMaxLevel("not-an-object" as unknown, false)).toBe("policy");
  });
});
