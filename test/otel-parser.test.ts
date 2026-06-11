import { describe, expect, it } from "vitest";

import { parseOtlpMetrics } from "../src/server/otel.js";
import { createOtlpMetricsFixture } from "./fixtures.js";

describe("parseOtlpMetrics", () => {
  it("should normalize Claude Code metrics when OTLP JSON uses string integers", () => {
    const samples = parseOtlpMetrics(createOtlpMetricsFixture(), Date.UTC(2026, 5, 10, 10, 1, 0));

    expect(samples).toHaveLength(13);
    expect(samples.some((sample) => sample.metricName === "other.metric")).toBe(false);

    const inputTokens = samples.find(
      (sample) => sample.metricName === "claude_code.token.usage" && sample.attributes.type === "input"
    );
    expect(inputTokens?.value).toBe(1200);
    expect(inputTokens?.numericKind).toBe("int");
    expect(inputTokens?.aggregationTemporality).toBe("delta");
    expect(inputTokens?.resourceAttributes["team.id"]).toBe("personal");

    const cost = samples.find((sample) => sample.metricName === "claude_code.cost.usage");
    expect(cost?.value).toBe(0.0375);
    expect(cost?.numericKind).toBe("double");
  });

  it("should reject non-object OTLP payloads", () => {
    expect(() => parseOtlpMetrics(null)).toThrow("OTLP metrics payload must be a JSON object.");
  });
});
