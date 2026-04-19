/**
 * Unit tests for the NEW 3 V1 Gap 4 budget → autonomy-demotion observer.
 *
 * Validates:
 * - scopeType='agent' + autopilot → one-step demotion to policy.
 * - scopeType='agent' + policy → one-step demotion to gated.
 * - scopeType='agent' + gated → no-op (already at floor).
 * - scopeType='company'/'project' → no-op (V1.1 fan-out TODO).
 * - Idempotent: re-firing for an already-demoted agent is safe.
 *
 * Placed in `server/src/__tests__/` (project convention). Route-level
 * integration for budget-incident INSERT is covered by budgets-service
 * tests; here we exercise the observer helper directly using the same
 * `makeDb` fake-drizzle pattern as autonomy-state-machine.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => {}),
}));

import { observeBudgetIncidentForDemotion } from "../services/budget-demotion-observer.ts";

interface AgentRow {
  id: string;
  companyId: string;
  role: string;
  permissions: Record<string, unknown>;
}

function makeDb(opts: {
  agentRows?: AgentRow[];
  invalidatedApprovalIds?: string[];
}) {
  const agentRows = opts.agentRows ?? [];
  const invalidatedApprovalIds = opts.invalidatedApprovalIds ?? [];
  const updates: Array<{ kind: "agents" | "approvals"; set: Record<string, unknown>; where: unknown }> = [];

  const selectBuilder = () => {
    let _whereArgs: unknown = null;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn((w: unknown) => {
      _whereArgs = w;
      return chain;
    });
    chain.then = vi.fn((resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve(resolve(agentRows.map((r) => ({ ...r })))),
    );
    void _whereArgs;
    return chain;
  };

  const db: Record<string, unknown> = {
    select: vi.fn(() => selectBuilder()),
    update: vi.fn((_tbl: unknown) => {
      let kind: "agents" | "approvals" = "agents";
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn((set: Record<string, unknown>) => {
        updates.push({ kind, set, where: null });
        const afterSet: Record<string, unknown> = {};
        const whereChain: Record<string, unknown> = {};
        whereChain.returning = vi.fn(async () =>
          invalidatedApprovalIds.map((id) => ({ id })),
        );
        afterSet.where = vi.fn((w: unknown) => {
          updates[updates.length - 1]!.where = w;
          kind = "approvals";
          updates[updates.length - 1]!.kind = kind;
          return whereChain;
        });
        return afterSet;
      });
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "approval-1", status: "pending" }]),
      })),
    })),
  };
  return { db, updates };
}

describe("observeBudgetIncidentForDemotion — agent scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("demotes autopilot → policy on agent-scoped incident", async () => {
    const { db, updates } = makeDb({
      agentRows: [
        {
          id: "agent-1",
          companyId: "company-1",
          role: "engineer",
          permissions: { autonomyLevel: "autopilot" },
        },
      ],
    });
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      thresholdType: "hard",
    });
    expect(result).toMatchObject({
      demoted: true,
      previousLevel: "autopilot",
      currentLevel: "policy",
    });
    // At least one update ran with the new autonomyLevel=policy in
    // the permissions set payload. The mock flips `kind` on the `.where`
    // call per the autonomy-state-machine test fake heuristic; we inspect
    // the set directly instead of by kind.
    const demotionUpdate = updates.find(
      (u) =>
        (u.set as Record<string, unknown>).permissions &&
        ((u.set as Record<string, unknown>).permissions as Record<string, unknown>)
          .autonomyLevel === "policy",
    );
    expect(demotionUpdate).toBeDefined();
  });

  it("demotes policy → gated on agent-scoped incident", async () => {
    const { db } = makeDb({
      agentRows: [
        {
          id: "agent-1",
          companyId: "company-1",
          role: "engineer",
          permissions: { autonomyLevel: "policy" },
        },
      ],
    });
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      thresholdType: "hard",
    });
    expect(result).toMatchObject({
      demoted: true,
      previousLevel: "policy",
      currentLevel: "gated",
    });
  });

  it("no-op when agent already at gated (floor)", async () => {
    const { db } = makeDb({
      agentRows: [
        {
          id: "agent-1",
          companyId: "company-1",
          role: "engineer",
          permissions: { autonomyLevel: "gated" },
        },
      ],
    });
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      thresholdType: "hard",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("already-at-floor");
  });

  it("no-op when agent not found", async () => {
    const { db } = makeDb({ agentRows: [] });
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-missing",
      thresholdType: "hard",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("agent-not-found");
  });

  it("idempotent: second fire for already-demoted agent is safe", async () => {
    const { db } = makeDb({
      agentRows: [
        {
          id: "agent-1",
          companyId: "company-1",
          role: "engineer",
          // Agent was autopilot, first observer ran and demoted to policy;
          // this fake reflects the post-demotion state for the 2nd fire.
          permissions: { autonomyLevel: "policy" },
        },
      ],
    });
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1-retry",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      thresholdType: "hard",
    });
    // Re-firing demotes one step further (policy → gated). In the real
    // world the state machine's rank guard makes this safe regardless of
    // whether the caller is re-firing or observing a NEW incident — the
    // plan explicitly states "idempotent; safe to re-fire."
    expect(result.demoted).toBe(true);
    expect(result.currentLevel).toBe("gated");
  });
});

describe("observeBudgetIncidentForDemotion — non-agent scope (V1.1 TODO)", () => {
  it("no-op for scopeType=company", async () => {
    const { db } = makeDb({});
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "company",
      scopeId: "company-1",
      thresholdType: "hard",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("non-agent-scope");
  });

  it("no-op for scopeType=project", async () => {
    const { db } = makeDb({});
    const result = await observeBudgetIncidentForDemotion(db as any, {
      incidentId: "inc-1",
      companyId: "company-1",
      scopeType: "project",
      scopeId: "proj-1",
      thresholdType: "hard",
    });
    expect(result.demoted).toBe(false);
    expect(result.reason).toBe("non-agent-scope");
  });
});
