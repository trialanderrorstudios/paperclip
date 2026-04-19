/**
 * Test for NEW 0-B-2 (-tne): structured scope fields on
 * AdapterExecutionContext, serialized into the openclaw-gateway WS
 * `agent` spawn frame.
 *
 * V1 is advisory — we only assert the serialization. Runtime enforcement
 * is V1.1 per the Overwatch-v3 plan.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AdapterAgent,
  AdapterExecutionContext,
  AdapterRuntime,
} from "@paperclipai/adapter-utils";
import { execute } from "../server/execute.js";

type Running = {
  server: WebSocketServer;
  sockets: Set<WebSocket>;
  capturedAgentParams: Record<string, unknown> | null;
};

const running: Running[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) continue;
    for (const socket of entry.sockets) {
      try {
        socket.close(1000, "test teardown");
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});

function startMockGateway(): Promise<{ url: string; running: Running }> {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const sockets = new Set<WebSocket>();
    const entry: Running = { server, sockets, capturedAgentParams: null };

    server.on("error", (err) => reject(err));

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));

      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }),
      );

      socket.on("message", (raw) => {
        let parsed: {
          type?: string;
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (parsed.type !== "req" || !parsed.id) return;

        if (parsed.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { protocol: 3 },
            }),
          );
          return;
        }

        if (parsed.method === "agent") {
          entry.capturedAgentParams = parsed.params ?? null;
          // Respond with a successful ok status so execute() completes
          // cleanly without needing an agent.wait roundtrip.
          socket.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: {
                status: "ok",
                runId: "run-test-scope",
                result: { text: "done" },
              },
            }),
          );
          return;
        }
      });
    });

    server.on("listening", () => {
      const address = server.address() as AddressInfo;
      const url = `ws://127.0.0.1:${address.port}`;
      running.push(entry);
      resolve({ url, running: entry });
    });
  });
}

function buildContext(
  url: string,
  scope: AdapterExecutionContext["scope"],
): AdapterExecutionContext {
  const agent: AdapterAgent = {
    id: "agent-test",
    companyId: "company-test",
    name: "TestAgent",
    adapterType: "openclaw_gateway",
    adapterConfig: {},
  };
  const runtime: AdapterRuntime = {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  };
  return {
    runId: "run-test-scope",
    agent,
    runtime,
    config: {
      url,
      disableDeviceAuth: true,
      authToken: "test-token",
      timeoutSec: 10,
      waitTimeoutMs: 5_000,
    },
    context: {},
    onLog: async () => {},
    scope,
  };
}

describe("openclaw-gateway execute structured scope (NEW 0-B-2)", () => {
  it("serializes context.scope into the WS agent spawn frame", async () => {
    const { url, running: entry } = await startMockGateway();
    const ctx = buildContext(url, {
      allowedTools: ["Read", "Grep"],
      allowedPaths: ["/tmp", "/workspace"],
      deniedTools: ["Bash"],
      deniedPaths: ["/etc"],
      workingDir: "/tmp",
      networkAccess: "localhost",
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const captured = entry.capturedAgentParams;
    expect(captured).not.toBeNull();
    const scope = (captured as Record<string, unknown>)?.scope as
      | Record<string, unknown>
      | undefined;
    expect(scope).toBeDefined();
    expect(scope).toEqual({
      allowedTools: ["Read", "Grep"],
      allowedPaths: ["/tmp", "/workspace"],
      deniedTools: ["Bash"],
      deniedPaths: ["/etc"],
      workingDir: "/tmp",
      networkAccess: "localhost",
    });
  }, 15_000);

  it("omits the scope field entirely when no scope is provided", async () => {
    const { url, running: entry } = await startMockGateway();
    const ctx = buildContext(url, undefined);

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const captured = entry.capturedAgentParams;
    expect(captured).not.toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(captured ?? {}, "scope"),
    ).toBe(false);
  }, 15_000);

  it("omits empty arrays and invalid networkAccess values", async () => {
    const { url, running: entry } = await startMockGateway();
    const ctx = buildContext(url, {
      allowedTools: [],
      allowedPaths: [],
      workingDir: "",
      networkAccess: "localhost",
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const captured = entry.capturedAgentParams;
    const scope = (captured as Record<string, unknown>)?.scope as
      | Record<string, unknown>
      | undefined;
    // Only networkAccess survives the filter; empty arrays + empty
    // workingDir are stripped.
    expect(scope).toEqual({ networkAccess: "localhost" });
  }, 15_000);
});
