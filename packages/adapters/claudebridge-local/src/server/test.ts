import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

async function probeClaudebridge(url: string, token: string): Promise<"ok" | "auth_failed" | "unreachable"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve("unreachable");
    }, 5_000);

    let done = false;
    const finish = (r: "ok" | "auth_failed" | "unreachable") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(r);
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "req", id: "probe", method: "auth.hello", params: { token } }));
    });

    ws.on("message", (data) => {
      let frame: unknown;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (typeof frame === "object" && frame !== null && (frame as { type?: string }).type === "res") {
        const res = frame as { ok: boolean };
        finish(res.ok ? "ok" : "auth_failed");
      }
    });

    ws.on("error", () => finish("unreachable"));
    ws.on("close", () => { if (!done) finish("unreachable"); });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (typeof ctx.config === "object" && ctx.config !== null ? ctx.config : {}) as Record<string, unknown>;

  const wsUrl = nonEmpty(config.wsUrl) ?? "ws://127.0.0.1:7737";
  checks.push({
    code: "claudebridge_url",
    level: "info",
    message: `Claudebridge URL: ${wsUrl}`,
  });

  // Resolve token.
  let token = nonEmpty(config.token);
  if (!token) {
    const pairingsPath = join(homedir(), ".claudebridge", "pairings.json");
    if (!existsSync(pairingsPath)) {
      checks.push({
        code: "claudebridge_no_pairings_file",
        level: "error",
        message: `No pairing token in config and ${pairingsPath} not found.`,
        hint: "Run 'claudebridge pair' or set adapterConfig.token explicitly.",
      });
    } else {
      try {
        const parsed = JSON.parse(readFileSync(pairingsPath, "utf8")) as { pairings?: Array<{ token: string }> };
        token = parsed.pairings?.[0]?.token ?? null;
        if (!token) {
          checks.push({
            code: "claudebridge_pairings_empty",
            level: "error",
            message: `${pairingsPath} has no entries.`,
            hint: "Run 'claudebridge pair' to register this machine.",
          });
        } else {
          checks.push({
            code: "claudebridge_token_auto_resolved",
            level: "info",
            message: "Pairing token resolved from ~/.claudebridge/pairings.json.",
          });
        }
      } catch {
        checks.push({
          code: "claudebridge_pairings_parse_error",
          level: "error",
          message: `Failed to parse ${join(homedir(), ".claudebridge", "pairings.json")}.`,
        });
      }
    }
  } else {
    checks.push({
      code: "claudebridge_token_configured",
      level: "info",
      message: "Pairing token is explicitly configured.",
    });
  }

  if (token) {
    try {
      const probeResult = await probeClaudebridge(wsUrl, token);
      if (probeResult === "ok") {
        checks.push({
          code: "claudebridge_probe_ok",
          level: "info",
          message: "Claudebridge connection and authentication succeeded.",
        });
      } else if (probeResult === "auth_failed") {
        checks.push({
          code: "claudebridge_auth_failed",
          level: "error",
          message: "Connected to Claudebridge but authentication was rejected.",
          hint: "Check your pairing token. Re-run 'claudebridge pair' to generate a fresh token.",
        });
      } else {
        checks.push({
          code: "claudebridge_unreachable",
          level: "warn",
          message: `Could not connect to Claudebridge at ${wsUrl}.`,
          hint: "Make sure the Claudebridge daemon is running (bun run src/server.ts or equivalent).",
        });
      }
    } catch (err) {
      checks.push({
        code: "claudebridge_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Claudebridge probe error",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
