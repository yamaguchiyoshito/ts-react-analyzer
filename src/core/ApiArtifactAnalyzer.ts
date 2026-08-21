import fs from "node:fs/promises";
import path from "node:path";

import type { ParsedFile } from "../types/index.js";

export interface OpenApiSummary {
  specFiles: string[];
  diffFiles: string[];
  breakingChanges: number | null;
}

export interface MswSummary {
  apiFileCount: number;
  handlerFiles: string[];
  handlerCount: number;
}

export interface TimeoutRetrySummary {
  apiFileCount: number;
  resilientFiles: string[];
}

export interface ApiArtifactSummary {
  openApi: OpenApiSummary | null;
  msw: MswSummary;
  timeoutRetry: TimeoutRetrySummary;
}

export class ApiArtifactAnalyzer {
  private projectRoot?: string;

  async analyzeProject(projectRoot: string, parsedFiles: ParsedFile[]): Promise<ApiArtifactSummary> {
    this.projectRoot = path.resolve(projectRoot);
    const specFiles = await this.findOpenApiSpecFiles(projectRoot);
    const diffFiles = await this.findOpenApiDiffFiles(projectRoot);
    const breakingChanges = diffFiles.length > 0 ? await this.parseBreakingChanges(diffFiles) : null;

    return {
      openApi: specFiles.length > 0 || diffFiles.length > 0
        ? {
            specFiles,
            diffFiles,
            breakingChanges,
          }
        : null,
      msw: this.collectMswSummary(parsedFiles),
      timeoutRetry: this.collectTimeoutRetrySummary(parsedFiles),
    };
  }

  private async findOpenApiSpecFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "openapi.yaml",
      "openapi.yml",
      "openapi.json",
      "swagger.yaml",
      "swagger.yml",
      "swagger.json",
      "docs/openapi.yaml",
      "docs/openapi.yml",
      "docs/openapi.json",
    ], ["docs", "api", "specs", "contracts"], /(openapi|swagger).+\.(json|ya?ml)$/iu);
  }

  private async findOpenApiDiffFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "openapi-diff.json",
      "reports/openapi-diff.json",
      "reports/openapi-validation.json",
      "artifacts/openapi-diff.json",
    ], ["reports", "artifacts", ".artifacts", "contracts"], /openapi.+(diff|validation).+\.json$/iu);
  }

  private async parseBreakingChanges(files: string[]): Promise<number> {
    let breakingChanges = 0;

    for (const filePath of files) {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      breakingChanges += this.extractBreakingChanges(payload);
    }

    return breakingChanges;
  }

  private extractBreakingChanges(payload: unknown): number {
    if (!payload || typeof payload !== "object") {
      return 0;
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.breakingDifferences)) {
      return record.breakingDifferences.length;
    }
    if (Array.isArray(record.breakingChanges)) {
      return record.breakingChanges.length;
    }
    if (record.summary && typeof record.summary === "object") {
      const summary = record.summary as Record<string, unknown>;
      if (typeof summary.breakingChanges === "number") {
        return summary.breakingChanges;
      }
    }
    if (record.changes && typeof record.changes === "object") {
      const changes = record.changes as Record<string, unknown>;
      if (Array.isArray(changes.breaking)) {
        return changes.breaking.length;
      }
    }
    if (typeof record.breakingDifferencesFound === "boolean") {
      return record.breakingDifferencesFound ? 1 : 0;
    }
    return 0;
  }

  private collectMswSummary(parsedFiles: ParsedFile[]): MswSummary {
    const apiFileCount = this.getApiFiles(parsedFiles).length;
    const handlerFiles: string[] = [];
    let handlerCount = 0;

    for (const parsedFile of parsedFiles) {
      if (!/from\s+["']msw(?:\/node)?["']/u.test(parsedFile.sourceCode) && !/setupServer\(/u.test(parsedFile.sourceCode)) {
        continue;
      }

      handlerFiles.push(parsedFile.filePath);
      const matches = parsedFile.sourceCode.match(/\b(?:http|rest)\.(get|post|put|patch|delete|options|head)\(/gu);
      handlerCount += matches?.length ?? 0;
    }

    return {
      apiFileCount,
      handlerFiles,
      handlerCount,
    };
  }

  private collectTimeoutRetrySummary(parsedFiles: ParsedFile[]): TimeoutRetrySummary {
    const apiFiles = this.getApiFiles(parsedFiles);
    const resilientFiles = apiFiles
      .filter((parsedFile) =>
        /(AbortController|AbortSignal\.timeout|axios-retry|p-retry|\b(?:timeout|retry)\b\s*[:=])/u.test(parsedFile.sourceCode)
      )
      .map((parsedFile) => parsedFile.filePath);

    return {
      apiFileCount: apiFiles.length,
      resilientFiles,
    };
  }

  private getApiFiles(parsedFiles: ParsedFile[]): ParsedFile[] {
    // プロジェクトより上位のディレクトリ名 (例: /home/user/services/proj) が
    // API 層判定に混入しないよう、プロジェクト相対パスで照合する。
    return parsedFiles.filter((parsedFile) =>
      /(^|\/)(api|infra|service|services|client|clients|repository|repositories|gateway)(\/|$)/iu.test(
        this.toProjectRelativePath(parsedFile.filePath),
      )
    );
  }

  private toProjectRelativePath(filePath: string): string {
    const normalized = filePath.replace(/\\/gu, "/");
    if (!this.projectRoot || !path.isAbsolute(filePath)) {
      return normalized;
    }
    const relative = path.relative(this.projectRoot, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return normalized;
    }
    return relative.split(path.sep).join("/");
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
