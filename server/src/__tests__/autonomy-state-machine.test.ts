import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  autonomyStateMachine,
  effectiveAutonomyLevel,
  resolveCompanyMaxLevel,
  capToCompanyFloor,
  AutonomyStateMachineError,
} from "../services/autonomy-state-machine.ts";

// Avoid loading the real logActivity (which imports instanceSettingsService etc.).
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => {}),
}));

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

  // select builder
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
    // Note: _whereArgs is kept in closure to avoid ts-unused warnings
    void _whereArgs;
    return chain;
  };

  const db: Record<string, unknown> = {
    select: vi.fn(() => selectBuilder()),
    update: vi.fn((_tbl: unknown) => {
      // Detect which table is being updated by the caller path — but the
      // state machine calls with agents vs approvals, and we use the most
      // recent call to decide. Here we split into two chains: one for
      // agents (resolves undefined) and one for approvals (resolves rows
      // with returning()).
      let kind: "agents" | "approvals" = "agents";
      // Heuristic: count prior update() calls on this db — odd-numbered
      // first is agents then approvals, by position in state machine.
      // Instead, rely on the approvals.returning() call path.
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn((set: Record<string, unknown>) => {
        updates.push({ kind, set, where: null });
        const afterSet: Record<string, unknown> = {};
        afterSet.where = vi.fn(async (w: unknown) => {
          updates[updates.length - 1]!.where = w;
          // If this is an approvals update with returning, it will chain
          // to .returning(). The drizzle API is:
          //   db.update(table).set(...).where(...).returning(...)
          // But when no returning is chained, we still resolve here.
          return [];
        });
        // Allow chaining .where(...).returning()
        // Drizzle chains both forms; we provide a thenable so await works
        // either way.
        const whereChain: Record<string, unknown> = {};
        whereChain.returning = vi.fn(async () =>
          invalidatedApprovalIds.map((id) => ({ id })),
        );
        afterSet.where = vi.fn((w: unknown) => {
          updates[updates.length - 1]!.where = w;
          // Mark this as approvals update (the only update path that uses .returning)
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

describe("effectiveAutonomyLevel", () => {
  it("returns explicit level when set", () => {
    expect(effectiveAutonomyLevel({ autonomyLevel: "policy" }, "ceo")).toBe("policy");
  });

  it("falls back to role default when permission empty", () => {
    expect(effectiveAutonomyLevel({}, "ceo")).toBe("gated");
    expect(effectiveAutonomyLevel(null, "engineer")).toBe("gated");
  });

  it("defaults to gated when role unknown and permissions empty", () => {
    expect(effectiveAutonomyLevel({}, "alien_overlord")).toBe("gated");
  });

  it("ignores invalid-string autonomyLevel values", () => {
    expect(effectiveAutonomyLevel({ autonomyLevel: "super" }, "general")).toBe("gated");
  });
});

describe("resolveCompanyMaxLevel compat shim", () => {
  it("uses explicit maxLevel when set", () => {
    expect(resolveCompanyMaxLevel({ maxLevel: "autopilot" }, true)).toBe("autopilot");
  });

  it("synthesizes gated when policy empty + requireBoardApproval=true", () => {
    expect(resolveCompanyMaxLevel({}, true)).toBe("gated");
  });

  it("synthesizes policy when policy empty + requireBoardApproval=false", () => {
    expect(resolveCompanyMaxLevel({}, false)).toBe("policy");
  });

  it("treats null policy as empty", () => {
    expect(resolveCompanyMaxLevel(null, false)).toBe("policy");
  });
});

describe("capToCompanyFloor", () => {
  it("passes target through when at-or-below floor", () => {
    expect(capToCompanyFloor("policy", "autopilot")).toBe("policy");
    expect(capToCompanyFloor("gated", "policy")).toBe("gated");
  });

  it("caps target when target exceeds floor", () => {
    expect(capToCompanyFloor("autopilot", "policy")).toBe("policy");
    expect(capToCompanyFloor("policy", "gated")).toBe("gated");
  });
});

describe("autonomyStateMachine.promote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes gated → policy for a board_member (non-CEO agent)", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: {} },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.promote({
      agentId: "a1",
      targetLevel: "policy",
      actor: { actorType: "user", actorId: "u1", membershipRole: "admin" },
    });
    expect(result).toMatchObject({ previousLevel: "gated", currentLevel: "policy", tier: "board_member" });
  });

  it("rejects board_member promoting CEO to autopilot", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "ceo", permissions: { autonomyLevel: "policy" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.promote({
        agentId: "a1",
        targetLevel: "autopilot",
        actor: { actorType: "user", actorId: "u1", membershipRole: "admin" },
      }),
    ).rejects.toThrow(AutonomyStateMachineError);
  });

  it("allows board_owner promoting CEO to autopilot", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "ceo", permissions: { autonomyLevel: "policy" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.promote({
      agentId: "a1",
      targetLevel: "autopilot",
      actor: { actorType: "user", actorId: "u1", membershipRole: "owner" },
    });
    expect(result.currentLevel).toBe("autopilot");
  });

  it("rejects skip-step promotion gated → autopilot", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "general", permissions: {} },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.promote({
        agentId: "a1",
        targetLevel: "autopilot",
        actor: { actorType: "user", actorId: "u1", membershipRole: "owner" },
      }),
    ).rejects.toMatchObject({ code: "invalid_step" });
  });

  it("rejects no-op promotion", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "general", permissions: { autonomyLevel: "policy" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.promote({
        agentId: "a1",
        targetLevel: "policy",
        actor: { actorType: "user", actorId: "u1", membershipRole: "owner" },
      }),
    ).rejects.toMatchObject({ code: "noop" });
  });

  it("rejects board_observer promoting anything", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: {} },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.promote({
        agentId: "a1",
        targetLevel: "policy",
        actor: { actorType: "user", actorId: "u1", membershipRole: "viewer" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects agent actors via promote path (they must propose)", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: {} },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.promote({
        agentId: "a1",
        targetLevel: "policy",
        actor: { actorType: "agent", actorId: "a1" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("autonomyStateMachine.demote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("demotes autopilot → policy and invalidates pending promotion proposals", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: { autonomyLevel: "autopilot" } },
      ],
      invalidatedApprovalIds: ["p1", "p2"],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.demote({
      agentId: "a1",
      targetLevel: "policy",
      reason: "budget_breach",
      actor: { actorType: "system", actorId: "budget-observer" },
    });
    expect(result).toMatchObject({
      previousLevel: "autopilot",
      currentLevel: "policy",
      invalidatedProposals: 2,
    });
  });

  it("idempotent — second demotion attempt to same level emits audit but skips mutation", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: { autonomyLevel: "policy" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.demote({
      agentId: "a1",
      targetLevel: "policy",
      reason: "manual",
      actor: { actorType: "user", actorId: "u1", membershipRole: "owner" },
    });
    expect(result).toMatchObject({
      previousLevel: "policy",
      currentLevel: "policy",
      invalidatedProposals: 0,
    });
  });

  it("demotion-wins race: attempting to 'demote' to a higher level is a no-op", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: { autonomyLevel: "gated" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    // If an observer tries to "demote" to policy while the agent is at
    // gated, the current level stays gated (idempotent, rank-guarded).
    const result = await sm.demote({
      agentId: "a1",
      targetLevel: "policy",
      reason: "manual",
      actor: { actorType: "system", actorId: "obs" },
    });
    expect(result.currentLevel).toBe("gated");
    expect(result.invalidatedProposals).toBe(0);
  });

  it("board_member CAN demote CEO (safety valve)", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "ceo", permissions: { autonomyLevel: "autopilot" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.demote({
      agentId: "a1",
      targetLevel: "gated",
      reason: "manual",
      actor: { actorType: "user", actorId: "u1", membershipRole: "admin" },
    });
    expect(result.currentLevel).toBe("gated");
  });

  it("board_observer CANNOT demote anyone", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "engineer", permissions: { autonomyLevel: "policy" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.demote({
        agentId: "a1",
        targetLevel: "gated",
        reason: "manual",
        actor: { actorType: "user", actorId: "u1", membershipRole: "viewer" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("system actor always has demotion authority (automatic trigger)", async () => {
    const { db } = makeDb({
      agentRows: [
        { id: "a1", companyId: "c1", role: "ceo", permissions: { autonomyLevel: "autopilot" } },
      ],
    });
    const sm = autonomyStateMachine(db as any);
    const result = await sm.demote({
      agentId: "a1",
      targetLevel: "gated",
      reason: "allowlist_violation",
      actor: { actorType: "system", actorId: "allowlist-watchdog" },
    });
    expect(result.currentLevel).toBe("gated");
  });
});

describe("autonomyStateMachine.createPromotionProposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agent creates an approval row for their own promotion", async () => {
    const { db } = makeDb({ agentRows: [] });
    const sm = autonomyStateMachine(db as any);
    const row = await sm.createPromotionProposal({
      agentId: "a1",
      companyId: "c1",
      fromLevel: "gated",
      toLevel: "policy",
      actor: { actorType: "agent", actorId: "a1" },
    });
    expect(row).toMatchObject({ id: "approval-1", status: "pending" });
  });

  it("rejects user actor via proposal path (they should call promote directly)", async () => {
    const { db } = makeDb({ agentRows: [] });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.createPromotionProposal({
        agentId: "a1",
        companyId: "c1",
        fromLevel: "gated",
        toLevel: "policy",
        actor: { actorType: "user", actorId: "u1", membershipRole: "owner" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects skip-step proposals", async () => {
    const { db } = makeDb({ agentRows: [] });
    const sm = autonomyStateMachine(db as any);
    await expect(
      sm.createPromotionProposal({
        agentId: "a1",
        companyId: "c1",
        fromLevel: "gated",
        toLevel: "autopilot",
        actor: { actorType: "agent", actorId: "a1" },
      }),
    ).rejects.toMatchObject({ code: "invalid_step" });
  });
});
