import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AvailableUsageLimits, ExtraUsageStatus, LimitWindow, UsageLimits } from "../shared/contracts.js";

const DEFAULT_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_CACHE_TTL_MS = 30_000;

const WINDOW_DEFINITIONS = [
  { key: "five_hour", label: "Session (5h)" },
  { key: "seven_day", label: "Weekly (all models)" },
  { key: "seven_day_opus", label: "Weekly (Opus)" },
  { key: "seven_day_sonnet", label: "Weekly (Sonnet)" }
] as const;

export interface LimitsProviderOptions {
  credentialsPath?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}

export interface LimitsProvider {
  getLimits(): Promise<UsageLimits>;
}

export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export function createLimitsProvider(options: LimitsProviderOptions = {}): LimitsProvider {
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const endpoint = options.endpoint ?? DEFAULT_USAGE_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  let cached: UsageLimits | null = null;
  let cachedAtMs = 0;

  return {
    async getLimits(): Promise<UsageLimits> {
      const now = Date.now();
      if (cached && now - cachedAtMs < cacheTtlMs) {
        return cached;
      }

      cached = await fetchLimits(credentialsPath, endpoint, fetchImpl);
      cachedAtMs = now;
      return cached;
    }
  };
}

async function fetchLimits(credentialsPath: string, endpoint: string, fetchImpl: typeof fetch): Promise<UsageLimits> {
  const fetchedAt = new Date().toISOString();

  const accessToken = await readAccessToken(credentialsPath);
  if (!accessToken) {
    return unavailable(fetchedAt, `No OAuth token found at ${credentialsPath}. Log in with Claude Code first.`);
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json"
      }
    });
  } catch (requestError) {
    const message = requestError instanceof Error ? requestError.message : "request failed";
    return unavailable(fetchedAt, `Usage endpoint unreachable: ${message}`);
  }

  if (response.status === 401 || response.status === 403) {
    return unavailable(fetchedAt, "OAuth token rejected. Open Claude Code so it refreshes the token, then retry.");
  }

  if (!response.ok) {
    return unavailable(fetchedAt, `Usage endpoint returned status ${response.status}.`);
  }

  return parseUsageResponse(await response.json(), fetchedAt);
}

async function readAccessToken(credentialsPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    return null;
  }

  try {
    const credentials = asRecord(JSON.parse(raw));
    const oauth = asRecord(credentials?.claudeAiOauth);
    return readString(oauth?.accessToken);
  } catch {
    return null;
  }
}

function parseUsageResponse(payload: unknown, fetchedAt: string): AvailableUsageLimits {
  const root = asRecord(payload) ?? {};
  const windows: LimitWindow[] = [];

  for (const definition of WINDOW_DEFINITIONS) {
    const window = asRecord(root[definition.key]);
    const usedPercent = readNumber(window?.utilization);
    const resetsAt = readString(window?.resets_at);
    if (usedPercent === null || resetsAt === null) {
      continue;
    }

    windows.push({ key: definition.key, label: definition.label, usedPercent, resetsAt });
  }

  return {
    available: true,
    fetchedAt,
    windows,
    extraUsage: parseExtraUsage(root.extra_usage)
  };
}

function parseExtraUsage(payload: unknown): ExtraUsageStatus | null {
  const extra = asRecord(payload);
  if (!extra || extra.is_enabled !== true) {
    return null;
  }

  const monthlyLimit = readNumber(extra.monthly_limit);
  const usedCredits = readNumber(extra.used_credits);
  const usedPercent = readNumber(extra.utilization);
  const currency = readString(extra.currency);
  if (monthlyLimit === null || usedCredits === null || usedPercent === null || currency === null) {
    return null;
  }

  return { monthlyLimit, usedCredits, usedPercent, currency };
}

function unavailable(fetchedAt: string, reason: string): UsageLimits {
  return { available: false, fetchedAt, reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
