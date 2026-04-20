import { Router, type Request, type Response } from "express";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, companies, heartbeatRuns, issues as issuesTable } from "@paperclipai/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentMineInboxQuerySchema,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  // NEW 3 V1 (-tne): autonomy helpers used by the PATCH interceptor.
  type AutonomyLevel,
  type AllowlistEnvelope,
  resolveBoardTier,
  canEditAllowlist,
  isAutonomyDemotion,
  isValidPromotionStep,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  companySkillService,
  budgetService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
// NEW 3 V1 (-tne): autonomy state machine + compat shim helpers.
import {
  autonomyStateMachine,
  effectiveAutonomyLevel,
  resolveCompanyMaxLevel,
  capToCompanyFloor,
  AutonomyStateMachineError,
} from "../services/autonomy-state-machine.js";
// NEW 3 V1 (-tne): pre-dispatch envelope check (Gap 2).
import {
  checkDeclaredSurfaceAgainstEnvelope,
  type EnvelopeCheckVerdict,
} from "../services/allowlist-check.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@paperclipai/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";

export function agentRoutes(db: Db) {
  // Legacy hardcoded maps — used as fallback when adapter module does not
  // declare capability flags explicitly.
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    droid_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    hermes_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

  /** Check if an adapter supports the managed instructions bundle. */
  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  /** Resolve the adapter config key for the instructions file path. */
  function resolveInstructionsPathKey(adapterType: string): string | null {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
    if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
    if (adapter?.supportsInstructionsBundle === false) return null;
    return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
  }
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;

  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const budgets = budgetService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const instructions = agentInstructionsService();
  const companySkills = companySkillService(db);
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (canCreateAgents(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "agent_creator" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  // NEW 3 V1 (-tne): state machine bound to the current db handle.
  const autonomySM = autonomyStateMachine(db);

  /**
   * Resolve the board tier for the requesting user against a specific
   * company. Returns a `membershipRole` string suitable for passing into
   * `resolveBoardTier()`. Returns null for agent / local-implicit actors.
   */
  function resolveActorMembershipRoleForCompany(req: Request, companyId: string): string | null {
    if (req.actor.type !== "board") return null;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return "owner";
    const memberships = Array.isArray(req.actor.memberships) ? req.actor.memberships : [];
    const m = memberships.find((entry) => entry.companyId === companyId);
    return m?.membershipRole ?? null;
  }

  /**
   * Intercept NEW 3 autonomy fields on a PATCH body and apply them via
   * the state machine. Returns the count of autonomy mutations applied
   * so the caller can decide whether to still run the legacy update.
   * On agent-auth paths, promotions create an `autonomy.promotion`
   * approval row instead of writing directly.
   */
  async function applyAutonomyPatch(
    req: Request,
    res: Response,
    existing: { id: string; companyId: string; role: string; permissions: unknown },
    body: Record<string, unknown>,
  ): Promise<{ handled: boolean; error?: true }> {
    const hasLevel = hasOwn(body, "autonomyLevel");
    const hasAllowlist = hasOwn(body, "allowlist");
    if (!hasLevel && !hasAllowlist) return { handled: false };

    const targetLevel = body.autonomyLevel as AutonomyLevel | undefined;
    const allowlist = body.allowlist as AllowlistEnvelope | undefined;
    const reason = typeof body.autonomyReason === "string" ? body.autonomyReason : undefined;
    const currentLevel = effectiveAutonomyLevel(existing.permissions, existing.role);

    // Verify company-floor cap before anything.
    if (hasLevel && targetLevel) {
      const companyRow = await db
        .select({
          autonomyPolicy: companies.autonomyPolicy,
          requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
        })
        .from(companies)
        .where(eq(companies.id, existing.companyId))
        .then((rows) => rows[0] ?? null);
      const floor = resolveCompanyMaxLevel(
        companyRow?.autonomyPolicy ?? {},
        companyRow?.requireBoardApprovalForNewAgents ?? true,
      );
      const capped = capToCompanyFloor(targetLevel, floor);
      if (capped !== targetLevel) {
        res.status(422).json({
          error: `target level ${targetLevel} exceeds company floor ${floor}`,
        });
        return { handled: true, error: true };
      }
    }

    // Agent-auth promotions: create approval row; no direct write.
    if (req.actor.type === "agent") {
      if (!hasLevel || !targetLevel) {
        res.status(422).json({
          error: "agents may only submit autonomyLevel changes (allowlist edits require board auth)",
        });
        return { handled: true, error: true };
      }
      const actorAgentId = req.actor.agentId ?? null;
      if (!actorAgentId || actorAgentId !== existing.id) {
        res.status(403).json({ error: "agents may only propose their own autonomy changes" });
        return { handled: true, error: true };
      }
      if (!isValidPromotionStep(currentLevel, targetLevel)) {
        res.status(422).json({
          error: `invalid promotion step ${currentLevel} → ${targetLevel}`,
        });
        return { handled: true, error: true };
      }
      try {
        await autonomySM.createPromotionProposal({
          agentId: existing.id,
          companyId: existing.companyId,
          fromLevel: currentLevel,
          toLevel: targetLevel,
          actor: { actorType: "agent", actorId: actorAgentId },
          justification: reason,
        });
      } catch (err) {
        if (err instanceof AutonomyStateMachineError) {
          res.status(422).json({ error: err.message, code: err.code });
          return { handled: true, error: true };
        }
        throw err;
      }
      return { handled: true };
    }

    // Board-auth path.
    const membershipRole = resolveActorMembershipRoleForCompany(req, existing.companyId);
    const tier = resolveBoardTier(membershipRole);
    const isCeoAgent = existing.role === "ceo";

    try {
      if (hasLevel && targetLevel && targetLevel !== currentLevel) {
        if (isAutonomyDemotion(currentLevel, targetLevel)) {
          await autonomySM.demote({
            agentId: existing.id,
            targetLevel,
            reason: "manual",
            actor: { actorType: "user", actorId: req.actor.userId ?? "board", membershipRole, resolvedTier: tier },
            note: reason,
          });
        } else {
          await autonomySM.promote({
            agentId: existing.id,
            targetLevel,
            actor: { actorType: "user", actorId: req.actor.userId ?? "board", membershipRole, resolvedTier: tier },
            justification: reason,
          });
        }
      }
      if (hasAllowlist && allowlist !== undefined) {
        if (!canEditAllowlist(tier, { isCeoAgent })) {
          res.status(403).json({ error: `tier ${tier} may not edit this allowlist` });
          return { handled: true, error: true };
        }
        // Write allowlist directly onto permissions jsonb — a simple
        // merge preserves other permission keys (e.g. canCreateAgents).
        const currentPermissions =
          existing.permissions && typeof existing.permissions === "object" && !Array.isArray(existing.permissions)
            ? { ...(existing.permissions as Record<string, unknown>) }
            : {};
        currentPermissions.allowlist = allowlist;
        await db
          .update(agentsTable)
          .set({ permissions: currentPermissions, updatedAt: new Date() })
          .where(eq(agentsTable.id, existing.id));
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          agentId: existing.id,
          action: "agent.allowlist_updated",
          entityType: "agent",
          entityId: existing.id,
          details: { actorRoleAtTime: tier, allowlist },
        });
      }
    } catch (err) {
      if (err instanceof AutonomyStateMachineError) {
        const status = err.code === "forbidden" ? 403 : 422;
        res.status(status).json({ error: err.message, code: err.code });
        return { handled: true, error: true };
      }
      throw err;
    }
    return { handled: true };
  }

  async function applyDefaultAgentTaskAssignGrant(
    companyId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return null;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !canCreateAgents(actorAgent)) {
      throw forbidden("Missing permission: can create agents");
    }
    return actorAgent;
  }

  async function assertBoardCanManageAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) {
      throw forbidden("Missing permission: agents:create");
    }
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    return assertCanCreateAgentsForCompany(req, companyId);
  }

  async function getAccessibleAgent(req: Request, res: Response, id: string) {
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return null;
    }
    assertCompanyAccess(req, agent.companyId);
    if (req.actor.type === "board") {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    return agent;
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, req.actor.userId, "agents:create");
    }
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      await assertBoardCanManageAgentsForCompany(req, targetAgent.companyId);
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (actorAgent.id === targetAgent.id) return;
    if (actorAgent.role === "ceo") return;
    const allowedByGrant = await access.hasPermission(
      targetAgent.companyId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    if (allowedByGrant || canCreateAgents(actorAgent)) return;
    throw forbidden("Only CEO or agent creators can modify other agents");
  }

  async function assertCanReadAgent(req: Request, targetAgent: { companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      await assertCanReadConfigurations(req, targetAgent.companyId);
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
    const parsedRuntimeConfig = asRecord(runtimeConfig);
    const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
    const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
    const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

    if (parseBooleanLike(heartbeat.enabled) == null) {
      heartbeat.enabled = false;
    }

    normalizedRuntimeConfig.heartbeat = heartbeat;
    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  /**
   * NEW 0-B-7 (-tne): mint a PAPERCLIP_API_KEY for the newly-hired
   * agent and write it into adapterConfig.env so the runtime (Claude
   * CLI, Codex, openclaw-routed adapters) gets it as an env var on
   * wake. Caller-supplied env.PAPERCLIP_API_KEY wins. Closes over
   * the outer `svc` + `db`.
   */
  async function provisionAgentPaperclipKeyForHire(agent: {
    id: string;
    adapterConfig: unknown;
  }): Promise<void> {
    const currentConfig = asRecord(agent.adapterConfig) ?? {};
    const currentEnv = asRecord(currentConfig.env) ?? {};
    // Caller already supplied a key — respect it.
    if (
      currentEnv.PAPERCLIP_API_KEY !== undefined &&
      currentEnv.PAPERCLIP_API_KEY !== null
    ) {
      return;
    }
    const key = await svc.createApiKey(agent.id, "primary");
    const nextEnv = {
      ...currentEnv,
      PAPERCLIP_API_KEY: { type: "plain" as const, value: key.token },
    };
    const nextAdapterConfig = { ...currentConfig, env: nextEnv };
    await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
  }

  /**
   * NEW 0-B-6 (-tne): Overwatch-v3 delegation path. When a caller POSTs
   * agent-hires with adapterType=openclaw_gateway but leaves the
   * gateway-specific fields empty, fill them from env so the CEO can
   * delegate to openclaw-routed subordinates with a minimal body
   * (just role + name + capabilities) — they don't need to hold the
   * gateway admin token or know the loopback URL.
   *
   * Env:
   *   OPENCLAW_GATEWAY_URL    default ws://127.0.0.1:18789
   *   OPENCLAW_GATEWAY_TOKEN  required on non-loopback gateway deployments
   *
   * Explicit adapterConfig fields always win — this is a fill-in, not
   * a forced override.
   */
  function applyOpenclawGatewayEnvDefaults(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const next = { ...adapterConfig };
    if (!asNonEmptyString(next.url)) {
      const envUrl = asNonEmptyString(process.env.OPENCLAW_GATEWAY_URL);
      next.url = envUrl ?? "ws://127.0.0.1:18789";
    }
    const headersRecord = asRecord(next.headers) ?? {};
    const hasTokenHeader =
      asNonEmptyString(headersRecord["x-openclaw-token"]) !== null ||
      asNonEmptyString(headersRecord["x-openclaw-auth"]) !== null ||
      asNonEmptyString(headersRecord["authorization"]) !== null;
    if (!hasTokenHeader) {
      const envToken = asNonEmptyString(process.env.OPENCLAW_GATEWAY_TOKEN);
      if (envToken) {
        next.headers = { ...headersRecord, "x-openclaw-token": envToken };
      }
    }
    return next;
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    // OpenCode requires explicit model selection — no default
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return applyOpenclawGatewayEnvDefaults(
      adapterType,
      ensureGatewayDeviceKey(adapterType, next),
    );
  }

  async function assertAdapterConfigConstraints(
    companyId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterConfig);
    const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: runtimeConfig.model,
        command: runtimeConfig.command,
        cwd: runtimeConfig.cwd,
        env: runtimeEnv,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(agent: T): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      return agent;
    }

    const promptTemplate = typeof adapterConfig.promptTemplate === "string"
      ? adapterConfig.promptTemplate
      : "";
    const files = promptTemplate.trim().length === 0
      ? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role))
      : { "AGENTS.md": promptTemplate };
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  async function assertCanManageInstructionsPath(req: Request, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type !== "board") {
      throw forbidden(
        "Only board-authenticated callers can manage instructions path or bundle configuration",
      );
    }
    await assertBoardCanManageAgentsForCompany(req, targetAgent.companyId);
  }

  function assertNoAgentInstructionsConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown> | null | undefined,
  ) {
    if (req.actor.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS.filter((key) => adapterConfig[key] !== undefined);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkills: string[] = [],
  ): AgentSkillSnapshot {
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  // Legacy hardcoded set — used as fallback when adapter module does not
  // declare requiresMaterializedRuntimeSkills explicitly.
  const LEGACY_MATERIALIZED_SKILLS_SET = new Set([
    "cursor",
    "gemini_local",
    "opencode_local",
    "pi_local",
  ]);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.requiresMaterializedRuntimeSkills !== undefined) {
      return adapter.requiresMaterializedRuntimeSkills;
    }
    return LEGACY_MATERIALIZED_SKILLS_SET.has(adapterType);
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
  ) {
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ) {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null as string[] | null,
        runtimeSkillEntries: null as Awaited<ReturnType<typeof companySkills.listRuntimeSkillEntries>> | null,
      };
    }

    const resolvedRequestedSkills = await companySkills.resolveRequestedSkillKeys(
      companyId,
      requestedDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    const requiredSkills = runtimeSkillEntries
      .filter((entry) => entry.required)
      .map((entry) => entry.key);
    const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkills),
      desiredSkills,
      runtimeSkillEntries,
    };
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const models = await listAdapterModels(type);
    res.json(models);
  });

  router.get("/companies/:companyId/adapters/:type/detect-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);

    const detected = await detectAdapterModel(type);
    res.json(detected);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = assertKnownAdapterType(req.params.type as string);
      await assertCanReadConfigurations(req, companyId);

      const adapter = requireServerAdapter(type);

      const inputAdapterConfig =
        (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
      );

      const result = await adapter.testEnvironment({
        companyId,
        adapterType: type,
        config: runtimeAdapterConfig,
      });

      res.json(result);
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);

    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId, {
        materializeMissing: false,
      });
      const requiredSkills = runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key);
      res.json(buildUnsupportedSkillSnapshot(agent.adapterType, Array.from(new Set([...requiredSkills, ...preference.desiredSkills]))));
      return;
    }

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    res.json(snapshot);
  });

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCanUpdateAgent(req, agent);

      const requestedSkills = Array.from(
        new Set(
          (req.body.desiredSkills as string[])
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );
      const {
        adapterConfig: nextAdapterConfig,
        desiredSkills,
        runtimeSkillEntries,
      } = await resolveDesiredSkillAssignment(
        agent.companyId,
        agent.adapterType,
        agent.adapterConfig as Record<string, unknown>,
        requestedSkills,
      );
      if (!desiredSkills || !runtimeSkillEntries) {
        throw unprocessable("Skill sync requires desiredSkills.");
      }
      const actor = getActorInfo(req);
      const updated = await svc.update(agent.id, {
        adapterConfig: nextAdapterConfig,
      }, {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-sync",
        },
      });
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const adapter = findActiveServerAdapter(updated.adapterType);
      const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        updated.companyId,
        updated.adapterConfig,
      );
      const runtimeSkillConfig = {
        ...runtimeConfig,
        paperclipRuntimeSkills: runtimeSkillEntries,
      };
      const snapshot = adapter?.syncSkills
        ? await adapter.syncSkills({
            agentId: updated.id,
            companyId: updated.companyId,
            adapterType: updated.adapterType,
            config: runtimeSkillConfig,
          }, desiredSkills)
        : adapter?.listSkills
          ? await adapter.listSkills({
              agentId: updated.id,
              companyId: updated.companyId,
              adapterType: updated.adapterType,
              config: runtimeSkillConfig,
            })
          : buildUnsupportedSkillSnapshot(updated.adapterType, desiredSkills);

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.skills_synced",
        entityType: "agent",
        entityId: updated.id,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          adapterType: updated.adapterType,
          desiredSkills,
          mode: snapshot.mode,
          supported: snapshot.supported,
          entryCount: snapshot.entries.length,
          warningCount: snapshot.warnings.length,
        },
      });

      res.json(snapshot);
    },
  );

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryParams = Object.keys(req.query).sort();
    if (unsupportedQueryParams.length > 0) {
      res.status(400).json({
        error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}`,
      });
      return;
    }
    const result = await svc.list(companyId);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    if (canReadConfigs) {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      assigneeAgentId: req.actor.agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
    });

    res.json(
      rows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
      })),
    );
  });

  router.get("/agents/me/inbox/mine", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const query = agentMineInboxQuerySchema.parse(req.query);
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
    });

    res.json(rows);
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);
    const isSelf = req.actor.type === "agent" && req.actor.agentId === id;
    const canReadSensitiveDetail = isSelf
      ? true
      : await actorCanReadConfigurationsForCompany(req, agent.companyId);
    if (!canReadSensitiveDetail) {
      res.json(await buildAgentDetail(agent, { restricted: true }));
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const {
      desiredSkills: requestedDesiredSkills,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      // NEW 3 V1 (-tne): extract autonomy initial values — they ride on
      // `permissions` jsonb, not as top-level agent columns.
      initialAutonomyLevel: requestedInitialAutonomyLevel,
      initialAllowlist: requestedInitialAllowlist,
      ...hireInput
    } = req.body;
    hireInput.adapterType = assertKnownAdapterType(hireInput.adapterType);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectAgentAdapterWorkspaceCommandPaths(hireInput.adapterConfig),
    );
    assertNoAgentInstructionsConfigMutation(
      req,
      (hireInput.adapterConfig ?? {}) as Record<string, unknown>,
    );
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType,
      ((hireInput.adapterConfig ?? {}) as Record<string, unknown>),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      desiredSkillAssignment.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      companyId,
      hireInput.adapterType,
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    let requiresApproval = company.requireBoardApprovalForNewAgents;

    // NEW 3 V1 (-tne): compose permissions jsonb with requested initial
    // autonomy level + allowlist, capped by company floor. Falls back to
    // role default when level omitted (plan §6.1).
    const companyFloor = resolveCompanyMaxLevel(
      company.autonomyPolicy ?? {},
      company.requireBoardApprovalForNewAgents,
    );
    const basePermissions =
      normalizedHireInput.permissions && typeof normalizedHireInput.permissions === "object"
        ? { ...(normalizedHireInput.permissions as Record<string, unknown>) }
        : {};
    // Effective level at hire time: request → capped by floor, else role
    // default. capToCompanyFloor here takes the MIN of the two.
    const effectiveHireLevel: AutonomyLevel = requestedInitialAutonomyLevel
      ? capToCompanyFloor(requestedInitialAutonomyLevel, companyFloor)
      : capToCompanyFloor(
          effectiveAutonomyLevel({}, normalizedHireInput.role),
          companyFloor,
        );
    if (requestedInitialAutonomyLevel) {
      basePermissions.autonomyLevel = effectiveHireLevel;
    }
    if (requestedInitialAllowlist) {
      basePermissions.allowlist = requestedInitialAllowlist;
    }
    const composedPermissions = Object.keys(basePermissions).length > 0 ? basePermissions : undefined;

    // NEW 3 V1 (-tne) Gap 2: pre-dispatch envelope check at hire time.
    // The declared surface is whatever tools/paths the requester put in
    // `initialAllowlist`. We check against the company-floor envelope
    // (plan §5.1 — `autonomyPolicy.companyFloorAllowlist`). Verdict drives
    // whether this hire auto-approves, queues a normal board review, or
    // triggers an `allowlist.exception` branch.
    const companyFloorEnvelope: AllowlistEnvelope =
      (company.autonomyPolicy && typeof company.autonomyPolicy === "object"
        ? ((company.autonomyPolicy as Record<string, unknown>)
            .companyFloorAllowlist as AllowlistEnvelope | undefined)
        : undefined) ?? {};
    let envelopeVerdict: EnvelopeCheckVerdict = { kind: "allow" };
    let envelopeExceptionApproval: Awaited<
      ReturnType<typeof approvalsSvc.getById>
    > | null = null;
    if (requestedInitialAllowlist) {
      envelopeVerdict = checkDeclaredSurfaceAgainstEnvelope({
        level: effectiveHireLevel,
        envelope: companyFloorEnvelope,
        declaredTools: requestedInitialAllowlist.allowedTools,
        declaredPaths: requestedInitialAllowlist.allowedPaths,
      });
    }
    // Auto-approve at policy/autopilot when the declared surface fits the
    // company floor envelope. Gated stays on the normal approval path.
    // Deny → immediate reject + `allowlist.violated` emission, and we
    // refuse to create the hire approval (the operator asked for out-of-
    // envelope at an auto-trusted level; that's the exact violation).
    if (envelopeVerdict.kind === "allow" && effectiveHireLevel !== "gated") {
      requiresApproval = false;
    }
    const status = requiresApproval ? "pending_approval" : "idle";

    const createdAgent = await svc.create(companyId, {
      ...normalizedHireInput,
      permissions: composedPermissions,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);

    // NEW 0-B-7 (-tne): every fresh hire gets a Paperclip API key minted
    // and injected into adapterConfig.env.PAPERCLIP_API_KEY on the way
    // in. Without this, Overwatch-v3 CEOs hiring subordinates via
    // POST /agent-hires had to chain three calls (hire → POST keys →
    // PATCH adapterConfig.env) just to give their hires API access.
    // Now the single hire POST yields a fully-provisioned agent.
    //
    // Idempotent — skipped if the caller explicitly provided env.PAPERCLIP_API_KEY.
    // Best-effort — if the mint or update fails, the agent is still
    // created and can be repaired later.
    try {
      await provisionAgentPaperclipKeyForHire(agent);
    } catch (err) {
      logger.warn(
        { err, agentId: agent.id },
        "auto-provision of PAPERCLIP_API_KEY failed — agent created without it",
      );
    }

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    // NEW 3 V1 (-tne) Gap 2: DENY branch — declared surface hit an
    // explicit company-floor deniedTool/deniedPath. Emit
    // `allowlist.violated` and refuse to queue the hire approval.
    // (The agent row is already created — left at pending_approval
    //  with no approval; operator sees the violation in activity_log.)
    if (envelopeVerdict.kind === "deny") {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "allowlist.violated",
        entityType: "agent",
        entityId: agent.id,
        details: {
          phase: "hire",
          reason: envelopeVerdict.reason,
          effectiveLevel: effectiveHireLevel,
          violations: envelopeVerdict.violations.map((v) => ({
            kind: v.kind,
            value: v.value,
            resultKind: v.result.kind,
          })),
        },
      });
      res.status(422).json({
        error: "hire rejected: declared allowlist surface hits company-floor deny rule",
        violations: envelopeVerdict.violations,
      });
      return;
    }

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      // NEW 3 V1 (-tne) Gap 2: ESCALATE branch — declared surface is
      // outside the company-floor envelope at policy/autopilot. Queue
      // an `allowlist.exception` approval (status pending) INSTEAD of
      // a `hire_agent` approval. Board reviews + approves or rejects.
      if (envelopeVerdict.kind === "escalate") {
        envelopeExceptionApproval = await approvalsSvc.create(companyId, {
          type: "allowlist.exception",
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
          status: "pending",
          payload: {
            agentId: agent.id,
            phase: "hire",
            declared: requestedInitialAllowlist,
            envelopeSnapshot: companyFloorEnvelope,
            violations: envelopeVerdict.violations.map((v) => ({
              kind: v.kind,
              value: v.value,
              resultKind: v.result.kind,
            })),
          },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date(),
        });
      }
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          // NEW 3 V1 (-tne): link to the envelope exception approval when
          // one was raised so the board UI can surface both together.
          linkedAllowlistExceptionApprovalId:
            envelopeExceptionApproval?.id ?? null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }
    // NEW 3 V1 (-tne) Gap 2: log the exception approval creation so the
    // board UI surfaces the out-of-envelope flag alongside the hire.
    if (envelopeExceptionApproval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: envelopeExceptionApproval.id,
        details: {
          type: envelopeExceptionApproval.type,
          linkedAgentId: agent.id,
          linkedHireApprovalId: approval?.id ?? null,
        },
      });
    }

    res.status(201).json({
      agent,
      approval,
      allowlistExceptionApproval: envelopeExceptionApproval,
    });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent") {
      assertBoard(req);
    }

    const {
      desiredSkills: requestedDesiredSkills,
      ...createInput
    } = req.body;
    createInput.adapterType = assertKnownAdapterType(createInput.adapterType);
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      createInput.adapterType,
      ((createInput.adapterConfig ?? {}) as Record<string, unknown>),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      createInput.adapterType,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      desiredSkillAssignment.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      companyId,
      createInput.adapterType,
      normalizedAdapterConfig,
    );

    const createdAgent = await svc.create(companyId, {
      ...createInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizeNewAgentRuntimeConfig(createInput.runtimeConfig),
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    res.status(201).json(agent);
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (actorAgent.role !== "ceo") {
        res.status(403).json({ error: "Only CEO can manage permissions" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
    }

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const effectiveCanAssignTasks =
      agent.role === "ceo" || Boolean(agent.permissions?.canCreateAgents) || req.body.canAssignTasks;
    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canAssignTasks: effectiveCanAssignTasks,
      },
    });

    res.json(await buildAgentDetail(agent));
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    res.json(await instructions.getBundle(existing));
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    if (hasOwn(req.body as object, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }

    const patchData = { ...(req.body as Record<string, unknown>) };
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;

    // NEW 3 V1 (-tne): intercept autonomy fields BEFORE the legacy update
    // path. On success, strip them from patchData so the existing flow
    // doesn't see them and svc.update() (which zod-unknown-field-strips
    // inside) stays clean.
    const autonomyResult = await applyAutonomyPatch(req, res, existing, patchData);
    if (autonomyResult.error) return;
    if (autonomyResult.handled) {
      delete patchData.autonomyLevel;
      delete patchData.allowlist;
      delete patchData.autonomyReason;
      // If the only fields on the patch were autonomy fields, early-exit.
      if (Object.keys(patchData).length === 0) {
        const refreshed = await svc.getById(id);
        res.json(refreshed ?? existing);
        return;
      }
    }
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      assertNoAgentInstructionsConfigMutation(req, adapterConfig);
      assertNoAgentHostWorkspaceCommandMutation(
        req,
        collectAgentAdapterWorkspaceCommandPaths(adapterConfig),
      );
      const changingInstructionsConfig = Object.keys(adapterConfig).some((key) =>
        KNOWN_INSTRUCTIONS_BUNDLE_KEYS.includes(key as (typeof KNOWN_INSTRUCTIONS_BUNDLE_KEYS)[number]),
      );
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsPath(req, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        const ADAPTER_AGNOSTIC_KEYS = [
          "env", "cwd", "timeoutSec", "graceSec",
          "promptTemplate", "bootstrapPromptTemplate",
        ] as const;
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
      );
      const normalizedEffectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        effectiveAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (touchesAdapterConfiguration && requestedAdapterType === "opencode_local") {
      const effectiveAdapterConfig = asRecord(patchData.adapterConfig) ?? {};
      await assertAdapterConfigConstraints(
        existing.companyId,
        requestedAdapterType,
        effectiveAdapterConfig,
      );
    }

    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    res.json(agent);
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.terminate(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const key = await svc.createApiKey(id, req.body.name);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keyId = req.params.keyId as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }

    const key = await svc.getKeyById(keyId);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    const revoked = await svc.revokeKey(agent.id, keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }

    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json(await buildSkippedWakeupResponse(agent, req.body.payload ?? null));
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.companyId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }

    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
      "manual",
      {
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      },
    );

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    assertCompanyAccess(req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const runs = await heartbeat.list(companyId, agentId, limit);
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const minCountParam = req.query.minCount as string | undefined;
    const minCount = minCountParam ? Math.max(0, Math.min(20, parseInt(minCountParam, 10) || 0)) : 0;

    const columns = {
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRuns = await db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (minCount > 0 && liveRuns.length < minCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(minCount - liveRuns.length);

      res.json([...liveRuns, ...recentRuns]);
      return;
    }

    res.json(liveRuns);
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);
    res.json(redactCurrentUserValue(run, await getCurrentUserRedactionOptions()));
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await heartbeat.getRun(runId);
    if (existing) {
      assertCompanyAccess(req, existing.companyId);
    }
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRunLogAccess(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await heartbeat.readLog(run, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.companyId);

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) {
      res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    assertCompanyAccess(req, operation.companyId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(liveRuns);
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json({
      ...run,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
    });
  });

  return router;
}
