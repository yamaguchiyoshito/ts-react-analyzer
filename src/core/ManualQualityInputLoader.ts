import fs from "node:fs/promises";
import path from "node:path";

import type { ManualQualityMetricInput, QualityEvidence, QualityVerdict } from "../types/index.js";

interface ManualQualityInputFile {
  metrics?: ManualQualityMetricInput[];
}

const ALLOWED_VERDICTS = new Set<QualityVerdict>(["pass", "partial", "warn", "fail", "manual", "not_applicable"]);
const ALLOWED_EVIDENCE_TYPES = new Set<QualityEvidence["type"]>(["file", "metric", "note"]);

export class ManualQualityInputLoader {
  async load(inputPath: string): Promise<ManualQualityMetricInput[]> {
    const resolvedPath = path.resolve(inputPath);
    const raw = JSON.parse(await fs.readFile(resolvedPath, "utf8")) as unknown;
    const directory = path.dirname(resolvedPath);

    return this.normalize(raw, directory);
  }

  private normalize(raw: unknown, directory: string): ManualQualityMetricInput[] {
    if (Array.isArray(raw)) {
      return raw.flatMap((entry) => this.normalizeEntry(entry, directory));
    }

    if (!raw || typeof raw !== "object") {
      return [];
    }

    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.metrics)) {
      return record.metrics.flatMap((entry) => this.normalizeEntry(entry, directory));
    }

    return Object.entries(record).flatMap(([id, value]) => this.normalizeEntry({
      id,
      ...(value && typeof value === "object" ? value as Record<string, unknown> : {}),
    }, directory));
  }

  private normalizeEntry(entry: unknown, directory: string): ManualQualityMetricInput[] {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim()) {
      return [];
    }

    const evidence = Array.isArray(record.evidence)
      ? record.evidence.flatMap((item) => this.normalizeEvidence(item, directory))
      : undefined;
    const verdict = typeof record.verdict === "string" && ALLOWED_VERDICTS.has(record.verdict as QualityVerdict)
      ? record.verdict as QualityVerdict
      : undefined;

    return [{
      id: record.id,
      actual: typeof record.actual === "string" ? record.actual : undefined,
      threshold: typeof record.threshold === "string" ? record.threshold : undefined,
      verdict,
      summary: typeof record.summary === "string" ? record.summary : undefined,
      evidence,
    }];
  }

  private normalizeEvidence(entry: unknown, directory: string): QualityEvidence[] {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label : "manual";
    const value = typeof record.value === "string" ? record.value : "";
    const type = typeof record.type === "string" && ALLOWED_EVIDENCE_TYPES.has(record.type as QualityEvidence["type"])
      ? record.type as QualityEvidence["type"]
      : "note";
    const filePath = typeof record.filePath === "string"
      ? path.resolve(directory, record.filePath)
      : undefined;

    return [{
      type,
      label,
      value: filePath && !value ? filePath : value,
      filePath,
    }];
  }
}
