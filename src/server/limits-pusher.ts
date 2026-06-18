import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import type { UsageLimits } from "../shared/contracts.js";
import { createLimitsProvider } from "./limits.js";
import { createTelegramSessionRefreshNotifierFromEnv } from "./telegram.js";

const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  loadEnvFile(envPath);
}

const ingestUrl = process.env.DASHBOARD_INGEST_URL;
const ingestAuth = process.env.DASHBOARD_INGEST_AUTH;
const intervalMs = Number(process.env.LIMITS_PUSH_INTERVAL_MS ?? 60_000);

if (!ingestUrl) {
  throw new Error("DASHBOARD_INGEST_URL is required (e.g. https://host/api/limits/ingest).");
}

const notifier = createTelegramSessionRefreshNotifierFromEnv();
const provider = createLimitsProvider({
  ...(notifier ? { sessionRefreshNotifier: notifier } : {}),
  onNotificationError: (error, event) => {
    log("error", "Telegram session refresh alert failed", { event, error: describeError(error) });
  }
});

async function pushLimits(target: string): Promise<void> {
  const limits = await provider.getLimits();
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ingestAuth ? { Authorization: ingestAuth } : {})
    },
    body: JSON.stringify(limits)
  });

  if (!response.ok) {
    throw new PushError(`Ingest endpoint returned status ${response.status}.`, response.status);
  }

  log("info", "Pushed limits snapshot", { available: limits.available, ...summarize(limits) });
}

function tick(target: string): void {
  pushLimits(target).catch((error: unknown) => {
    log("error", "Failed to push limits snapshot", { error: describeError(error) });
  });
}

const interval = setInterval(() => tick(ingestUrl), intervalMs);
tick(ingestUrl);

log("info", "Limits pusher started", { ingestUrl, intervalMs, telegram: notifier !== null });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(interval);
    process.exit(0);
  });
}

class PushError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PushError";
    this.status = status;
  }
}

function summarize(limits: UsageLimits): Record<string, unknown> {
  return limits.available
    ? { windows: limits.windows.length }
    : { reason: limits.reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(level: "info" | "error", message: string, data: Record<string, unknown> = {}): void {
  const entry = { level, message, time: new Date().toISOString(), ...data };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
