import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import type {
  CacheStats,
  CachedAnalysisPayload,
  CachedAnalysisRecord,
} from "../types/index.js";

export class AnalysisCache {
  private readonly cacheFile: string;
  private readonly configHash: string;
  private readonly records = new Map<string, CachedAnalysisRecord>();
  private readonly nextRecords = new Map<string, CachedAnalysisRecord>();
  private readonly stats: CacheStats = { hits: 0, misses: 0 };

  constructor(cacheDir: string, projectRoot: string, compilerOptions: ts.CompilerOptions) {
    const projectKey = this.hash(projectRoot).slice(0, 16);
    this.cacheFile = path.join(cacheDir, "analysis", `${projectKey}.json`);
    this.configHash = this.hash(this.stableStringify(compilerOptions));
  }

  async initialize(): Promise<void> {
    try {
      const content = await fs.readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(content) as CachedAnalysisRecord[];
      this.records.clear();
      for (const record of parsed) {
        this.records.set(record.filePath, record);
      }
    } catch {
      this.records.clear();
    }
  }

  get(filePath: string, sourceSha256: string): CachedAnalysisPayload | null {
    const record = this.records.get(filePath);
    if (!record || record.sourceSha256 !== sourceSha256 || record.configHash !== this.configHash) {
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    this.nextRecords.set(filePath, record);
    return record.payload;
  }

  set(filePath: string, sourceSha256: string, payload: CachedAnalysisPayload): void {
    this.nextRecords.set(filePath, {
      filePath,
      sourceSha256,
      configHash: this.configHash,
      payload,
      timestamp: Date.now(),
    });
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const records = Array.from(this.nextRecords.values()).sort((left, right) => left.filePath.localeCompare(right.filePath));
    await fs.writeFile(this.cacheFile, JSON.stringify(records, null, 2), "utf8");
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(",")}}`;
    }

    return JSON.stringify(value);
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}
