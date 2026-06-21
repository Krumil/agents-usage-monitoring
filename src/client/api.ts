import type { DashboardData, RangeKey, SetupInstructions, UsageLimits } from "../shared/contracts.js";

export async function getDashboard(range: RangeKey, signal?: AbortSignal): Promise<DashboardData> {
  const init: RequestInit | undefined = signal ? { signal } : undefined;
  const response = await fetch(`/api/dashboard?range=${range}`, init);
  if (!response.ok) {
    throw new Error(`Dashboard request failed with status ${response.status}.`);
  }

  return (await response.json()) as DashboardData;
}

export async function getSetup(signal?: AbortSignal): Promise<SetupInstructions> {
  const init: RequestInit | undefined = signal ? { signal } : undefined;
  const response = await fetch("/api/setup", init);
  if (!response.ok) {
    throw new Error(`Setup request failed with status ${response.status}.`);
  }

  return (await response.json()) as SetupInstructions;
}

export async function getLimits(signal?: AbortSignal): Promise<UsageLimits> {
  const init: RequestInit | undefined = signal ? { signal } : undefined;
  const response = await fetch("/api/limits", init);
  if (!response.ok) {
    throw new Error(`Limits request failed with status ${response.status}.`);
  }

  return (await response.json()) as UsageLimits;
}

export async function getVapidPublicKey(signal?: AbortSignal): Promise<string> {
  const init: RequestInit | undefined = signal ? { signal } : undefined;
  const response = await fetch("/api/push/vapid-public-key", init);
  if (!response.ok) {
    throw new Error(`VAPID key request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as { key: string };
  return data.key;
}

export async function subscribeToPush(subscription: PushSubscriptionJSON): Promise<void> {
  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription)
  });
  if (!response.ok) {
    throw new Error(`Push subscribe failed with status ${response.status}.`);
  }
}

export async function unsubscribeFromPush(endpoint: string): Promise<void> {
  const response = await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint })
  });
  if (!response.ok) {
    throw new Error(`Push unsubscribe failed with status ${response.status}.`);
  }
}
