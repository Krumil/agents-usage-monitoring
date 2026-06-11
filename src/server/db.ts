import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { IngestStatus } from "../shared/contracts.js";
import type { AttributeMap, ParsedMetricSample } from "./otel.js";

export interface StoredMetricSample extends ParsedMetricSample {
  id: number;
}

interface MetricSampleRow {
  id: number;
  metric_name: string;
  unit: string;
  observed_at_ms: number;
  start_at_ms: number | null;
  value: number;
  numeric_kind: string;
  metric_kind: string;
  aggregation_temporality: string;
  is_monotonic: number;
  attributes_json: string;
  resource_attributes_json: string;
  scope_name: string | null;
  scope_version: string | null;
  received_at_ms: number;
}

interface IngestStatusRow {
  last_received_at_ms: number | null;
  total_samples: number | null;
  last_sample_count: number | null;
}

export class UsageDatabase {
  private readonly database: Database.Database;

  public constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  public insertBatch(samples: ParsedMetricSample[], receivedAtMs: number): void {
    const insertBatch = this.database.prepare(
      "INSERT INTO ingest_batches (received_at_ms, sample_count) VALUES (?, ?)"
    );
    const insertSample = this.database.prepare(`
      INSERT INTO metric_samples (
        metric_name,
        unit,
        observed_at_ms,
        start_at_ms,
        value,
        numeric_kind,
        metric_kind,
        aggregation_temporality,
        is_monotonic,
        attributes_json,
        resource_attributes_json,
        scope_name,
        scope_version,
        received_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.database.transaction(() => {
      insertBatch.run(receivedAtMs, samples.length);

      for (const sample of samples) {
        insertSample.run(
          sample.metricName,
          sample.unit,
          sample.observedAtMs,
          sample.startAtMs,
          sample.value,
          sample.numericKind,
          sample.metricKind,
          sample.aggregationTemporality,
          sample.isMonotonic ? 1 : 0,
          JSON.stringify(sample.attributes),
          JSON.stringify(sample.resourceAttributes),
          sample.scopeName,
          sample.scopeVersion,
          sample.receivedAtMs
        );
      }
    });

    transaction();
  }

  public getSamplesSince(sinceMs: number | null): StoredMetricSample[] {
    const statement =
      sinceMs === null
        ? this.database.prepare("SELECT * FROM metric_samples ORDER BY observed_at_ms ASC, id ASC")
        : this.database.prepare(
            "SELECT * FROM metric_samples WHERE observed_at_ms >= ? ORDER BY observed_at_ms ASC, id ASC"
          );

    const rows = sinceMs === null ? statement.all() : statement.all(sinceMs);
    return rows.map((row) => this.rowToSample(row as MetricSampleRow));
  }

  public getStatus(): IngestStatus {
    const row = this.database
      .prepare(
        `
        SELECT
          MAX(received_at_ms) AS last_received_at_ms,
          COALESCE((SELECT COUNT(*) FROM metric_samples), 0) AS total_samples,
          COALESCE((SELECT sample_count FROM ingest_batches ORDER BY id DESC LIMIT 1), 0) AS last_sample_count
        FROM ingest_batches
      `
      )
      .get() as IngestStatusRow;

    return {
      lastReceivedAt: row.last_received_at_ms ? new Date(row.last_received_at_ms).toISOString() : null,
      totalSamples: row.total_samples ?? 0,
      lastSampleCount: row.last_sample_count ?? 0
    };
  }

  public close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        unit TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        start_at_ms INTEGER,
        value REAL NOT NULL,
        numeric_kind TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        aggregation_temporality TEXT NOT NULL,
        is_monotonic INTEGER NOT NULL,
        attributes_json TEXT NOT NULL,
        resource_attributes_json TEXT NOT NULL,
        scope_name TEXT,
        scope_version TEXT,
        received_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS metric_samples_observed_at_idx
        ON metric_samples (observed_at_ms);

      CREATE INDEX IF NOT EXISTS metric_samples_metric_name_idx
        ON metric_samples (metric_name);

      CREATE TABLE IF NOT EXISTS ingest_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at_ms INTEGER NOT NULL,
        sample_count INTEGER NOT NULL
      );
    `);
  }

  private rowToSample(row: MetricSampleRow): StoredMetricSample {
    return {
      id: row.id,
      metricName: row.metric_name,
      unit: row.unit,
      observedAtMs: row.observed_at_ms,
      startAtMs: row.start_at_ms,
      value: row.value,
      numericKind: row.numeric_kind === "double" ? "double" : "int",
      metricKind: row.metric_kind === "gauge" ? "gauge" : "sum",
      aggregationTemporality: normalizeTemporality(row.aggregation_temporality),
      isMonotonic: row.is_monotonic === 1,
      attributes: parseAttributeJson(row.attributes_json),
      resourceAttributes: parseAttributeJson(row.resource_attributes_json),
      scopeName: row.scope_name,
      scopeVersion: row.scope_version,
      receivedAtMs: row.received_at_ms
    };
  }
}

function normalizeTemporality(value: string): StoredMetricSample["aggregationTemporality"] {
  if (value === "delta" || value === "cumulative") {
    return value;
  }

  return "unspecified";
}

function parseAttributeJson(value: string): AttributeMap {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  return parsed as AttributeMap;
}
