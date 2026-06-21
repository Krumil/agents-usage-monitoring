import type { DashboardTotals } from "../shared/contracts.js";
import { buildDashboard } from "./dashboard.js";
import type { UsageDatabase } from "./db.js";
import type { PushSender } from "./push.js";

export interface DailySummaryOptions {
  database: UsageDatabase;
  pushSender: PushSender;
  hour: number;
  onError?: (error: unknown) => void;
}

export interface DailySummaryScheduler {
  stop(): void;
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

export function startDailySummaryScheduler(options: DailySummaryOptions): DailySummaryScheduler {
  let timer: NodeJS.Timeout;

  const fire = async (): Promise<void> => {
    try {
      const dashboard = buildDashboard(options.database, "24h");
      await options.pushSender.sendToAll({
        title: "Claude Code — daily summary",
        body: formatDailySummary(dashboard.totals),
        url: "/"
      });
    } catch (error) {
      options.onError?.(error);
    }
  };

  const scheduleNext = (): void => {
    timer = setTimeout(() => {
      void fire();
      scheduleNext();
    }, msUntilNextHour(options.hour, Date.now()));
  };

  scheduleNext();

  return {
    stop(): void {
      clearTimeout(timer);
    }
  };
}

export function formatDailySummary(totals: DashboardTotals): string {
  const cost = `$${totals.costUsd.toFixed(2)}`;
  const tokens = compactFormatter.format(totals.tokens.total);
  return `Last 24h: ${cost}, ${tokens} tokens, ${totals.sessions} sessions.`;
}

export function msUntilNextHour(hour: number, nowMs: number): number {
  const next = new Date(nowMs);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= nowMs) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - nowMs;
}
