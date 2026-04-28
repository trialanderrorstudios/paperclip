// Wakeup orchestration carve-out (-tne, 2026-04-24).
//
// Validates the CEO-of-record / manager-of branches for
// POST /api/agents/:id/wakeup. Three explicit auth branches:
//   1. SELF       — caller is the target agent.
//   2. MANAGER    — target.reportsTo === caller.id.
//   3. CEO        — caller.role === 'ceo' AND caller.companyId === target.companyId.
//
// Anything else still 403s. We also assert that orchestration metadata
// (paperclipWakeInvokedBy, wakeOrchestrationVector) and the operator
// prompt (payload.prompt → contextSnapshot.wakeReason) are forwarded
// to the heartbeat service.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const targetAgentId = "11111111-1111-4111-8111-111111111111";
const managerAgentId = "22222222-2222-4222-8222-222222222222";
const ceoAgentId = "33333333-3333-4333-8333-333333333333";
const strangerAgentId = "44444444-4444-4444-8444-444444444444";
const companyId = "55555555-5555-4555-8555-555555555555";
const otherCompanyId = "66666666-6666-4666-8666-666666666666";

function makeAgent(overrides: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    companyId,
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-24T00:00:00.000Z"),
    updatedAt: new Date("2026-04-24T00:00:00.000Z"),
    ...overrides,
  };
}

const targetAgent = makeAgent({
  id: targetAgentId,
  name: "Target",
  role: "engineer",
  reportsTo: managerAgentId,
});

const managerAgent = makeAgent({
  id: managerAgentId,
  name: "Manager",
  role: "manager",
  reportsTo: ceoAgentId,
});

const ceoAgent = makeAgent({
  id: ceoAgentId,
  name: "CEO",
  role: "ceo",
  reportsTo: null,
});

const strangerAgent = makeAgent({
  id: strangerAgentId,
  name: "Stranger",
  role: "engineer",
  reportsTo: null,
});

const ceoOtherCompany = makeAgent({
  id: ceoAgentId,
  name: "CEO-elsewhere",
  role: "ceo",
  companyId: otherCompanyId,
  reportsTo: null,
});

const agentDirectory: Record<string, ReturnType<typeof makeAgent>> = {
  [targetAgentId]: targetAgent,
  [managerAgentId]: managerAgent,
  [ceoAgentId]: ceoAgent,
  [strangerAgentId]: strangerAgent,
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
  wakeup: vi.fn(),
  invoke: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function fakeRun(id: string) {
  return {
    id,
    companyId,
    agentId: targetAgentId,
    status: "queued" as const,
    invocationSource: "on_demand",
    triggerDetail: "manual",
  };
}

describe("agent wakeup orchestration carve-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockImplementation(async (id: string) =>
      agentDirectory[id] ?? null,
    );
    mockHeartbeatService.wakeup.mockResolvedValue(fakeRun("run-self"));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("(self) allows an agent to wake itself and stamps the audit vector", async () => {
    const app = createApp({
      type: "agent",
      agentId: targetAgentId,
      companyId,
    });

    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    const [, opts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(opts.contextSnapshot.wakeOrchestrationVector).toBe("self");
    expect(opts.contextSnapshot.paperclipWakeInvokedBy).toBe(targetAgentId);
    expect(opts.contextSnapshot.wakeReason).toBeUndefined();
  });

  it("(manager) allows the direct manager (Y.reportsTo === X.id) to wake a subordinate", async () => {
    const app = createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
    });

    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(202);
    const [, opts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(opts.contextSnapshot.wakeOrchestrationVector).toBe("manager");
    expect(opts.contextSnapshot.paperclipWakeInvokedBy).toBe(managerAgentId);
  });

  it("(ceo) allows a CEO to wake a peer-reporting subordinate inside the same company", async () => {
    const app = createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId,
    });

    // Target reports to manager, NOT directly to the CEO. Should still pass
    // via the ceo branch.
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(202);
    const [, opts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(opts.contextSnapshot.wakeOrchestrationVector).toBe("ceo");
    expect(opts.contextSnapshot.paperclipWakeInvokedBy).toBe(ceoAgentId);
  });

  it("(stranger) rejects an unrelated peer agent with 403", async () => {
    const app = createApp({
      type: "agent",
      agentId: strangerAgentId,
      companyId,
    });

    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent can only invoke itself");
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("(ceo-cross-company) rejects a CEO from a different company with 403 via assertCompanyAccess", async () => {
    // The caller is identified as agent in another company; assertCompanyAccess
    // catches this before our orchestration branches even run.
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ceoAgentId) return ceoOtherCompany;
      return agentDirectory[id] ?? null;
    });
    const app = createApp({
      type: "agent",
      agentId: ceoAgentId,
      companyId: otherCompanyId,
    });

    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand" });

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("(prompt-forwarding) manager-supplied payload.prompt is piped into contextSnapshot.wakeReason", async () => {
    const app = createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
    });

    const briefing = "Please draft the Q3 roadmap and post a summary on the board.";
    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand", payload: { prompt: briefing } });

    expect(res.status).toBe(202);
    const [, opts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(opts.contextSnapshot.wakeReason).toBe(briefing);
    // Payload itself is forwarded verbatim too — adapters that read payload
    // shouldn't lose anything.
    expect(opts.payload).toEqual({ prompt: briefing });
  });

  it("(prompt-forwarding-self) self-wake does NOT have its payload.prompt promoted to wakeReason", async () => {
    // Self-wake should keep the existing semantics; only manager/CEO/board
    // wakes can inject an operator prompt this way.
    const app = createApp({
      type: "agent",
      agentId: targetAgentId,
      companyId,
    });

    const res = await request(app)
      .post(`/api/agents/${targetAgentId}/wakeup`)
      .send({ source: "on_demand", payload: { prompt: "do the thing" } });

    expect(res.status).toBe(202);
    const [, opts] = mockHeartbeatService.wakeup.mock.calls[0];
    expect(opts.contextSnapshot.wakeReason).toBeUndefined();
  });
});
