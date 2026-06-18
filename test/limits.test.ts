import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLimitsProvider, type SessionRefreshEvent, type SessionRefreshNotifier } from "../src/server/limits.js";

const tempDirs: string[] = [];

function writeCredentials(accessToken = "test-token"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-limits-"));
  tempDirs.push(tempDir);
  const credentialsPath = path.join(tempDir, ".credentials.json");
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken } }));
  return credentialsPath;
}

function usageResponse(options: { fiveHourResetAt?: string; fiveHourUtilization?: number } = {}): Response {
  return new Response(
    JSON.stringify({
      five_hour: {
        utilization: options.fiveHourUtilization ?? 10,
        resets_at: options.fiveHourResetAt ?? "2026-06-11T13:30:00+00:00"
      },
      seven_day: { utilization: 27, resets_at: "2026-06-14T07:00:00+00:00" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 1, resets_at: "2026-06-14T07:00:00+00:00" },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 3000,
        used_credits: 2770,
        utilization: 92.33,
        currency: "EUR"
      }
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("limits provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return plan windows and extra usage when the usage endpoint responds", async () => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const limits = await provider.getLimits();

    expect(limits.available).toBe(true);
    if (!limits.available) {
      return;
    }

    expect(limits.windows).toEqual([
      { key: "five_hour", label: "Session (5h)", usedPercent: 10, resetsAt: "2026-06-11T13:30:00+00:00" },
      { key: "seven_day", label: "Weekly (all models)", usedPercent: 27, resetsAt: "2026-06-14T07:00:00+00:00" },
      { key: "seven_day_sonnet", label: "Weekly (Sonnet)", usedPercent: 1, resetsAt: "2026-06-14T07:00:00+00:00" }
    ]);
    expect(limits.extraUsage).toEqual({
      monthlyLimit: 3000,
      usedCredits: 2770,
      usedPercent: 92.33,
      currency: "EUR"
    });
  });

  it("should send the stored token with the oauth beta header", async () => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials("secret-abc"),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await provider.getLimits();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-abc",
          "anthropic-beta": "oauth-2025-04-20"
        })
      })
    );
  });

  it("should report unavailable when the credentials file is missing", async () => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: "/nonexistent/.credentials.json",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (limits.available) {
      return;
    }

    expect(limits.reason).toContain("No OAuth token found");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should report unavailable when the usage endpoint rejects the token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (limits.available) {
      return;
    }

    expect(limits.reason).toContain("OAuth token rejected");
  });

  it("should report unavailable when the usage endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (limits.available) {
      return;
    }

    expect(limits.reason).toContain("ECONNREFUSED");
  });

  it("should keep serving the last good limits when the endpoint is rate limited", async () => {
    vi.useFakeTimers();
    const responses = [usageResponse()];
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response("{}", { status: 429 }));
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 1_000
    });

    const first = await provider.getLimits();
    vi.advanceTimersByTime(1_500);
    const second = await provider.getLimits();

    expect(first.available).toBe(true);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should report unavailable when rate limited with no prior success", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (limits.available) {
      return;
    }

    expect(limits.reason).toContain("429");
  });

  it("should back off after a 429 before calling the endpoint again", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 1_000
    });

    await provider.getLimits();
    vi.advanceTimersByTime(60_000);
    await provider.getLimits();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await provider.getLimits();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("should not mask auth failures with stale limits", async () => {
    vi.useFakeTimers();
    const responses = [usageResponse()];
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response("{}", { status: 401 }));
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 1_000
    });

    await provider.getLimits();
    vi.advanceTimersByTime(1_500);
    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (limits.available) {
      return;
    }

    expect(limits.reason).toContain("OAuth token rejected");
  });

  it("should cache responses within the ttl", async () => {
    const fetchImpl = vi.fn(async () => usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 60_000
    });

    await provider.getLimits();
    await provider.getLimits();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should send a session refresh alert when the observed reset time passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:29:30.000Z"));
    const notifier: SessionRefreshNotifier = {
      sendSessionRefreshAlert: vi.fn(async () => undefined)
    };
    const fetchImpl = vi.fn(async () => usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      sessionRefreshNotifier: notifier
    });

    await provider.getLimits();
    vi.setSystemTime(new Date("2026-06-11T13:30:01.000Z"));
    await provider.getLimits();
    await provider.getLimits();

    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledTimes(1);
    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00+00:00",
      nextResetAt: null,
      observedAt: "2026-06-11T13:30:01.000Z",
      currentUsedPercent: null
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("should include the next reset when the endpoint advances after a refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:29:00.000Z"));
    const notifier: SessionRefreshNotifier = {
      sendSessionRefreshAlert: vi.fn(async () => undefined)
    };
    const responses = [
      usageResponse({ fiveHourResetAt: "2026-06-11T13:30:00+00:00" }),
      usageResponse({ fiveHourResetAt: "2026-06-11T18:30:00+00:00", fiveHourUtilization: 4 })
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? usageResponse());
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheTtlMs: 1_000,
      sessionRefreshNotifier: notifier
    });

    await provider.getLimits();
    vi.setSystemTime(new Date("2026-06-11T13:31:00.000Z"));
    await provider.getLimits();

    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00+00:00",
      nextResetAt: "2026-06-11T18:30:00+00:00",
      observedAt: "2026-06-11T13:31:00.000Z",
      currentUsedPercent: 4
    });
  });

  it("should retry a session refresh alert when the notifier fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:29:30.000Z"));
    const notificationErrors: Array<{ error: unknown; event: SessionRefreshEvent }> = [];
    const notifier: SessionRefreshNotifier = {
      sendSessionRefreshAlert: vi.fn().mockRejectedValueOnce(new Error("telegram unavailable")).mockResolvedValueOnce(undefined)
    };
    const provider = createLimitsProvider({
      credentialsPath: writeCredentials(),
      fetchImpl: vi.fn(async () => usageResponse()) as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      sessionRefreshNotifier: notifier,
      onNotificationError: (error, event) => {
        notificationErrors.push({ error, event });
      }
    });

    await provider.getLimits();
    vi.setSystemTime(new Date("2026-06-11T13:30:01.000Z"));
    await provider.getLimits();
    await provider.getLimits();

    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledTimes(2);
    expect(notificationErrors).toHaveLength(1);
  });
});
