/**
 * Unit tests for the NEW 3 V1.5 incident-demotion observer.
 *
 * Validates:
 * - Allowlist-violation incident demotes autopilot → policy.
 * - Allowlist-violation incident demotes policy → gated.
 * - Already-gated agent: no-op (already at floor).
 * - Agent not found: no-op with reason.
 * - Errors in the underlying state machine are swallowed (fire-and-
 *   forget contract — caller's activity row must not roll back).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => {}),
}));

import { observeIncidentForDemotion } from "../services/incident-demotion-observer.ts";

interface AgentRow {
  id: string;
  role: string;
  permissions: Record<string, unknown>;
}

function makeDb(opts: { agentRows?: AgentRow[]; throwOnUpdate?: boolean }) {
  const agentRows = opts.agentRows ?? [];
  const updates: Array<{ kind: string; set: Record<string, unknown> }> = [];

  const selectBuilder = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.then = vi.fn((resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve(resolve(agentRows.map((r) => ({ ...r })))),
    );
    return chain;
  };

  const db: Record<string, unknown> = {
    select: vi.fn(() => selectBuilder()),
    update: vi.fn(() => {
      let kind = "agents";
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn((set: Record<string, unknown>) => {
        if (opts.throwOnUpdate) {
          throw new Error("synthetic update failure");
        }
        updates.push({ kind, set });
        const afterSet: Record<string, unknown> = {};
        const whereChain: Record<string, unknown> = {};
        whereChain.returning = vi.fn(async () => []);
        afterSet.where = vi.fn(() => {
          kind = "approvals";
          return whereChain;
        });
        return afterSet;
      });
      return chain;
    }),
  };
  return { db, updates };
}

describe("observeIncidentForDemotion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("demotes autopilot → policy on allowlist_violation", async () => {
    const { db, updates } = makeDb({
      agentRows: [
        {
          id: "agent-1",
          role: "engineer",
          permissions: { autonomyLevel: "autopilot" },
        },
      ],
    });
    const result = await observeIncidentForDemotion(db as any, {
      agentId: "agent-1",
      companyId: "company-1",
      reason: "allowlist_violation",
      runId: "run-x",
    });
    expect(result.demoted).toBe(true);
    expect(result.previousLevel).toBe("autopilot");
    expect(result.currentLevel).toBe("policy");
    const agentUpdate = updates.find(
      (u) => (u.set.permissions as Record<string, unknown>)?.autonomyLevel === "policy",
    );
    expect(agentUpdate).toBeDefined();
  });

  it("demotes policy → gated on allowlist_violation", async () => {
    const { db, updates } = makeDb({
      agentRows: [
        {
          id: "agent-2",
          role: "engineer",
          permissions: { autonomyLevel: "policy" },
        },
      ],
    });
    const result = await observeIncidentForDemotion(db as any, {
      agentId: "agent-2",
      companyId: "company-1",
      reason: "allowlist_violation",
    });
    expect(result.demoted).toBe(true);
    expect(result.previousLevel).toBe("policy");
    expect(result.currentLevel).toBe("gated");
    const agentUpdate = updates.find(
      (u) => (u.set.permissions as Record<string, unknown>)?.autonomyLevel === "gated",
    );
    expect(agentUpdate).toBeDefined();
  });

  it("no-op when already gated (already at floor)", async () => {
    const { db, updates } = makeDb({
      agentRows: [
        {
          id: "agent-3",
          role: "engineer",
          permissions: { autonomyLevel: "gated" },
        },
      ],
    });
    const result = await observeIncidentForDemotion(db as any, {
      agentId: "agent-3",
      companyId: "company-1",
      reason: "allowlist_violation",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("already-at-floor");
    expect(updates).toHaveLength(0);
  });

  it("no-op + reason on agent-not-found", async () => {
    const { db, updates } = makeDb({ agentRows: [] });
    const result = await observeIncidentForDemotion(db as any, {
      agentId: "missing",
      companyId: "company-1",
      reason: "allowlist_violation",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("agent-not-found");
    expect(updates).toHaveLength(0);
  });

  it("swallows downstream errors (fire-and-forget contract)", async () => {
    const { db } = makeDb({
      agentRows: [
        {
          id: "agent-err",
          role: "engineer",
          permissions: { autonomyLevel: "autopilot" },
        },
      ],
      throwOnUpdate: true,
    });
    // Must not throw — callers (heartbeat.ts, agents.ts) emit the
    // activity row first and call this fire-and-forget.
    const result = await observeIncidentForDemotion(db as any, {
      agentId: "agent-err",
      companyId: "company-1",
      reason: "allowlist_violation",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("demote-error");
  });
});
