import type { SessionRefreshEvent, SessionRefreshNotifier } from "./limits.js";
import type {
  RefreshNudgeFailedEvent,
  RefreshNudgeNotifier,
  RefreshNudgeScheduledEvent,
  RefreshNudgeSentEvent
} from "./refresh-nudge.js";

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const MAX_ERROR_BODY_LENGTH = 500;

export interface TelegramSessionRefreshNotifierOptions {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

export interface TelegramSessionRefreshNotifier extends SessionRefreshNotifier, RefreshNudgeNotifier {}

export class TelegramNotificationError extends Error {
  readonly status: number | null;
  readonly responseBody: string | null;

  constructor(message: string, options: { status?: number; responseBody?: string | null } = {}) {
    super(message);
    this.name = "TelegramNotificationError";
    this.status = options.status ?? null;
    this.responseBody = options.responseBody ?? null;
  }
}

export function createTelegramSessionRefreshNotifier(
  options: TelegramSessionRefreshNotifierOptions
): TelegramSessionRefreshNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL;

  async function sendMessage(text: string): Promise<void> {
    const response = await fetchImpl(`${apiBaseUrl}/bot${options.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: options.chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      throw new TelegramNotificationError(`Telegram sendMessage failed with status ${response.status}.`, {
        status: response.status,
        responseBody: await readResponseBody(response)
      });
    }
  }

  return {
    async sendSessionRefreshAlert(event: SessionRefreshEvent): Promise<void> {
      await sendMessage(formatSessionRefreshMessage(event));
    },
    async sendRefreshNudgeScheduled(event: RefreshNudgeScheduledEvent): Promise<void> {
      await sendMessage(formatRefreshNudgeScheduledMessage(event));
    },
    async sendRefreshNudgeSent(event: RefreshNudgeSentEvent): Promise<void> {
      await sendMessage(formatRefreshNudgeSentMessage(event));
    },
    async sendRefreshNudgeFailed(event: RefreshNudgeFailedEvent): Promise<void> {
      await sendMessage(formatRefreshNudgeFailedMessage(event));
    }
  };
}

export function createTelegramSessionRefreshNotifierFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TelegramSessionRefreshNotifier | null {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!botToken && !chatId) {
    return null;
  }

  if (!botToken || !chatId) {
    throw new TelegramNotificationError("Telegram alerts need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
  }

  return createTelegramSessionRefreshNotifier({ botToken, chatId });
}

export function formatSessionRefreshMessage(event: SessionRefreshEvent): string {
  const lines = [
    "Claude Code token session refreshed.",
    `Reset time: ${event.resetAt}`,
    `Observed: ${event.observedAt}`
  ];

  if (event.nextResetAt) {
    lines.push(`Next reset: ${event.nextResetAt}`);
  }

  if (event.currentUsedPercent !== null) {
    lines.push(`Current session remaining: ${formatRemainingPercent(event.currentUsedPercent)}`);
  }

  return lines.join("\n");
}

export function formatRefreshNudgeScheduledMessage(event: RefreshNudgeScheduledEvent): string {
  return [
    "Claude Code refresh nudge scheduled.",
    `Reset time: ${event.resetAt}`,
    `Will send: ${event.dueAt}`,
    `Scheduled: ${event.scheduledAt}`,
    `Command: ${event.command}`
  ].join("\n");
}

export function formatRefreshNudgeSentMessage(event: RefreshNudgeSentEvent): string {
  return [
    "Claude Code refresh nudge sent.",
    `Reset time: ${event.resetAt}`,
    `Sent: ${event.attemptedAt}`,
    `Command: ${event.command}`
  ].join("\n");
}

export function formatRefreshNudgeFailedMessage(event: RefreshNudgeFailedEvent): string {
  return [
    "Claude Code refresh nudge failed.",
    `Reset time: ${event.resetAt}`,
    `Attempted: ${event.attemptedAt}`,
    `Retry: ${event.retryAt}`,
    `Command: ${event.command}`,
    `Error: ${event.errorMessage}`
  ].join("\n");
}

function formatRemainingPercent(usedPercent: number): string {
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  return `${Math.round(remainingPercent)}%`;
}

async function readResponseBody(response: Response): Promise<string | null> {
  try {
    const body = await response.text();
    return body.length > MAX_ERROR_BODY_LENGTH ? `${body.slice(0, MAX_ERROR_BODY_LENGTH)}...` : body;
  } catch {
    return null;
  }
}
