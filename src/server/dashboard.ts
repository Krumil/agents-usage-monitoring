import {
  type BreakdownItem,
  type DashboardData,
  type DashboardTotals,
  type RangeKey,
  type TimeBucket
} from "../shared/contracts.js";
import type { StoredMetricSample, UsageDatabase } from "./db.js";
import { mergeAttributes } from "./otel.js";

interface RangeWindow {
  sinceMs: number | null;
  bucketMs: number;
}

interface BucketAccumulator {
  startMs: number;
  endMs: number;
  tokens: number;
  costUsd: number;
  activeSeconds: number;
  linesAdded: number;
  linesRemoved: number;
  sessions: number;
}

const emptyTotals = (): DashboardTotals => ({
  sessions: 0,
  costUsd: 0,
  tokens: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0
  },
  activeSeconds: {
    cli: 0,
    user: 0,
    total: 0
  },
  lines: {
    added: 0,
    removed: 0,
    net: 0
  },
  commits: 0,
  pullRequests: 0,
  editDecisions: {
    accepted: 0,
    rejected: 0
  }
});

export function buildDashboard(database: UsageDatabase, range: RangeKey, nowMs = Date.now()): DashboardData {
  const window = getRangeWindow(range, nowMs);
  const samples = database.getSamplesSince(window.sinceMs);
  const totals = emptyTotals();
  const modelCost = new Map<string, number>();
  const modelTokens = new Map<string, number>();
  const querySourceCost = new Map<string, number>();
  const sessionCost = new Map<string, number>();

  for (const sample of samples) {
    const attributes = mergeAttributes(sample);
    const type = stringAttribute(attributes, "type");
    const model = stringAttribute(attributes, "model");
    const querySource = stringAttribute(attributes, "query_source");
    const sessionId = stringAttribute(attributes, "session.id");

    switch (sample.metricName) {
      case "claude_code.session.count":
        totals.sessions += sample.value;
        break;
      case "claude_code.token.usage":
        addTokenTotal(totals, type, sample.value);
        addMapValue(modelTokens, model ?? "unknown", sample.value);
        break;
      case "claude_code.cost.usage":
        totals.costUsd += sample.value;
        addMapValue(modelCost, model ?? "unknown", sample.value);
        addMapValue(querySourceCost, querySource ?? "unknown", sample.value);
        addMapValue(sessionCost, sessionId ?? "unknown", sample.value);
        break;
      case "claude_code.active_time.total":
        addActiveTimeTotal(totals, type, sample.value);
        break;
      case "claude_code.lines_of_code.count":
        addLineTotal(totals, type, sample.value);
        break;
      case "claude_code.commit.count":
        totals.commits += sample.value;
        break;
      case "claude_code.pull_request.count":
        totals.pullRequests += sample.value;
        break;
      case "claude_code.code_edit_tool.decision":
        addDecisionTotal(totals, stringAttribute(attributes, "decision"), sample.value);
        break;
    }
  }

  totals.tokens.total =
    totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreation;
  totals.activeSeconds.total = totals.activeSeconds.cli + totals.activeSeconds.user;
  totals.lines.net = totals.lines.added - totals.lines.removed;

  return {
    range,
    generatedAt: new Date(nowMs).toISOString(),
    ingest: database.getStatus(),
    totals,
    series: buildSeries(samples, window, nowMs),
    breakdowns: {
      models: mergeBreakdowns(modelCost, modelTokens),
      tokenTypes: [
        { key: "input", value: totals.tokens.input },
        { key: "output", value: totals.tokens.output },
        { key: "cache read", value: totals.tokens.cacheRead },
        { key: "cache creation", value: totals.tokens.cacheCreation }
      ].filter((item) => item.value > 0),
      querySources: mapToBreakdown(querySourceCost),
      sessions: mapToBreakdown(sessionCost, 6)
    }
  };
}

function buildSeries(samples: StoredMetricSample[], window: RangeWindow, nowMs: number): TimeBucket[] {
  const minObserved = samples[0]?.observedAtMs ?? nowMs - window.bucketMs * 12;
  const sinceMs = window.sinceMs ?? minObserved;
  const startMs = alignDown(sinceMs, window.bucketMs);
  const endMs = alignUp(nowMs, window.bucketMs);
  const buckets = new Map<number, BucketAccumulator>();

  for (let bucketStart = startMs; bucketStart < endMs; bucketStart += window.bucketMs) {
    buckets.set(bucketStart, {
      startMs: bucketStart,
      endMs: bucketStart + window.bucketMs,
      tokens: 0,
      costUsd: 0,
      activeSeconds: 0,
      linesAdded: 0,
      linesRemoved: 0,
      sessions: 0
    });
  }

  for (const sample of samples) {
    const bucketStart = alignDown(sample.observedAtMs, window.bucketMs);
    const bucket = buckets.get(bucketStart);
    if (!bucket) {
      continue;
    }

    const attributes = mergeAttributes(sample);
    const type = stringAttribute(attributes, "type");

    if (sample.metricName === "claude_code.token.usage") {
      bucket.tokens += sample.value;
    }

    if (sample.metricName === "claude_code.cost.usage") {
      bucket.costUsd += sample.value;
    }

    if (sample.metricName === "claude_code.active_time.total") {
      bucket.activeSeconds += sample.value;
    }

    if (sample.metricName === "claude_code.lines_of_code.count" && type === "added") {
      bucket.linesAdded += sample.value;
    }

    if (sample.metricName === "claude_code.lines_of_code.count" && type === "removed") {
      bucket.linesRemoved += sample.value;
    }

    if (sample.metricName === "claude_code.session.count") {
      bucket.sessions += sample.value;
    }
  }

  return Array.from(buckets.values()).map((bucket) => ({
    start: new Date(bucket.startMs).toISOString(),
    end: new Date(bucket.endMs).toISOString(),
    label: formatBucketLabel(bucket.startMs, window.bucketMs),
    tokens: bucket.tokens,
    costUsd: bucket.costUsd,
    activeSeconds: bucket.activeSeconds,
    linesAdded: bucket.linesAdded,
    linesRemoved: bucket.linesRemoved,
    sessions: bucket.sessions
  }));
}

function getRangeWindow(range: RangeKey, nowMs: number): RangeWindow {
  switch (range) {
    case "1h":
      return { sinceMs: nowMs - 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 };
    case "24h":
      return { sinceMs: nowMs - 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 };
    case "7d":
      return { sinceMs: nowMs - 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    case "30d":
      return { sinceMs: nowMs - 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 };
    case "all":
      return { sinceMs: null, bucketMs: 24 * 60 * 60 * 1000 };
  }
}

function addTokenTotal(totals: DashboardTotals, type: string | null, value: number): void {
  if (type === "input") {
    totals.tokens.input += value;
  }

  if (type === "output") {
    totals.tokens.output += value;
  }

  if (type === "cacheRead") {
    totals.tokens.cacheRead += value;
  }

  if (type === "cacheCreation") {
    totals.tokens.cacheCreation += value;
  }
}

function addActiveTimeTotal(totals: DashboardTotals, type: string | null, value: number): void {
  if (type === "cli") {
    totals.activeSeconds.cli += value;
  }

  if (type === "user") {
    totals.activeSeconds.user += value;
  }
}

function addLineTotal(totals: DashboardTotals, type: string | null, value: number): void {
  if (type === "added") {
    totals.lines.added += value;
  }

  if (type === "removed") {
    totals.lines.removed += value;
  }
}

function addDecisionTotal(totals: DashboardTotals, decision: string | null, value: number): void {
  if (decision === "accept") {
    totals.editDecisions.accepted += value;
  }

  if (decision === "reject") {
    totals.editDecisions.rejected += value;
  }
}

function mergeBreakdowns(costs: Map<string, number>, tokens: Map<string, number>): BreakdownItem[] {
  const keys = new Set([...costs.keys(), ...tokens.keys()]);
  return Array.from(keys)
    .map((key) => ({
      key,
      value: costs.get(key) ?? 0,
      secondary: tokens.get(key) ?? 0
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function mapToBreakdown(map: Map<string, number>, limit = 8): BreakdownItem[] {
  return Array.from(map.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function addMapValue(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" ? value : null;
}

function alignDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function alignUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function formatBucketLabel(value: number, bucketMs: number): string {
  const date = new Date(value);

  if (bucketMs < 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (bucketMs < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: "2-digit" });
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
