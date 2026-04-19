import { describe, expect, it, vi, beforeEach } from "vitest";
import { graduationSignalsService } from "../services/graduation-signals.ts";

interface ActivityRow {
  action: string;
  createdAt: Date;
}

function makeDb(rows: ActivityRow[], captureFilters?: { wheres: unknown[] }) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((w: unknown) => {
      captureFilters?.wheres.push(w);
      return chain;
    }),
    then: vi.fn((resolve: (rows: ActivityRow[]) => unknown) =>
      Promise.resolve(resolve(rows)),
    ),
  } as unknown as Record<string, unknown>;
  return {
    select: vi.fn(() => chain),
  };
}

describe("graduationSignalsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts clean runs, rejections, budget breaches", async () => {
    const rows: ActivityRow[] = [
      { action: "heartbeat.run.succeeded", createdAt: new Date("2026-04-10T00:00:00Z") },
      { action: "heartbeat.run.succeeded", createdAt: new Date("2026-04-11T00:00:00Z") },
      { action: "agent.run_completed", createdAt: new Date("2026-04-12T00:00:00Z") },
      { action: "approval.rejected", createdAt: new Date("2026-04-09T00:00:00Z") },
      { action: "budget.incident_opened", createdAt: new Date("2026-04-08T00:00:00Z") },
    ];
    const db = makeDb(rows);
    const svc = graduationSignalsService(db as any, {
      now: () => new Date("2026-04-19T00:00:00Z").getTime(),
    });
    const signals = await svc.getSignals("a1");
    expect(signals.cleanRunCount).toBe(3);
    expect(signals.boardRejectCount).toBe(1);
    expect(signals.budgetBreachCount).toBe(1);
    expect(signals.probationStart).toBe("2026-04-08T00:00:00.000Z");
  });

  it("computes tool rejection rate from allowlist violations / total runs", async () => {
    const rows: ActivityRow[] = [
      { action: "heartbeat.run.succeeded", createdAt: new Date("2026-04-10T00:00:00Z") },
      { action: "heartbeat.run.succeeded", createdAt: new Date("2026-04-11T00:00:00Z") },
      { action: "heartbeat.run.failed", createdAt: new Date("2026-04-12T00:00:00Z") },
      { action: "heartbeat.run.timed_out", createdAt: new Date("2026-04-13T00:00:00Z") },
      { action: "allowlist.violated", createdAt: new Date("2026-04-14T00:00:00Z") },
    ];
    const db = makeDb(rows);
    const svc = graduationSignalsService(db as any, {
      now: () => new Date("2026-04-19T00:00:00Z").getTime(),
    });
    const signals = await svc.getSignals("a1");
    // 1 allowlist-violation / 4 total runs = 0.25
    expect(signals.toolRejectionRate).toBe(0.25);
  });

  it("returns zeros for an agent with no activity", async () => {
    const db = makeDb([]);
    const svc = graduationSignalsService(db as any);
    const signals = await svc.getSignals("a1");
    expect(signals.cleanRunCount).toBe(0);
    expect(signals.boardRejectCount).toBe(0);
    expect(signals.toolRejectionRate).toBe(0);
    expect(signals.probationStart).toBeNull();
  });

  it("caches results for 60s per agent", async () => {
    const rows: ActivityRow[] = [
      { action: "heartbeat.run.succeeded", createdAt: new Date("2026-04-10T00:00:00Z") },
    ];
    const db = makeDb(rows);
    let nowMs = 1_000_000;
    const svc = graduationSignalsService(db as any, { now: () => nowMs });
    await svc.getSignals("a1");
    await svc.getSignals("a1");
    await svc.getSignals("a1");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("cache expires after 60s TTL", async () => {
    const rows: ActivityRow[] = [];
    const db = makeDb(rows);
    let nowMs = 1_000_000;
    const svc = graduationSignalsService(db as any, { now: () => nowMs });
    await svc.getSignals("a1");
    nowMs += 61 * 1000;
    await svc.getSignals("a1");
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("invalidate(agentId) clears only that agent's cache", async () => {
    const rows: ActivityRow[] = [];
    const db = makeDb(rows);
    const svc = graduationSignalsService(db as any);
    await svc.getSignals("a1");
    await svc.getSignals("a2");
    expect(db.select).toHaveBeenCalledTimes(2);
    svc.invalidate("a1");
    await svc.getSignals("a1");
    await svc.getSignals("a2");
    // a1 re-fetched, a2 still cached
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("issues a single select call covering a 30-day window", async () => {
    const rows: ActivityRow[] = [];
    const captureFilters = { wheres: [] as unknown[] };
    const db = makeDb(rows, captureFilters);
    const svc = graduationSignalsService(db as any, {
      now: () => new Date("2026-04-19T00:00:00Z").getTime(),
    });
    await svc.getSignals("a1");
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(captureFilters.wheres).toHaveLength(1);
  });
});
