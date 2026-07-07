import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { createApp, resolveStaticDir } from "./app.js";
import type { VapidConfig } from "./push.js";
import { createClaudeRefreshNudgeFromEnv } from "./refresh-nudge.js";
import { createTelegramSessionRefreshNotifierFromEnv } from "./telegram.js";

const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  loadEnvFile(envPath);
}

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 4318);
const databasePath = path.resolve(process.env.DATABASE_PATH ?? ".data/claude-usage.sqlite");
const limitsSource = process.env.LIMITS_SOURCE === "push" ? "push" : "fetch";
const sessionRefreshNotifier = limitsSource === "push" ? null : createTelegramSessionRefreshNotifierFromEnv();
const sessionRefreshNudge =
  limitsSource === "push"
    ? null
    : createClaudeRefreshNudgeFromEnv(process.env, undefined, sessionRefreshNotifier ?? undefined);

const vapid = resolveVapidConfig();
const dailySummaryHour = resolveDailySummaryHour(process.env.DAILY_SUMMARY_HOUR);
const limits =
  sessionRefreshNotifier || sessionRefreshNudge
    ? {
        ...(sessionRefreshNotifier ? { sessionRefreshNotifier } : {}),
        ...(sessionRefreshNudge ? { sessionRefreshNudge } : {})
      }
    : undefined;

const app = await createApp({
  databasePath,
  port,
  staticDir: resolveStaticDir(),
  limitsSource,
  ...(limits ? { limits } : {}),
  ...(vapid ? { vapid } : {}),
  ...(dailySummaryHour !== undefined ? { dailySummaryHour } : {})
});

await app.listen({ host, port });

function resolveVapidConfig(): VapidConfig | undefined {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey && !privateKey && !subject) {
    return undefined;
  }

  if (!publicKey || !privateKey || !subject) {
    throw new Error("Web push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT (a mailto: or https: URL).");
  }

  return { publicKey, privateKey, subject };
}

function resolveDailySummaryHour(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }

  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("DAILY_SUMMARY_HOUR must be an integer between 0 and 23.");
  }

  return hour;
}
