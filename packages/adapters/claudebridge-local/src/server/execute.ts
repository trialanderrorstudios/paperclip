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

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, agent, runtime, context, onLog, abortSignal } = ctx;

  const wsUrl = nonEmpty(config.wsUrl) ?? "ws://127.0.0.1:7737";
  const token = nonEmpty(config.token) ?? readFirstPairingToken();
  const model = nonEmpty(config.model) ?? "claude-opus-4-7";
  const systemPrompt = nonEmpty(config.systemPrompt) ?? undefined;
  const label = nonEmpty(config.label) ?? agent.name;

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

  // Build the wake prompt. Paperclip's adapter context puts the
  // operator's reason (the Captain's Desk prompt) at context.wakeReason —
  // same field claude-local reads. context.paperclipWake carries the
  // issue-thread wake payload when a run is issue-bound.
  const wakePayload = context?.paperclipWake;
  const wakePromptSection = wakePayload ? renderPaperclipWakePrompt(wakePayload) : null;
  const rawPrompt = nonEmpty(context?.wakeReason as string) ?? "";
  const wakeText = [rawPrompt, wakePromptSection].filter(Boolean).join("\n\n").trim();

  if (!wakeText) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "claudebridge_local: no prompt text in context",
      errorCode: "claudebridge_no_prompt",
    };
  }

  // Paperclip env vars (PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, etc.).
  const paperclipEnv = buildPaperclipEnv(agent);
  // Also pass auth token so the agent can call back to Paperclip.
  if (ctx.authToken) paperclipEnv["PAPERCLIP_API_KEY"] = ctx.authToken;

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
