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

// ─── Runtime envelope enforcement (NEW 3 V1.2, -tne) ─────────────────────────
//
// Real runtime enforcement via Claudebridge's `envelope` param on
// `claude.session.create`. Claudebridge builds an SDK `canUseTool`
// callback from the rules, denying out-of-envelope tool calls BEFORE
// they execute. On denial Claudebridge emits a `tool_denied` event
// which we log to the Paperclip run stdout with a `[envelope_deny]`
// prefix for the iPad feed parser.
//
// Replaces the V1.1 stub (prompt-only + post-hoc abort) that lived here.
// See `ceo-plans/NEW-3-V2-runtime-envelope-enforcement.md` for the full
// trajectory and where V2 (openclaw-side enforcement) fits in.

type AdapterScope = NonNullable<AdapterExecutionContext["scope"]>;

/**
 * Build the envelope param Claudebridge accepts on session.create from
 * the Paperclip scope context. Returns null when the scope declares no
 * enforceable rules — in that case we send NO envelope param at all
 * so Claudebridge skips installing canUseTool.
 */
function buildEnvelopeFromScope(scope: AdapterScope | undefined): {
  allowedPaths?: string[];
  deniedPaths?: string[];
  deniedTools?: string[];
  networkAccess?: "none" | "localhost" | "full";
  workingDir?: string;
} | null {
  if (!scope) return null;
  const hasRule =
    (scope.allowedTools && scope.allowedTools.length > 0) ||
    (scope.deniedTools && scope.deniedTools.length > 0) ||
    (scope.allowedPaths && scope.allowedPaths.length > 0) ||
    (scope.deniedPaths && scope.deniedPaths.length > 0) ||
    (scope.networkAccess && scope.networkAccess !== "full") ||
    !!scope.workingDir;
  if (!hasRule) return null;
  const env: ReturnType<typeof buildEnvelopeFromScope> = {};
  if (scope.allowedPaths?.length) env!.allowedPaths = [...scope.allowedPaths];
  if (scope.deniedPaths?.length) env!.deniedPaths = [...scope.deniedPaths];
  // allowedTools flows as a separate param in Claudebridge (it maps to
  // the SDK's declarative allowedTools list, not the canUseTool). See
  // the session.create call below.
  if (scope.deniedTools?.length) env!.deniedTools = [...scope.deniedTools];
  if (scope.networkAccess) env!.networkAccess = scope.networkAccess;
  if (scope.workingDir) env!.workingDir = scope.workingDir;
  return env;
}

/**
 * Short advisory block telling the agent what the rules are. With real
 * enforcement in Claudebridge via canUseTool, this is informational —
 * agents that know their envelope can save turns by not attempting
 * denied tool calls in the first place.
 */
function renderEnvelopeBlock(scope: AdapterScope): string {
  const lines: string[] = [
    "=== Runtime envelope (enforced) ===",
    "Your operator has declared a scope envelope for this run.",
    "Tool calls outside the envelope are rejected BEFORE they execute",
    "(you'll see a deny response). The rules:",
    "",
  ];
  if (scope.allowedTools?.length) lines.push(`allowed_tools: ${scope.allowedTools.join(", ")}`);
  if (scope.deniedTools?.length) lines.push(`denied_tools: ${scope.deniedTools.join(", ")}`);
  if (scope.allowedPaths?.length) lines.push(`allowed_paths: ${scope.allowedPaths.join(", ")}`);
  if (scope.deniedPaths?.length) lines.push(`denied_paths: ${scope.deniedPaths.join(", ")}`);
  if (scope.networkAccess) lines.push(`network_access: ${scope.networkAccess}`);
  if (scope.workingDir) lines.push(`working_dir: ${scope.workingDir}`);
  lines.push("", "If a needed action is outside the envelope, stop and ask the operator to widen it.");
  lines.push("===================================");
  return lines.join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, runtime, context, onLog, abortSignal } = ctx;

  const wsUrl = nonEmpty(config.wsUrl) ?? "ws://127.0.0.1:7737";
  const token = nonEmpty(config.token) ?? readFirstPairingToken();
  const model = nonEmpty(config.model) ?? "claude-opus-4-7";
  const rawSystemPrompt = nonEmpty(config.systemPrompt) ?? undefined;
  const label = nonEmpty(config.label) ?? agent.name;

  // NEW 3 V1.2 (-tne): real runtime envelope enforcement via
  // Claudebridge's canUseTool callback. When ctx.scope has any rule
  // set, we pass an `envelope` param on session.create and Claudebridge
  // gates each tool call. Also prepend an advisory block to the
  // systemPrompt so the agent knows the rules. Always-on — no feature
  // flag. Empty scope = no envelope param sent = no enforcement.
  const scope = ctx.scope ?? null;
  const envelopeParam = scope ? buildEnvelopeFromScope(scope) : null;
  const allowedToolsList =
    scope?.allowedTools && scope.allowedTools.length > 0 ? [...scope.allowedTools] : undefined;
  const systemPrompt =
    scope && envelopeParam
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
        return;
      }

      // NEW 3 V1.2 (-tne): Claudebridge's canUseTool callback fires this
      // event when it denies a tool call BEFORE it executes. Log with a
      // structured prefix the iPad's LiveRunFeed parser recognizes to
      // render a distinct "DENIED" chip.
      if (env.type === "tool_denied") {
        const p = env.payload as {
          toolName: string;
          input: unknown;
          reason: string;
          matchedPattern?: string;
        };
        const patternSuffix = p.matchedPattern ? ` (pattern: ${p.matchedPattern})` : "";
        void onLog(
          "stdout",
          `\n[envelope_deny] ${p.toolName}: ${p.reason}${patternSuffix}\n`,
        );
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
      // NEW 3 V1.2 (-tne): when an envelope is active, DROP
      // permissionMode=bypassPermissions. bypassPermissions in the
      // Claude Agent SDK short-circuits canUseTool — if we keep it
      // while also supplying envelope, the envelope is never
      // consulted. With envelope present, fall back to the SDK's
      // default permission flow (which respects canUseTool) but also
      // pass our allowlist so deterministic tool-name checks don't
      // even hit canUseTool.
      const effectivePermissionMode = envelopeParam ? "default" : "bypassPermissions";
      const createResult = (await client.request(
        "claude.session.create",
        {
          cwd,
          model,
          skipWorktree: true,
          label,
          ownerTag: "paperclip",
          env: paperclipEnv,
          permissionMode: effectivePermissionMode,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(allowedToolsList ? { allowedTools: allowedToolsList } : {}),
          ...(scope?.deniedTools?.length ? { disallowedTools: [...scope.deniedTools] } : {}),
          ...(envelopeParam ? { envelope: envelopeParam } : {}),
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
    // NEW 3 V1.2: envelope violations are non-fatal — Claudebridge denies
    // the tool call, the agent receives a deny response, and the run
    // continues. So we no longer error-code here on envelope violations.
    return {
      exitCode: isAbort ? 130 : 1,
      signal: isAbort ? "SIGINT" : null,
      timedOut: false,
      errorMessage: msg,
      errorCode: isAbort ? "aborted" : "claudebridge_error",
    };
  } finally {
    client.close();
  }
}
