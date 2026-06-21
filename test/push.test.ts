import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { setVapidDetails, sendNotification } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn()
}));

vi.mock("web-push", () => ({ default: { setVapidDetails, sendNotification } }));

import { createApp } from "../src/server/app.js";
import { UsageDatabase } from "../src/server/db.js";
import { createPushSender } from "../src/server/push.js";
import type { PushSubscriptionPayload } from "../src/shared/contracts.js";

const tempDirs: string[] = [];

function makeDb(): UsageDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-push-"));
  tempDirs.push(dir);
  return new UsageDatabase(path.join(dir, "usage.sqlite"));
}

function subscription(endpoint: string): PushSubscriptionPayload {
  return { endpoint, expirationTime: null, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
}

const vapid = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:test@example.com" };

describe("push sender", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should prune subscriptions that return 410 Gone", async () => {
    const database = makeDb();
    database.savePushSubscription(subscription("https://push.example/a"));
    database.savePushSubscription(subscription("https://push.example/b"));

    sendNotification.mockImplementation(async (target: PushSubscriptionPayload) => {
      if (target.endpoint === "https://push.example/a") {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      return undefined;
    });

    const sender = createPushSender(database, vapid);
    await sender.sendToAll({ title: "Test", body: "Body" });

    expect(database.listPushSubscriptions().map((row) => row.endpoint)).toEqual(["https://push.example/b"]);
    database.close();
  });

  it("should keep subscriptions and report transient errors", async () => {
    const database = makeDb();
    database.savePushSubscription(subscription("https://push.example/a"));
    sendNotification.mockImplementation(async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });
    const errors: unknown[] = [];

    const sender = createPushSender(database, vapid, (error) => errors.push(error));
    await sender.sendToAll({ title: "Test", body: "Body" });

    expect(database.listPushSubscriptions()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    database.close();
  });

  it("should deliver session refresh alerts to all subscriptions", async () => {
    const database = makeDb();
    database.savePushSubscription(subscription("https://push.example/a"));
    sendNotification.mockResolvedValue(undefined);

    const sender = createPushSender(database, vapid);
    await sender.createSessionRefreshNotifier().sendSessionRefreshAlert({
      resetAt: "2026-06-11T13:30:00+00:00",
      nextResetAt: null,
      observedAt: "2026-06-11T13:30:01.000Z",
      currentUsedPercent: null
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [, body] = sendNotification.mock.calls[0] as [PushSubscriptionPayload, string];
    expect(JSON.parse(body).body).toContain("session refreshed");
    database.close();
  });
});

describe("push subscription routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeApp(): ReturnType<typeof createApp> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-push-app-"));
    tempDirs.push(dir);
    return createApp({
      databasePath: path.join(dir, "usage.sqlite"),
      port: 4318,
      logger: false,
      limitsSource: "push",
      vapid
    });
  }

  it("should expose the VAPID public key", async () => {
    const app = await makeApp();
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/push/vapid-public-key" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ key: "public-key" });
    await app.close();
  });

  it("should store and remove a subscription", async () => {
    const app = await makeApp();
    await app.ready();

    const subscribe = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(subscription("https://push.example/a"))
    });
    expect(subscribe.statusCode).toBe(200);

    const unsubscribe = await app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ endpoint: "https://push.example/a" })
    });
    expect(unsubscribe.statusCode).toBe(200);

    await app.close();
  });

  it("should reject a malformed subscription with 400", async () => {
    const app = await makeApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ endpoint: "https://push.example/a" })
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
