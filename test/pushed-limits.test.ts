import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AvailableUsageLimits } from "../src/shared/contracts.js";
import { createApp } from "../src/server/app.js";
import { createPushedLimitsProvider } from "../src/server/limits.js";

const tempDirs: string[] = [];

function sampleLimits(fetchedAt = "2026-06-18T10:00:00.000Z"): AvailableUsageLimits {
  return {
    available: true,
    fetchedAt,
    windows: [{ key: "five_hour", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-06-18T13:30:00+00:00" }],
    extraUsage: null
  };
}

function makeApp(): ReturnType<typeof createApp> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pushed-"));
  tempDirs.push(tempDir);
  return createApp({
    databasePath: path.join(tempDir, "usage.sqlite"),
    port: 4318,
    logger: false,
    limitsSource: "push"
  });
}

describe("pushed limits provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should report unavailable before any snapshot is pushed", async () => {
    const provider = createPushedLimitsProvider();

    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (!limits.available) {
      expect(limits.reason).toContain("Waiting for the local usage agent");
    }
  });

  it("should return the latest pushed snapshot", async () => {
    const provider = createPushedLimitsProvider();
    provider.ingest(sampleLimits());

    const limits = await provider.getLimits();

    expect(limits).toEqual(sampleLimits());
  });

  it("should report the snapshot as stale once it exceeds maxAgeMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T10:00:00.000Z"));
    const provider = createPushedLimitsProvider({ maxAgeMs: 60_000 });
    provider.ingest(sampleLimits());

    vi.setSystemTime(new Date("2026-06-18T10:05:00.000Z"));
    const limits = await provider.getLimits();

    expect(limits.available).toBe(false);
    if (!limits.available) {
      expect(limits.reason).toContain("stale");
    }
  });
});

describe("limits ingest route", () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should round-trip a pushed snapshot through ingest and limits", async () => {
    const app = await makeApp();
    await app.ready();

    const ingestResponse = await app.inject({
      method: "POST",
      url: "/api/limits/ingest",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(sampleLimits())
    });
    expect(ingestResponse.statusCode).toBe(200);

    const limitsResponse = await app.inject({ method: "GET", url: "/api/limits" });
    expect(limitsResponse.statusCode).toBe(200);
    expect(limitsResponse.json()).toEqual(sampleLimits());

    await app.close();
  });

  it("should reject an invalid limits payload with 400", async () => {
    const app = await makeApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/limits/ingest",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ available: true, windows: "nope" })
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("should report unavailable before the first push", async () => {
    const app = await makeApp();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/limits" });
    expect(response.statusCode).toBe(200);
    expect(response.json().available).toBe(false);

    await app.close();
  });
});
