/**
 * Test for NEW 0-B-1 (-tne): abortSignal passthrough on
 * AdapterExecutionContext, honored by the openclaw-gateway adapter.
 *
 * When the host cancels via AbortController.abort(), the WebSocket must be
 * closed cleanly and the execute() promise must reject with an AbortError
 * (not with an error-shaped AdapterExecutionResult).
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
    const entry: Running = { server, sockets };

    server.on("error", (err) => reject(err));

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));

      // 1) send challenge immediately so the client can proceed with connect
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "test-nonce" },
        }),
      );

      // 2) respond to connect, but never respond to agent (so the host can
      // abort mid-flight).
      socket.on("message", (raw) => {
        let parsed: { type?: string; id?: string; method?: string };
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

        // Intentionally do not respond to "agent" — the abort test needs the
        // adapter to be mid-flight when we fire AbortController.abort().
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
  abortSignal: AbortSignal | undefined,
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
    runId: "run-test-abort",
    agent,
    runtime,
    config: {
      url,
      // Disable device auth so the mock server does not need to implement
      // ed25519 challenge/response signing. authToken is enough to satisfy
      // the outbound handshake.
      disableDeviceAuth: true,
      authToken: "test-token",
      // Short timeout so a hung test fails fast rather than hanging CI.
      waitTimeoutMs: 30_000,
      timeoutSec: 30,
    },
    context: {},
    onLog: async () => {},
    abortSignal,
  };
}

describe("openclaw-gateway execute abortSignal (NEW 0-B-1)", () => {
  it("rejects with AbortError and closes the websocket when the signal fires mid-flight", async () => {
    const { url, running: entry } = await startMockGateway();
    const controller = new AbortController();
    const ctx = buildContext(url, controller.signal);

    const promise = execute(ctx);

    // Wait until at least one client has connected so we know we are
    // mid-flight. The mock never answers "agent", so abort is the only way
    // this promise ever settles.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("mock gateway never saw a connection")),
        5_000,
      );
      const check = () => {
        if (entry.sockets.size > 0) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });

    controller.abort();

    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");

    // WS should have been closed cleanly by the adapter in response to abort.
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => resolve(), 2_000);
      const check = () => {
        if (entry.sockets.size === 0) {
          clearTimeout(deadline);
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    expect(entry.sockets.size).toBe(0);
  }, 15_000);

  it("rejects immediately with AbortError if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = buildContext("ws://127.0.0.1:1", controller.signal);
    let caught: unknown = null;
    try {
      await execute(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  });
});
