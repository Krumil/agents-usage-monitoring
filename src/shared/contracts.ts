export const RANGE_KEYS = ["1h", "24h", "7d", "30d", "all"] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];

export interface IngestStatus {
  lastReceivedAt: string | null;
  totalSamples: number;
  lastSampleCount: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface LineTotals {
  added: number;
  removed: number;
  net: number;
}

export interface DecisionTotals {
  accepted: number;
  rejected: number;
}

export interface ActiveTimeTotals {
  cli: number;
  user: number;
  total: number;
}

export interface DashboardTotals {
  sessions: number;
  costUsd: number;
  tokens: TokenTotals;
  activeSeconds: ActiveTimeTotals;
  lines: LineTotals;
  commits: number;
  pullRequests: number;
  editDecisions: DecisionTotals;
}

export interface TimeBucket {
  start: string;
  end: string;
  label: string;
  tokens: number;
  costUsd: number;
  activeSeconds: number;
  linesAdded: number;
  linesRemoved: number;
  sessions: number;
}

export interface BreakdownItem {
  key: string;
  value: number;
  secondary?: number;
}

export interface DashboardBreakdowns {
  models: BreakdownItem[];
  tokenTypes: BreakdownItem[];
  querySources: BreakdownItem[];
  sessions: BreakdownItem[];
}

export interface DashboardData {
  range: RangeKey;
  generatedAt: string;
  ingest: IngestStatus;
  totals: DashboardTotals;
  series: TimeBucket[];
  breakdowns: DashboardBreakdowns;
}

export interface SetupInstructions {
  endpoint: string;
  snippet: string;
}

export interface LimitWindow {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: string;
}

export interface ExtraUsageStatus {
  monthlyLimit: number;
  usedCredits: number;
  usedPercent: number;
  currency: string;
}

export interface AvailableUsageLimits {
  available: true;
  fetchedAt: string;
  windows: LimitWindow[];
  extraUsage: ExtraUsageStatus | null;
}

export interface UnavailableUsageLimits {
  available: false;
  fetchedAt: string;
  reason: string;
}

export type UsageLimits = AvailableUsageLimits | UnavailableUsageLimits;

export function isRangeKey(value: string): value is RangeKey {
  return RANGE_KEYS.includes(value as RangeKey);
}
