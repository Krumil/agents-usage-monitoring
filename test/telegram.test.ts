import { describe, expect, it, vi } from "vitest";

import {
  createTelegramSessionRefreshNotifier,
  formatRefreshNudgeFailedMessage,
  formatRefreshNudgeScheduledMessage,
  formatRefreshNudgeSentMessage,
  formatSessionRefreshMessage,
  TelegramNotificationError
} from "../src/server/telegram.js";

const refreshEvent = {
  resetAt: "2026-06-11T13:30:00+00:00",
  nextResetAt: "2026-06-11T18:30:00+00:00",
  observedAt: "2026-06-11T13:31:00.000Z",
  currentUsedPercent: 4
};

const nudgeScheduledEvent = {
  resetAt: "2026-06-11T13:30:00+00:00",
  dueAt: "2026-06-11T13:31:00.000Z",
  scheduledAt: "2026-06-11T13:00:00.000Z",
  command: "claude"
};

const nudgeSentEvent = {
  resetAt: "2026-06-11T13:30:00+00:00",
  attemptedAt: "2026-06-11T13:31:00.000Z",
  command: "claude"
};

const nudgeFailedEvent = {
  resetAt: "2026-06-11T13:30:00+00:00",
  attemptedAt: "2026-06-11T13:31:00.000Z",
  retryAt: "2026-06-11T13:32:00.000Z",
  command: "claude",
  errorMessage: "command failed"
};

describe("telegram session refresh notifier", () => {
  it("should format the session refresh message", () => {
    expect(formatSessionRefreshMessage(refreshEvent)).toBe(
      [
        "Claude Code token session refreshed.",
        "Reset time: 2026-06-11T13:30:00+00:00",
        "Observed: 2026-06-11T13:31:00.000Z",
        "Next reset: 2026-06-11T18:30:00+00:00",
        "Current session remaining: 96%"
      ].join("\n")
    );
  });

  it("should send a Telegram message for a session refresh alert", async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const notifier = createTelegramSessionRefreshNotifier({
      botToken: "bot-token",
      chatId: "chat-1",
      apiBaseUrl: "https://telegram.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await notifier.sendSessionRefreshAlert(refreshEvent);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://telegram.test/botbot-token/sendMessage",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } })
    );

    const requestInit = fetchImpl.mock.calls[0]?.[1];
    expect(typeof requestInit?.body).toBe("string");
    if (typeof requestInit?.body !== "string") {
      return;
    }

    expect(JSON.parse(requestInit.body) as unknown).toEqual({
      chat_id: "chat-1",
      text: formatSessionRefreshMessage(refreshEvent),
      disable_web_page_preview: true
    });
  });

  it("should format refresh nudge status messages", () => {
    expect(formatRefreshNudgeScheduledMessage(nudgeScheduledEvent)).toBe(
      [
        "Claude Code refresh nudge scheduled.",
        "Reset time: 2026-06-11T13:30:00+00:00",
        "Will send: 2026-06-11T13:31:00.000Z",
        "Scheduled: 2026-06-11T13:00:00.000Z",
        "Command: claude"
      ].join("\n")
    );
    expect(formatRefreshNudgeSentMessage(nudgeSentEvent)).toBe(
      [
        "Claude Code refresh nudge sent.",
        "Reset time: 2026-06-11T13:30:00+00:00",
        "Sent: 2026-06-11T13:31:00.000Z",
        "Command: claude"
      ].join("\n")
    );
    expect(formatRefreshNudgeFailedMessage(nudgeFailedEvent)).toBe(
      [
        "Claude Code refresh nudge failed.",
        "Reset time: 2026-06-11T13:30:00+00:00",
        "Attempted: 2026-06-11T13:31:00.000Z",
        "Retry: 2026-06-11T13:32:00.000Z",
        "Command: claude",
        "Error: command failed"
      ].join("\n")
    );
  });

  it("should send a Telegram message for refresh nudge status", async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const notifier = createTelegramSessionRefreshNotifier({
      botToken: "bot-token",
      chatId: "chat-1",
      apiBaseUrl: "https://telegram.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await notifier.sendRefreshNudgeScheduled(nudgeScheduledEvent);

    const requestInit = fetchImpl.mock.calls[0]?.[1];
    expect(typeof requestInit?.body).toBe("string");
    if (typeof requestInit?.body !== "string") {
      return;
    }

    expect(JSON.parse(requestInit.body) as unknown).toEqual({
      chat_id: "chat-1",
      text: formatRefreshNudgeScheduledMessage(nudgeScheduledEvent),
      disable_web_page_preview: true
    });
  });

  it("should throw a TelegramNotificationError when Telegram rejects the request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 400 }));
    const notifier = createTelegramSessionRefreshNotifier({
      botToken: "bot-token",
      chatId: "chat-1",
      apiBaseUrl: "https://telegram.test",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(notifier.sendSessionRefreshAlert(refreshEvent)).rejects.toMatchObject({
      name: "TelegramNotificationError",
      status: 400,
      responseBody: JSON.stringify({ ok: false })
    } satisfies Partial<TelegramNotificationError>);
  });
});
