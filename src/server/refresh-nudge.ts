import { execFile } from "node:child_process";

const DEFAULT_CLAUDE_REFRESH_CLI = "claude";
const DEFAULT_CLAUDE_REFRESH_PROMPT = "Reply only with: refreshed";
const DEFAULT_CLAUDE_REFRESH_OFFSET_MS = 60_000;
const DEFAULT_CLAUDE_REFRESH_TIMEOUT_MS = 120_000;
const DEFAULT_CLAUDE_REFRESH_RETRY_MS = 60_000;
const DEFAULT_CLAUDE_REFRESH_MAX_BUDGET_USD = "0.05";
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SAME_RESET_TOLERANCE_MS = 5 * 60_000;

export interface SessionRefreshNudge {
  schedule(resetAt: string, nowMs: number): void;
  stop(): void;
}

export interface RefreshNudgeScheduledEvent {
  resetAt: string;
  dueAt: string;
  scheduledAt: string;
  command: string;
}

export interface RefreshNudgeSentEvent {
  resetAt: string;
  attemptedAt: string;
  command: string;
}

export interface RefreshNudgeFailedEvent {
  resetAt: string;
  attemptedAt: string;
  retryAt: string;
  command: string;
  errorMessage: string;
}

export interface RefreshNudgeNotifier {
  sendRefreshNudgeScheduled(event: RefreshNudgeScheduledEvent): Promise<void>;
  sendRefreshNudgeSent(event: RefreshNudgeSentEvent): Promise<void>;
  sendRefreshNudgeFailed(event: RefreshNudgeFailedEvent): Promise<void>;
}

export interface RefreshCommandOptions {
  timeoutMs: number;
}

export type RefreshCommandRunner = (
  command: string,
  args: readonly string[],
  options: RefreshCommandOptions
) => Promise<void>;

export type RefreshNudgeLogLevel = "info" | "error";

export type RefreshNudgeLogHandler = (
  level: RefreshNudgeLogLevel,
  message: string,
  data: Record<string, unknown>
) => void;

export interface RefreshNudgeOptions {
  command: string;
  args: readonly string[];
  offsetMs: number;
  timeoutMs: number;
  retryMs: number;
  runCommand?: RefreshCommandRunner;
  notifier?: RefreshNudgeNotifier;
  onLog?: RefreshNudgeLogHandler;
}

interface ScheduledRefresh {
  resetAt: string;
  resetMs: number;
  dueMs: number;
}

export function createClaudeRefreshNudgeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onLog: RefreshNudgeLogHandler = defaultLog,
  notifier?: RefreshNudgeNotifier
): SessionRefreshNudge | null {
  const options = createClaudeRefreshNudgeOptionsFromEnv(env, onLog, undefined, notifier);
  return options ? createRefreshNudge(options) : null;
}

export function createClaudeRefreshNudgeOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onLog: RefreshNudgeLogHandler = defaultLog,
  runCommand?: RefreshCommandRunner,
  notifier?: RefreshNudgeNotifier
): RefreshNudgeOptions | null {
  if (isDisabled(env.CLAUDE_REFRESH_NUDGE)) {
    return null;
  }

  const command = readStringEnv(env.CLAUDE_REFRESH_CLI) ?? DEFAULT_CLAUDE_REFRESH_CLI;
  const prompt = readStringEnv(env.CLAUDE_REFRESH_PROMPT) ?? DEFAULT_CLAUDE_REFRESH_PROMPT;
  const maxBudgetUsd = readStringEnv(env.CLAUDE_REFRESH_MAX_BUDGET_USD) ?? DEFAULT_CLAUDE_REFRESH_MAX_BUDGET_USD;

  return {
    command,
    args: [
      "--safe-mode",
      "--print",
      "--no-session-persistence",
      "--tools",
      "",
      "--max-budget-usd",
      maxBudgetUsd,
      prompt
    ],
    offsetMs: readNonNegativeIntegerEnv(env, "CLAUDE_REFRESH_OFFSET_MS", DEFAULT_CLAUDE_REFRESH_OFFSET_MS),
    timeoutMs: readPositiveIntegerEnv(env, "CLAUDE_REFRESH_TIMEOUT_MS", DEFAULT_CLAUDE_REFRESH_TIMEOUT_MS),
    retryMs: readPositiveIntegerEnv(env, "CLAUDE_REFRESH_RETRY_MS", DEFAULT_CLAUDE_REFRESH_RETRY_MS),
    ...(runCommand ? { runCommand } : {}),
    ...(notifier ? { notifier } : {}),
    onLog
  };
}

export function createRefreshNudge(options: RefreshNudgeOptions): SessionRefreshNudge {
  const runCommand = options.runCommand ?? execFileCommandRunner;
  let scheduled: ScheduledRefresh | null = null;
  let completedResetMs: number | null = null;
  let failureNotifiedResetMs: number | null = null;
  let runningResetAt: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const log = (level: RefreshNudgeLogLevel, message: string, data: Record<string, unknown>): void => {
    options.onLog?.(level, message, data);
  };

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const queueRun = (resetAt: string, delayMs: number): void => {
    clearTimer();
    timer = setTimeout(() => {
      void run(resetAt);
    }, delayMs);
  };

  const run = async (resetAt: string): Promise<void> => {
    if (!scheduled || scheduled.resetAt !== resetAt || isSameReset(completedResetMs, scheduled.resetMs)) {
      return;
    }

    const activeSchedule = scheduled;
    if (runningResetAt === resetAt) {
      return;
    }

    runningResetAt = resetAt;
    const attemptedAt = new Date().toISOString();

    try {
      await runCommand(options.command, options.args, { timeoutMs: options.timeoutMs });
      completedResetMs = activeSchedule.resetMs;
      if (scheduled?.resetAt === resetAt) {
        scheduled = null;
      }
      log("info", "Claude refresh nudge sent", { resetAt, attemptedAt, command: options.command });
      await notifyRefreshNudgeSent(options, { resetAt, attemptedAt, command: options.command }, log);
    } catch (error) {
      const retryAt = new Date(Date.now() + options.retryMs).toISOString();
      const errorMessage = describeError(error);
      log("error", "Claude refresh nudge failed", {
        resetAt,
        attemptedAt,
        command: options.command,
        retryMs: options.retryMs,
        error: errorMessage
      });
      if (!isSameReset(failureNotifiedResetMs, activeSchedule.resetMs)) {
        failureNotifiedResetMs = activeSchedule.resetMs;
        await notifyRefreshNudgeFailed(
          options,
          { resetAt, attemptedAt, retryAt, command: options.command, errorMessage },
          log
        );
      }
      if (scheduled?.resetAt === resetAt) {
        queueRun(resetAt, options.retryMs);
      }
    } finally {
      if (runningResetAt === resetAt) {
        runningResetAt = null;
      }
    }
  };

  return {
    schedule(resetAt: string, nowMs: number): void {
      const resetMs = Date.parse(resetAt);
      if (
        !Number.isFinite(resetMs) ||
        isSameReset(completedResetMs, resetMs) ||
        isSameReset(scheduled?.resetMs ?? null, resetMs)
      ) {
        return;
      }

      const dueMs = resetMs + options.offsetMs;
      const dueAt = new Date(dueMs).toISOString();
      const scheduledAt = new Date(nowMs).toISOString();
      scheduled = { resetAt, resetMs, dueMs };
      queueRun(resetAt, Math.max(0, dueMs - nowMs));
      log("info", "Scheduled Claude refresh nudge", {
        resetAt,
        dueAt,
        command: options.command
      });
      void notifyRefreshNudgeScheduled(options, { resetAt, dueAt, scheduledAt, command: options.command }, log);
    },
    stop(): void {
      clearTimer();
      scheduled = null;
    }
  };
}

export const execFileCommandRunner: RefreshCommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT_BYTES },
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      }
    );
  });

function isSameReset(existingMs: number | null, resetMs: number): boolean {
  return existingMs !== null && Math.abs(existingMs - resetMs) <= SAME_RESET_TOLERANCE_MS;
}

async function notifyRefreshNudgeScheduled(
  options: RefreshNudgeOptions,
  event: RefreshNudgeScheduledEvent,
  log: RefreshNudgeLogHandler
): Promise<void> {
  if (!options.notifier) {
    return;
  }

  try {
    await options.notifier.sendRefreshNudgeScheduled(event);
    log("info", "Refresh nudge Telegram notification sent", { event: "scheduled", resetAt: event.resetAt });
  } catch (error) {
    log("error", "Refresh nudge Telegram notification failed", {
      event: "scheduled",
      resetAt: event.resetAt,
      error: describeError(error)
    });
  }
}

async function notifyRefreshNudgeSent(
  options: RefreshNudgeOptions,
  event: RefreshNudgeSentEvent,
  log: RefreshNudgeLogHandler
): Promise<void> {
  if (!options.notifier) {
    return;
  }

  try {
    await options.notifier.sendRefreshNudgeSent(event);
    log("info", "Refresh nudge Telegram notification sent", { event: "sent", resetAt: event.resetAt });
  } catch (error) {
    log("error", "Refresh nudge Telegram notification failed", {
      event: "sent",
      resetAt: event.resetAt,
      error: describeError(error)
    });
  }
}

async function notifyRefreshNudgeFailed(
  options: RefreshNudgeOptions,
  event: RefreshNudgeFailedEvent,
  log: RefreshNudgeLogHandler
): Promise<void> {
  if (!options.notifier) {
    return;
  }

  try {
    await options.notifier.sendRefreshNudgeFailed(event);
    log("info", "Refresh nudge Telegram notification sent", { event: "failed", resetAt: event.resetAt });
  } catch (error) {
    log("error", "Refresh nudge Telegram notification failed", {
      event: "failed",
      resetAt: event.resetAt,
      error: describeError(error)
    });
  }
}

function readStringEnv(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function readNonNegativeIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readStringEnv(env[name]);
  if (raw === null) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer number of milliseconds.`);
  }

  return value;
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readStringEnv(env[name]);
  if (raw === null) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds.`);
  }

  return value;
}

function isDisabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return new Set(["0", "false", "no", "off"]).has(value.trim().toLowerCase());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLog(level: RefreshNudgeLogLevel, message: string, data: Record<string, unknown>): void {
  const entry = { level, message, time: new Date().toISOString(), ...data };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
