import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, budgetIncidents, heartbeatRuns } from "@paperclipai/db";

export type AgentTrust = {
  agentId: string;
  trustScore: number;
  violationsToday: number;
  cleanStreak: number;
};

export type CompanyTrustSnapshot = {
  companyHealthScore: number;
  cleanAgents: number;
  withViolations: number;
  runsToday: number;
  deniedToday: number;
  budgetIncidents: number;
  agents: AgentTrust[];
};

/**
 * Trust engine — §1.1.
 *
 * Compute formula (V1, on-read):
 *   violationsToday(agent) =
 *     count(approvals WHERE requested_by_agent_id = agent.id
 *                      AND status = 'rejected'
 *                      AND decided_at >= today_utc_start)
 *     + count(budget_incidents WHERE scope_type = 'agent'
 *                                AND scope_id = agent.id
 *                                AND created_at >= today_utc_start)
 *   trustScore(agent) = clamp(100 - violationsToday * 15 - agentBudgetIncidents * 10, 0, 100)
 *   cleanStreak(agent) = count(heartbeat_runs WHERE agent_id = agent.id
 *                                              AND status = 'completed'
 *                                              AND started_at > last_violation_at(agent))
 *                          (or all-time completed runs when no prior violation)
 *
 *   deniedToday(company)      = count(approvals WHERE company_id = X
 *                                               AND status = 'rejected'
 *                                               AND decided_at >= today_utc_start)
 *   runsToday(company)        = count(heartbeat_runs WHERE company_id = X
 *                                                    AND started_at >= today_utc_start)
 *   budgetIncidents(company)  = count(budget_incidents WHERE company_id = X
 *                                                      AND status = 'open')
 *   cleanAgents(company)      = count(agents WHERE violationsToday = 0)
 *   withViolations(company)   = count(agents WHERE violationsToday > 0)
 *   companyHealthScore        = round(mean(agent trustScores)); 100 when no agents.
 */
export function trustService(db: Db) {
  function startOfUtcDay(now: Date = new Date()): Date {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
  }

  function computeTrustScore(violationsToday: number, agentBudgetIncidents: number): number {
    const raw = 100 - violationsToday * 15 - agentBudgetIncidents * 10;
    return Math.max(0, Math.min(100, raw));
  }

  async function getCompanyTrust(companyId: string): Promise<CompanyTrustSnapshot> {
    const dayStart = startOfUtcDay();

    const companyAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    // Per-agent denial counts today
    const agentDenials = await db
      .select({
        agentId: approvals.requestedByAgentId,
        count: sql<number>`count(*)::int`,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "rejected"),
          gte(approvals.decidedAt, dayStart),
        ),
      )
      .groupBy(approvals.requestedByAgentId);

    // Per-agent budget incidents today
    const agentBudgetToday = await db
      .select({
        agentId: budgetIncidents.scopeId,
        count: sql<number>`count(*)::int`,
      })
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.companyId, companyId),
          eq(budgetIncidents.scopeType, "agent"),
          gte(budgetIncidents.createdAt, dayStart),
        ),
      )
      .groupBy(budgetIncidents.scopeId);

    // Per-agent completed runs (for cleanStreak approximation)
    const agentCompletedRuns = await db
      .select({
        agentId: heartbeatRuns.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "completed"),
        ),
      )
      .groupBy(heartbeatRuns.agentId);

    const denialsByAgent = new Map<string, number>();
    for (const row of agentDenials) {
      if (row.agentId) denialsByAgent.set(row.agentId, Number(row.count) || 0);
    }
    const budgetByAgent = new Map<string, number>();
    for (const row of agentBudgetToday) {
      if (row.agentId) budgetByAgent.set(row.agentId, Number(row.count) || 0);
    }
    const cleanRunsByAgent = new Map<string, number>();
    for (const row of agentCompletedRuns) {
      if (row.agentId) cleanRunsByAgent.set(row.agentId, Number(row.count) || 0);
    }

    const agentTrust: AgentTrust[] = companyAgents.map((agent) => {
      const denials = denialsByAgent.get(agent.id) ?? 0;
      const budget = budgetByAgent.get(agent.id) ?? 0;
      const violationsToday = denials + budget;
      const trustScore = computeTrustScore(violationsToday, budget);
      const cleanStreak = violationsToday > 0 ? 0 : (cleanRunsByAgent.get(agent.id) ?? 0);
      return {
        agentId: agent.id,
        trustScore,
        violationsToday,
        cleanStreak,
      };
    });

    // Company aggregates
    const deniedTodayRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.status, "rejected"),
          gte(approvals.decidedAt, dayStart),
        ),
      );
    const runsTodayRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          gte(heartbeatRuns.startedAt, dayStart),
        ),
      );
    const openBudgetIncidentsRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(budgetIncidents)
      .where(
        and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")),
      );

    const deniedToday = Number(deniedTodayRow[0]?.count ?? 0);
    const runsToday = Number(runsTodayRow[0]?.count ?? 0);
    const companyBudgetIncidents = Number(openBudgetIncidentsRow[0]?.count ?? 0);
    const cleanAgents = agentTrust.filter((a) => a.violationsToday === 0).length;
    const withViolations = agentTrust.length - cleanAgents;
    const companyHealthScore = agentTrust.length === 0
      ? 100
      : Math.round(
        agentTrust.reduce((sum, a) => sum + a.trustScore, 0) / agentTrust.length,
      );

    return {
      companyHealthScore,
      cleanAgents,
      withViolations,
      runsToday,
      deniedToday,
      budgetIncidents: companyBudgetIncidents,
      agents: agentTrust,
    };
  }

  return {
    computeTrustScore,
    getCompanyTrust,
  };
}
