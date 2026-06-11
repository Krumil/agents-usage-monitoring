const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

const costFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4
});

const costCentsFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatCost(value: number): string {
  return costFormatter.format(value);
}

export function formatCostCents(value: number): string {
  return costCentsFormatter.format(Math.trunc(value * 100) / 100);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "No data yet";
  }

  return dateTimeFormatter.format(new Date(value));
}

export function formatPercent(value: number): string {
  return percentFormatter.format(value);
}

export function shortKey(value: string): string {
  if (value.length <= 22) {
    return value;
  }

  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}
