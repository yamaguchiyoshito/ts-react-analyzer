import fs from "node:fs/promises";
import path from "node:path";

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
}

export class SecurityArtifactAnalyzer {
  async analyzeProject(projectRoot: string): Promise<SecurityArtifactSummary> {
    const toolSummaries: SecurityToolSummary[] = [];

    for (const filePath of await this.findNpmAuditFiles(projectRoot)) {
      toolSummaries.push(await this.parseNpmAuditFile(filePath));
    }
    for (const filePath of await this.findTrivyFiles(projectRoot)) {
      toolSummaries.push(await this.parseTrivyFile(filePath));
    }

    return {
      tools: toolSummaries,
    };
  }

  private async findNpmAuditFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "npm-audit.json",
      "reports/npm-audit.json",
      "audit.json",
      "artifacts/npm-audit.json",
    ], ["reports", "artifacts", ".artifacts"], /(npm-)?audit.*\.json$/iu);
  }

  private async findTrivyFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "trivy.json",
      "trivy-results.json",
      "reports/trivy.json",
      "reports/trivy-results.json",
      "artifacts/trivy.json",
    ], ["reports", "artifacts", ".artifacts"], /trivy.*\.json$/iu);
  }

  private async parseNpmAuditFile(filePath: string): Promise<SecurityToolSummary> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const counts = this.extractNpmAuditCounts(payload);

    return {
      tool: "npm-audit",
      filePath,
      ...counts,
    };
  }

  private async parseTrivyFile(filePath: string): Promise<SecurityToolSummary> {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const counts = this.extractTrivyCounts(payload);

    return {
      tool: "trivy",
      filePath,
      ...counts,
    };
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
