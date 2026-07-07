import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClaudeRefreshNudgeOptionsFromEnv,
  createRefreshNudge,
  type RefreshCommandRunner,
  type RefreshNudgeLogHandler,
  type RefreshNudgeNotifier
} from "../src/server/refresh-nudge.js";

describe("refresh nudge scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should run one minute after the observed reset time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:00:00.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 59_000);
    expect(runCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("claude", ["--print", "refresh"], { timeoutMs: 120_000 });
  });

  it("should run immediately when the due time already passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:31:01.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("should not run twice for the same reset after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:31:01.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);
    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("should retry after a failed command", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:31:01.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>()
      .mockRejectedValueOnce(new Error("command failed"))
      .mockResolvedValueOnce(undefined);
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runCommand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("should notify when a refresh nudge is scheduled and sent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:29:00.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const notifier: RefreshNudgeNotifier = {
      sendRefreshNudgeScheduled: vi.fn(async () => undefined),
      sendRefreshNudgeSent: vi.fn(async () => undefined),
      sendRefreshNudgeFailed: vi.fn(async () => undefined)
    };
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand,
      notifier
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(notifier.sendRefreshNudgeScheduled).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00.000Z",
      dueAt: "2026-06-11T13:31:00.000Z",
      scheduledAt: "2026-06-11T13:29:00.000Z",
      command: "claude"
    });
    expect(notifier.sendRefreshNudgeSent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(notifier.sendRefreshNudgeSent).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00.000Z",
      attemptedAt: "2026-06-11T13:31:00.000Z",
      command: "claude"
    });
  });

  it("should notify the first failed attempt for a reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:31:01.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>().mockRejectedValue(new Error("command failed"));
    const notifier: RefreshNudgeNotifier = {
      sendRefreshNudgeScheduled: vi.fn(async () => undefined),
      sendRefreshNudgeSent: vi.fn(async () => undefined),
      sendRefreshNudgeFailed: vi.fn(async () => undefined)
    };
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand,
      notifier
    });

    nudge.schedule("2026-06-11T13:30:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(notifier.sendRefreshNudgeFailed).toHaveBeenCalledTimes(1);
    expect(notifier.sendRefreshNudgeFailed).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00.000Z",
      attemptedAt: "2026-06-11T13:31:01.000Z",
      retryAt: "2026-06-11T13:32:01.000Z",
      command: "claude",
      errorMessage: "command failed"
    });
  });

  it("should cancel a stale timer when the reset time changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T13:00:00.000Z"));
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const nudge = createRefreshNudge({
      command: "claude",
      args: ["--print", "refresh"],
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });

    nudge.schedule("2026-06-11T13:10:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    nudge.schedule("2026-06-11T13:20:00.000Z", Date.now());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

describe("refresh nudge env config", () => {
  it("should build the default Claude command without a shell", () => {
    const log: RefreshNudgeLogHandler = () => undefined;
    const runCommand = vi.fn<RefreshCommandRunner>(async () => undefined);
    const options = createClaudeRefreshNudgeOptionsFromEnv({}, log, runCommand);

    expect(options).toMatchObject({
      command: "claude",
      offsetMs: 60_000,
      timeoutMs: 120_000,
      retryMs: 60_000,
      runCommand
    });
    expect(options?.args).toEqual([
      "--safe-mode",
      "--print",
      "--no-session-persistence",
      "--tools",
      "",
      "--max-budget-usd",
      "0.05",
      "Reply only with: refreshed"
    ]);
  });

  it("should return null when disabled by env", () => {
    expect(createClaudeRefreshNudgeOptionsFromEnv({ CLAUDE_REFRESH_NUDGE: "0" })).toBeNull();
  });
});
