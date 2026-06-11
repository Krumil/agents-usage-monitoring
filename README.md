# Claude Code Usage Dashboard

Local dashboard for monitoring your Claude Code usage. Claude Code exports OpenTelemetry metrics, this app receives them, stores everything in a local SQLite database, and renders a live dashboard with:

- Cost (USD) and token totals (input, output, cache read, cache creation)
- Sessions, active time (CLI vs user), lines added/removed, commits and PRs
- Breakdowns by model, token type, and session
- Time-series charts with 1h / 24h / 7d / 30d / all ranges, updated live over SSE
- Remaining plan limits (5h session and weekly windows) read from the same endpoint Claude Code's `/usage` screen uses

Everything stays on your machine: the only outbound request is the optional plan-limits lookup to Anthropic's API.

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

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `4318` | Server / OTLP receiver port |
| `HOST` | `0.0.0.0` | Server bind address |
| `DATABASE_PATH` | `.data/claude-usage.sqlite` | SQLite database location |

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest unit + integration tests
pnpm test:e2e    # playwright end-to-end tests
pnpm check       # typecheck + test + build
```

## How it works

- `src/server` — Fastify app. `POST /v1/metrics` accepts OTLP JSON from Claude Code, parses the samples, and writes them to SQLite (better-sqlite3). `GET /api/dashboard` aggregates totals, time buckets, and breakdowns for a range; `GET /api/live` streams updates over SSE on every ingest; `GET /api/limits` proxies plan limits.
- `src/client` — React + Vite single-page dashboard.
- `src/shared` — typed contracts shared between server and client.
