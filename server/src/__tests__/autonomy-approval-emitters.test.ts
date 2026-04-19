/**
 * Unit tests for the NEW 3 V1 Gap 3 activity emitters.
 *
 * Covers:
 * - `autonomy.proposal.approved` fires when an approval with
 *   `type='autonomy.promotion'` resolves to approved.
 * - `allowlist.exception.approved` fires when an approval with
 *   `type='allowlist.exception'` resolves to approved.
 * - Neither fires for other approval types.
 *
 * The third emitter (`allowlist.violated` DENY-branch) is covered in
 * agents-autonomy-approval.test.ts via the matcher-helper, and is
 * additionally fired from the hire route when the Gap 2 DENY branch
 * triggers. Here we scope to the approval-resolve surface.
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

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

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
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("NEW 3 V1 Gap 3 autonomy activity emitters", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("emits autonomy.proposal.approved when an autonomy.promotion approval resolves to approved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-ap",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "pending",
      payload: {
        agentId: "agent-42",
        fromLevel: "gated",
        toLevel: "policy",
      },
      requestedByAgentId: "agent-42",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-ap",
        companyId: "company-1",
        type: "autonomy.promotion",
        status: "approved",
        payload: {
          agentId: "agent-42",
          fromLevel: "gated",
          toLevel: "policy",
        },
        requestedByAgentId: "agent-42",
      },
      applied: true,
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/approvals/approval-ap/approve")
      .send({});

    expect(res.status).toBe(200);
    const emittedActions = mockLogActivity.mock.calls.map((call) => call[1].action);
    expect(emittedActions).toContain("approval.approved");
    expect(emittedActions).toContain("autonomy.proposal.approved");
    const emit = mockLogActivity.mock.calls.find(
      (call) => call[1].action === "autonomy.proposal.approved",
    );
    expect(emit).toBeDefined();
    expect(emit![1]).toMatchObject({
      entityType: "approval",
      entityId: "approval-ap",
      agentId: "agent-42",
    });
  });

  it("emits allowlist.exception.approved when an allowlist.exception approval resolves to approved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-ex",
      companyId: "company-1",
      type: "allowlist.exception",
      status: "pending",
      payload: { agentId: "agent-99", attemptedTool: "Bash" },
      requestedByAgentId: "agent-99",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-ex",
        companyId: "company-1",
        type: "allowlist.exception",
        status: "approved",
        payload: { agentId: "agent-99", attemptedTool: "Bash" },
        requestedByAgentId: "agent-99",
      },
      applied: true,
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/approvals/approval-ex/approve")
      .send({});

    expect(res.status).toBe(200);
    const emittedActions = mockLogActivity.mock.calls.map((call) => call[1].action);
    expect(emittedActions).toContain("allowlist.exception.approved");
    const emit = mockLogActivity.mock.calls.find(
      (call) => call[1].action === "allowlist.exception.approved",
    );
    expect(emit).toBeDefined();
    expect(emit![1]).toMatchObject({
      entityType: "approval",
      entityId: "approval-ex",
      agentId: "agent-99",
    });
  });

  it("does NOT emit autonomy-specific events for other approval types (hire_agent)", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-hire",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-hire",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/approvals/approval-hire/approve")
      .send({});

    expect(res.status).toBe(200);
    const emittedActions = mockLogActivity.mock.calls.map((call) => call[1].action);
    expect(emittedActions).toContain("approval.approved");
    expect(emittedActions).not.toContain("autonomy.proposal.approved");
    expect(emittedActions).not.toContain("allowlist.exception.approved");
  });

  it("does NOT emit when applied=false (idempotent retry path)", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-ap",
      companyId: "company-1",
      type: "autonomy.promotion",
      status: "approved",
      payload: { agentId: "agent-42" },
      requestedByAgentId: "agent-42",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-ap",
        companyId: "company-1",
        type: "autonomy.promotion",
        status: "approved",
        payload: { agentId: "agent-42" },
        requestedByAgentId: "agent-42",
      },
      applied: false,
    });

    const app = await createApp();
    await request(app).post("/api/approvals/approval-ap/approve").send({});

    const emittedActions = mockLogActivity.mock.calls.map((call) => call[1].action);
    expect(emittedActions).not.toContain("autonomy.proposal.approved");
  });
});
