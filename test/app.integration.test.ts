import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DashboardData } from "../src/shared/contracts.js";
import { createApp } from "../src/server/app.js";
import { createOtlpMetricsFixture } from "./fixtures.js";

const tempDirs: string[] = [];

describe("usage API", () => {
  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should ingest metrics and return dashboard totals", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-"));
    tempDirs.push(tempDir);
    const app = await createApp({
      databasePath: path.join(tempDir, "usage.sqlite"),
      port: 4318,
      logger: false
    });

    await app.ready();

    const ingestResponse = await app.inject({
      method: "POST",
      url: "/v1/metrics",
      headers: {
        "content-type": "application/json"
      },
      payload: JSON.stringify(createOtlpMetricsFixture())
    });
    expect(ingestResponse.statusCode).toBe(200);
    expect(ingestResponse.json()).toEqual({});

    const dashboardResponse = await app.inject({
      method: "GET",
      url: "/api/dashboard?range=all"
    });
    expect(dashboardResponse.statusCode).toBe(200);

    const dashboard = dashboardResponse.json() as DashboardData;
    expect(dashboard.totals.sessions).toBe(1);
    expect(dashboard.totals.tokens.total).toBe(2000);
    expect(dashboard.totals.costUsd).toBe(0.0375);
    expect(dashboard.totals.lines.net).toBe(33);
    expect(dashboard.totals.editDecisions.accepted).toBe(3);
    expect(dashboard.ingest.totalSamples).toBe(13);

    await app.close();
  });

  it("should reject OTLP protobuf payloads with setup guidance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-"));
    tempDirs.push(tempDir);
    const app = await createApp({
      databasePath: path.join(tempDir, "usage.sqlite"),
      port: 4318,
      logger: false
    });

    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/metrics",
      headers: {
        "content-type": "application/x-protobuf"
      },
      payload: Buffer.from([])
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().error).toContain("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json");

    await app.close();
  });

  it("should expose plan limits without touching the real credentials", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-usage-"));
    tempDirs.push(tempDir);
    const credentialsPath = path.join(tempDir, ".credentials.json");
    fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));

    const fetchImpl = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 42, resets_at: "2026-06-11T13:30:00+00:00" },
          seven_day: { utilization: 8, resets_at: "2026-06-14T07:00:00+00:00" }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const app = await createApp({
      databasePath: path.join(tempDir, "usage.sqlite"),
      port: 4318,
      logger: false,
      limits: { credentialsPath, fetchImpl: fetchImpl as typeof fetch }
    });

    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/limits" });
    expect(response.statusCode).toBe(200);

    const limits = response.json() as { available: boolean; windows: Array<{ key: string; usedPercent: number }> };
    expect(limits.available).toBe(true);
    expect(limits.windows).toHaveLength(2);
    expect(limits.windows[0]).toMatchObject({ key: "five_hour", usedPercent: 42 });

    await app.close();
  });
});
