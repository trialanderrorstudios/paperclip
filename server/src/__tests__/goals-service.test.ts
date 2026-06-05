import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  goals,
  issues,
  projectGoals,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { goalService } from "../services/goals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres goal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("goalService.remove", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof goalService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-goals-service-");
    db = createDb(tempDb.connectionString);
    svc = goalService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.update(goals).set({ parentId: null });
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("detaches same-company goal references before deleting the goal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const childGoalId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const costEventId = randomUUID();
    const financeEventId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CFO",
      role: "finance",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(goals).values([
      {
        id: goalId,
        companyId,
        title: "Sprint 15",
        level: "team",
        status: "active",
      },
      {
        id: childGoalId,
        companyId,
        title: "Child goal",
        level: "task",
        status: "planned",
        parentId: goalId,
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Work graph",
      status: "in_progress",
      goalId,
    });

    await db.insert(projectGoals).values({
      projectId,
      goalId,
      companyId,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId,
      title: "Attached sprint ticket",
      status: "todo",
      priority: "medium",
    });

    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      issueId,
      projectId,
      goalId,
      provider: "openai",
      biller: "codex",
      model: "gpt-5",
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      costCents: 1,
      occurredAt: new Date(),
    });

    await db.insert(financeEvents).values({
      id: financeEventId,
      companyId,
      agentId,
      issueId,
      projectId,
      goalId,
      costEventId,
      eventKind: "llm_usage",
      direction: "debit",
      biller: "codex",
      provider: "openai",
      model: "gpt-5",
      amountCents: 1,
      occurredAt: new Date(),
    });

    await expect(svc.remove(goalId)).resolves.toEqual(expect.objectContaining({
      id: goalId,
      title: "Sprint 15",
    }));

    await expect(
      db.select().from(goals).where(eq(goals.id, goalId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select({ parentId: goals.parentId }).from(goals).where(eq(goals.id, childGoalId)),
    ).resolves.toEqual([{ parentId: null }]);
    await expect(
      db.select({ goalId: projects.goalId }).from(projects).where(eq(projects.id, projectId)),
    ).resolves.toEqual([{ goalId: null }]);
    await expect(
      db.select({ goalId: issues.goalId }).from(issues).where(eq(issues.id, issueId)),
    ).resolves.toEqual([{ goalId: null }]);
    await expect(
      db.select({ goalId: costEvents.goalId }).from(costEvents).where(eq(costEvents.id, costEventId)),
    ).resolves.toEqual([{ goalId: null }]);
    await expect(
      db.select({ goalId: financeEvents.goalId }).from(financeEvents).where(eq(financeEvents.id, financeEventId)),
    ).resolves.toEqual([{ goalId: null }]);
    await expect(
      db.select().from(projectGoals).where(eq(projectGoals.projectId, projectId)),
    ).resolves.toHaveLength(0);
  });
});
