import fs from "node:fs/promises";
import path from "node:path";

import { formatArtifactWarning, readTextArtifact } from "./ArtifactJson.js";

export interface JUnitSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  files: string[];
  executedTestFiles: string[];
}

export interface CoverageSummary {
  lineFound: number;
  lineHit: number;
  lineCoverage: number | null;
  files: string[];
  sourceFiles: Array<{
    filePath: string;
    lineFound: number;
    lineHit: number;
    lineCoverage: number | null;
  }>;
}

export interface VitestSummary {
  files: string[];
  scripts: string[];
}

export interface TestArtifactSummary {
  junit: JUnitSummary | null;
  coverage: CoverageSummary | null;
  vitest: VitestSummary | null;
  /** 名前は一致したが読めなかった / 形式が違ったため無視した成果物 */
  warnings: string[];
}

export class TestArtifactAnalyzer {
  async analyzeProject(projectRoot: string): Promise<TestArtifactSummary> {
    const junitFiles = await this.findJUnitFiles(projectRoot);
    const coverageFiles = await this.findCoverageFiles(projectRoot);
    const vitest = await this.detectVitest(projectRoot);
    const warnings: string[] = [];

    return {
      junit: junitFiles.length > 0 ? await this.parseJUnitFiles(projectRoot, junitFiles, warnings) : null,
      coverage: coverageFiles.length > 0 ? await this.parseCoverageFiles(projectRoot, coverageFiles, warnings) : null,
      vitest,
      warnings,
    };
  }

  private async findJUnitFiles(projectRoot: string): Promise<string[]> {
    const files = new Set<string>();
    const directCandidates = [
      "junit.xml",
      "junit-report.xml",
      "reports/junit.xml",
      "reports/junit-report.xml",
      "test-results/junit.xml",
      "test-results/results.xml",
      "coverage/junit.xml",
    ];
    const searchDirectories = ["reports", "test-results", "coverage", ".artifacts"];

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

      for (const filePath of await this.findFilesByPattern(resolvedDirectory, 3, (fileName) => /\.xml$/u.test(fileName) && /(junit|result)/iu.test(fileName))) {
        files.add(filePath);
      }
    }

    return Array.from(files).sort();
  }

  private async findCoverageFiles(projectRoot: string): Promise<string[]> {
    const files = new Set<string>();
    const directCandidates = [
      "coverage/lcov.info",
      "lcov.info",
      "reports/lcov.info",
      "test-results/lcov.info",
    ];

    for (const candidate of directCandidates) {
      const resolved = path.join(projectRoot, candidate);
      if (await this.exists(resolved)) {
        files.add(resolved);
      }
    }

    return Array.from(files).sort();
  }

  private async parseJUnitFiles(projectRoot: string, files: string[], warnings: string[]): Promise<JUnitSummary | null> {
    let totalTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    const executedTestFiles = new Set<string>();
    const acceptedFiles: string[] = [];

    for (const filePath of files) {
      const read = await readTextArtifact(filePath);
      if (!read.ok) {
        warnings.push(formatArtifactWarning(filePath, read.error));
        continue;
      }
      const xml = read.value;
      // ファイル名の (junit|result) 一致だけでは他ツールの XML も拾うため、
      // JUnit 形式の証である <testsuite 要素を必須にする
      if (!/<testsuite\b/iu.test(xml)) {
        warnings.push(formatArtifactWarning(filePath, "JUnit 形式 (<testsuite>) ではないため無視しました"));
        continue;
      }
      acceptedFiles.push(filePath);
      const suiteTags = Array.from(xml.matchAll(/<testsuite\b[^>]*>/gu));
      const testcases = this.extractJUnitTestCases(xml);

      if (testcases.length > 0) {
        totalTests += testcases.length;
        for (const testcase of testcases) {
          if (/<(?:failure|error)\b/iu.test(testcase.body)) {
            failedTests += 1;
          } else if (/<skipped\b/iu.test(testcase.body)) {
            skippedTests += 1;
          }
          const testFile = this.extractStringAttribute(testcase.raw, "file");
          if (testFile) {
            executedTestFiles.add(this.resolveArtifactSourcePath(projectRoot, filePath, testFile));
          }
        }
      } else if (suiteTags.length > 0) {
        for (const match of suiteTags) {
          const tag = match[0];
          totalTests += this.extractIntegerAttribute(tag, "tests");
          failedTests += this.extractIntegerAttribute(tag, "failures");
          failedTests += this.extractIntegerAttribute(tag, "errors");
          skippedTests += this.extractIntegerAttribute(tag, "skipped");
          const suiteFile = this.extractStringAttribute(tag, "file");
          if (suiteFile) {
            executedTestFiles.add(this.resolveArtifactSourcePath(projectRoot, filePath, suiteFile));
          }
        }
      }

      if (suiteTags.length === 0 && testcases.length === 0) {
        failedTests += Array.from(xml.matchAll(/<(failure|error)\b/gu)).length;
        skippedTests += Array.from(xml.matchAll(/<skipped\b/gu)).length;
      }
    }

    if (acceptedFiles.length === 0) {
      return null;
    }

    const passedTests = Math.max(0, totalTests - failedTests - skippedTests);

    return {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      files: acceptedFiles,
      executedTestFiles: Array.from(executedTestFiles).sort(),
    };
  }

  private extractJUnitTestCases(xml: string): Array<{ raw: string; body: string }> {
    // 開始タグを属性の引用符を考慮して取り、自己終了 (<testcase ... />) かどうかで
    // 本文の有無を判定する。単純な [^>]* だと自己終了タグの "/" を飲み込み、後続の
    // </testcase> まで 1 マッチに統合されてテスト数を過少集計する。
    const cases: Array<{ raw: string; body: string }> = [];
    const openTag = /<testcase\b((?:[^>"'/]|"[^"]*"|'[^']*')*)(\/?)>/gu;
    const closeTag = "</testcase>";
    let match: RegExpExecArray | null;
    while ((match = openTag.exec(xml)) !== null) {
      if (match[2] === "/") {
        cases.push({ raw: match[0], body: "" });
        continue;
      }
      const closeIndex = xml.indexOf(closeTag, openTag.lastIndex);
      if (closeIndex === -1) {
        cases.push({ raw: match[0], body: "" });
        continue;
      }
      cases.push({ raw: match[0], body: xml.slice(openTag.lastIndex, closeIndex) });
      openTag.lastIndex = closeIndex + closeTag.length;
    }
    return cases;
  }

  private async parseCoverageFiles(projectRoot: string, files: string[], warnings: string[]): Promise<CoverageSummary | null> {
    const sourceFiles = new Map<string, { lineFound: number; lineHit: number }>();
    const acceptedFiles: string[] = [];

    for (const filePath of files) {
      const read = await readTextArtifact(filePath);
      if (!read.ok) {
        warnings.push(formatArtifactWarning(filePath, read.error));
        continue;
      }
      acceptedFiles.push(filePath);
      const content = read.value;
      let currentSourcePath: string | null = null;
      let currentLineFound = 0;
      let currentLineHit = 0;

      const flushRecord = (): void => {
        if (!currentSourcePath) {
          return;
        }

        const existing = sourceFiles.get(currentSourcePath) ?? { lineFound: 0, lineHit: 0 };
        existing.lineFound += currentLineFound;
        existing.lineHit += currentLineHit;
        sourceFiles.set(currentSourcePath, existing);
      };

      for (const line of content.split(/\r?\n/u)) {
        if (line.startsWith("SF:")) {
          flushRecord();
          currentSourcePath = this.resolveCoverageSourcePath(projectRoot, filePath, line.slice(3));
          currentLineFound = 0;
          currentLineHit = 0;
          continue;
        }
        if (line.startsWith("LF:")) {
          currentLineFound = Number.parseInt(line.slice(3), 10) || 0;
          continue;
        }
        if (line.startsWith("LH:")) {
          currentLineHit = Number.parseInt(line.slice(3), 10) || 0;
          continue;
        }
        if (line === "end_of_record") {
          flushRecord();
          currentSourcePath = null;
          currentLineFound = 0;
          currentLineHit = 0;
        }
      }

      flushRecord();
    }

    if (acceptedFiles.length === 0) {
      return null;
    }

    const summarizedSourceFiles = Array.from(sourceFiles.entries())
      .map(([filePath, summary]) => ({
        filePath,
        lineFound: summary.lineFound,
        lineHit: summary.lineHit,
        lineCoverage: summary.lineFound > 0 ? (summary.lineHit / summary.lineFound) * 100 : null,
      }))
      .sort((left, right) => left.filePath.localeCompare(right.filePath));
    const lineFound = summarizedSourceFiles.reduce((sum, item) => sum + item.lineFound, 0);
    const lineHit = summarizedSourceFiles.reduce((sum, item) => sum + item.lineHit, 0);

    return {
      lineFound,
      lineHit,
      lineCoverage: lineFound > 0 ? (lineHit / lineFound) * 100 : null,
      files: acceptedFiles,
      sourceFiles: summarizedSourceFiles,
    };
  }

  private resolveCoverageSourcePath(projectRoot: string, coverageFilePath: string, sourcePath: string): string {
    return this.resolveArtifactSourcePath(projectRoot, coverageFilePath, sourcePath);
  }

  private async detectVitest(projectRoot: string): Promise<VitestSummary | null> {
    const files = new Set<string>();
    const scripts = new Set<string>();
    const packageJsonPath = path.join(projectRoot, "package.json");

    if (await this.exists(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
        const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
        for (const field of dependencyFields) {
          const record = packageJson[field];
          if (record && typeof record === "object" && "vitest" in record) {
            files.add(packageJsonPath);
            break;
          }
        }

        const packageScripts = packageJson.scripts;
        if (packageScripts && typeof packageScripts === "object") {
          for (const [name, command] of Object.entries(packageScripts)) {
            if (typeof command === "string" && /\bvitest\b/u.test(command)) {
              files.add(packageJsonPath);
              scripts.add(`${name}: ${command}`);
            }
          }
        }
      } catch {
        // noop
      }
    }

    const configCandidates = [
      "vitest.config.ts",
      "vitest.config.tsx",
      "vitest.config.js",
      "vitest.config.jsx",
      "vitest.config.mjs",
      "vitest.config.cjs",
      "vitest.config.mts",
      "vitest.config.cts",
      "vitest.workspace.ts",
      "vitest.workspace.js",
      "vitest.workspace.mts",
      "vitest.workspace.cts",
    ];

    for (const candidate of configCandidates) {
      const resolved = path.join(projectRoot, candidate);
      if (await this.exists(resolved)) {
        files.add(resolved);
      }
    }

    if (files.size === 0 && scripts.size === 0) {
      return null;
    }

    return {
      files: Array.from(files).sort(),
      scripts: Array.from(scripts).sort(),
    };
  }

  private extractIntegerAttribute(tag: string, attribute: string): number {
    const match = new RegExp(`${attribute}="(\\d+)"`, "u").exec(tag);
    return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
  }

  private extractStringAttribute(tag: string, attribute: string): string | null {
    const match = new RegExp(`${attribute}="([^"]+)"`, "u").exec(tag);
    return match?.[1]?.trim() ? match[1].trim() : null;
  }

  private resolveArtifactSourcePath(projectRoot: string, artifactFilePath: string, sourcePath: string): string {
    const trimmed = sourcePath.trim();
    if (!trimmed) {
      return artifactFilePath;
    }
    if (path.isAbsolute(trimmed)) {
      return path.normalize(trimmed);
    }

    const projectRelative = path.resolve(projectRoot, trimmed);
    const artifactRelative = path.resolve(path.dirname(artifactFilePath), trimmed);
    return trimmed.startsWith(".") ? artifactRelative : projectRelative;
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
