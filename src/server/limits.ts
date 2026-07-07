import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AvailableUsageLimits,
  ExtraUsageStatus,
  LimitWindow,
  UnavailableUsageLimits,
  UsageLimits
} from "../shared/contracts.js";
import type { SessionRefreshNudge } from "./refresh-nudge.js";

const DEFAULT_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_CACHE_TTL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

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
  sessionRefreshNotifier?: SessionRefreshNotifier;
  sessionRefreshNudge?: SessionRefreshNudge;
  onNotificationError?: (error: unknown, event: SessionRefreshEvent) => void;
}

export interface LimitsProvider {
  getLimits(): Promise<UsageLimits>;
}

export interface PushedLimitsProvider extends LimitsProvider {
  ingest(limits: UsageLimits): void;
}

export interface PushedLimitsProviderOptions {
  maxAgeMs?: number;
  sessionRefreshNotifier?: SessionRefreshNotifier;
  sessionRefreshNudge?: SessionRefreshNudge;
  onNotificationError?: (error: unknown, event: SessionRefreshEvent) => void;
}

const DEFAULT_PUSHED_MAX_AGE_MS = 300_000;

export function createPushedLimitsProvider(options: PushedLimitsProviderOptions = {}): PushedLimitsProvider {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_PUSHED_MAX_AGE_MS;
  const observer = options.sessionRefreshNotifier || options.sessionRefreshNudge
    ? createSessionRefreshObserver({
        notifier: options.sessionRefreshNotifier,
        nudge: options.sessionRefreshNudge,
        onNotificationError: options.onNotificationError
      })
    : null;

  let latest: UsageLimits | null = null;
  let receivedAtMs = 0;

  return {
    ingest(limits: UsageLimits): void {
      latest = limits;
      receivedAtMs = Date.now();
      if (observer) {
        void observer.observe(limits, receivedAtMs).catch(() => undefined);
      }
    },
    async getLimits(): Promise<UsageLimits> {
      const now = Date.now();
      if (!latest) {
        return unavailable(new Date(now).toISOString(), "Waiting for the local usage agent to push plan limits.");
      }

      const ageMs = now - receivedAtMs;
      if (ageMs > maxAgeMs) {
        const ageMin = Math.round(ageMs / 60_000);
        return unavailable(
          new Date(now).toISOString(),
          `Plan limits are stale (last update ${ageMin} min ago). Is the local usage agent running?`
        );
      }

      return latest;
    }
  };
}

export interface SessionRefreshEvent {
  resetAt: string;
  nextResetAt: string | null;
  observedAt: string;
  currentUsedPercent: number | null;
}

export interface SessionRefreshNotifier {
  sendSessionRefreshAlert(event: SessionRefreshEvent): Promise<void>;
}

export interface SessionRefreshObserverOptions {
  notifier?: SessionRefreshNotifier | undefined;
  nudge?: SessionRefreshNudge | undefined;
  onNotificationError?: ((error: unknown, event: SessionRefreshEvent) => void) | undefined;
}

export interface SessionRefreshObserver {
  observe(limits: UsageLimits, nowMs: number): Promise<void>;
}

export function createSessionRefreshObserver(
  options: SessionRefreshObserverOptions = {}
): SessionRefreshObserver {
  const state: SessionRefreshState = {
    watchedResetAt: null,
    alertedResetAt: null,
    pendingAlert: null
  };

  return {
    observe(limits: UsageLimits, nowMs: number): Promise<void> {
      return observeSessionRefresh(limits, state, options, nowMs);
    }
  };
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
  let nextFetchAtMs = 0;
  let lastGood: AvailableUsageLimits | null = null;
  const observer = createSessionRefreshObserver({
    notifier: options.sessionRefreshNotifier,
    nudge: options.sessionRefreshNudge,
    onNotificationError: options.onNotificationError
  });

  return {
    async getLimits(): Promise<UsageLimits> {
      const now = Date.now();
      if (cached && now < nextFetchAtMs) {
        await observer.observe(cached, now);
        return cached;
      }

      const outcome = await fetchLimits(credentialsPath, endpoint, fetchImpl);
      if (outcome.limits.available) {
        lastGood = outcome.limits;
      }

      cached = !outcome.limits.available && outcome.transient && lastGood ? lastGood : outcome.limits;
      nextFetchAtMs = now + Math.max(cacheTtlMs, outcome.retryAfterMs ?? 0);
      await observer.observe(cached, now);
      return cached;
    }
  };
}

interface FetchOutcome {
  limits: UsageLimits;
  transient: boolean;
  retryAfterMs: number | null;
}

interface SessionRefreshState {
  watchedResetAt: string | null;
  alertedResetAt: string | null;
  pendingAlert: SessionRefreshEvent | null;
}

async function fetchLimits(credentialsPath: string, endpoint: string, fetchImpl: typeof fetch): Promise<FetchOutcome> {
  const fetchedAt = new Date().toISOString();

  const accessToken = await readAccessToken(credentialsPath);
  if (!accessToken) {
    return failure(unavailable(fetchedAt, `No OAuth token found at ${credentialsPath}. Log in with Claude Code first.`));
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
    return failure(unavailable(fetchedAt, `Usage endpoint unreachable: ${message}`), { transient: true });
  }

  if (response.status === 401 || response.status === 403) {
    return failure(unavailable(fetchedAt, "OAuth token rejected. Open Claude Code so it refreshes the token, then retry."));
  }

  if (response.status === 429) {
    return failure(unavailable(fetchedAt, "Usage endpoint rate limited (status 429). Retrying after a backoff."), {
      transient: true,
      retryAfterMs: readRetryAfterMs(response) ?? RATE_LIMIT_BACKOFF_MS
    });
  }

  if (!response.ok) {
    return failure(unavailable(fetchedAt, `Usage endpoint returned status ${response.status}.`), {
      transient: response.status >= 500
    });
  }

  return { limits: parseUsageResponse(await response.json(), fetchedAt), transient: false, retryAfterMs: null };
}

function failure(
  limits: UnavailableUsageLimits,
  options: { transient?: boolean; retryAfterMs?: number } = {}
): FetchOutcome {
  return { limits, transient: options.transient ?? false, retryAfterMs: options.retryAfterMs ?? null };
}

async function observeSessionRefresh(
  limits: UsageLimits,
  state: SessionRefreshState,
  options: SessionRefreshObserverOptions,
  nowMs: number
): Promise<void> {
  if (state.pendingAlert) {
    const sent = await sendSessionRefreshAlert(state.pendingAlert, state, options);
    if (!sent) {
      return;
    }
  }

  if (!limits.available) {
    return;
  }

  const sessionWindow = limits.windows.find((window) => window.key === "five_hour");
  if (!sessionWindow || !isValidDate(sessionWindow.resetsAt)) {
    return;
  }

  options.nudge?.schedule(sessionWindow.resetsAt, nowMs);

  if (!state.watchedResetAt) {
    state.watchedResetAt = sessionWindow.resetsAt;
    return;
  }

  const watchedResetAt = state.watchedResetAt;
  const watchedResetMs = Date.parse(watchedResetAt);
  if (!Number.isFinite(watchedResetMs)) {
    state.watchedResetAt = sessionWindow.resetsAt;
    return;
  }

  if (nowMs >= watchedResetMs && state.alertedResetAt !== watchedResetAt) {
    const nextResetAt = sessionWindow.resetsAt === watchedResetAt ? null : sessionWindow.resetsAt;
    const event: SessionRefreshEvent = {
      resetAt: watchedResetAt,
      nextResetAt,
      observedAt: new Date(nowMs).toISOString(),
      currentUsedPercent: nextResetAt ? sessionWindow.usedPercent : null
    };
    const sent = await sendSessionRefreshAlert(event, state, options);
    if (!sent) {
      return;
    }
  }

  if (sessionWindow.resetsAt !== watchedResetAt) {
    state.watchedResetAt = sessionWindow.resetsAt;
  }
}

async function sendSessionRefreshAlert(
  event: SessionRefreshEvent,
  state: SessionRefreshState,
  options: SessionRefreshObserverOptions
): Promise<boolean> {
  const notifier = options.notifier;
  if (!notifier) {
    state.alertedResetAt = event.resetAt;
    state.pendingAlert = null;
    return true;
  }

  try {
    await notifier.sendSessionRefreshAlert(event);
    state.alertedResetAt = event.resetAt;
    state.pendingAlert = null;
    return true;
  } catch (error) {
    state.pendingAlert = event;
    options.onNotificationError?.(error, event);
    return false;
  }
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function readRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
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

export function parseUsageLimits(payload: unknown): UsageLimits | null {
  const root = asRecord(payload);
  if (!root) {
    return null;
  }

  const fetchedAt = readString(root.fetchedAt);
  if (fetchedAt === null) {
    return null;
  }

  if (root.available === false) {
    const reason = readString(root.reason);
    return reason === null ? null : { available: false, fetchedAt, reason };
  }

  if (root.available !== true || !Array.isArray(root.windows)) {
    return null;
  }

  const windows: LimitWindow[] = [];
  for (const entry of root.windows) {
    const window = asRecord(entry);
    const key = readString(window?.key);
    const label = readString(window?.label);
    const usedPercent = readNumber(window?.usedPercent);
    const resetsAt = readString(window?.resetsAt);
    if (key === null || label === null || usedPercent === null || resetsAt === null) {
      return null;
    }

    windows.push({ key, label, usedPercent, resetsAt });
  }

  return { available: true, fetchedAt, windows, extraUsage: parseStoredExtraUsage(root.extraUsage) };
}

function parseStoredExtraUsage(payload: unknown): ExtraUsageStatus | null {
  const extra = asRecord(payload);
  if (!extra) {
    return null;
  }

  const monthlyLimit = readNumber(extra.monthlyLimit);
  const usedCredits = readNumber(extra.usedCredits);
  const usedPercent = readNumber(extra.usedPercent);
  const currency = readString(extra.currency);
  if (monthlyLimit === null || usedCredits === null || usedPercent === null || currency === null) {
    return null;
  }

  return { monthlyLimit, usedCredits, usedPercent, currency };
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

function unavailable(fetchedAt: string, reason: string): UnavailableUsageLimits {
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
