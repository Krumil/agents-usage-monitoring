import { describe, expect, it } from "vitest";

import { formatDailySummary, msUntilNextHour } from "../src/server/daily-summary.js";
import type { DashboardTotals } from "../src/shared/contracts.js";

function totals(overrides: Partial<DashboardTotals> = {}): DashboardTotals {
  return {
    sessions: 6,
    costUsd: 4.2,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 1_240_000 },
    activeSeconds: { cli: 0, user: 0, total: 0 },
    lines: { added: 0, removed: 0, net: 0 },
    commits: 0,
    pullRequests: 0,
    editDecisions: { accepted: 0, rejected: 0 },
    ...overrides
  };
}

describe("daily summary", () => {
  it("should format cost, tokens, and sessions for the last 24h", () => {
    expect(formatDailySummary(totals())).toBe("Last 24h: $4.20, 1.2M tokens, 6 sessions.");
  });

  it("should schedule the next run later today when the hour is still ahead", () => {
    const now = Date.parse("2026-06-11T08:00:00");
    expect(msUntilNextHour(9, now)).toBe(60 * 60 * 1000);
  });

  it("should schedule the next run for tomorrow when the hour already passed", () => {
    const now = Date.parse("2026-06-11T10:00:00");
    expect(msUntilNextHour(9, now)).toBe(23 * 60 * 60 * 1000);
  });
});
