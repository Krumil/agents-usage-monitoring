import { OtlpParseError } from "./errors.js";

const SUPPORTED_METRICS = [
  "claude_code.session.count",
  "claude_code.lines_of_code.count",
  "claude_code.pull_request.count",
  "claude_code.commit.count",
  "claude_code.cost.usage",
  "claude_code.token.usage",
  "claude_code.code_edit_tool.decision",
  "claude_code.active_time.total"
] as const;

const supportedMetricSet = new Set<string>(SUPPORTED_METRICS);

export type NumericKind = "int" | "double";
export type MetricKind = "sum" | "gauge";
export type AggregationTemporality = "delta" | "cumulative" | "unspecified";

export type AttributeValue = string | number | boolean;

export interface AttributeMap {
  [key: string]: AttributeValue;
}

export interface ParsedMetricSample {
  metricName: string;
  unit: string;
  observedAtMs: number;
  startAtMs: number | null;
  value: number;
  numericKind: NumericKind;
  metricKind: MetricKind;
  aggregationTemporality: AggregationTemporality;
  isMonotonic: boolean;
  attributes: AttributeMap;
  resourceAttributes: AttributeMap;
  scopeName: string | null;
  scopeVersion: string | null;
  receivedAtMs: number;
}

interface DataPointGroup {
  metricKind: MetricKind;
  dataPoints: unknown[];
  aggregationTemporality: AggregationTemporality;
  isMonotonic: boolean;
}

export function parseOtlpMetrics(payload: unknown, receivedAtMs = Date.now()): ParsedMetricSample[] {
  const root = asRecord(payload);
  if (!root) {
    throw new OtlpParseError("OTLP metrics payload must be a JSON object.");
  }

  const resourceMetrics = readArray(root.resourceMetrics);
  const samples: ParsedMetricSample[] = [];

  for (const resourceMetric of resourceMetrics) {
    const resourceMetricObject = asRecord(resourceMetric);
    if (!resourceMetricObject) {
      continue;
    }

    const resourceObject = asRecord(resourceMetricObject.resource);
    const resourceAttributes = attributesToRecord(resourceObject?.attributes);
    const scopeMetrics = readArray(resourceMetricObject.scopeMetrics);

    for (const scopeMetric of scopeMetrics) {
      const scopeMetricObject = asRecord(scopeMetric);
      if (!scopeMetricObject) {
        continue;
      }

      const scopeObject = asRecord(scopeMetricObject.scope);
      const scopeName = readString(scopeObject?.name);
      const scopeVersion = readString(scopeObject?.version);
      const metrics = readArray(scopeMetricObject.metrics);

      for (const metric of metrics) {
        const metricObject = asRecord(metric);
        const metricName = readString(metricObject?.name);
        if (!metricObject || !metricName || !supportedMetricSet.has(metricName)) {
          continue;
        }

        const pointGroup = readDataPointGroup(metricObject);
        if (!pointGroup) {
          continue;
        }

        for (const dataPoint of pointGroup.dataPoints) {
          const dataPointObject = asRecord(dataPoint);
          if (!dataPointObject) {
            continue;
          }

          const numeric = readNumericValue(dataPointObject);
          if (!numeric) {
            continue;
          }

          samples.push({
            metricName,
            unit: readString(metricObject.unit) ?? "",
            observedAtMs: readUnixNanoMs(dataPointObject.timeUnixNano, receivedAtMs),
            startAtMs: readOptionalUnixNanoMs(dataPointObject.startTimeUnixNano),
            value: numeric.value,
            numericKind: numeric.kind,
            metricKind: pointGroup.metricKind,
            aggregationTemporality: pointGroup.aggregationTemporality,
            isMonotonic: pointGroup.isMonotonic,
            attributes: attributesToRecord(dataPointObject.attributes),
            resourceAttributes,
            scopeName,
            scopeVersion,
            receivedAtMs
          });
        }
      }
    }
  }

  return samples;
}

export function mergeAttributes(sample: Pick<ParsedMetricSample, "attributes" | "resourceAttributes">): AttributeMap {
  return {
    ...sample.resourceAttributes,
    ...sample.attributes
  };
}

function readDataPointGroup(metricObject: Record<string, unknown>): DataPointGroup | null {
  const sum = asRecord(metricObject.sum);
  if (sum) {
    return {
      metricKind: "sum",
      dataPoints: readArray(sum.dataPoints),
      aggregationTemporality: readAggregationTemporality(sum.aggregationTemporality),
      isMonotonic: readBoolean(sum.isMonotonic) ?? false
    };
  }

  const gauge = asRecord(metricObject.gauge);
  if (gauge) {
    return {
      metricKind: "gauge",
      dataPoints: readArray(gauge.dataPoints),
      aggregationTemporality: "unspecified",
      isMonotonic: false
    };
  }

  return null;
}

function readNumericValue(dataPointObject: Record<string, unknown>): { value: number; kind: NumericKind } | null {
  const doubleValue = readNumber(dataPointObject.asDouble);
  if (doubleValue !== null) {
    return { value: doubleValue, kind: "double" };
  }

  const intValue = readNumber(dataPointObject.asInt);
  if (intValue !== null) {
    return { value: intValue, kind: "int" };
  }

  return null;
}

function attributesToRecord(attributes: unknown): AttributeMap {
  const record: AttributeMap = {};

  for (const attribute of readArray(attributes)) {
    const attributeObject = asRecord(attribute);
    const key = readString(attributeObject?.key);
    const value = readAttributeValue(attributeObject?.value);
    if (key && value !== undefined) {
      record[key] = value;
    }
  }

  return record;
}

function readAttributeValue(value: unknown): AttributeValue | undefined {
  const valueObject = asRecord(value);
  if (!valueObject) {
    return undefined;
  }

  const stringValue = readString(valueObject.stringValue);
  if (stringValue !== null) {
    return stringValue;
  }

  const intValue = readNumber(valueObject.intValue);
  if (intValue !== null) {
    return intValue;
  }

  const doubleValue = readNumber(valueObject.doubleValue);
  if (doubleValue !== null) {
    return doubleValue;
  }

  const boolValue = readBoolean(valueObject.boolValue);
  if (boolValue !== null) {
    return boolValue;
  }

  if (valueObject.arrayValue !== undefined || valueObject.kvlistValue !== undefined) {
    return JSON.stringify(valueObject.arrayValue ?? valueObject.kvlistValue);
  }

  return undefined;
}

function readAggregationTemporality(value: unknown): AggregationTemporality {
  if (value === 1 || value === "1" || value === "AGGREGATION_TEMPORALITY_DELTA") {
    return "delta";
  }

  if (value === 2 || value === "2" || value === "AGGREGATION_TEMPORALITY_CUMULATIVE") {
    return "cumulative";
  }

  return "unspecified";
}

function readUnixNanoMs(value: unknown, fallbackMs: number): number {
  return readOptionalUnixNanoMs(value) ?? fallbackMs;
}

function readOptionalUnixNanoMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  try {
    const normalized = typeof value === "number" ? Math.trunc(value).toString() : value;
    return Number(BigInt(normalized) / 1_000_000n);
  } catch {
    return null;
  }
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}
