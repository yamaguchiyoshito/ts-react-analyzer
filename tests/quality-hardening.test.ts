import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BrowserAuditAnalyzer,
  ConfigManager,
  ManualQualityInputError,
  ManualQualityInputLoader,
  QualityReportGenerator,
  SecurityArtifactAnalyzer,
  TestArtifactAnalyzer,
  isEvidenceLossRegression,
  selectBlockingRegressionMetrics,
  validateQualityGateMetricIds,
} from "../src/core/index.js";
import type { GraphMetrics, QualityDiffReport, QualityMetricDiffEntry, QualityReport } from "../src/types/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");
const execFileAsync = promisify(execFile);

function createEmptyGraphMetrics(): GraphMetrics {
  return {
    cycles: [],
    totalDependencies: 0,
    externalDependencies: 0,
    stronglyConnectedComponents: [],
    weaklyConnectedComponents: [],
    topPageRank: [],
    topInDegree: [],
    topOutDegree: [],
    largestStronglyConnectedComponentSize: 0,
    warnings: [],
  };
}

async function makeTempProject(prefix: string): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(projectRoot, "reports"), { recursive: true });
  return projectRoot;
}

async function generateQualityReport(
  projectRoot: string,
  onProgress?: (message: string, metadata?: Record<string, unknown>) => void,
): Promise<QualityReport> {
  return new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: [],
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 1,
  }, {
    outputDir: path.join(projectRoot, "out"),
    prefix: "hardening",
    formats: ["json"],
    onProgress,
  });
}

function findMetric(report: QualityReport, metricId: string) {
  for (const category of report.categories) {
    const metric = category.metrics.find((entry) => entry.id === metricId);
    if (metric) {
      return metric;
    }
  }
  return undefined;
}

function diffEntry(overrides: Partial<QualityMetricDiffEntry> & { id: string }): QualityMetricDiffEntry {
  return {
    category: "test",
    categoryLabel: "テスト",
    label: overrides.id,
    status: "changed",
    trend: "regressed",
    changes: [],
    ...overrides,
  };
}

function fakeDiff(metrics: QualityMetricDiffEntry[]): QualityDiffReport {
  return { metrics } as unknown as QualityDiffReport;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failure.code === "number" ? failure.code : -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const lighthousePayload = {
  categories: { performance: { score: 0.95 } },
  audits: {
    "largest-contentful-paint": { numericValue: 1200 },
    interactive: { numericValue: 2000 },
  },
};

// ---- 1. 成果物の誤認 -------------------------------------------------------

test("SecurityArtifactAnalyzer does not treat lighthouse-audit.json or a11y-audit.json as npm audit", async () => {
  const projectRoot = await makeTempProject("hardening-audit-name-");
  try {
    await fs.writeFile(path.join(projectRoot, "reports", "lighthouse-audit.json"), JSON.stringify(lighthousePayload), "utf8");
    await fs.writeFile(path.join(projectRoot, "reports", "a11y-audit.json"), JSON.stringify({ violations: [] }), "utf8");

    const summary = await new SecurityArtifactAnalyzer().analyzeProject(projectRoot);
    assert.equal(summary.tools.length, 0, "no npm-audit tool summary should be produced");
    assert.deepEqual(summary.warnings, [], "files that do not match by name are silently ignored");

    const report = await generateQualityReport(projectRoot);
    const metric = findMetric(report, "dependency_vulnerabilities");
    assert.equal(metric?.verdict, "manual");
    assert.equal(metric?.automation, "manual");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("SecurityArtifactAnalyzer still accepts npm-audit.json / audit-report.json and validates their shape", async () => {
  const projectRoot = await makeTempProject("hardening-audit-shape-");
  try {
    await fs.writeFile(path.join(projectRoot, "reports", "npm-audit.json"), JSON.stringify({
      metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0 } },
    }), "utf8");
    await fs.writeFile(path.join(projectRoot, "reports", "audit-report.json"), JSON.stringify({
      vulnerabilities: { lodash: { severity: "high" } },
    }), "utf8");
    // 名前は audit だが中身が npm audit ではない
    await fs.writeFile(path.join(projectRoot, "audit.json"), JSON.stringify({ score: 100, checks: [] }), "utf8");

    const summary = await new SecurityArtifactAnalyzer().analyzeProject(projectRoot);
    assert.equal(summary.tools.length, 2);
    assert.equal(summary.tools.find((tool) => tool.filePath.endsWith("npm-audit.json"))?.critical, 1);
    assert.equal(summary.tools.find((tool) => tool.filePath.endsWith("audit-report.json"))?.high, 1);
    assert.equal(summary.warnings.length, 1);
    assert.match(summary.warnings[0] ?? "", /audit\.json/u);
    assert.match(summary.warnings[0] ?? "", /npm audit/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("BrowserAuditAnalyzer ignores taxes.json and axe files without a violations array", async () => {
  const projectRoot = await makeTempProject("hardening-axe-name-");
  try {
    // 旧パターン /axe.*\.json$/ なら拾ってしまうファイル
    await fs.writeFile(path.join(projectRoot, "reports", "taxes.json"), JSON.stringify({ violations: [{ impact: "critical", nodes: [{}] }] }), "utf8");
    // 名前は axe だが形式が違う
    await fs.writeFile(path.join(projectRoot, "reports", "axe.json"), JSON.stringify({ summary: "not axe" }), "utf8");

    const ignored = await new BrowserAuditAnalyzer().analyzeProject(projectRoot);
    assert.equal(ignored.axe, null);
    assert.equal(ignored.warnings.length, 1);
    assert.match(ignored.warnings[0] ?? "", /axe\.json/u);

    await fs.writeFile(path.join(projectRoot, "reports", "axe-results.json"), JSON.stringify({ violations: [{ impact: "serious", nodes: [{}, {}] }] }), "utf8");
    const accepted = await new BrowserAuditAnalyzer().analyzeProject(projectRoot);
    assert.equal(accepted.axe?.seriousCount, 2);
    assert.deepEqual(accepted.axe?.files.map((filePath) => path.basename(filePath)), ["axe-results.json"]);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("TestArtifactAnalyzer requires <testsuite> before counting a result XML", async () => {
  const projectRoot = await makeTempProject("hardening-junit-shape-");
  try {
    await fs.mkdir(path.join(projectRoot, "test-results"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "test-results", "lint-results.xml"), "<?xml version=\"1.0\"?><checkstyle><file name=\"a.ts\"><error line=\"1\"/></file></checkstyle>", "utf8");

    const ignored = await new TestArtifactAnalyzer().analyzeProject(projectRoot);
    assert.equal(ignored.junit, null);
    assert.equal(ignored.warnings.length, 1);
    assert.match(ignored.warnings[0] ?? "", /lint-results\.xml/u);

    await fs.writeFile(path.join(projectRoot, "test-results", "junit.xml"), "<testsuite tests=\"3\" failures=\"1\" errors=\"0\" skipped=\"0\"></testsuite>", "utf8");
    const accepted = await new TestArtifactAnalyzer().analyzeProject(projectRoot);
    assert.equal(accepted.junit?.totalTests, 3);
    assert.equal(accepted.junit?.failedTests, 1);
    assert.deepEqual(accepted.junit?.files.map((filePath) => path.basename(filePath)), ["junit.xml"]);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

// ---- 2. 壊れた成果物 JSON --------------------------------------------------

test("SecurityArtifactAnalyzer skips a truncated reports/npm-audit.json without throwing", async () => {
  const projectRoot = await makeTempProject("hardening-audit-truncated-");
  try {
    await fs.writeFile(path.join(projectRoot, "reports", "npm-audit.json"), "{\"metadata\": {\"vulnerabilities\": {\"critical\": 1,", "utf8");

    const summary = await new SecurityArtifactAnalyzer().analyzeProject(projectRoot);
    assert.equal(summary.tools.length, 0);
    assert.equal(summary.warnings.length, 1);
    assert.match(summary.warnings[0] ?? "", /npm-audit\.json/u);
    assert.match(summary.warnings[0] ?? "", /JSON/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("QualityReportGenerator keeps the metric manual and surfaces the warning when an artifact is malformed", async () => {
  const projectRoot = await makeTempProject("hardening-warning-surface-");
  try {
    await fs.writeFile(path.join(projectRoot, "reports", "npm-audit.json"), "{ not json", "utf8");
    await fs.writeFile(path.join(projectRoot, "reports", "lighthouse.json"), "[truncated", "utf8");
    const progress: string[] = [];
    const report = await generateQualityReport(projectRoot, (message) => progress.push(message));

    const vulnerabilities = findMetric(report, "dependency_vulnerabilities");
    assert.equal(vulnerabilities?.verdict, "manual");
    assert.ok(vulnerabilities?.evidence.some((item) => item.label === "取込警告" && item.value.includes("npm-audit.json")));
    assert.match(vulnerabilities?.summary ?? "", /取り込めなかった成果物が 1 件/u);

    const lighthouse = findMetric(report, "lighthouse_performance");
    assert.equal(lighthouse?.verdict, "manual");
    assert.ok(lighthouse?.evidence.some((item) => item.label === "取込警告" && item.value.includes("lighthouse.json")));

    assert.ok(progress.some((message) => message === "Quality phase: security artifacts warning"));
    assert.ok(progress.some((message) => message === "Quality phase: browser audits warning"));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("ManualQualityInputLoader raises a clear error for malformed JSON", async () => {
  const projectRoot = await makeTempProject("hardening-manual-input-");
  try {
    const inputPath = path.join(projectRoot, "quality.manual.json");
    await fs.writeFile(inputPath, "{ \"metrics\": [ { \"id\": \"csrf_protection\", }", "utf8");

    await assert.rejects(
      () => new ManualQualityInputLoader().load(inputPath),
      (error: unknown) => {
        assert.ok(error instanceof ManualQualityInputError);
        assert.match(error.message, /JSON として解釈できません/u);
        assert.ok(error.message.includes(inputPath));
        return true;
      },
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

// ---- 3. フェーズ失敗で全体が落ちない ---------------------------------------

test("QualityReportGenerator keeps generating when one phase throws and marks its metrics as 収集失敗", async () => {
  const projectRoot = await makeTempProject("hardening-phase-failure-");
  const original = SecurityArtifactAnalyzer.prototype.analyzeProject;
  SecurityArtifactAnalyzer.prototype.analyzeProject = async () => {
    throw new Error("EACCES: permission denied, scandir reports");
  };
  try {
    const progress: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const report = await generateQualityReport(projectRoot, (message, metadata) => progress.push({ message, metadata }));

    const vulnerabilities = findMetric(report, "dependency_vulnerabilities");
    assert.equal(vulnerabilities?.verdict, "manual");
    assert.equal(vulnerabilities?.automation, "manual");
    assert.equal(vulnerabilities?.actual, "収集失敗");
    assert.match(vulnerabilities?.summary ?? "", /^収集失敗: EACCES/u);

    // 他のフェーズの指標はそのまま出る
    assert.equal(findMetric(report, "dangerous_html")?.verdict, "pass");
    assert.equal(findMetric(report, "secret_indicators")?.verdict, "pass");
    assert.equal(report.categories.length, 12);
    assert.ok(report.categories.every((category) => category.metrics.length > 0));

    const failed = progress.find((entry) => entry.message === "Quality phase: security artifacts failed");
    assert.ok(failed, "failure must be reported via onProgress");
    assert.match(String(failed?.metadata?.error), /EACCES/u);
    assert.ok(await fs.stat(path.join(projectRoot, "out", "hardening_quality_report.json")));
  } finally {
    SecurityArtifactAnalyzer.prototype.analyzeProject = original;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

// ---- 4. 証跡喪失を gate が見る ---------------------------------------------

test("selectBlockingRegressionMetrics treats automatic -> manual (evidence loss) as blocking", () => {
  const evidenceLoss = diffEntry({
    id: "coverage_rate",
    baselineVerdict: "pass",
    currentVerdict: "manual",
    baselineAutomation: "automatic",
    currentAutomation: "manual",
  });
  const verdictRegression = diffEntry({
    id: "typescript_errors",
    category: "code",
    baselineVerdict: "pass",
    currentVerdict: "warn",
    baselineAutomation: "automatic",
    currentAutomation: "automatic",
  });
  const manualToManual = diffEntry({
    id: "csrf_protection",
    category: "security",
    baselineVerdict: "pass",
    currentVerdict: "manual",
    baselineAutomation: "manual",
    currentAutomation: "manual",
  });
  const sameVerdictNumeric = diffEntry({
    id: "hardcoded_jsx_text",
    category: "i18n",
    baselineVerdict: "fail",
    currentVerdict: "fail",
    baselineAutomation: "automatic",
    currentAutomation: "automatic",
  });
  const derived = diffEntry({
    id: "route_test_file_presence",
    currentAggregation: "derived",
    baselineVerdict: "pass",
    currentVerdict: "manual",
    baselineAutomation: "automatic",
    currentAutomation: "manual",
  });
  const diff = fakeDiff([evidenceLoss, verdictRegression, manualToManual, sameVerdictNumeric, derived]);

  assert.equal(isEvidenceLossRegression(evidenceLoss), true);
  assert.equal(isEvidenceLossRegression(manualToManual), false);

  const blocking = selectBlockingRegressionMetrics(diff, { qualityGateBlockingMetricIds: [], qualityGateMonitoringMetricIds: [] });
  assert.deepEqual(blocking.map((metric) => metric.id), ["coverage_rate", "typescript_errors"]);

  const monitored = selectBlockingRegressionMetrics(diff, { qualityGateBlockingMetricIds: [], qualityGateMonitoringMetricIds: ["coverage_rate"] });
  assert.deepEqual(monitored.map((metric) => metric.id), ["typescript_errors"]);

  const onlyCoverage = selectBlockingRegressionMetrics(diff, { qualityGateBlockingMetricIds: ["coverage_rate"], qualityGateMonitoringMetricIds: [] });
  assert.deepEqual(onlyCoverage.map((metric) => metric.id), ["coverage_rate"]);
});

test("QualityReportGenerator phase failure shows up as an evidence-loss regression against a healthy baseline", async () => {
  const projectRoot = await makeTempProject("hardening-evidence-loss-");
  try {
    await fs.writeFile(path.join(projectRoot, "reports", "npm-audit.json"), JSON.stringify({
      metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 } },
    }), "utf8");
    const baseline = await generateQualityReport(projectRoot);
    assert.equal(findMetric(baseline, "dependency_vulnerabilities")?.verdict, "pass");

    // 今回は成果物が壊れている
    await fs.writeFile(path.join(projectRoot, "reports", "npm-audit.json"), "{", "utf8");
    const current = await generateQualityReport(projectRoot);
    const { QualityDiffGenerator } = await import("../src/core/index.js");
    const diff = new QualityDiffGenerator().compare(current, baseline, "baseline.json", "current.json");
    const blocking = selectBlockingRegressionMetrics(diff, { qualityGateBlockingMetricIds: [], qualityGateMonitoringMetricIds: [] });
    assert.ok(blocking.some((metric) => metric.id === "dependency_vulnerabilities"), "evidence loss must block the gate");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

// ---- 5. 設定値の検証 -------------------------------------------------------

test("ConfigManager rejects non-numeric and negative numeric options with a clear message", () => {
  const configManager = new ConfigManager();

  assert.throws(() => configManager.loadFromCLI({ impactScoreThreshold: "abc" }), /--impact-threshold[\s\S]*"abc"/u);
  assert.throws(() => configManager.loadFromCLI({ impactScoreThreshold: "-1" }), /--impact-threshold/u);
  assert.throws(() => configManager.loadFromCLI({ complexityThreshold: "12abc" }), /--complexity-threshold/u);
  assert.throws(() => configManager.loadFromCLI({ maxFileSize: "1.5" }), /--max-file-size/u);
  assert.throws(() => configManager.loadFromCLI({ maxTypeCheckRootNames: "" }), /--max-typecheck-root-names/u);
  assert.throws(() => configManager.loadFromEnvironment({ ANALYZER_IMPACT_SCORE_THRESHOLD: "NaN" }), /ANALYZER_IMPACT_SCORE_THRESHOLD/u);
  assert.throws(() => configManager.loadFromEnvironment({ ANALYZER_COMPLEXITY_THRESHOLD: "x" }), /ANALYZER_COMPLEXITY_THRESHOLD/u);

  assert.equal(configManager.loadFromCLI({ impactScoreThreshold: "60" }).impactScoreThreshold, 60);
  assert.equal(configManager.loadFromCLI({ impactScoreThreshold: " 0 " }).impactScoreThreshold, 0);
  assert.equal(configManager.loadFromEnvironment({ ANALYZER_MAX_FILE_SIZE: "1024" }).maxFileSizeBytes, 1024);
});

test("ConfigManager rejects unknown output formats, analysis scopes and quality profiles", () => {
  const configManager = new ConfigManager();

  assert.throws(() => configManager.loadFromCLI({ format: "json,xlsx" }), /--format[\s\S]*"xlsx"[\s\S]*csv, markdown, json, html, all/u);
  assert.throws(() => configManager.loadFromEnvironment({ ANALYZER_FORMATS: "pdf" }), /ANALYZER_FORMATS/u);
  assert.throws(() => configManager.loadFromCLI({ analysisScope: "sources" }), /--analysis-scope[\s\S]*all, source-only/u);
  assert.throws(() => configManager.loadFromCLI({ qualityProfile: "lib" }), /--quality-profile[\s\S]*application, library-repo/u);
  assert.throws(() => configManager.loadFromEnvironment({ ANALYZER_ANALYSIS_SCOPE: "everything" }), /ANALYZER_ANALYSIS_SCOPE/u);

  assert.deepEqual(configManager.loadFromCLI({ format: "json, html" }).outputFormats, ["json", "html"]);
  assert.equal(configManager.loadFromCLI({ analysisScope: "source-only" }).analysisScope, "source-only");
});

test("ConfigManager warns about unknown keys in analyzer.config.json and rejects invalid values", async () => {
  const projectRoot = await makeTempProject("hardening-config-file-");
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const configManager = new ConfigManager();
    const configPath = path.join(projectRoot, "analyzer.config.json");

    await fs.writeFile(configPath, JSON.stringify({
      outputDir: "./reports",
      excludePattern: ["legacy"],
      qualityGate: { blocking: [] },
    }), "utf8");
    const loaded = configManager.loadFromFile(configPath);
    assert.equal(loaded.outputDir, "./reports");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /excludePattern/u);
    assert.match(warnings[0] ?? "", /qualityGate/u);
    assert.ok(warnings[0]?.includes(configPath));

    await fs.writeFile(configPath, JSON.stringify({ outputFormats: ["json", "docx"] }), "utf8");
    assert.throws(() => configManager.loadFromFile(configPath), /outputFormats[\s\S]*"docx"/u);

    await fs.writeFile(configPath, JSON.stringify({ impactScoreThreshold: "60" }), "utf8");
    assert.throws(() => configManager.loadFromFile(configPath), /impactScoreThreshold/u);

    await fs.writeFile(configPath, JSON.stringify({ analysisScope: "partial" }), "utf8");
    assert.throws(() => configManager.loadFromFile(configPath), /analysisScope[\s\S]*all, source-only/u);

    await fs.writeFile(configPath, "{ \"outputDir\": ", "utf8");
    assert.throws(() => configManager.loadFromFile(configPath), /JSON として解釈できません/u);
  } finally {
    console.warn = originalWarn;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLI exits 1 with a Japanese error for --impact-threshold abc instead of silently passing", async () => {
  const projectRoot = await makeTempProject("hardening-cli-threshold-");
  try {
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const answer = 42;\n", "utf8");

    const result = await runCli([
      "analyze", projectRoot,
      "--impact-threshold", "abc",
      "--fail-on-impact",
      "--output", path.join(projectRoot, "out"),
      "--cache-dir", path.join(projectRoot, ".cache"),
      "--log-file", path.join(projectRoot, "analysis.log"),
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /エラー: --impact-threshold/u);
    assert.match(result.stderr, /"abc"/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

// ---- 6. 未知の指標 ID ------------------------------------------------------

test("validateQualityGateMetricIds reports unknown ids and an all-unknown blocking list", () => {
  const report = {
    categories: [
      { metrics: [{ id: "coverage_rate" }, { id: "typescript_errors" }] },
      { metrics: [{ id: "documentation_presence" }] },
    ],
  } as unknown as QualityReport;

  const partiallyUnknown = validateQualityGateMetricIds(report, {
    qualityGateBlockingMetricIds: ["coverage_rate", "coverage_rat"],
    qualityGateMonitoringMetricIds: ["documentation_presence", "docs_presence"],
  });
  assert.deepEqual(partiallyUnknown.unknownBlockingMetricIds, ["coverage_rat"]);
  assert.deepEqual(partiallyUnknown.unknownMonitoringMetricIds, ["docs_presence"]);
  assert.equal(partiallyUnknown.blockingAllUnknown, false);

  const allUnknown = validateQualityGateMetricIds(report, {
    qualityGateBlockingMetricIds: ["secret_indicator"],
    qualityGateMonitoringMetricIds: [],
  });
  assert.deepEqual(allUnknown.unknownBlockingMetricIds, ["secret_indicator"]);
  assert.equal(allUnknown.blockingAllUnknown, true);

  const nothingConfigured = validateQualityGateMetricIds(report, { qualityGateBlockingMetricIds: [], qualityGateMonitoringMetricIds: [] });
  assert.equal(nothingConfigured.blockingAllUnknown, false);
});

test("CLI quality gate fails with exit 1 when every blocking metric id is unknown, and reports a malformed manual input", async () => {
  const projectRoot = await makeTempProject("hardening-cli-gate-ids-");
  try {
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const answer = 42;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
      include: ["src"],
    }), "utf8");
    const commonArgs = [
      "--output", path.join(projectRoot, "out"),
      "--cache-dir", path.join(projectRoot, ".cache"),
      "--log-file", path.join(projectRoot, "analysis.log"),
      "--format", "json",
    ];

    const unknownIds = await runCli([
      "quality", "gate", projectRoot,
      "--quality-gate-blocking-metrics", "secret_indicator,coverage_rat",
      ...commonArgs,
    ]);
    assert.equal(unknownIds.code, 1);
    assert.match(unknownIds.stderr, /警告: 未知の指標 ID/u);
    assert.match(unknownIds.stderr, /エラー: --quality-gate-blocking-metrics に指定した指標 ID がすべて未知です/u);

    // 一部が実在すれば gate は続行する (悪化なし・FAIL なしなので PASS)
    const partiallyKnown = await runCli([
      "quality", "gate", projectRoot,
      "--quality-gate-blocking-metrics", "secret_indicators,coverage_rat",
      ...commonArgs,
    ]);
    assert.equal(partiallyKnown.code, 0, partiallyKnown.stderr);
    assert.match(partiallyKnown.stderr, /警告: 未知の指標 ID[\s\S]*coverage_rat/u);

    // 壊れた quality.manual.json は握りつぶさず、パス付きで利用者に知らせて exit 1
    await fs.writeFile(path.join(projectRoot, "quality.manual.json"), "{ \"metrics\": [", "utf8");
    const malformedManual = await runCli(["quality", "collect", projectRoot, ...commonArgs]);
    assert.equal(malformedManual.code, 1);
    assert.match(malformedManual.stderr, /エラー: 手動品質入力ファイルを JSON として解釈できません/u);
    assert.ok(malformedManual.stderr.includes(path.join(projectRoot, "quality.manual.json")));
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
