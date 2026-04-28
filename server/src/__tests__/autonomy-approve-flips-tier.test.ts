/**
 * Integration tests for the NEW 3 V1.5 approve-handler tier-flip wiring.
 *
 * Validates the four-line acceptance:
 * - approve on autonomy.promotion → state machine promote() is called
 * - reject on autonomy.promotion → no promote() call (tier unchanged)
 * - hire_agent approval is unaffected (no promote)
 * - stale proposal (current level != payload.fromLevel) → request-revision
 *
 * Mocks svc.approve / autonomyStateMachine — pure approve-handler test.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

const mockPromote = vi.hoisted(() => vi.fn());
const mockDemote = vi.hoisted(() => vi.fn());
const mockCreatePromotionProposal = vi.hoisted(() => vi.fn());
const mockCreateSystemPromotionProposal = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
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
    // Pass-through; the route imports this and it should still resolve
    // to whatever the agent row says.
    effectiveAutonomyLevel: actual.effectiveAutonomyLevel,
  };
});

const fakeAgentRows: Array<{
  id: string;
  role: string;
  permissions: Record<string, unknown>;
}> = [];

function selectThenable() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.then = vi.fn((resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(resolve(fakeAgentRows.map((r) => ({ ...r })))),
  );
  return chain;
}

const fakeDb: any = {
  select: vi.fn(() => selectThenable()),
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    })),
  })),
};

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/approvals.js")>("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-owner-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [
        { companyId: "company-1", membershipRole: "owner", status: "active" },
      ],
    };
    next();
  });
  app.use("/api", approvalRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

describe("NEW 3 V1.5 approve handler — tier flip wiring", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakeAgentRows.length = 0;
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("approve flips tier — sm.promote called with payload.toLevel", async () => {
    fakeAgentRows.push({
      id: "agent-flip",
      role: "engineer",
      permissions: { autonomyLevel: "gated" }, // matches payload.fromLevel
    });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "pending",
      payload: {
        agentId: "agent-flip",
        fromLevel: "gated",
        toLevel: "policy",
      },
      requestedByAgentId: "agent-flip",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "autonomy.promotion",
        status: "approved",
        payload: {
          agentId: "agent-flip",
          fromLevel: "gated",
          toLevel: "policy",
        },
        requestedByAgentId: "agent-flip",
      },
      applied: true,
    });
    mockPromote.mockResolvedValue({
      previousLevel: "gated",
      currentLevel: "policy",
      tier: "board_owner",
    });

    const app = await createApp();
    const res = await request(app).post("/api/approvals/approval-1/approve").send({});

    expect(res.status).toBe(200);
    expect(mockPromote).toHaveBeenCalledTimes(1);
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-flip",
        targetLevel: "policy",
        actor: expect.objectContaining({
          actorType: "user",
          actorId: "user-owner-1",
          membershipRole: "owner",
        }),
      }),
    );
    const emittedActions = mockLogActivity.mock.calls.map((c) => c[1].action);
    expect(emittedActions).toContain("autonomy.proposal.approved");
  });

  it("deny (reject) leaves tier alone — sm.promote NOT called", async () => {
    fakeAgentRows.push({
      id: "agent-deny",
      role: "engineer",
      permissions: { autonomyLevel: "gated" },
    });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "pending",
      payload: {
        agentId: "agent-deny",
        fromLevel: "gated",
        toLevel: "policy",
      },
      requestedByAgentId: "agent-deny",
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-2",
        companyId: "company-1",
        type: "autonomy.promotion",
        status: "rejected",
        payload: {
          agentId: "agent-deny",
          fromLevel: "gated",
          toLevel: "policy",
        },
        requestedByAgentId: "agent-deny",
      },
      applied: true,
    });

    const app = await createApp();
    const res = await request(app).post("/api/approvals/approval-2/reject").send({});

    expect(res.status).toBe(200);
    // CRITICAL: rejecting a promotion proposal must NOT flip the tier.
    expect(mockPromote).not.toHaveBeenCalled();
    const emittedActions = mockLogActivity.mock.calls.map((c) => c[1].action);
    expect(emittedActions).toContain("approval.rejected");
    expect(emittedActions).not.toContain("autonomy.proposal.approved");
  });

  it("stale proposal (agent demoted since proposal) → request-revision, no promote", async () => {
    // Agent is currently `gated` but the proposal payload.fromLevel says
    // `policy` — meaning a demotion fired between proposal and approval.
    fakeAgentRows.push({
      id: "agent-stale",
      role: "engineer",
      permissions: { autonomyLevel: "gated" },
    });
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "pending",
      payload: {
        agentId: "agent-stale",
        fromLevel: "policy", // stale
        toLevel: "autopilot",
      },
      requestedByAgentId: "agent-stale",
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-3",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "revision_requested",
      payload: {
        agentId: "agent-stale",
        fromLevel: "policy",
        toLevel: "autopilot",
      },
      requestedByAgentId: "agent-stale",
    });

    const app = await createApp();
    const res = await request(app).post("/api/approvals/approval-3/approve").send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("autonomy.proposal_stale");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.requestRevision).toHaveBeenCalledTimes(1);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("hire_agent approval — promote NOT called for unrelated approval types", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-h",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-h",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-h",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-h",
      },
      applied: true,
    });

    const app = await createApp();
    const res = await request(app).post("/api/approvals/approval-h/approve").send({});

    expect(res.status).toBe(200);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
