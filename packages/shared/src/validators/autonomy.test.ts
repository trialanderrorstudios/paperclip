import { describe, expect, it } from "vitest";
import {
  allowlistEnvelopeSchema,
  envelopeForLevelSchema,
  autonomyPolicySchema,
  agentAutonomyPatchSchema,
  autonomyPromotionApprovalPayloadSchema,
  allowlistExceptionApprovalPayloadSchema,
  isValidPromotionStep,
  isAutonomyDemotion,
} from "./autonomy.js";
import { AUTONOMY_LEVELS } from "../types/autonomy.js";

describe("autonomy validators", () => {
  describe("allowlistEnvelopeSchema", () => {
    it("accepts an envelope with explicit tools + paths", () => {
      const parsed = allowlistEnvelopeSchema.parse({
        allowedTools: ["Read", "Grep"],
        allowedPaths: ["src/**", "tests/**"],
        deniedPaths: ["secrets/**"],
        maxCostUSD: 5,
        networkAccess: "localhost",
      });
      expect(parsed.allowedTools).toEqual(["Read", "Grep"]);
    });

    it("rejects an empty-string glob", () => {
      const result = allowlistEnvelopeSchema.safeParse({ allowedPaths: [""] });
      expect(result.success).toBe(false);
    });

    it("rejects unbalanced-brace globs as invalid picomatch syntax", () => {
      const result = allowlistEnvelopeSchema.safeParse({ allowedPaths: ["src/{a,b"] });
      expect(result.success).toBe(false);
    });

    it("rejects unbalanced-bracket globs", () => {
      const result = allowlistEnvelopeSchema.safeParse({ allowedPaths: ["src/[a-z"] });
      expect(result.success).toBe(false);
    });

    it("rejects negative maxCostUSD", () => {
      const result = allowlistEnvelopeSchema.safeParse({ maxCostUSD: -1 });
      expect(result.success).toBe(false);
    });

    it("rejects unknown networkAccess values", () => {
      const result = allowlistEnvelopeSchema.safeParse({ networkAccess: "public" });
      expect(result.success).toBe(false);
    });

    it("rejects unknown top-level fields (strict)", () => {
      const result = allowlistEnvelopeSchema.safeParse({ badField: true });
      expect(result.success).toBe(false);
    });
  });

  describe("envelopeForLevelSchema", () => {
    it("rejects empty envelope at gated", () => {
      const result = envelopeForLevelSchema("gated").safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts explicit envelope at gated", () => {
      const result = envelopeForLevelSchema("gated").safeParse({
        allowedTools: ["Read"],
        allowedPaths: ["src/main.ts"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects wildcards at gated level", () => {
      const result = envelopeForLevelSchema("gated").safeParse({
        allowedTools: ["Read"],
        allowedPaths: ["src/**"],
      });
      expect(result.success).toBe(false);
    });

    it("accepts empty envelope at policy (falls back to role defaults)", () => {
      const result = envelopeForLevelSchema("policy").safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts wildcards at autopilot", () => {
      const result = envelopeForLevelSchema("autopilot").safeParse({
        allowedPaths: ["**/*"],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("autonomyPolicySchema", () => {
    it("accepts a maxLevel-only policy", () => {
      expect(autonomyPolicySchema.parse({ maxLevel: "policy" })).toEqual({ maxLevel: "policy" });
    });

    it("rejects invalid maxLevel", () => {
      const result = autonomyPolicySchema.safeParse({ maxLevel: "super" });
      expect(result.success).toBe(false);
    });

    it("rejects unknown fields (strict)", () => {
      const result = autonomyPolicySchema.safeParse({ maxLevel: "gated", extra: 1 });
      expect(result.success).toBe(false);
    });
  });

  describe("isValidPromotionStep", () => {
    it("allows gated → policy", () => {
      expect(isValidPromotionStep("gated", "policy")).toBe(true);
    });

    it("allows policy → autopilot", () => {
      expect(isValidPromotionStep("policy", "autopilot")).toBe(true);
    });

    it("rejects level-skip gated → autopilot", () => {
      expect(isValidPromotionStep("gated", "autopilot")).toBe(false);
    });

    it("rejects no-op same-level promote", () => {
      expect(isValidPromotionStep("policy", "policy")).toBe(false);
    });

    it("rejects reverse direction", () => {
      expect(isValidPromotionStep("autopilot", "policy")).toBe(false);
    });
  });

  describe("isAutonomyDemotion", () => {
    it("flags autopilot → gated as demotion", () => {
      expect(isAutonomyDemotion("autopilot", "gated")).toBe(true);
    });

    it("flags policy → gated as demotion", () => {
      expect(isAutonomyDemotion("policy", "gated")).toBe(true);
    });

    it("does not flag same-level as demotion", () => {
      expect(isAutonomyDemotion("policy", "policy")).toBe(false);
    });

    it("does not flag promotion as demotion", () => {
      expect(isAutonomyDemotion("gated", "policy")).toBe(false);
    });
  });

  describe("agentAutonomyPatchSchema", () => {
    it("accepts level-only patch", () => {
      const parsed = agentAutonomyPatchSchema.parse({ autonomyLevel: "policy" });
      expect(parsed.autonomyLevel).toBe("policy");
    });

    it("accepts allowlist-only patch", () => {
      const parsed = agentAutonomyPatchSchema.parse({ allowlist: { allowedTools: ["Read"] } });
      expect(parsed.allowlist?.allowedTools).toEqual(["Read"]);
    });

    it("rejects unknown top-level fields (strict)", () => {
      const result = agentAutonomyPatchSchema.safeParse({ nope: true });
      expect(result.success).toBe(false);
    });
  });

  describe("approval payload schemas", () => {
    it("accepts an autonomy.promotion payload", () => {
      const parsed = autonomyPromotionApprovalPayloadSchema.parse({
        agentId: "00000000-0000-0000-0000-000000000001",
        fromLevel: "gated",
        toLevel: "policy",
      });
      expect(parsed.fromLevel).toBe("gated");
    });

    it("rejects an invalid-uuid agent on promotion payload", () => {
      const result = autonomyPromotionApprovalPayloadSchema.safeParse({
        agentId: "not-a-uuid",
        fromLevel: "gated",
        toLevel: "policy",
      });
      expect(result.success).toBe(false);
    });

    it("accepts an allowlist.exception payload", () => {
      const parsed = allowlistExceptionApprovalPayloadSchema.parse({
        agentId: "00000000-0000-0000-0000-000000000001",
        attemptedTool: "Bash",
        attemptedPath: "ops/deploy.sh",
      });
      expect(parsed.attemptedTool).toBe("Bash");
    });
  });

  describe("constant wiring", () => {
    it("exports exactly three levels in ladder order", () => {
      expect(AUTONOMY_LEVELS).toEqual(["gated", "policy", "autopilot"]);
    });
  });
});
