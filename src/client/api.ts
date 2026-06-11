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
