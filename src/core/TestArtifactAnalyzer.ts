import fs from "node:fs/promises";
import path from "node:path";

export interface JUnitSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  files: string[];
}

export interface CoverageSummary {
  lineFound: number;
  lineHit: number;
  lineCoverage: number | null;
  files: string[];
}

export interface VitestSummary {
  files: string[];
  scripts: string[];
}

export interface TestArtifactSummary {
  junit: JUnitSummary | null;
  coverage: CoverageSummary | null;
  vitest: VitestSummary | null;
}

export class TestArtifactAnalyzer {
  async analyzeProject(projectRoot: string): Promise<TestArtifactSummary> {
    const junitFiles = await this.findJUnitFiles(projectRoot);
    const coverageFiles = await this.findCoverageFiles(projectRoot);
    const vitest = await this.detectVitest(projectRoot);

    return {
      junit: junitFiles.length > 0 ? await this.parseJUnitFiles(junitFiles) : null,
      coverage: coverageFiles.length > 0 ? await this.parseCoverageFiles(coverageFiles) : null,
      vitest,
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

  private async parseJUnitFiles(files: string[]): Promise<JUnitSummary> {
    let totalTests = 0;
    let failedTests = 0;
    let skippedTests = 0;

    for (const filePath of files) {
      const xml = await fs.readFile(filePath, "utf8");
      const suiteTags = Array.from(xml.matchAll(/<testsuite\b[^>]*>/gu));

      if (suiteTags.length > 0) {
        for (const match of suiteTags) {
          const tag = match[0];
          totalTests += this.extractIntegerAttribute(tag, "tests");
          failedTests += this.extractIntegerAttribute(tag, "failures");
          failedTests += this.extractIntegerAttribute(tag, "errors");
          skippedTests += this.extractIntegerAttribute(tag, "skipped");
        }
        continue;
      }

      totalTests += Array.from(xml.matchAll(/<testcase\b/gu)).length;
      failedTests += Array.from(xml.matchAll(/<(failure|error)\b/gu)).length;
      skippedTests += Array.from(xml.matchAll(/<skipped\b/gu)).length;
    }

    const passedTests = Math.max(0, totalTests - failedTests - skippedTests);

    return {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      files,
    };
  }

  private async parseCoverageFiles(files: string[]): Promise<CoverageSummary> {
    let lineFound = 0;
    let lineHit = 0;

    for (const filePath of files) {
      const content = await fs.readFile(filePath, "utf8");
      for (const line of content.split(/\r?\n/u)) {
        if (line.startsWith("LF:")) {
          lineFound += Number.parseInt(line.slice(3), 10) || 0;
        } else if (line.startsWith("LH:")) {
          lineHit += Number.parseInt(line.slice(3), 10) || 0;
        }
      }
    }

    return {
      lineFound,
      lineHit,
      lineCoverage: lineFound > 0 ? (lineHit / lineFound) * 100 : null,
      files,
    };
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
