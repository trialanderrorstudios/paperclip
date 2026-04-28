import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import {
  autonomyStateMachine,
  AutonomyStateMachineError,
  effectiveAutonomyLevel,
} from "../services/autonomy-state-machine.js";
import { agents as agentsTable } from "@paperclipai/db";
import { resolveBoardTier, type AutonomyLevel } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";

    // NEW 3 V1.5 (-tne): pre-check for autonomy.promotion staleness.
    // The proposal's payload.fromLevel was correct when the proposal
    // was created — but a demotion trigger (budget/staleness/incident)
    // may have lowered the agent's effective level since. Approving a
    // stale proposal would either no-op (sm.promote throws `noop`) or
    // skip a tier (sm.promote throws `invalid_step`). Surface this to
    // the operator as a revision request rather than 500 / silent fail.
    if (existingApproval.type === "autonomy.promotion") {
      const stalePayload = existingApproval.payload as Record<string, unknown> | null;
      const targetAgentId =
        (stalePayload && typeof stalePayload.agentId === "string"
          ? stalePayload.agentId
          : null) ?? existingApproval.requestedByAgentId;
      const proposalFrom =
        stalePayload && typeof stalePayload.fromLevel === "string"
          ? (stalePayload.fromLevel as AutonomyLevel)
          : null;
      if (targetAgentId) {
        // Pre-check is a safety net; if the agent lookup fails for any
        // reason (db throw, missing select, etc.) fall through to the
        // standard approve path. The state machine's `sm.promote` will
        // throw cleanly with `noop` / `invalid_step` and the existing
        // catch path below will surface that as an audit row.
        let agentRow: {
          id: string;
          role: string;
          permissions: unknown;
        } | null = null;
        try {
          agentRow = await db
            .select({
              id: agentsTable.id,
              role: agentsTable.role,
              permissions: agentsTable.permissions,
            })
            .from(agentsTable)
            .where(eq(agentsTable.id, targetAgentId))
            .then((rows) => rows[0] ?? null);
        } catch (err) {
          logger.warn(
            { err, approvalId: id, targetAgentId },
            "autonomy.promotion staleness pre-check failed; falling through to approve",
          );
        }
        if (agentRow) {
          const currentLevel = effectiveAutonomyLevel(
            agentRow.permissions,
            agentRow.role,
          );
          if (proposalFrom && currentLevel !== proposalFrom) {
            // Stale — agent has been demoted (or otherwise re-leveled).
            // Convert the approve attempt into a revision request so
            // the operator sees what happened and can re-propose if
            // the agent re-accrues trust.
            const revisedNote =
              `proposal stale: agent currently at '${currentLevel}', payload fromLevel '${proposalFrom}'. ` +
              "A demotion trigger fired between proposal creation and approval; re-propose if criteria still met.";
            const revised = await svc.requestRevision(id, decidedByUserId, revisedNote);
            await logActivity(db, {
              companyId: revised.companyId,
              actorType: "user",
              actorId: req.actor.userId ?? "board",
              action: "approval.revision_requested",
              entityType: "approval",
              entityId: revised.id,
              details: {
                type: revised.type,
                staleProposal: true,
                proposalFromLevel: proposalFrom,
                currentLevel,
              },
            });
            res.status(409).json({
              error: revisedNote,
              code: "autonomy.proposal_stale",
              approval: redactApprovalPayload(revised),
            });
            return;
          }
        }
      }
    }

    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      // NEW 3 V1.5 (-tne): wire autonomy.promotion approval → sm.promote
      // so the agent's tier actually flips. Emit the audit row first
      // (so it survives even if promote throws), then attempt the
      // promote. Failures here are logged but do not roll back the
      // approval — the approval itself is the operator's decision and
      // a downstream demotion observer can correct any drift.
      if (approval.type === "autonomy.promotion") {
        const payload = (approval.payload ?? {}) as Record<string, unknown>;
        const targetAgentId =
          (typeof payload.agentId === "string" ? payload.agentId : null) ??
          approval.requestedByAgentId ?? null;
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          agentId: targetAgentId,
          action: "autonomy.proposal.approved",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requestedByAgentId: approval.requestedByAgentId,
            payload: approval.payload,
          },
        });

        if (targetAgentId && typeof payload.toLevel === "string") {
          const targetLevel = payload.toLevel as AutonomyLevel;
          // Resolve the deciding board user's tier so sm.promote can
          // enforce CEO-asymmetry (autopilot promotion requires owner).
          let membershipRole: string | null = null;
          if (req.actor.type === "board") {
            if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
              membershipRole = "owner";
            } else if (Array.isArray(req.actor.memberships)) {
              const m = req.actor.memberships.find(
                (entry) => entry.companyId === approval.companyId,
              );
              membershipRole = m?.membershipRole ?? null;
            }
          }
          const tier = resolveBoardTier(membershipRole);
          try {
            const sm = autonomyStateMachine(db);
            await sm.promote({
              agentId: targetAgentId,
              targetLevel,
              actor: {
                actorType: "user",
                actorId: req.actor.userId ?? "board",
                membershipRole,
                resolvedTier: tier,
              },
              justification: `approved via approval ${approval.id}`,
            });
          } catch (err) {
            if (err instanceof AutonomyStateMachineError) {
              // `noop` (already at target) and `invalid_step` (stale
              // payload that survived the pre-check) are expected
              // race outcomes. Audit them but don't 500.
              logger.warn(
                { code: err.code, approvalId: approval.id, targetAgentId, targetLevel },
                "autonomy.promotion approval applied but state machine refused",
              );
              await logActivity(db, {
                companyId: approval.companyId,
                actorType: "system",
                actorId: "approve-handler",
                agentId: targetAgentId,
                action: "autonomy.promotion.tier_flip_skipped",
                entityType: "approval",
                entityId: approval.id,
                details: { code: err.code, targetLevel, message: err.message },
              });
            } else {
              logger.error(
                { err, approvalId: approval.id, targetAgentId, targetLevel },
                "sm.promote threw unexpectedly from approve handler",
              );
            }
          }
        }
      } else if (approval.type === "allowlist.exception") {
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          agentId:
            typeof approval.payload === "object" && approval.payload !== null
              ? ((approval.payload as Record<string, unknown>).agentId as
                  | string
                  | undefined) ?? approval.requestedByAgentId ?? null
              : approval.requestedByAgentId ?? null,
          action: "allowlist.exception.approved",
          entityType: "approval",
          entityId: approval.id,
          details: {
            requestedByAgentId: approval.requestedByAgentId,
            payload: approval.payload,
          },
        });
      }

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
