# Claude Code Usage Dashboard

Local dashboard for monitoring your Claude Code usage. Claude Code exports OpenTelemetry metrics, this app receives them, stores everything in a local SQLite database, and renders a live dashboard with:

- Cost (USD) and token totals (input, output, cache read, cache creation)
- Sessions, active time (CLI vs user), lines added/removed, commits and PRs
- Breakdowns by model, token type, and session
- Time-series charts with 1h / 24h / 7d / 30d / all ranges, updated live over SSE
- Remaining plan limits (5h session and weekly windows) read from the same endpoint Claude Code's `/usage` screen uses

Everything stays on your machine except the optional plan-limits lookup to Anthropic's API and optional Telegram alerts.

## Requirements

- Node.js 22+
- [pnpm](https://pnpm.io) (`corepack enable` or `npm i -g pnpm`)
- Claude Code installed and logged in

## Install

```bash
git clone https://github.com/Krumil/agents-usage-monitoring.git
cd agents-usage-monitoring
pnpm install
```

## Enable telemetry in Claude Code

Claude Code needs to be told to export metrics to this app. Add this to the `env` block of `~/.claude/settings.json` so it applies to every session:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "http://localhost:4318/v1/metrics",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta",
    "OTEL_METRIC_EXPORT_INTERVAL": "5000"
  }
}
```

Or export the same variables in your shell before launching `claude`, if you prefer per-shell control:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=none
export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics
export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
export OTEL_METRIC_EXPORT_INTERVAL=5000
claude
```

Restart any running Claude Code sessions after changing settings.

## Run

Development (server on 4318, client on 5173 with hot reload):

```bash
pnpm dev
```

Open `http://127.0.0.1:5173` (Vite picks the next free port if 5173 is taken — check the dev output).

Production (single server serving the built client on 4318):

```bash
pnpm build
pnpm start
```

Then open `http://127.0.0.1:4318`.

Data is stored in `.data/claude-usage.sqlite`. Delete the file to start fresh.

## Plan limits

The dashboard shows remaining session (5h) and weekly plan limits at the top. The server reads the OAuth token from `~/.claude/.credentials.json` and queries `https://api.anthropic.com/api/oauth/usage` (the same unofficial endpoint Claude Code's `/usage` screen uses), cached for 30 seconds. Anthropic reports utilization percentages and reset times, not raw token counts. If the token is missing or expired, the strip shows why instead of failing.

## Telegram session refresh alerts

Set these variables before starting the server to get a Telegram message when the observed 5h Claude Code token session refreshes:

```bash
export TELEGRAM_BOT_TOKEN=123456:replace-me
export TELEGRAM_CHAT_ID=123456789
pnpm dev
```

When both values are set, the server checks plan limits every 60 seconds. The alert fires once for each observed 5h reset time after that reset time has passed.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `4318` | Server / OTLP receiver port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DATABASE_PATH` | `.data/claude-usage.sqlite` | SQLite database location |
| `LIMITS_SOURCE` | `fetch` | `fetch` reads the local OAuth token and queries Anthropic; `push` serves a snapshot sent to `POST /api/limits/ingest` (used for remote deployment) |
| `LIMITS_INGEST_SECRET` | required when `LIMITS_SOURCE=push` | Secret the ingest route requires in the `Authorization` header; the server refuses to start in push mode without it |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram bot token for session refresh alerts |
| `TELEGRAM_CHAT_ID` | unset | Telegram chat ID that receives session refresh alerts |
| `VAPID_PUBLIC_KEY` | unset | Web Push public VAPID key; enables phone push notifications in push mode when set with the private key and subject |
| `VAPID_PRIVATE_KEY` | unset | Web Push private VAPID key |
| `VAPID_SUBJECT` | unset | VAPID contact, a `mailto:` or `https:` URL |
| `DAILY_SUMMARY_HOUR` | unset | Hour (0–23, server local time) to push a daily cost/token/session summary; unset disables it |

The limits pusher (`dist/server/server/limits-pusher.js`) reads:

| Env var | Default | Description |
| --- | --- | --- |
| `DASHBOARD_INGEST_URL` | required | URL of the remote `POST /api/limits/ingest` endpoint |
| `DASHBOARD_INGEST_AUTH` | unset | Value sent as the `Authorization` header (e.g. `Basic <base64>`) |
| `LIMITS_PUSH_INTERVAL_MS` | `60000` | How often to fetch and push the limits snapshot |

## Remote deployment

To keep the dashboard always up on a server while keeping your Claude OAuth token on your own machine:

- **Server** (`LIMITS_SOURCE=push`) receives telemetry, serves the dashboard, and exposes `POST /api/limits/ingest`. It never reads a token. Put it behind a reverse proxy with TLS + auth.
- **Local machine** runs the limits pusher, which fetches plan limits with your local token, sends Telegram alerts, and pushes only the resulting snapshot (utilization percentages and reset times) to the server. The token never leaves your machine.

Point Claude Code at the server by setting `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to the server's `/v1/metrics` URL (add an `OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=...` entry if the proxy requires auth).

## Install on your phone + push notifications

The dashboard is an installable PWA. On a remote (push-mode) deployment served over HTTPS it can also send notifications to your phone — when the 5h session resets and an optional daily summary — using the Web Push standard. No Firebase or app store needed.

Push requires a secure context (HTTPS, which the remote deployment already has) and a VAPID key pair. Generate one once:

```bash
npx web-push generate-vapid-keys
```

Set the keys on the **server** (push mode):

```bash
export LIMITS_SOURCE=push
export LIMITS_INGEST_SECRET=...        # already required in push mode
export VAPID_PUBLIC_KEY=BPx...
export VAPID_PRIVATE_KEY=...
export VAPID_SUBJECT=mailto:you@example.com
export DAILY_SUMMARY_HOUR=9            # optional, server local time
pnpm start
```

Then on your Android phone:

1. Open the dashboard's public HTTPS URL in Chrome.
2. Use the browser menu → **Add to Home screen** to install it.
3. Open it from the home-screen icon and tap **Enable alerts**, then grant the notification permission.

Notifications arrive even when the app is closed. Session-reset alerts mirror the Telegram wording; the daily summary reports the last 24h cost, tokens, and session count. Subscriptions are stored server-side in SQLite and pruned automatically when a browser drops them.

To confirm a notification reaches your phone after subscribing, fire a test push (reads the same VAPID env and the server's database):

```bash
node scripts/send-test-push.mjs "Test" "Hello from the server"
```

> A home-screen *widget* (a live tile) is not possible from a PWA — Android has no web API for it and it would require a separate native app. This delivers an app icon plus push notifications, which is the most you can do without going native.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest unit + integration tests
pnpm test:e2e    # playwright end-to-end tests
pnpm check       # typecheck + test + build
```

## How it works

- `src/server` — Fastify app. `POST /v1/metrics` accepts OTLP JSON from Claude Code, parses the samples, and writes them to SQLite (better-sqlite3). `GET /api/dashboard` aggregates totals, time buckets, and breakdowns for a range; `GET /api/live` streams updates over SSE on every ingest; `GET /api/limits` proxies plan limits. In push mode with VAPID keys set, `GET /api/push/vapid-public-key` and `POST /api/push/{subscribe,unsubscribe}` manage Web Push subscriptions.
- `src/client` — React + Vite single-page dashboard.
- `src/shared` — typed contracts shared between server and client.
