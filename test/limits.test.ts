import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLimitsProvider } from "../src/server/limits.js";

const tempDirs: string[] = [];

function writeCredentials(accessToken = "test-token"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-limits-"));
  tempDirs.push(tempDir);
  const credentialsPath = path.join(tempDir, ".credentials.json");
  fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken } }));
  return credentialsPath;
}

function usageResponse(): Response {
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 10, resets_at: "2026-06-11T13:30:00+00:00" },
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
});
