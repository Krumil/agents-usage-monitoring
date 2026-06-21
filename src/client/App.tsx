import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getDashboard, getLimits, getSetup } from "./api.js";
import { PixelIcon } from "./icons.js";
import {
  disablePushNotifications,
  enablePushNotifications,
  hasActivePushSubscription,
  isPushSupported
} from "./push.js";
import {
  formatCompact,
  formatCost,
  formatCostCents,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  shortKey
} from "./format.js";
import {
  RANGE_KEYS,
  type BreakdownItem,
  type DashboardData,
  type RangeKey,
  type SetupInstructions,
  type TimeBucket,
  type UsageLimits
} from "../shared/contracts.js";

interface MetricCardProps {
  label: string;
  value: number;
  formatter: (value: number) => string;
  detail: string;
  icon: ReactNode;
}

interface SeriesDefinition {
  key: "tokens" | "costUsd" | "activeSeconds" | "linesAdded" | "linesRemoved" | "sessions";
  label: string;
  color: string;
  formatter: (value: number) => string;
}

const usageSeries: SeriesDefinition[] = [
  { key: "tokens", label: "tokens", color: "var(--lime)", formatter: formatCompact },
  { key: "costUsd", label: "cost", color: "var(--gold)", formatter: formatCost }
];

const workSeries: SeriesDefinition[] = [
  { key: "activeSeconds", label: "active", color: "var(--cyan)", formatter: formatDuration },
  { key: "linesAdded", label: "added", color: "var(--lime)", formatter: formatNumber },
  { key: "linesRemoved", label: "removed", color: "var(--magenta)", formatter: formatNumber }
];

export function App(): ReactNode {
  const [range, setRange] = useState<RangeKey>("24h");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [setup, setSetup] = useState<SetupInstructions | null>(null);
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([getDashboard(range, controller.signal), getSetup(controller.signal)])
      .then(([nextDashboard, nextSetup]) => {
        setDashboard(nextDashboard);
        setSetup(nextSetup);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : "Dashboard request failed.");
        }
      });

    return () => {
      controller.abort();
    };
  }, [range]);

  useEffect(() => {
    const controller = new AbortController();

    const loadLimits = (): void => {
      void getLimits(controller.signal)
        .then(setLimits)
        .catch(() => {
          if (!controller.signal.aborted) {
            setLimits({ available: false, fetchedAt: new Date().toISOString(), reason: "Limits request failed." });
          }
        });
    };

    loadLimits();
    const interval = window.setInterval(loadLimits, 60_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/live?range=${range}`);

    source.addEventListener("open", () => {
      setIsLive(true);
    });

    source.addEventListener("dashboard", (event) => {
      setDashboard(JSON.parse(event.data) as DashboardData);
      setError(null);
    });

    source.addEventListener("error", () => {
      setIsLive(false);
    });

    return () => {
      source.close();
      setIsLive(false);
    };
  }, [range]);

  const totals = dashboard?.totals;
  const hasData = (dashboard?.ingest.totalSamples ?? 0) > 0;
  const tokenCacheShare = useMemo(() => {
    if (!totals || totals.tokens.total === 0) {
      return 0;
    }

    return (totals.tokens.cacheRead + totals.tokens.cacheCreation) / totals.tokens.total;
  }, [totals]);

  const copySetup = useCallback(() => {
    if (!setup) {
      return;
    }

    void navigator.clipboard.writeText(setup.snippet).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [setup]);

  return (
    <main className="app-shell">
      <section className="topbar" aria-label="Dashboard header">
        <div>
          <p className="eyebrow">local otel receiver</p>
          <h1>Claude Code usage</h1>
        </div>
        <div className="topbar-actions">
          <AlertsButton />
          <div className={isLive ? "status-pill live" : "status-pill"} aria-live="polite">
            <PixelIcon name="signal" size={16} />
            {isLive ? "Live" : "Connecting"}
          </div>
          <div className="range-control" role="tablist" aria-label="Time range">
            {RANGE_KEYS.map((rangeKey) => (
              <button
                key={rangeKey}
                type="button"
                className={range === rangeKey ? "active" : ""}
                onClick={() => setRange(rangeKey)}
                role="tab"
                aria-selected={range === rangeKey}
              >
                {rangeKey}
              </button>
            ))}
          </div>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <LimitsStrip limits={limits} />

      <section className="metric-grid" aria-label="Usage totals">
        <MetricCard
          label="Estimated cost"
          value={totals?.costUsd ?? 0}
          formatter={formatCostCents}
          detail={`Updated ${formatDateTime(dashboard?.ingest.lastReceivedAt ?? null)}`}
          icon={<PixelIcon name="coins" size={24} />}
        />
        <MetricCard
          label="Tokens"
          value={totals?.tokens.total ?? 0}
          formatter={formatCompact}
          detail={`${formatPercent(tokenCacheShare)} cache traffic`}
          icon={<PixelIcon name="bolt" size={24} />}
        />
        <MetricCard
          label="Active time"
          value={totals?.activeSeconds.total ?? 0}
          formatter={formatDuration}
          detail={`${formatDuration(totals?.activeSeconds.cli ?? 0)} cli processing`}
          icon={<PixelIcon name="clock" size={24} />}
        />
        <MetricCard
          label="Sessions"
          value={totals?.sessions ?? 0}
          formatter={formatNumber}
          detail={`${formatNumber(dashboard?.ingest.totalSamples ?? 0)} metric samples`}
          icon={<PixelIcon name="heart" size={24} />}
        />
        <MetricCard
          label="Code lines"
          value={totals?.lines.net ?? 0}
          formatter={formatNumber}
          detail={`${formatNumber(totals?.lines.added ?? 0)} added, ${formatNumber(totals?.lines.removed ?? 0)} removed`}
          icon={<PixelIcon name="code" size={24} />}
        />
        <MetricCard
          label="Git activity"
          value={(totals?.commits ?? 0) + (totals?.pullRequests ?? 0)}
          formatter={formatNumber}
          detail={`${formatNumber(totals?.commits ?? 0)} commits, ${formatNumber(totals?.pullRequests ?? 0)} PRs`}
          icon={<PixelIcon name="commit" size={24} />}
        />
      </section>

      <section className="dashboard-grid" aria-label="Usage charts">
        <Panel title="Usage flow" aside={`${range} window`}>
          <SeriesChart buckets={dashboard?.series ?? []} series={usageSeries} />
        </Panel>

        <Panel title="Model spend" aside={formatCost(totals?.costUsd ?? 0)}>
          <BreakdownList
            items={dashboard?.breakdowns.models ?? []}
            primaryFormatter={formatCost}
            secondaryFormatter={formatCompact}
            secondaryLabel="tokens"
          />
        </Panel>

        <Panel title="Work trace" aside={formatDuration(totals?.activeSeconds.total ?? 0)}>
          <SeriesChart buckets={dashboard?.series ?? []} series={workSeries} />
        </Panel>

        <Panel title="Token mix" aside={formatCompact(totals?.tokens.total ?? 0)}>
          <BreakdownList items={dashboard?.breakdowns.tokenTypes ?? []} primaryFormatter={formatCompact} />
        </Panel>

        <Panel title="Query sources" aside="cost">
          <BreakdownList items={dashboard?.breakdowns.querySources ?? []} primaryFormatter={formatCost} />
        </Panel>

        <Panel title="Session spend" aside="top 6">
          <BreakdownList items={dashboard?.breakdowns.sessions ?? []} primaryFormatter={formatCost} shortenKeys />
        </Panel>
      </section>

      <section className={hasData ? "setup-strip" : "setup-strip empty"} aria-label="Telemetry setup">
        <div>
          <p className="eyebrow">collector endpoint</p>
          <h2>{setup?.endpoint ?? "http://localhost:4318/v1/metrics"}</h2>
        </div>
        <button type="button" className="copy-button" onClick={copySetup} disabled={!setup} title="Copy setup command">
          <PixelIcon name="copy" size={16} />
          {copied ? "Copied" : "Copy"}
        </button>
        <pre>{setup?.snippet ?? "Loading setup command..."}</pre>
      </section>
    </main>
  );
}

type AlertsState = "unknown" | "unsupported" | "denied" | "on" | "off";

function AlertsButton(): ReactNode {
  const [state, setState] = useState<AlertsState>("unknown");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!isPushSupported()) {
        if (!cancelled) {
          setState("unsupported");
        }
        return;
      }

      if (Notification.permission === "denied") {
        if (!cancelled) {
          setState("denied");
        }
        return;
      }

      const active = await hasActivePushSubscription();
      if (!cancelled) {
        setState(active ? "on" : "off");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        if (state === "on") {
          await disablePushNotifications();
          setState("off");
        } else {
          const enabled = await enablePushNotifications();
          setState(enabled ? "on" : Notification.permission === "denied" ? "denied" : "off");
        }
      } catch {
        setState(Notification.permission === "denied" ? "denied" : "off");
      } finally {
        setBusy(false);
      }
    })();
  }, [state]);

  if (state === "unknown" || state === "unsupported") {
    return null;
  }

  const isOn = state === "on";
  const label = state === "denied" ? "Alerts blocked" : isOn ? "Alerts on" : "Enable alerts";

  return (
    <button
      type="button"
      className={isOn ? "alerts-button on" : "alerts-button"}
      onClick={toggle}
      disabled={busy || state === "denied"}
      title={
        state === "denied"
          ? "Notifications are blocked. Enable them in your browser settings."
          : isOn
            ? "Disable usage push notifications"
            : "Enable usage push notifications"
      }
      aria-pressed={isOn}
    >
      <PixelIcon name="bell" size={16} />
      {label}
    </button>
  );
}

function LimitsStrip({ limits }: { limits: UsageLimits | null }): ReactNode {
  if (!limits) {
    return null;
  }

  if (!limits.available) {
    return (
      <section className="limits-strip unavailable" aria-label="Plan limits">
        <PixelIcon name="gauge" size={16} />
        <span>Plan limits unavailable: {limits.reason}</span>
      </section>
    );
  }

  const extra = limits.extraUsage;

  return (
    <section className="limits-strip" aria-label="Plan limits">
      {limits.windows.map((window) => (
        <div className="limit-cell" key={window.key}>
          <div className="limit-head">
            <span>{window.label}</span>
            <strong>{formatPercent(Math.max(0, 100 - window.usedPercent) / 100)} left</strong>
          </div>
          <div className="limit-track" aria-hidden="true">
            <i
              className={limitLevel(window.usedPercent)}
              style={{ width: `${Math.min(100, Math.max(2, window.usedPercent))}%` }}
            />
          </div>
          <small>
            {Math.round(window.usedPercent)}% used · resets {formatDateTime(window.resetsAt)}
          </small>
        </div>
      ))}
      {extra ? (
        <div className="limit-cell">
          <div className="limit-head">
            <span>Extra credits ({extra.currency})</span>
            <strong>{formatNumber(extra.monthlyLimit - extra.usedCredits)} left</strong>
          </div>
          <div className="limit-track" aria-hidden="true">
            <i
              className={limitLevel(extra.usedPercent)}
              style={{ width: `${Math.min(100, Math.max(2, extra.usedPercent))}%` }}
            />
          </div>
          <small>
            {formatNumber(extra.usedCredits)} of {formatNumber(extra.monthlyLimit)} used
          </small>
        </div>
      ) : null}
    </section>
  );
}

function limitLevel(usedPercent: number): string {
  if (usedPercent >= 85) {
    return "critical";
  }

  if (usedPercent >= 60) {
    return "warm";
  }

  return "ok";
}

function useArcadeNumber(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target) {
      return;
    }

    const totalSteps = 8;
    let step = 0;
    const tick = window.setInterval(() => {
      step += 1;
      const next = step >= totalSteps ? target : from + ((target - from) * step) / totalSteps;
      shownRef.current = next;
      setShown(next);
      if (step >= totalSteps) {
        window.clearInterval(tick);
      }
    }, 50);

    return () => {
      window.clearInterval(tick);
    };
  }, [target]);

  return shown;
}

function MetricCard({ label, value, formatter, detail, icon }: MetricCardProps): ReactNode {
  const shown = useArcadeNumber(value);

  return (
    <article className="metric-card">
      <div className="metric-icon" aria-hidden="true">
        {icon}
      </div>
      <div>
        <p>{label}</p>
        <strong>{formatter(shown)}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function Panel({ title, aside, children }: { title: string; aside: string; children: ReactNode }): ReactNode {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        <span>{aside}</span>
      </header>
      {children}
    </section>
  );
}

function SeriesChart({ buckets, series }: { buckets: TimeBucket[]; series: SeriesDefinition[] }): ReactNode {
  const maxValue = Math.max(
    1,
    ...buckets.flatMap((bucket) => series.map((definition) => bucket[definition.key] as number))
  );
  const width = 680;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 34, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const xForIndex = (index: number): number =>
    padding.left + (buckets.length <= 1 ? innerWidth : (index / (buckets.length - 1)) * innerWidth);
  const yForValue = (value: number): number => padding.top + innerHeight - (value / maxValue) * innerHeight;

  if (buckets.length === 0) {
    return <EmptyPanel icon={<PixelIcon name="hourglass" size={24} />} label="Waiting for metrics" />;
  }

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Time series chart">
        {[0, 0.25, 0.5, 0.75, 1].map((mark) => {
          const y = padding.top + innerHeight * mark;
          return <line key={mark} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="gridline" />;
        })}
        {series.map((definition) => {
          const coords = buckets.map((bucket, index) => ({
            x: xForIndex(index),
            y: yForValue(bucket[definition.key] as number)
          }));
          const points = coords
            .flatMap((coord, index) => {
              const previous = coords[index - 1];
              if (!previous) {
                return [`${coord.x},${coord.y}`];
              }

              const midX = (previous.x + coord.x) / 2;
              return [`${midX},${previous.y}`, `${midX},${coord.y}`, `${coord.x},${coord.y}`];
            })
            .join(" ");
          return (
            <polyline
              key={definition.key}
              className="series-line"
              points={points}
              fill="none"
              stroke={definition.color}
              strokeWidth="3"
            />
          );
        })}
        {buckets.map((bucket, index) => {
          if (index % Math.max(1, Math.floor(buckets.length / 6)) !== 0) {
            return null;
          }

          return (
            <text key={bucket.start} x={xForIndex(index)} y={height - 10} textAnchor="middle" className="axis-label">
              {bucket.label}
            </text>
          );
        })}
      </svg>
      <div className="legend">
        {series.map((definition) => (
          <span key={definition.key}>
            <i style={{ backgroundColor: definition.color }} />
            {definition.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function BreakdownList({
  items,
  primaryFormatter,
  secondaryFormatter,
  secondaryLabel,
  shortenKeys = false
}: {
  items: BreakdownItem[];
  primaryFormatter: (value: number) => string;
  secondaryFormatter?: (value: number) => string;
  secondaryLabel?: string;
  shortenKeys?: boolean;
}): ReactNode {
  const maxValue = Math.max(1, ...items.map((item) => item.value));

  if (items.length === 0) {
    return <EmptyPanel icon={<PixelIcon name="ghost" size={24} />} label="No samples in this range" />;
  }

  return (
    <div className="breakdown-list">
      {items.map((item) => (
        <div className="breakdown-row" key={item.key}>
          <div>
            <span title={item.key}>{shortenKeys ? shortKey(item.key) : item.key}</span>
            <strong>{primaryFormatter(item.value)}</strong>
          </div>
          <div className="bar-track" aria-hidden="true">
            <i style={{ width: `${Math.max(3, (item.value / maxValue) * 100)}%` }} />
          </div>
          {secondaryFormatter && item.secondary !== undefined ? (
            <small>
              {secondaryFormatter(item.secondary)} {secondaryLabel}
            </small>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ icon, label }: { icon: ReactNode; label: string }): ReactNode {
  return (
    <div className="empty-panel">
      {icon}
      <span>{label}</span>
    </div>
  );
}
