import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

// ─── Wire types (mirror claudebridge src/types.ts) ───────────────────────────

type RequestFrame = { type: "req"; id: string; method: string; params?: unknown };
type ResponseFrame =
  | { type: "res"; id: string; ok: true; result: unknown }
  | { type: "res"; id: string; ok: false; error: { code: string; message: string } };
type EventFrame = { type: "event"; name: string; payload: unknown };
type WireFrame = RequestFrame | ResponseFrame | EventFrame;

type ClaudeEventEnvelope = {
  sessionId: string;
  seq: number;
  ts: number;
  turnId?: string;
  type: string;
  payload: unknown;
};

// ─── WS Client ───────────────────────────────────────────────────────────────

type PendingReq = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class ClaudebridgeWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingReq>();
  private onEvent: ((env: ClaudeEventEnvelope) => void) | null = null;
  private closed = false;

  async connect(url: string, token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.on("error", (err) => reject(err));
      ws.on("message", (data) => this.handleMessage(data.toString()));
      ws.on("close", () => {
        this.closed = true;
        for (const [, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error("claudebridge: connection closed"));
        }
        this.pending.clear();
      });
    });

    // Authenticate immediately after open.
    await this.request("auth.hello", { token }, 10_000);
  }

  setEventHandler(handler: (env: ClaudeEventEnvelope) => void) {
    this.onEvent = handler;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.ws || this.closed) throw new Error("claudebridge: not connected");
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`claudebridge: request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: string) {
    let frame: WireFrame;
    try {
      frame = JSON.parse(raw) as WireFrame;
    } catch {
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        const err = new Error(frame.error?.message ?? "unknown error") as Error & { code?: string };
        err.code = frame.error?.code;
        pending.reject(err);
      }
      return;
    }

    if (frame.type === "event" && frame.name === "claude.session.event") {
      const env = frame.payload as ClaudeEventEnvelope;
      this.onEvent?.(env);
    }
  }
}

// ─── Token resolution ─────────────────────────────────────────────────────────

function readFirstPairingToken(): string {
  const p = join(homedir(), ".claudebridge", "pairings.json");
  if (!existsSync(p)) {
    throw new Error(
      `claudebridge_local: no pairing token configured and ${p} not found. ` +
        "Run 'claudebridge pair' or set config.token explicitly.",
    );
  }
  let parsed: { pairings?: Array<{ token: string }> };
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(`claudebridge_local: failed to parse ${p}`);
  }
  const token = parsed.pairings?.[0]?.token;
  if (!token) {
    throw new Error(
      `claudebridge_local: ${p} has no entries. ` +
        "Run 'claudebridge pair' to register this machine.",
    );
  }
  return token;
}

// ─── Execute ─────────────────────────────────────────────────────────────────

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asBoolean(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

// ─── Runtime envelope enforcement (NEW 3 V1.1 stub, -tne) ────────────────────
//
// Feature-flagged via `adapterConfig.enforceRuntimeEnvelope=true`. Default
// OFF — V1 is pre-dispatch-only; turning this on activates a best-effort
// runtime stub. See `ceo-plans/NEW-3-V2-runtime-envelope-enforcement.md`
// in the overwatch-v3 project for the design.
//
// This stub is explicitly NOT a security boundary: it relies on
// (a) Claude reading an envelope block in the systemPrompt and complying,
// (b) observing tool_use events post-hoc and aborting the session.
// The proper gate is V1.2 (SDK `canUseTool`) or V2 (openclaw-gateway hook).

type AdapterScope = NonNullable<AdapterExecutionContext["scope"]>;

function renderEnvelopeBlock(scope: AdapterScope): string {
  const lines: string[] = [
    "=== Runtime envelope (NEW 3 V1.1) ===",
    "Your operator has declared a scope envelope for this run. You MUST",
    "stay inside it. If a request would require a tool, path, or network",
    "destination outside the envelope, DO NOT attempt the call — instead",
    "describe what you would have done and ask the operator to widen the",
    "envelope. Violating the envelope will abort the turn.",
    "",
  ];
  if (scope.allowedTools && scope.allowedTools.length > 0) {
    lines.push(`allowed_tools: ${scope.allowedTools.join(", ")}`);
  } else {
    lines.push("allowed_tools: (no explicit allowlist — use only tools on the implicit allowlist for your role)");
  }
  if (scope.deniedTools && scope.deniedTools.length > 0) {
    lines.push(`denied_tools: ${scope.deniedTools.join(", ")}`);
  }
  if (scope.allowedPaths && scope.allowedPaths.length > 0) {
    lines.push(`allowed_paths: ${scope.allowedPaths.join(", ")}`);
  }
  if (scope.deniedPaths && scope.deniedPaths.length > 0) {
    lines.push(`denied_paths: ${scope.deniedPaths.join(", ")}`);
  }
  if (scope.networkAccess) {
    lines.push(`network_access: ${scope.networkAccess}`);
  }
  if (scope.workingDir) {
    lines.push(`working_dir: ${scope.workingDir} (treat as root for relative paths)`);
  }
  lines.push("", "===================================");
  return lines.join("\n");
}

/**
 * Compile a scope envelope into a cheap runtime matcher. Returns null when
 * the envelope is effectively empty (nothing to enforce). The matcher
 * intentionally uses simple substring / suffix checks rather than a real
 * glob engine at the stub level — it's advisory, and drift from the
 * pre-dispatch matcher (`server/src/services/allowlist-matcher.ts`) is
 * acceptable for V1.1. V1.2 will replace this with the shared matcher.
 */
type ScopeMatcher = {
  checkTool(name: string, input: unknown): { ok: true } | { ok: false; rule: string };
};

function compileScopeMatcher(scope: AdapterScope): ScopeMatcher | null {
  const allowedTools = scope.allowedTools ?? null;
  const deniedTools = scope.deniedTools ?? [];
  const allowedPaths = scope.allowedPaths ?? null;
  const deniedPaths = scope.deniedPaths ?? [];
  const networkAccess = scope.networkAccess ?? null;

  const anyRule =
    (allowedTools && allowedTools.length > 0) ||
    deniedTools.length > 0 ||
    (allowedPaths && allowedPaths.length > 0) ||
    deniedPaths.length > 0 ||
    networkAccess != null;
  if (!anyRule) return null;

  // Collect plausible path-looking strings out of a tool's input.
  const extractCandidatePaths = (input: unknown): string[] => {
    if (!input || typeof input !== "object") return [];
    const out: string[] = [];
    const rec = input as Record<string, unknown>;
    for (const key of [
      "file_path",
      "path",
      "filePath",
      "notebook_path",
      "notebookPath",
      "directory",
      "cwd",
    ]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
    return out;
  };

  // Rough glob-ish matcher: supports leading `**/`, trailing `/**`, and
  // plain substring. Intentionally conservative (more likely to flag).
  const matchesPattern = (path: string, pattern: string): boolean => {
    if (pattern === path) return true;
    if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
      return path.includes(pattern.slice(3, -3));
    }
    if (pattern.startsWith("**/")) {
      return path.endsWith(pattern.slice(3));
    }
    if (pattern.endsWith("/**")) {
      return path.startsWith(pattern.slice(0, -3));
    }
    return path.includes(pattern);
  };

  return {
    checkTool(name, input) {
      if (deniedTools.includes(name)) {
        return { ok: false, rule: `deniedTools:${name}` };
      }
      if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(name)) {
        return { ok: false, rule: `allowedTools(not-in-list):${name}` };
      }
      const paths = extractCandidatePaths(input);
      for (const p of paths) {
        for (const pat of deniedPaths) {
          if (matchesPattern(p, pat)) {
            return { ok: false, rule: `deniedPaths:${pat}` };
          }
        }
        if (allowedPaths && allowedPaths.length > 0) {
          const anyAllow = allowedPaths.some((pat) => matchesPattern(p, pat));
          if (!anyAllow) {
            return { ok: false, rule: `allowedPaths(no-match):${p}` };
          }
        }
      }
      // Very loose network check — only applies to Bash + WebFetch + WebSearch.
      if (networkAccess === "none" || networkAccess === "localhost") {
        if (name === "WebFetch" || name === "WebSearch") {
          if (networkAccess === "none") {
            return { ok: false, rule: `networkAccess:${networkAccess}` };
          }
          // "localhost" can't really be checked for Web* — conservatively deny.
          return { ok: false, rule: `networkAccess:${networkAccess}:web-tool` };
        }
        if (name === "Bash" && typeof (input as { command?: unknown })?.command === "string") {
          const cmd = (input as { command: string }).command;
          if (networkAccess === "none" && /\b(curl|wget|nc|http|https:|http:)\b/.test(cmd)) {
            return { ok: false, rule: `networkAccess:none:bash` };
          }
          if (
            networkAccess === "localhost" &&
            /\b(curl|wget)\b/.test(cmd) &&
            !/(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)/.test(cmd)
          ) {
            return { ok: false, rule: `networkAccess:localhost:bash` };
          }
        }
      }
      return { ok: true };
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, runtime, context, onLog, abortSignal } = ctx;

  const wsUrl = nonEmpty(config.wsUrl) ?? "ws://127.0.0.1:7737";
  const token = nonEmpty(config.token) ?? readFirstPairingToken();
  const model = nonEmpty(config.model) ?? "claude-opus-4-7";
  const rawSystemPrompt = nonEmpty(config.systemPrompt) ?? undefined;
  const label = nonEmpty(config.label) ?? agent.name;

  // NEW 3 V1.1 (-tne): feature-flagged runtime envelope enforcement.
  // When enabled, the adapter (a) prepends a concrete envelope block to
  // the systemPrompt (so Claude sees the allowlist declaratively) and
  // (b) observes tool_use events; a tool call that violates the envelope
  // aborts the session and returns errorCode="envelope_violation".
  // This is advisory, not a real gate — see the design doc at
  // overwatch-v3/ceo-plans/NEW-3-V2-runtime-envelope-enforcement.md for
  // why, and for the V1.2/V2 upgrade path.
  const enforceRuntimeEnvelope = asBoolean(config.enforceRuntimeEnvelope);
  const scope = enforceRuntimeEnvelope ? (ctx.scope ?? null) : null;
  const scopeMatcher: ScopeMatcher | null = scope ? compileScopeMatcher(scope) : null;
  const systemPrompt =
    scope && scopeMatcher
      ? [renderEnvelopeBlock(scope), rawSystemPrompt].filter(Boolean).join("\n\n")
      : rawSystemPrompt;

  // cwd is the agent workspace directory. skipWorktree=true because it's not a git repo.
  const cwd = nonEmpty(config.cwd) ?? join(homedir(), ".paperclip", "instances", "default", "workspaces", agent.id);

  if (!existsSync(cwd)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `claudebridge_local: cwd does not exist: ${cwd}`,
      errorCode: "claudebridge_cwd_missing",
    };
  }

  // Paperclip env vars (PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, etc.)
  // merged onto the parent process env. buildPaperclipEnv returns only
  // Paperclip-specific vars; if we pass that raw the child Claude Code
  // CLI loses HOME/PATH/XDG_CONFIG_HOME and can't find its auth
  // (manifests as "Not logged in · Please run /login" even though
  // `claude auth status` is healthy on the Mac).
  const processEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") processEnv[k] = v;
  }
  const paperclipEnv: Record<string, string> = {
    ...processEnv,
    ...buildPaperclipEnv(agent),
  };
  // Also pass auth token so the agent can call back to Paperclip.
  if (ctx.authToken) paperclipEnv["PAPERCLIP_API_KEY"] = ctx.authToken;

  // Build the wake prompt. Paperclip's adapter context puts the
  // operator's reason (the Captain's Desk prompt) at context.wakeReason —
  // same field claude-local reads. context.paperclipWake carries the
  // issue-thread wake payload when a run is issue-bound.
  const wakePayload = context?.paperclipWake;
  const wakePromptSection = wakePayload ? renderPaperclipWakePrompt(wakePayload) : null;
  const rawPrompt = nonEmpty(context?.wakeReason as string) ?? "";

  // NEW 0-B-8 (-tne): prepend a concrete CONTEXT block with the
  // Paperclip ids and API key. Claude's Bash tool runs in a sandbox
  // that doesn't expose PAPERCLIP_* env vars, so the agent needs the
  // literal values in the prompt to curl Paperclip's API. Values are
  // scoped (per-agent API key, per-company id) — safe to include.
  const contextBlock = [
    "=== Paperclip context ===",
    `PAPERCLIP_API_URL=${paperclipEnv.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100"}`,
    `PAPERCLIP_COMPANY_ID=${paperclipEnv.PAPERCLIP_COMPANY_ID ?? ""}`,
    `PAPERCLIP_AGENT_ID=${paperclipEnv.PAPERCLIP_AGENT_ID ?? ""}`,
    `PAPERCLIP_RUN_ID=${paperclipEnv.PAPERCLIP_RUN_ID ?? ""}`,
    paperclipEnv.PAPERCLIP_API_KEY
      ? `PAPERCLIP_API_KEY=${paperclipEnv.PAPERCLIP_API_KEY}`
      : "PAPERCLIP_API_KEY=(not provisioned — hit /api/agents/me for self-discovery)",
    "=========================",
    "",
    "Use these literal values in your curl commands — Bash sandbox",
    "does NOT inherit these as env vars. Substitute them directly.",
  ].join("\n");

  const wakeText = [contextBlock, rawPrompt, wakePromptSection]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!wakeText) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "claudebridge_local: no prompt text in context",
      errorCode: "claudebridge_no_prompt",
    };
  }

  const client = new ClaudebridgeWsClient();

  const log = async (line: string) => onLog("stdout", line + "\n");

  try {
    await log(`[claudebridge_local] connecting to ${wsUrl}`);
    await client.connect(wsUrl, token);
    await log("[claudebridge_local] authenticated");

    // Reuse an existing Claudebridge session across runs to preserve context.
    const existingSessionId = nonEmpty(runtime.sessionParams?.claudebridgeSessionId as string);

    let claudebridgeSessionId = "";
    let isNewSession = false;

    // Register event handler BEFORE sending the message to avoid race.
    let turnEndResolve!: (result: TurnEndResult) => void;
    let turnEndReject!: (err: Error) => void;

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let finalModel = model;
    let turnEnded = false;

    type TurnEndResult = {
      stopReason: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };

    const turnEndPromise = new Promise<TurnEndResult>((res, rej) => {
      turnEndResolve = res;
      turnEndReject = rej;
    });

    // Track accumulated text output for summary.
    let textAccumulator = "";

    // NEW 3 V1.1 (-tne): runtime envelope violation tracker. When the
    // matcher flags a dispatched tool call, we stash the violation and
    // abort the session below. The run returns errorCode="envelope_violation".
    let envelopeViolation: {
      toolName: string;
      rule: string;
      inputSnippet: string;
    } | null = null;

    client.setEventHandler((env) => {
      if (env.type === "text_delta") {
        const text = (env.payload as { text: string }).text;
        textAccumulator += text;
        void onLog("stdout", text);
        return;
      }

      if (env.type === "thinking") {
        const text = (env.payload as { text: string }).text;
        void onLog("stdout", `[thinking] ${text}`);
        return;
      }

      if (env.type === "tool_use") {
        const p = env.payload as { name: string; toolUseId: string; input: unknown };
        void onLog("stdout", `\n[tool_use] ${p.name} ${JSON.stringify(p.input)}\n`);

        // Runtime envelope check (best-effort, post-hoc).
        if (scopeMatcher && !envelopeViolation) {
          try {
            const check = scopeMatcher.checkTool(p.name, p.input);
            if (!check.ok) {
              let snippet = "";
              try {
                snippet = JSON.stringify(p.input).slice(0, 200);
              } catch {
                snippet = "<unserializable>";
              }
              envelopeViolation = {
                toolName: p.name,
                rule: check.rule,
                inputSnippet: snippet,
              };
              const event = {
                ts: new Date().toISOString(),
                type: "envelope_violation",
                toolName: p.name,
                matchedRule: check.rule,
                enforcement: "post_hoc_abort",
                action: "turn_aborted",
                inputSnippet: snippet,
              };
              void onLog("stderr", `[envelope_violation] ${JSON.stringify(event)}\n`);
              // Abort the session — best-effort, we don't await.
              void (async () => {
                try {
                  await client.request(
                    "claude.session.close",
                    { sessionId: claudebridgeSessionId },
                    5_000,
                  );
                } catch {
                  // Ignore — the close may race with turn completion.
                }
                if (!turnEnded) {
                  turnEnded = true;
                  turnEndReject(
                    new Error(
                      `envelope_violation: ${p.name} rejected by rule ${check.rule}`,
                    ),
                  );
                }
              })();
            }
          } catch (err) {
            // Never let the matcher crash the run.
            void onLog(
              "stderr",
              `[envelope_matcher_error] ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        return;
      }

      if (env.type === "tool_result") {
        const p = env.payload as { toolUseId: string; isError: boolean };
        void onLog("stdout", `[tool_result] ${p.toolUseId} isError=${p.isError}\n`);
        return;
      }

      if (env.type === "turn_end") {
        if (!turnEnded) {
          turnEnded = true;
          turnEndResolve(env.payload as TurnEndResult);
        }
        return;
      }

      if (env.type === "session_error") {
        const p = env.payload as { code: string; message: string; fatal: boolean };
        void onLog("stderr", `[session_error] ${p.code}: ${p.message}\n`);
        if (p.fatal && !turnEnded) {
          turnEnded = true;
          turnEndReject(new Error(`claudebridge session_error ${p.code}: ${p.message}`));
        }
        return;
      }
    });

    // Try to reuse an existing session; create a new one on miss.
    if (existingSessionId) {
      try {
        await client.request("claude.session.send", { sessionId: existingSessionId, text: wakeText }, 10_000);
        claudebridgeSessionId = existingSessionId;
        await log(`[claudebridge_local] resumed session ${claudebridgeSessionId}`);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "SESSION_NOT_FOUND") {
          // Session expired (Claudebridge restart) — fall through to create.
          isNewSession = true;
        } else {
          throw err;
        }
      }
    } else {
      isNewSession = true;
    }

    if (isNewSession) {
      const createResult = (await client.request(
        "claude.session.create",
        {
          cwd,
          model,
          skipWorktree: true,
          label,
          ownerTag: "paperclip",
          env: paperclipEnv,
          // NEW 0-B-8 (-tne): Paperclip-owned agents run with
          // bypassPermissions so their Bash tool can actually call
          // Paperclip's API (curl, printenv, etc). Policy enforcement
          // lives upstream in Paperclip's envelope, not here.
          permissionMode: "bypassPermissions",
          ...(systemPrompt ? { systemPrompt } : {}),
        },
        30_000,
      )) as { sessionId: string; worktreePath: string };
      claudebridgeSessionId = createResult.sessionId;
      await log(`[claudebridge_local] created session ${claudebridgeSessionId}`);

      // Now send the message.
      await client.request("claude.session.send", { sessionId: claudebridgeSessionId, text: wakeText }, 10_000);
    }

    // Wait for the turn to complete or the abort signal.
    if (abortSignal) {
      await Promise.race([
        turnEndPromise,
        new Promise<never>((_, rej) => {
          if (abortSignal.aborted) {
            rej(new Error("aborted"));
            return;
          }
          abortSignal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        }),
      ]).catch(async (err: Error) => {
        if (err.message === "aborted") {
          await log("[claudebridge_local] abort signal received, interrupting session");
          try {
            await client.request("claude.session.close", { sessionId: claudebridgeSessionId }, 5_000);
          } catch {
            // ignore close errors on abort
          }
        }
        throw err;
      });
    } else {
      await turnEndPromise;
    }

    const turnResult = await turnEndPromise.catch(() => null);
    if (turnResult) {
      usage.inputTokens = turnResult.inputTokens ?? 0;
      usage.outputTokens = turnResult.outputTokens ?? 0;
      usage.cacheReadTokens = (turnResult.cacheReadTokens as number | undefined) ?? 0;
      usage.cacheWriteTokens = (turnResult.cacheWriteTokens as number | undefined) ?? 0;
      finalModel = turnResult.model ?? model;
    }

    await log(`\n[claudebridge_local] turn_end stopReason=${turnResult?.stopReason ?? "unknown"}`);

    // Do NOT close the session — leaving it open lets Second Brain → Claude
    // show the session in the iPad UI and allows resuming on next wake.

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      model: finalModel,
      provider: "anthropic",
      billingType: "subscription",
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadTokens,
      },
      sessionParams: { claudebridgeSessionId },
      sessionDisplayId: claudebridgeSessionId,
      summary: textAccumulator.slice(0, 500) || null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[claudebridge_local] error: ${msg}\n`);
    const isAbort = msg === "aborted" || (err instanceof Error && err.name === "AbortError");
    // NEW 3 V1.1 (-tne): distinguish envelope-violation aborts from generic
    // errors so the operator (and downstream state machines like autonomy
    // demotion at V2) can key off the errorCode.
    const isEnvelope = msg.startsWith("envelope_violation:");
    return {
      exitCode: isAbort ? 130 : 1,
      signal: isAbort ? "SIGINT" : null,
      timedOut: false,
      errorMessage: msg,
      errorCode: isEnvelope
        ? "envelope_violation"
        : isAbort
          ? "aborted"
          : "claudebridge_error",
    };
  } finally {
    client.close();
  }
}
