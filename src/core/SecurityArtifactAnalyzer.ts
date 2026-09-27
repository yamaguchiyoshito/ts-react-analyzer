import fs from "node:fs/promises";
import path from "node:path";

import { formatArtifactWarning, isRecord, readJsonArtifact } from "./ArtifactJson.js";

interface VulnerabilityCount {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface SecurityToolSummary extends VulnerabilityCount {
  tool: "npm-audit" | "trivy";
  filePath: string;
}

export interface SecurityArtifactSummary {
  tools: SecurityToolSummary[];
  /** 名前は一致したが読めなかった / 形式が違ったため無視した成果物 */
  warnings: string[];
}

// ファイル名 (basename) 単位で先頭一致させる。`.*audit.*` のような緩い一致だと
// lighthouse-audit.json や a11y-audit.json を npm audit と誤認し、脆弱性 0 件で
// pass 扱いになってしまう。
const NPM_AUDIT_FILE_PATTERN = /^(npm-)?audit([-.][\w.-]*)?\.json$/iu;
const TRIVY_FILE_PATTERN = /^trivy([-.][\w.-]*)?\.json$/iu;

export class SecurityArtifactAnalyzer {
  async analyzeProject(projectRoot: string): Promise<SecurityArtifactSummary> {
    const toolSummaries: SecurityToolSummary[] = [];
    const warnings: string[] = [];

    for (const filePath of await this.findNpmAuditFiles(projectRoot)) {
      const summary = await this.parseNpmAuditFile(filePath, warnings);
      if (summary) {
        toolSummaries.push(summary);
      }
    }
    for (const filePath of await this.findTrivyFiles(projectRoot)) {
      const summary = await this.parseTrivyFile(filePath, warnings);
      if (summary) {
        toolSummaries.push(summary);
      }
    }

    return {
      tools: toolSummaries,
      warnings,
    };
  }

  private async findNpmAuditFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "npm-audit.json",
      "reports/npm-audit.json",
      "audit.json",
      "artifacts/npm-audit.json",
    ], ["reports", "artifacts", ".artifacts"], NPM_AUDIT_FILE_PATTERN);
  }

  private async findTrivyFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "trivy.json",
      "trivy-results.json",
      "reports/trivy.json",
      "reports/trivy-results.json",
      "artifacts/trivy.json",
    ], ["reports", "artifacts", ".artifacts"], TRIVY_FILE_PATTERN);
  }

  private async parseNpmAuditFile(filePath: string, warnings: string[]): Promise<SecurityToolSummary | null> {
    const result = await readJsonArtifact(filePath);
    if (!result.ok) {
      warnings.push(formatArtifactWarning(filePath, result.error));
      return null;
    }
    if (!this.looksLikeNpmAudit(result.value)) {
      warnings.push(formatArtifactWarning(filePath, "npm audit の JSON 形式 (vulnerabilities / metadata.vulnerabilities / advisories) ではないため無視しました"));
      return null;
    }

    return {
      tool: "npm-audit",
      filePath,
      ...this.extractNpmAuditCounts(result.value),
    };
  }

  private async parseTrivyFile(filePath: string, warnings: string[]): Promise<SecurityToolSummary | null> {
    const result = await readJsonArtifact(filePath);
    if (!result.ok) {
      warnings.push(formatArtifactWarning(filePath, result.error));
      return null;
    }
    if (!this.looksLikeTrivy(result.value)) {
      warnings.push(formatArtifactWarning(filePath, "Trivy の JSON 形式 (Results 配列) ではないため無視しました"));
      return null;
    }

    return {
      tool: "trivy",
      filePath,
      ...this.extractTrivyCounts(result.value),
    };
  }

  private looksLikeNpmAudit(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }
    if (isRecord(payload.metadata) && isRecord(payload.metadata.vulnerabilities)) {
      return true;
    }
    if (isRecord(payload.vulnerabilities)) {
      return true;
    }
    return isRecord(payload.advisories);
  }

  private looksLikeTrivy(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }
    return Array.isArray(payload.Results) || Array.isArray(payload.results);
  }

  private extractNpmAuditCounts(payload: unknown): VulnerabilityCount {
    if (!payload || typeof payload !== "object") {
      return { critical: 0, high: 0, medium: 0, low: 0 };
    }

    const record = payload as Record<string, unknown>;
    if (record.metadata && typeof record.metadata === "object") {
      const vulnerabilities = (record.metadata as Record<string, unknown>).vulnerabilities;
      if (vulnerabilities && typeof vulnerabilities === "object") {
        const counts = vulnerabilities as Record<string, unknown>;
        return {
          critical: this.readCount(counts.critical),
          high: this.readCount(counts.high),
          medium: this.readCount(counts.moderate),
          low: this.readCount(counts.low),
        };
      }
    }

    if (record.vulnerabilities && typeof record.vulnerabilities === "object") {
      const counts: VulnerabilityCount = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const value of Object.values(record.vulnerabilities as Record<string, unknown>)) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const severity = ((value as Record<string, unknown>).severity as string | undefined)?.toLowerCase();
        if (severity === "critical") {
          counts.critical += 1;
        } else if (severity === "high") {
          counts.high += 1;
        } else if (severity === "moderate" || severity === "medium") {
          counts.medium += 1;
        } else if (severity === "low") {
          counts.low += 1;
        }
      }
      return counts;
    }

    return { critical: 0, high: 0, medium: 0, low: 0 };
  }

  private extractTrivyCounts(payload: unknown): VulnerabilityCount {
    const counts: VulnerabilityCount = { critical: 0, high: 0, medium: 0, low: 0 };

    if (!payload || typeof payload !== "object") {
      return counts;
    }

    const record = payload as Record<string, unknown>;
    const results = Array.isArray(record.Results) ? record.Results : Array.isArray(record.results) ? record.results : [];
    for (const result of results) {
      if (!result || typeof result !== "object") {
        continue;
      }
      const vulnerabilities = Array.isArray((result as Record<string, unknown>).Vulnerabilities)
        ? (result as Record<string, unknown>).Vulnerabilities as Array<Record<string, unknown>>
        : Array.isArray((result as Record<string, unknown>).vulnerabilities)
          ? (result as Record<string, unknown>).vulnerabilities as Array<Record<string, unknown>>
          : [];

      for (const vulnerability of vulnerabilities) {
        const severity = (vulnerability.Severity as string | undefined ?? vulnerability.severity as string | undefined ?? "").toLowerCase();
        if (severity === "critical") {
          counts.critical += 1;
        } else if (severity === "high") {
          counts.high += 1;
        } else if (severity === "medium" || severity === "moderate") {
          counts.medium += 1;
        } else if (severity === "low") {
          counts.low += 1;
        }
      }
    }

    return counts;
  }

  private readCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private async findFiles(
    projectRoot: string,
    directCandidates: string[],
    searchDirectories: string[],
    filePattern: RegExp,
  ): Promise<string[]> {
    const files = new Set<string>();

    for (const candidate of directCandidates) {
      const resolved = path.join(projectRoot, candidate);
      if (await this.exists(resolved)) {
        files.add(resolved);
      }
    }

    for (const directory of searchDirectories) {
      const resolvedDirectory = path.join(projectRoot, directory);
      if (!(await this.exists(resolvedDirectory))) {
        continue;
      }

      for (const filePath of await this.findFilesByPattern(resolvedDirectory, 3, (fileName) => filePattern.test(fileName))) {
        files.add(filePath);
      }
    }

    return Array.from(files).sort();
  }

  private async findFilesByPattern(
    currentDirectory: string,
    remainingDepth: number,
    predicate: (fileName: string) => boolean,
  ): Promise<string[]> {
    if (remainingDepth < 0) {
      return [];
    }

    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const resolved = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.findFilesByPattern(resolved, remainingDepth - 1, predicate));
      } else if (entry.isFile() && predicate(entry.name)) {
        files.push(resolved);
      }
    }

    return files;
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
