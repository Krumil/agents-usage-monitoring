import { describe, expect, it, vi } from "vitest";

import { createSessionRefreshObserver, type SessionRefreshNotifier } from "../src/server/limits.js";
import type { SessionRefreshNudge } from "../src/server/refresh-nudge.js";
import type { AvailableUsageLimits, UsageLimits } from "../src/shared/contracts.js";

function limits(resetsAt: string, usedPercent = 10): AvailableUsageLimits {
  return {
    available: true,
    fetchedAt: resetsAt,
    windows: [{ key: "five_hour", label: "Session (5h)", usedPercent, resetsAt }],
    extraUsage: null
  };
}

describe("session refresh observer", () => {
  it("should fire the notifier once when the watched reset time passes", async () => {
    const notifier: SessionRefreshNotifier = { sendSessionRefreshAlert: vi.fn(async () => undefined) };
    const observer = createSessionRefreshObserver({ notifier });
    const reset = "2026-06-11T13:30:00+00:00";

    await observer.observe(limits(reset), Date.parse("2026-06-11T13:29:30Z"));
    await observer.observe(limits(reset), Date.parse("2026-06-11T13:30:01Z"));
    await observer.observe(limits(reset), Date.parse("2026-06-11T13:30:05Z"));

    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledTimes(1);
    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledWith({
      resetAt: reset,
      nextResetAt: null,
      observedAt: new Date(Date.parse("2026-06-11T13:30:01Z")).toISOString(),
      currentUsedPercent: null
    });
  });

  it("should include the next reset once the window advances after a refresh", async () => {
    const notifier: SessionRefreshNotifier = { sendSessionRefreshAlert: vi.fn(async () => undefined) };
    const observer = createSessionRefreshObserver({ notifier });

    await observer.observe(limits("2026-06-11T13:30:00+00:00"), Date.parse("2026-06-11T13:29:00Z"));
    await observer.observe(limits("2026-06-11T18:30:00+00:00", 4), Date.parse("2026-06-11T13:31:00Z"));

    expect(notifier.sendSessionRefreshAlert).toHaveBeenCalledWith({
      resetAt: "2026-06-11T13:30:00+00:00",
      nextResetAt: "2026-06-11T18:30:00+00:00",
      observedAt: new Date(Date.parse("2026-06-11T13:31:00Z")).toISOString(),
      currentUsedPercent: 4
    });
  });

  it("should resolve without error when no notifier is configured", async () => {
    const observer = createSessionRefreshObserver();
    const reset = "2026-06-11T13:30:00+00:00";

    await observer.observe(limits(reset), Date.parse("2026-06-11T13:29:30Z"));

    await expect(observer.observe(limits(reset), Date.parse("2026-06-11T13:31:00Z"))).resolves.toBeUndefined();
  });

  it("should schedule a refresh nudge from the session reset time", async () => {
    const reset = "2026-06-11T13:30:00+00:00";
    const observedAtMs = Date.parse("2026-06-11T13:29:30Z");
    const nudge: SessionRefreshNudge = { schedule: vi.fn(), stop: vi.fn() };
    const observer = createSessionRefreshObserver({ nudge });

    await observer.observe(limits(reset), observedAtMs);

    expect(nudge.schedule).toHaveBeenCalledWith(reset, observedAtMs);
  });

  it("should not schedule a refresh nudge without a valid session window", async () => {
    const nudge: SessionRefreshNudge = { schedule: vi.fn(), stop: vi.fn() };
    const observer = createSessionRefreshObserver({ nudge });
    const unavailable: UsageLimits = {
      available: false,
      fetchedAt: "2026-06-11T13:29:30.000Z",
      reason: "Usage unavailable."
    };

    await observer.observe(unavailable, Date.parse("2026-06-11T13:29:30Z"));
    await observer.observe(limits("not-a-date"), Date.parse("2026-06-11T13:29:31Z"));

    expect(nudge.schedule).not.toHaveBeenCalled();
  });
});
