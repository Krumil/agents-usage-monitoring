import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { isRangeKey, type RangeKey } from "../shared/contracts.js";
import { buildDashboard } from "./dashboard.js";
import { UsageDatabase } from "./db.js";
import { OtlpParseError, UnsupportedOtlpContentTypeError } from "./errors.js";
import { createLimitsProvider, type LimitsProviderOptions } from "./limits.js";
import { parseOtlpMetrics } from "./otel.js";
import { buildSetupInstructions } from "./setup.js";

export interface CreateAppOptions {
  databasePath: string;
  port: number;
  staticDir?: string;
  logger?: boolean;
  limits?: LimitsProviderOptions;
}

interface QueryRecord {
  [key: string]: string | string[] | undefined;
}

const liveEvents = new EventEmitter();

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const database = new UsageDatabase(options.databasePath);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 10 * 1024 * 1024
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  app.addContentTypeParser("application/x-protobuf", { parseAs: "buffer" }, (_request, _body, done) => {
    done(
      new UnsupportedOtlpContentTypeError(
        "This receiver accepts OTLP JSON. Set OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json."
      )
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnsupportedOtlpContentTypeError) {
      reply.code(415).send({ error: error.message });
      return;
    }

    if (error instanceof OtlpParseError) {
      reply.code(400).send({ error: error.message });
      return;
    }

    reply.send(error);
  });

  app.post("/v1/metrics", async (request, reply) => {
    const receivedAtMs = Date.now();
    const samples = parseOtlpMetrics(request.body, receivedAtMs);
    database.insertBatch(samples, receivedAtMs);
    liveEvents.emit("ingest");

    reply.header("Content-Type", "application/json");
    return {};
  });

  app.get("/api/dashboard", async (request, reply) => {
    const range = parseRange(request.query, "24h");
    if (!range) {
      reply.code(400).send({ error: "Invalid range. Use 1h, 24h, 7d, 30d, or all." });
      return;
    }

    return buildDashboard(database, range);
  });

  app.get("/api/setup", async () => buildSetupInstructions(options.port));

  const limitsProvider = createLimitsProvider(options.limits);
  app.get("/api/limits", async () => limitsProvider.getLimits());

  app.get("/api/live", async (request, reply) => {
    const range = parseRange(request.query, "24h") ?? "24h";

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const sendDashboard = (): void => {
      const payload = JSON.stringify(buildDashboard(database, range));
      reply.raw.write(`event: dashboard\ndata: ${payload}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      liveEvents.off("ingest", sendDashboard);
    };

    liveEvents.on("ingest", sendDashboard);
    request.raw.on("close", cleanup);
    sendDashboard();
  });

  const staticDir = options.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/"
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/v1")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }

      reply.sendFile("index.html");
    });
  }

  return app;
}

function parseRange(query: unknown, fallback: RangeKey): RangeKey | null {
  const queryObject = query as QueryRecord;
  const rawRange = queryObject.range;
  const range = Array.isArray(rawRange) ? rawRange[0] : rawRange;

  if (range === undefined) {
    return fallback;
  }

  return isRangeKey(range) ? range : null;
}

export function resolveStaticDir(): string {
  return path.resolve(process.cwd(), "dist/client");
}
