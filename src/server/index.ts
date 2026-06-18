import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { createApp, resolveStaticDir } from "./app.js";
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

const ingestSecret = process.env.LIMITS_INGEST_SECRET;
if (limitsSource === "push" && !ingestSecret) {
  throw new Error("LIMITS_INGEST_SECRET is required when LIMITS_SOURCE=push (protects POST /api/limits/ingest).");
}

const app = await createApp({
  databasePath,
  port,
  staticDir: resolveStaticDir(),
  limitsSource,
  ...(ingestSecret ? { ingestSecret } : {}),
  ...(sessionRefreshNotifier ? { limits: { sessionRefreshNotifier } } : {})
});

await app.listen({ host, port });
