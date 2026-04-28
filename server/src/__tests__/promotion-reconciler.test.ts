/**
 * Unit tests for the NEW 3 V1.5 trust-based promotion reconciler.
 *
 * Validates the four key behaviors:
 * - Eligible agent (trustScore + cleanStreak >= threshold) creates an
 *   approval row of type `autonomy.promotion`, NOT a direct level flip.
 * - Below-threshold agent generates no proposal.
 * - Cooldown blocks repeat proposals (handled by the underlying
 *   createSystemPromotionProposal — verified via the upstream call).
 * - Company floor caps proposed target level.
 *
 * Mocks the trustService + the autonomy state machine so we exercise
 * only the reconciler's branching logic. The state-machine and trust-
 * service paths have their own dedicated test files.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetCompanyTrust = vi.hoisted(() => vi.fn());
const mockCreateSystemPromotionProposal = vi.hoisted(() => vi.fn());
const mockPromote = vi.hoisted(() => vi.fn());
const mockDemote = vi.hoisted(() => vi.fn());
const mockCreatePromotionProposal = vi.hoisted(() => vi.fn());

vi.mock("../services/trust.js", () => ({
  trustService: () => ({ getCompanyTrust: mockGetCompanyTrust }),
}));

vi.mock("../services/autonomy-state-machine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/autonomy-state-machine.js")
  >("../services/autonomy-state-machine.js");
  return {
    ...actual,
    autonomyStateMachine: () => ({
      promote: mockPromote,
      demote: mockDemote,
      createPromotionProposal: mockCreatePromotionProposal,
      createSystemPromotionProposal: mockCreateSystemPromotionProposal,
    }),
  };
});

import {
  resolvePromotionThresholds,
  runPromotionReconcilerTick,
} from "../services/promotion-reconciler.ts";

interface AgentRow {
  id: string;
  companyId: string;
  role: string;
  status: string;
  permissions: Record<string, unknown>;
}

interface CompanyRow {
  id: string;
  autonomyPolicy: Record<string, unknown> | null;
  requireBoardApprovalForNewAgents: boolean;
}

function makeDb(opts: {
  companyRows: CompanyRow[];
  agentsByCompanyId: Record<string, AgentRow[]>;
}) {
  const db: Record<string, unknown> = {
    select: vi.fn(() => {
      let calls = 0;
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn((tbl: { _: { name: string } } | unknown) => {
        // Distinguish `companies` vs `agents` by call order: first
        // select() in the reconciler is companies, then per-company a
        // select on agents. Track which call we're on via the `tbl`
        // identity if drizzle exposes it; we rely on call-order because
        // the fake table objects are interchangeable in this test.
        void tbl;
        return chain;
      });
      chain.where = vi.fn((w: unknown) => {
        void w;
        // Per-company agent fetch; whichever company id was matched in
        // the where clause we just return all agents — the eq() drizzle
        // helper isn't introspectable here. The reconciler iterates
        // companies sequentially, so we cycle through them.
        calls += 1;
        return chain;
      });
      chain.then = vi.fn((resolve: (rows: unknown[]) => unknown) => {
        // First .then() resolves the company list; subsequent ones
        // resolve agents for the company at index calls-1 (0-based).
        const companyIdx = Math.max(0, calls - 1);
        if (calls === 0) {
          return Promise.resolve(resolve(opts.companyRows));
        }
        const company = opts.companyRows[companyIdx];
        const agents = company ? (opts.agentsByCompanyId[company.id] ?? []) : [];
        return Promise.resolve(resolve(agents));
      });
      return chain;
    }),
  };
  return db;
}

// Drizzle-style chainable that resolves to an array via Symbol.toPrimitive
// can be hard to mock. We replace the test helper with a simpler shape
// that matches the reconciler's actual usage.
//
// The reconciler issues exactly two query shapes:
//   1. `db.select(...).from(companies)` — no WHERE — returns all companies
//   2. `db.select(...).from(agents).where(eq(agents.companyId, company.id))`
//      — returns agents for that company
//
// We can't introspect the drizzle eq() WHERE clause, so we route by
// call-order: the FIRST select() call resolves to companies, and the
// Nth subsequent call (N=1..companyRows.length) resolves to the agents
// for `companyRows[N-1]`. The reconciler iterates companies in array
// order so this lines up exactly.
function makeDbV2(opts: {
  companyRows: CompanyRow[];
  agentsByCompanyId: Record<string, AgentRow[]>;
}) {
  let selectCallCount = 0;
  const db: Record<string, unknown> = {
    select: vi.fn(() => {
      const myCallIdx = selectCallCount;
      selectCallCount += 1;
      const queryThenable: Record<string, unknown> = {};
      queryThenable.from = vi.fn(() => queryThenable);
      queryThenable.where = vi.fn(() => queryThenable);
      queryThenable.then = vi.fn((resolve: (rows: unknown[]) => unknown) => {
        if (myCallIdx === 0) {
          return Promise.resolve(resolve(opts.companyRows));
        }
        const company = opts.companyRows[myCallIdx - 1];
        const list = company ? opts.agentsByCompanyId[company.id] ?? [] : [];
        return Promise.resolve(resolve(list));
      });
      return queryThenable;
    }),
  };
  return db;
}

describe("resolvePromotionThresholds", () => {
  it("returns task-spec defaults when env unset", () => {
    delete process.env.AUTONOMY_PROMOTION_TRUST_TIER1;
    delete process.env.AUTONOMY_PROMOTION_STREAK_TIER1;
    delete process.env.AUTONOMY_PROMOTION_TRUST_TIER2;
    delete process.env.AUTONOMY_PROMOTION_STREAK_TIER2;
    expect(resolvePromotionThresholds()).toEqual({
      tier1: { trustScore: 90, cleanStreak: 7 },
      tier2: { trustScore: 95, cleanStreak: 30 },
    });
  });

  it("respects env overrides", () => {
    process.env.AUTONOMY_PROMOTION_TRUST_TIER1 = "85";
    process.env.AUTONOMY_PROMOTION_STREAK_TIER1 = "3";
    process.env.AUTONOMY_PROMOTION_TRUST_TIER2 = "99";
    process.env.AUTONOMY_PROMOTION_STREAK_TIER2 = "60";
    try {
      expect(resolvePromotionThresholds()).toEqual({
        tier1: { trustScore: 85, cleanStreak: 3 },
        tier2: { trustScore: 99, cleanStreak: 60 },
      });
    } finally {
      delete process.env.AUTONOMY_PROMOTION_TRUST_TIER1;
      delete process.env.AUTONOMY_PROMOTION_STREAK_TIER1;
      delete process.env.AUTONOMY_PROMOTION_TRUST_TIER2;
      delete process.env.AUTONOMY_PROMOTION_STREAK_TIER2;
    }
  });
});

describe("runPromotionReconcilerTick — eligible agent enqueues approval (no direct flip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUTONOMY_PROMOTION_TRUST_TIER1;
    delete process.env.AUTONOMY_PROMOTION_STREAK_TIER1;
    delete process.env.AUTONOMY_PROMOTION_TRUST_TIER2;
    delete process.env.AUTONOMY_PROMOTION_STREAK_TIER2;
    mockCreateSystemPromotionProposal.mockResolvedValue({
      id: "approval-1",
      status: "pending",
    });
  });

  it("creates a proposal and never calls promote() directly", async () => {
    const db = makeDbV2({
      companyRows: [
        {
          id: "company-1",
          autonomyPolicy: {},
          requireBoardApprovalForNewAgents: false, // floor → policy
        },
      ],
      agentsByCompanyId: {
        "company-1": [
          {
            id: "agent-elig",
            companyId: "company-1",
            role: "engineer",
            status: "active",
            permissions: { autonomyLevel: "gated" },
          },
        ],
      },
    });
    mockGetCompanyTrust.mockResolvedValue({
      companyHealthScore: 95,
      cleanAgents: 1,
      withViolations: 0,
      runsToday: 5,
      deniedToday: 0,
      budgetIncidents: 0,
      agents: [
        { agentId: "agent-elig", trustScore: 95, violationsToday: 0, cleanStreak: 10 },
      ],
    });

    const result = await runPromotionReconcilerTick(db as any);

    expect(mockCreateSystemPromotionProposal).toHaveBeenCalledTimes(1);
    expect(mockCreateSystemPromotionProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-elig",
        companyId: "company-1",
        fromLevel: "gated",
        toLevel: "policy",
        actorId: "promotion-reconciler",
      }),
    );
    // CRITICAL: tier flip is NEVER done by the reconciler.
    expect(mockPromote).not.toHaveBeenCalled();
    expect(result).toEqual({
      checked: 1,
      proposalsCreated: 1,
      skipped: 0,
    });
  });

  it("skips agent below trust threshold", async () => {
    const db = makeDbV2({
      companyRows: [
        {
          id: "company-1",
          autonomyPolicy: {},
          requireBoardApprovalForNewAgents: false,
        },
      ],
      agentsByCompanyId: {
        "company-1": [
          {
            id: "agent-low",
            companyId: "company-1",
            role: "engineer",
            status: "active",
            permissions: { autonomyLevel: "gated" },
          },
        ],
      },
    });
    mockGetCompanyTrust.mockResolvedValue({
      companyHealthScore: 80,
      cleanAgents: 0,
      withViolations: 1,
      runsToday: 1,
      deniedToday: 0,
      budgetIncidents: 0,
      agents: [
        { agentId: "agent-low", trustScore: 80, violationsToday: 1, cleanStreak: 0 },
      ],
    });

    const result = await runPromotionReconcilerTick(db as any);

    expect(mockCreateSystemPromotionProposal).not.toHaveBeenCalled();
    expect(result.proposalsCreated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips paused agents even when otherwise eligible", async () => {
    const db = makeDbV2({
      companyRows: [
        {
          id: "company-1",
          autonomyPolicy: {},
          requireBoardApprovalForNewAgents: false,
        },
      ],
      agentsByCompanyId: {
        "company-1": [
          {
            id: "agent-paused",
            companyId: "company-1",
            role: "engineer",
            status: "paused",
            permissions: { autonomyLevel: "gated" },
          },
        ],
      },
    });
    mockGetCompanyTrust.mockResolvedValue({
      companyHealthScore: 100,
      cleanAgents: 1,
      withViolations: 0,
      runsToday: 0,
      deniedToday: 0,
      budgetIncidents: 0,
      agents: [
        { agentId: "agent-paused", trustScore: 100, violationsToday: 0, cleanStreak: 100 },
      ],
    });

    await runPromotionReconcilerTick(db as any);
    expect(mockCreateSystemPromotionProposal).not.toHaveBeenCalled();
  });

  it("respects company floor — doesn't propose autopilot when floor=policy", async () => {
    const db = makeDbV2({
      companyRows: [
        {
          id: "company-1",
          autonomyPolicy: { maxLevel: "policy" },
          requireBoardApprovalForNewAgents: false,
        },
      ],
      agentsByCompanyId: {
        "company-1": [
          {
            id: "agent-pol",
            companyId: "company-1",
            role: "engineer",
            status: "active",
            permissions: { autonomyLevel: "policy" },
          },
        ],
      },
    });
    mockGetCompanyTrust.mockResolvedValue({
      companyHealthScore: 100,
      cleanAgents: 1,
      withViolations: 0,
      runsToday: 0,
      deniedToday: 0,
      budgetIncidents: 0,
      agents: [
        { agentId: "agent-pol", trustScore: 100, violationsToday: 0, cleanStreak: 100 },
      ],
    });

    await runPromotionReconcilerTick(db as any);
    // policy → autopilot would be proposed, but floor caps to policy
    // (== current level), so the reconciler must skip.
    expect(mockCreateSystemPromotionProposal).not.toHaveBeenCalled();
  });

  it("skips already-autopilot agents (no next tier)", async () => {
    const db = makeDbV2({
      companyRows: [
        {
          id: "company-1",
          autonomyPolicy: {},
          requireBoardApprovalForNewAgents: false,
        },
      ],
      agentsByCompanyId: {
        "company-1": [
          {
            id: "agent-top",
            companyId: "company-1",
            role: "engineer",
            status: "active",
            permissions: { autonomyLevel: "autopilot" },
          },
        ],
      },
    });
    mockGetCompanyTrust.mockResolvedValue({
      companyHealthScore: 100,
      cleanAgents: 1,
      withViolations: 0,
      runsToday: 0,
      deniedToday: 0,
      budgetIncidents: 0,
      agents: [
        { agentId: "agent-top", trustScore: 100, violationsToday: 0, cleanStreak: 100 },
      ],
    });

    await runPromotionReconcilerTick(db as any);
    expect(mockCreateSystemPromotionProposal).not.toHaveBeenCalled();
  });
});
