import { describe, expect, it } from "vitest";
import { compileAllowlistMatcher } from "../services/allowlist-matcher.ts";

describe("compileAllowlistMatcher", () => {
  describe("gated level", () => {
    it("denies tools not in explicit allowlist", () => {
      const m = compileAllowlistMatcher("gated", { allowedTools: ["Read"] });
      expect(m.matchTool("Read")).toEqual({ kind: "allowed" });
      expect(m.matchTool("Bash")).toEqual({ kind: "denied", reason: "not-in-allowlist" });
    });

    it("denies paths not in explicit allowlist", () => {
      const m = compileAllowlistMatcher("gated", { allowedPaths: ["src/main.ts"] });
      expect(m.matchPath("src/main.ts")).toEqual({ kind: "allowed" });
      expect(m.matchPath("src/other.ts")).toEqual({ kind: "denied", reason: "not-in-allowlist" });
    });

    it("empty envelope at gated denies everything (safety fallback)", () => {
      const m = compileAllowlistMatcher("gated", {});
      expect(m.matchTool("Read")).toEqual({ kind: "denied", reason: "not-in-allowlist" });
      expect(m.matchPath("any")).toEqual({ kind: "denied", reason: "not-in-allowlist" });
    });
  });

  describe("policy level", () => {
    it("allows tools inside envelope, escalates outside", () => {
      const m = compileAllowlistMatcher("policy", {
        allowedTools: ["Read", "Grep", "Bash"],
      });
      expect(m.matchTool("Read")).toEqual({ kind: "allowed" });
      expect(m.matchTool("Write")).toEqual({ kind: "escalate", reason: "out-of-envelope" });
    });

    it("allows glob-matched paths", () => {
      const m = compileAllowlistMatcher("policy", {
        allowedPaths: ["src/**", "tests/**"],
      });
      expect(m.matchPath("src/foo/bar.ts")).toEqual({ kind: "allowed" });
      expect(m.matchPath("tests/integration.ts")).toEqual({ kind: "allowed" });
      expect(m.matchPath("docs/readme.md")).toEqual({ kind: "escalate", reason: "out-of-envelope" });
    });

    it("explicit deny wins over allow", () => {
      const m = compileAllowlistMatcher("policy", {
        allowedPaths: ["src/**"],
        deniedPaths: ["src/secrets/**"],
      });
      expect(m.matchPath("src/app.ts")).toEqual({ kind: "allowed" });
      expect(m.matchPath("src/secrets/key.ts")).toEqual({ kind: "denied", reason: "explicit-deny" });
    });

    it("empty envelope at policy escalates everything", () => {
      const m = compileAllowlistMatcher("policy", {});
      expect(m.matchTool("Read")).toEqual({ kind: "escalate", reason: "out-of-envelope" });
    });
  });

  describe("autopilot level", () => {
    it("allows by default (wildcards trusted)", () => {
      const m = compileAllowlistMatcher("autopilot", { deniedPaths: ["secrets/**"] });
      expect(m.matchPath("anything/at/all")).toEqual({ kind: "allowed" });
    });

    it("empty envelope at autopilot allows everything", () => {
      const m = compileAllowlistMatcher("autopilot", {});
      expect(m.matchTool("Bash")).toEqual({ kind: "allowed" });
    });

    it("deniedPaths still enforced at autopilot", () => {
      const m = compileAllowlistMatcher("autopilot", {
        allowedPaths: ["**/*"],
        deniedPaths: ["/etc/**", "secrets/**"],
      });
      expect(m.matchPath("/etc/passwd")).toEqual({ kind: "denied", reason: "explicit-deny" });
      expect(m.matchPath("src/file.ts")).toEqual({ kind: "allowed" });
    });

    it("deniedTools enforced at autopilot", () => {
      const m = compileAllowlistMatcher("autopilot", {
        deniedTools: ["Bash"],
      });
      expect(m.matchTool("Bash")).toEqual({ kind: "denied", reason: "explicit-deny" });
      expect(m.matchTool("Read")).toEqual({ kind: "allowed" });
    });
  });

  describe("composition precedence", () => {
    it("deny always wins even when both allow and deny match", () => {
      const m = compileAllowlistMatcher("policy", {
        allowedPaths: ["**/*"],
        deniedPaths: ["src/**"],
      });
      expect(m.matchPath("src/foo.ts")).toEqual({ kind: "denied", reason: "explicit-deny" });
    });
  });
});
