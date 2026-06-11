import path from "node:path";

import { createApp, resolveStaticDir } from "./app.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 4318);
const databasePath = path.resolve(process.env.DATABASE_PATH ?? ".data/claude-usage.sqlite");

const app = await createApp({
  databasePath,
  port,
  staticDir: resolveStaticDir()
});

await app.listen({ host, port });
