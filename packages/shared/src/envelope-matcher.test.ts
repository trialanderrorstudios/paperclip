import { describe, expect, it } from "vitest";
import {
  checkBashNetwork,
  matchPath,
  matchToolCall,
  type EnvelopeRules,
} from "./envelope-matcher.js";
import { homedir } from "node:os";

describe("envelope-matcher: matchPath", () => {
  it("exact path matches", () => {
    expect(matchPath("/etc/passwd", "/etc/passwd")).toBe(true);
    expect(matchPath("/etc/passwd", "/etc/shadow")).toBe(false);
  });

  it("** matches any suffix", () => {
    expect(matchPath("**", "/any/path")).toBe(true);
    expect(matchPath("/etc/**", "/etc/passwd")).toBe(true);
    expect(matchPath("/etc/**", "/etc/ssh/sshd_config")).toBe(true);
    expect(matchPath("/etc/**", "/var/log/messages")).toBe(false);
  });

  it("single * matches within a segment", () => {
    expect(matchPath("/tmp/*.log", "/tmp/debug.log")).toBe(true);
    expect(matchPath("/tmp/*.log", "/tmp/nested/debug.log")).toBe(false);
  });

  it("tilde expansion", () => {
    expect(matchPath("~/secrets/**", `${homedir()}/secrets/keys.json`)).toBe(true);
    expect(matchPath("~/secrets/**", `${homedir()}/other/keys.json`)).toBe(false);
  });

  it("prefix-style globs for src-only rules", () => {
    expect(matchPath("src/**", "src/app/main.ts")).toBe(true);
    expect(matchPath("src/**", "src/")).toBe(true);
    expect(matchPath("src/**", "lib/app/main.ts")).toBe(false);
  });
});

describe("envelope-matcher: checkBashNetwork", () => {
  it("'full' allows everything", () => {
    expect(checkBashNetwork("curl https://evil.com", "full")).toEqual({ allowed: true });
  });

  it("'none' rejects any network tool", () => {
    for (const cmd of [
      "curl https://example.com",
      "wget http://example.com",
      "nc -z host 80",
      "ssh user@host",
      "ping -c 3 example.com",
      "dig example.com",
    ]) {
      const r = checkBashNetwork(cmd, "none");
      expect(r.allowed).toBe(false);
    }
  });

  it("'none' allows commands with no network tools", () => {
    expect(checkBashNetwork("echo hello && ls -la", "none")).toEqual({ allowed: true });
    expect(checkBashNetwork("git log --oneline", "none")).toEqual({ allowed: true });
  });

  it("'localhost' allows explicit loopback", () => {
    expect(checkBashNetwork("curl http://127.0.0.1:3100/api", "localhost").allowed).toBe(true);
    expect(checkBashNetwork("curl http://localhost:8080", "localhost").allowed).toBe(true);
    expect(checkBashNetwork("curl http://[::1]/", "localhost").allowed).toBe(true);
  });

  it("'localhost' rejects external hosts", () => {
    expect(checkBashNetwork("curl https://example.com", "localhost").allowed).toBe(false);
    expect(checkBashNetwork("wget https://paperclip.ai", "localhost").allowed).toBe(false);
  });
});

describe("envelope-matcher: matchToolCall tool-name rules", () => {
  it("denies when tool is in deniedTools", () => {
    const rules: EnvelopeRules = { deniedTools: ["Write"] };
    const r = matchToolCall("Write", { file_path: "/tmp/x" }, rules);
    expect(r.allowed).toBe(false);
  });

  it("allows when allowedTools has the tool", () => {
    const rules: EnvelopeRules = { allowedTools: ["Read", "Grep"] };
    const r = matchToolCall("Read", { file_path: "/tmp/x" }, rules);
    expect(r.allowed).toBe(true);
  });

  it("denies when allowedTools is non-empty and missing the tool", () => {
    const rules: EnvelopeRules = { allowedTools: ["Read", "Grep"] };
    const r = matchToolCall("Bash", { command: "ls" }, rules);
    expect(r.allowed).toBe(false);
  });

  it("empty allowedTools = no restriction", () => {
    const rules: EnvelopeRules = { allowedTools: [] };
    const r = matchToolCall("Bash", { command: "ls" }, rules);
    expect(r.allowed).toBe(true);
  });

  it("denied wins over allowed when both list the tool", () => {
    const rules: EnvelopeRules = { allowedTools: ["Bash"], deniedTools: ["Bash"] };
    const r = matchToolCall("Bash", { command: "ls" }, rules);
    expect(r.allowed).toBe(false);
  });
});

describe("envelope-matcher: matchToolCall path-arg tools", () => {
  it("Read respects deniedPaths", () => {
    const rules: EnvelopeRules = { deniedPaths: ["/etc/**"] };
    expect(matchToolCall("Read", { file_path: "/etc/passwd" }, rules).allowed).toBe(false);
    expect(matchToolCall("Read", { file_path: "/tmp/x" }, rules).allowed).toBe(true);
  });

  it("Write respects allowedPaths", () => {
    const rules: EnvelopeRules = { allowedPaths: ["src/**", "tests/**"] };
    expect(matchToolCall("Write", { file_path: "src/app/main.ts" }, rules).allowed).toBe(true);
    expect(matchToolCall("Write", { file_path: "/etc/passwd" }, rules).allowed).toBe(false);
  });

  it("Edit respects both", () => {
    const rules: EnvelopeRules = {
      allowedPaths: ["src/**"],
      deniedPaths: ["src/secrets/**"],
    };
    expect(matchToolCall("Edit", { file_path: "src/app.ts" }, rules).allowed).toBe(true);
    expect(matchToolCall("Edit", { file_path: "src/secrets/key.ts" }, rules).allowed).toBe(false);
  });

  it("tilde in file_path expanded for matching", () => {
    const rules: EnvelopeRules = { deniedPaths: ["~/secrets/**"] };
    expect(matchToolCall("Read", { file_path: "~/secrets/key" }, rules).allowed).toBe(false);
    expect(matchToolCall("Read", { file_path: `${homedir()}/secrets/key` }, rules).allowed).toBe(false);
  });
});

describe("envelope-matcher: matchToolCall Bash", () => {
  it("extracts paths from command args and checks against deniedPaths", () => {
    const rules: EnvelopeRules = { deniedPaths: ["/etc/**"] };
    const r = matchToolCall("Bash", { command: "cat /etc/passwd" }, rules);
    expect(r.allowed).toBe(false);
  });

  it("blocks network with networkAccess=none", () => {
    const rules: EnvelopeRules = { networkAccess: "none" };
    expect(matchToolCall("Bash", { command: "curl https://x.com" }, rules).allowed).toBe(false);
    expect(matchToolCall("Bash", { command: "echo hi" }, rules).allowed).toBe(true);
  });

  it("networkAccess=localhost permits explicit loopback", () => {
    const rules: EnvelopeRules = { networkAccess: "localhost" };
    expect(matchToolCall("Bash", { command: "curl http://127.0.0.1:3100" }, rules).allowed).toBe(true);
    expect(matchToolCall("Bash", { command: "curl https://x.com" }, rules).allowed).toBe(false);
  });

  it("combines path + network checks", () => {
    const rules: EnvelopeRules = {
      deniedPaths: ["/etc/**"],
      networkAccess: "none",
    };
    expect(matchToolCall("Bash", { command: "cat /etc/hosts" }, rules).allowed).toBe(false);
    expect(matchToolCall("Bash", { command: "curl http://x.com" }, rules).allowed).toBe(false);
    expect(matchToolCall("Bash", { command: "ls /tmp" }, rules).allowed).toBe(true);
  });

  it("handles quoted path args", () => {
    const rules: EnvelopeRules = { deniedPaths: ["/var/**"] };
    expect(matchToolCall("Bash", { command: "cat '/var/log/messages'" }, rules).allowed).toBe(false);
  });
});

describe("envelope-matcher: matchToolCall WebFetch / WebSearch", () => {
  it("WebFetch respects networkAccess='full'", () => {
    const rules: EnvelopeRules = { networkAccess: "full" };
    expect(matchToolCall("WebFetch", { url: "https://example.com" }, rules).allowed).toBe(true);
  });

  it("WebFetch rejected when networkAccess='none'", () => {
    const rules: EnvelopeRules = { networkAccess: "none" };
    expect(matchToolCall("WebFetch", { url: "https://example.com" }, rules).allowed).toBe(false);
  });

  it("WebFetch localhost-only accepts loopback hosts", () => {
    const rules: EnvelopeRules = { networkAccess: "localhost" };
    expect(matchToolCall("WebFetch", { url: "http://127.0.0.1/api" }, rules).allowed).toBe(true);
    expect(matchToolCall("WebFetch", { url: "http://localhost:3100/x" }, rules).allowed).toBe(true);
    expect(matchToolCall("WebFetch", { url: "https://example.com" }, rules).allowed).toBe(false);
  });

  it("WebSearch treated like WebFetch for network rules", () => {
    const rules: EnvelopeRules = { networkAccess: "none" };
    expect(matchToolCall("WebSearch", { query: "anything" }, rules).allowed).toBe(false);
  });
});

describe("envelope-matcher: unknown tools + empty rules", () => {
  it("unknown tools default-allow", () => {
    const rules: EnvelopeRules = {};
    expect(matchToolCall("SomeFutureTool", { foo: "bar" }, rules).allowed).toBe(true);
  });

  it("empty EnvelopeRules = all allowed", () => {
    expect(matchToolCall("Bash", { command: "curl https://x.com" }, {}).allowed).toBe(true);
    expect(matchToolCall("Read", { file_path: "/etc/passwd" }, {}).allowed).toBe(true);
  });

  it("deniedPaths dominates allowedPaths", () => {
    const rules: EnvelopeRules = {
      allowedPaths: ["**"],
      deniedPaths: ["/etc/**"],
    };
    expect(matchToolCall("Read", { file_path: "/etc/passwd" }, rules).allowed).toBe(false);
    expect(matchToolCall("Read", { file_path: "/tmp/x" }, rules).allowed).toBe(true);
  });
});

describe("envelope-matcher: workingDir subtree fallback", () => {
  it("when allowedPaths is undefined + workingDir is set, paths outside the subtree deny", () => {
    const rules: EnvelopeRules = { workingDir: "/Users/me/project" };
    expect(matchToolCall("Read", { file_path: "/Users/me/project/src/app.ts" }, rules).allowed).toBe(true);
    expect(matchToolCall("Read", { file_path: "/etc/passwd" }, rules).allowed).toBe(false);
  });

  it("explicit allowedPaths overrides workingDir", () => {
    const rules: EnvelopeRules = {
      workingDir: "/Users/me/project",
      allowedPaths: ["/tmp/**"],
    };
    expect(matchToolCall("Read", { file_path: "/tmp/x" }, rules).allowed).toBe(true);
    expect(matchToolCall("Read", { file_path: "/Users/me/project/app.ts" }, rules).allowed).toBe(false);
  });
});
