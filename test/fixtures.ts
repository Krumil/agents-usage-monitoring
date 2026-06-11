interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

interface OtlpPoint {
  attributes: OtlpAttribute[];
  timeUnixNano: string;
  startTimeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}

interface OtlpMetric {
  name: string;
  unit: string;
  sum: {
    aggregationTemporality: string;
    isMonotonic: boolean;
    dataPoints: OtlpPoint[];
  };
}

export function createOtlpMetricsFixture(nowMs = Date.UTC(2026, 5, 10, 10, 0, 0)): unknown {
  const startedAt = nowMs - 45_000;
  const sessionAttributes = [
    textAttribute("session.id", "session-alpha"),
    textAttribute("user.id", "local-user"),
    textAttribute("terminal.type", "vscode")
  ];

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [textAttribute("team.id", "personal")]
        },
        scopeMetrics: [
          {
            scope: {
              name: "claude-code",
              version: "2.1.170"
            },
            metrics: [
              metric("claude_code.session.count", "count", [
                point(1, [...sessionAttributes, textAttribute("start_type", "fresh")], nowMs, startedAt)
              ]),
              metric("claude_code.token.usage", "tokens", [
                point(1200, [...sessionAttributes, textAttribute("type", "input"), textAttribute("model", "claude-sonnet-4-6"), textAttribute("query_source", "main")], nowMs, startedAt),
                point(320, [...sessionAttributes, textAttribute("type", "output"), textAttribute("model", "claude-sonnet-4-6"), textAttribute("query_source", "main")], nowMs, startedAt),
                point(480, [...sessionAttributes, textAttribute("type", "cacheRead"), textAttribute("model", "claude-sonnet-4-6"), textAttribute("query_source", "main")], nowMs, startedAt)
              ]),
              metric("claude_code.cost.usage", "USD", [
                point(0.0375, [...sessionAttributes, textAttribute("model", "claude-sonnet-4-6"), textAttribute("query_source", "main")], nowMs, startedAt)
              ]),
              metric("claude_code.active_time.total", "s", [
                point(18, [...sessionAttributes, textAttribute("type", "user")], nowMs, startedAt),
                point(42, [...sessionAttributes, textAttribute("type", "cli")], nowMs, startedAt)
              ]),
              metric("claude_code.lines_of_code.count", "count", [
                point(44, [...sessionAttributes, textAttribute("type", "added")], nowMs, startedAt),
                point(11, [...sessionAttributes, textAttribute("type", "removed")], nowMs, startedAt)
              ]),
              metric("claude_code.commit.count", "count", [point(1, sessionAttributes, nowMs, startedAt)]),
              metric("claude_code.pull_request.count", "count", [point(1, sessionAttributes, nowMs, startedAt)]),
              metric("claude_code.code_edit_tool.decision", "count", [
                point(3, [...sessionAttributes, textAttribute("tool_name", "Edit"), textAttribute("decision", "accept")], nowMs, startedAt),
                point(1, [...sessionAttributes, textAttribute("tool_name", "Write"), textAttribute("decision", "reject")], nowMs, startedAt)
              ]),
              metric("other.metric", "count", [point(99, sessionAttributes, nowMs, startedAt)])
            ]
          }
        ]
      }
    ]
  };
}

function metric(name: string, unit: string, dataPoints: OtlpPoint[]): OtlpMetric {
  return {
    name,
    unit,
    sum: {
      aggregationTemporality: "AGGREGATION_TEMPORALITY_DELTA",
      isMonotonic: true,
      dataPoints
    }
  };
}

function point(value: number, attributes: OtlpAttribute[], timeMs: number, startMs: number): OtlpPoint {
  const base = {
    attributes,
    timeUnixNano: toUnixNano(timeMs),
    startTimeUnixNano: toUnixNano(startMs)
  };

  if (Number.isInteger(value)) {
    return {
      ...base,
      asInt: value.toString()
    };
  }

  return {
    ...base,
    asDouble: value
  };
}

function textAttribute(key: string, value: string): OtlpAttribute {
  return {
    key,
    value: {
      stringValue: value
    }
  };
}

function toUnixNano(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}
