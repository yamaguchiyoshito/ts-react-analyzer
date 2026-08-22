import fs from "node:fs/promises";
import path from "node:path";

export interface UiTestRunSummary {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  files: string[];
  executedTestFiles: string[];
}

export interface UiTestArtifactSummary {
  playwright: UiTestRunSummary | null;
  storybook: UiTestRunSummary | null;
}

interface PlaywrightLikeResult {
  status?: string;
}

interface PlaywrightLikeTest {
  status?: string;
  expectedStatus?: string;
  results?: PlaywrightLikeResult[];
  file?: string;
  path?: string;
  location?: {
    file?: string;
  };
}

interface StorybookLikeEntry {
  status?: string;
}

export class UiTestArtifactAnalyzer {
  async analyzeProject(projectRoot: string): Promise<UiTestArtifactSummary> {
    const playwrightFiles = await this.findPlaywrightFiles(projectRoot);
    const storybookFiles = await this.findStorybookFiles(projectRoot);

    return {
      playwright: playwrightFiles.length > 0 ? await this.parsePlaywrightFiles(projectRoot, playwrightFiles) : null,
      storybook: storybookFiles.length > 0 ? await this.parseStorybookFiles(storybookFiles) : null,
    };
  }

  private async findPlaywrightFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "playwright-report/results.json",
      "playwright-report/report.json",
      "test-results/playwright-report.json",
      "reports/playwright.json",
      "artifacts/playwright.json",
    ], ["playwright-report", "reports", "test-results", "artifacts", ".artifacts"], /(playwright|e2e).+\.json$/iu);
  }

  private async findStorybookFiles(projectRoot: string): Promise<string[]> {
    return this.findFiles(projectRoot, [
      "storybook-results.json",
      "storybook-test-results.json",
      "reports/storybook.json",
      "reports/storybook-results.json",
      "test-results/storybook.json",
      "artifacts/storybook.json",
    ], ["reports", "test-results", "artifacts", ".artifacts"], /storybook.+\.json$/iu);
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

  private async parsePlaywrightFiles(projectRoot: string, files: string[]): Promise<UiTestRunSummary> {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    const executedTestFiles = new Set<string>();

    for (const filePath of files) {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const tests = this.collectPlaywrightTests(payload);

      for (const test of tests) {
        totalTests += 1;
        const testFile = this.extractPlaywrightTestFile(test);
        if (testFile) {
          executedTestFiles.add(this.resolveArtifactSourcePath(projectRoot, filePath, testFile));
        }
        const status = this.normalizePlaywrightStatus(test);
        if (status === "passed") {
          passedTests += 1;
        } else if (status === "skipped") {
          skippedTests += 1;
        } else {
          failedTests += 1;
        }
      }
    }

    return {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      files,
      executedTestFiles: Array.from(executedTestFiles).sort(),
    };
  }

  private async parseStorybookFiles(files: string[]): Promise<UiTestRunSummary> {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;

    for (const filePath of files) {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const summary = this.extractStorybookSummary(payload);

      if (summary) {
        totalTests += summary.totalTests;
        passedTests += summary.passedTests;
        failedTests += summary.failedTests;
        skippedTests += summary.skippedTests;
        continue;
      }

      const entries = this.collectStorybookEntries(payload);
      for (const entry of entries) {
        totalTests += 1;
        const status = this.normalizeStorybookStatus(entry.status);
        if (status === "passed") {
          passedTests += 1;
        } else if (status === "skipped") {
          skippedTests += 1;
        } else {
          failedTests += 1;
        }
      }
    }

    return {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      files,
      executedTestFiles: [],
    };
  }

  private collectPlaywrightTests(payload: unknown): PlaywrightLikeTest[] {
    if (Array.isArray(payload)) {
      return payload.flatMap((item) => this.collectPlaywrightTests(item));
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.results) || typeof record.status === "string" || typeof record.expectedStatus === "string") {
      return [record as PlaywrightLikeTest];
    }

    const nested: PlaywrightLikeTest[] = [];
    for (const key of ["suites", "specs", "tests", "projects", "results"]) {
      if (Array.isArray(record[key])) {
        nested.push(...this.collectPlaywrightTests(record[key]));
      }
    }
    return nested;
  }

  private normalizePlaywrightStatus(test: PlaywrightLikeTest): "passed" | "failed" | "skipped" {
    // Playwright の test.status は最終判定 (expected / unexpected / flaky / skipped)。
    // results 配列を先に見るとリトライで成功した flaky が failed 扱いになるため、
    // 最終判定を優先し、無い場合のみ results から推定する。
    const directStatus = (test.status ?? "").toLowerCase();
    if (["passed", "expected", "flaky"].includes(directStatus)) {
      return "passed";
    }
    if (["failed", "unexpected", "timedout", "interrupted"].includes(directStatus)) {
      return "failed";
    }
    if (directStatus === "skipped" || (test.expectedStatus ?? "").toLowerCase() === "skipped") {
      return "skipped";
    }

    const resultStatuses = (test.results ?? [])
      .map((result) => (result.status ?? "").toLowerCase())
      .filter(Boolean);
    if (resultStatuses.length > 0) {
      // 最後の実行結果が最終状態 (リトライは配列の後ろに積まれる)
      const lastStatus = resultStatuses[resultStatuses.length - 1]!;
      if (lastStatus === "passed") {
        return "passed";
      }
      if (["failed", "timedout", "interrupted"].includes(lastStatus)) {
        return "failed";
      }
      if (resultStatuses.every((status) => status === "skipped")) {
        return "skipped";
      }
    }
    return "failed";
  }

  private extractPlaywrightTestFile(test: PlaywrightLikeTest): string | null {
    return test.location?.file?.trim()
      || test.file?.trim()
      || test.path?.trim()
      || null;
  }

  private extractStorybookSummary(payload: unknown): UiTestRunSummary | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const totalTests = this.readNumber(record.numTotalTests);
    const passedTests = this.readNumber(record.numPassedTests);
    const failedTests = (this.readNumber(record.numFailedTests) ?? 0) + (this.readNumber(record.numRuntimeErrorTestSuites) ?? 0);
    const skippedTests = (this.readNumber(record.numPendingTests) ?? 0) + (this.readNumber(record.numTodoTests) ?? 0);

    if (totalTests === null || passedTests === null) {
      return null;
    }

    return {
      totalTests,
      passedTests,
      failedTests: failedTests > 0 ? failedTests : Math.max(0, totalTests - passedTests - skippedTests),
      skippedTests,
      files: [],
      executedTestFiles: [],
    };
  }

  private collectStorybookEntries(payload: unknown): StorybookLikeEntry[] {
    if (Array.isArray(payload)) {
      return payload.flatMap((item) => this.collectStorybookEntries(item));
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.status === "string") {
      return [record as StorybookLikeEntry];
    }

    const nested: StorybookLikeEntry[] = [];
    for (const key of ["stories", "results", "tests", "entries"]) {
      if (Array.isArray(record[key])) {
        nested.push(...this.collectStorybookEntries(record[key]));
      }
    }
    return nested;
  }

  private normalizeStorybookStatus(status: string | undefined): "passed" | "failed" | "skipped" {
    const normalized = (status ?? "").toLowerCase();
    if (["passed", "pass", "success"].includes(normalized)) {
      return "passed";
    }
    if (["skipped", "pending", "todo"].includes(normalized)) {
      return "skipped";
    }
    return "failed";
  }

  private readNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
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
