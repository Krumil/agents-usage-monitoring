import type { SetupInstructions } from "../shared/contracts.js";

export function buildSetupInstructions(port: number): SetupInstructions {
  const endpoint = `http://localhost:${port}/v1/metrics`;
  const snippet = [
    "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
    "export OTEL_METRICS_EXPORTER=otlp",
    "export OTEL_LOGS_EXPORTER=none",
    "export OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json",
    `export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=${endpoint}`,
    "export OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta",
    "export OTEL_METRIC_EXPORT_INTERVAL=5000",
    "claude"
  ].join("\n");

  return { endpoint, snippet };
}
