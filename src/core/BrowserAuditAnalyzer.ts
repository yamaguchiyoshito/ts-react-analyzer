import fs from "node:fs/promises";
import path from "node:path";

export interface AxeSummary {
  totalViolations: number;
  criticalCount: number;
  seriousCount: number;
  moderateCount: number;
  minorCount: number;
  incompleteCount: number;
  files: string[];
}

export interface LighthouseSummary {
  performanceScore: number | null;
  lcpSeconds: number | null;
  ttiSeconds: number | null;
  files: string[];
}

export interface BrowserAuditSummary {
  axe: AxeSummary | null;
  lighthouse: LighthouseSummary | null;
}

interface AxeLikeViolation {
  impact?: string;
  nodes?: unknown[];
}

interface AxeLikeResult {
  violations?: AxeLikeViolation[];
  incomplete?: unknown[];
}

interface LighthouseLikeAudit {
  numericValue?: number;
}

interface LighthouseLikeResult {
  categories?: {
    performance?: {
      score?: number;
    };
  };
  audits?: {
    "largest-contentful-paint"?: LighthouseLikeAudit;
    interactive?: LighthouseLikeAudit;
  };
}

export class BrowserAuditAnalyzer {
  async analyzeProject(projectRoot: string): Promise<BrowserAuditSummary> {
    const axeFiles = await this.findAxeFiles(projectRoot);
    const lighthouseFiles = await this.findLighthouseFiles(projectRoot);

    return {
      axe: axeFiles.length > 0 ? await this.parseAxeFiles(axeFiles) : null,
      lighthouse: lighthouseFiles.length > 0 ? await this.parseLighthouseFiles(lighthouseFiles) : null,
    };
  }

  private async findAxeFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "axe-results.json",
      "axe-report.json",
      "reports/axe.json",
      "reports/axe-results.json",
      "test-results/axe.json",
      "artifacts/axe.json",
    ], ["reports", "test-results", "artifacts", ".artifacts"], /axe.*\.json$/iu);
  }

  private async findLighthouseFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "lighthouse.json",
      "lighthouse-report.json",
      "reports/lighthouse.json",
      "reports/lighthouse-report.json",
      "test-results/lighthouse.json",
      "artifacts/lighthouse.json",
    ], ["reports", "test-results", "artifacts", ".artifacts"], /lighthouse.*\.json$/iu);
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

  private async parseAxeFiles(files: string[]): Promise<AxeSummary> {
    let totalViolations = 0;
    let criticalCount = 0;
    let seriousCount = 0;
    let moderateCount = 0;
    let minorCount = 0;
    let incompleteCount = 0;

    for (const filePath of files) {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const results = this.collectAxeResults(payload);

      for (const result of results) {
        for (const violation of result.violations ?? []) {
          const nodeCount = Math.max(1, violation.nodes?.length ?? 0);
          totalViolations += nodeCount;
          switch ((violation.impact ?? "").toLowerCase()) {
            case "critical":
              criticalCount += nodeCount;
              break;
            case "serious":
              seriousCount += nodeCount;
              break;
            case "moderate":
              moderateCount += nodeCount;
              break;
            case "minor":
              minorCount += nodeCount;
              break;
            default:
              moderateCount += nodeCount;
              break;
          }
        }
        incompleteCount += result.incomplete?.length ?? 0;
      }
    }

    return {
      totalViolations,
      criticalCount,
      seriousCount,
      moderateCount,
      minorCount,
      incompleteCount,
      files,
    };
  }

  private async parseLighthouseFiles(files: string[]): Promise<LighthouseSummary> {
    let performanceScore: number | null = null;
    let lcpSeconds: number | null = null;
    let ttiSeconds: number | null = null;

    for (const filePath of files) {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const reports = this.collectLighthouseResults(payload);

      for (const report of reports) {
        const score = typeof report.categories?.performance?.score === "number"
          ? report.categories.performance.score * 100
          : null;
        const lcp = typeof report.audits?.["largest-contentful-paint"]?.numericValue === "number"
          ? report.audits["largest-contentful-paint"].numericValue / 1000
          : null;
        const tti = typeof report.audits?.interactive?.numericValue === "number"
          ? report.audits.interactive.numericValue / 1000
          : null;

        performanceScore = score === null
          ? performanceScore
          : performanceScore === null
            ? score
            : Math.min(performanceScore, score);
        lcpSeconds = lcp === null
          ? lcpSeconds
          : lcpSeconds === null
            ? lcp
            : Math.max(lcpSeconds, lcp);
        ttiSeconds = tti === null
          ? ttiSeconds
          : ttiSeconds === null
            ? tti
            : Math.max(ttiSeconds, tti);
      }
    }

    return {
      performanceScore,
      lcpSeconds,
      ttiSeconds,
      files,
    };
  }

  private collectAxeResults(payload: unknown): AxeLikeResult[] {
    if (Array.isArray(payload)) {
      return payload.flatMap((item) => this.collectAxeResults(item));
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.violations)) {
      return [record as AxeLikeResult];
    }
    if (record.results) {
      return this.collectAxeResults(record.results);
    }

    return [];
  }

  private collectLighthouseResults(payload: unknown): LighthouseLikeResult[] {
    if (Array.isArray(payload)) {
      return payload.flatMap((item) => this.collectLighthouseResults(item));
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const record = payload as Record<string, unknown>;
    if (record.categories && record.audits) {
      return [record as LighthouseLikeResult];
    }
    if (record.lhr) {
      return this.collectLighthouseResults(record.lhr);
    }
    if (record.results) {
      return this.collectLighthouseResults(record.results);
    }

    return [];
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
