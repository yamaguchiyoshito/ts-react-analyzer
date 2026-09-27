import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  QualityReportGenerator,
  REPORT_SCHEMA_VERSION,
  buildTestPathConventionKeys,
  collectTestTargetKeys,
  csvCell,
  escapeHtml,
  escapeMarkdownCell,
  hasMatchingTestFile,
  toCsvRow,
  toDisplayPath,
  verdictBadge,
} from "../src/core/index.js";
import type { GraphMetrics, PersistedAnalysisReport, QualityReport } from "../src/types/index.js";

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

/** Markdown 表の 1 行をセルに分割する。`\|` はセル内のエスケープ済みパイプとして扱う */
function splitMarkdownRow(row: string): string[] {
  const cells = row.split(/(?<!\\)\|/u);
  return cells.slice(1, -1).map((cell) => cell.trim());
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("node", [cliPath, ...args]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("escapeHtml escapes every HTML-significant character including quotes", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml("plain text"), "plain text");
});

test("escapeMarkdownCell escapes pipes and flattens newlines but leaves plain values untouched", () => {
  assert.equal(escapeMarkdownCell("a|b"), "a\\|b");
  assert.equal(escapeMarkdownCell("first\nsecond\r\nthird\rfourth"), "first second third fourth");
  assert.equal(escapeMarkdownCell("src/App.tsx"), "src/App.tsx");
  assert.equal(escapeMarkdownCell("already \\| escaped"), "already \\\\| escaped");
});

test("csvCell and toCsvRow follow RFC 4180 quoting", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("has,comma"), "\"has,comma\"");
  assert.equal(csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
  assert.equal(csvCell("multi\nline"), "\"multi\nline\"");
  assert.equal(csvCell("carriage\rreturn"), "\"carriage\rreturn\"");
  assert.equal(csvCell("plain", { alwaysQuote: true }), "\"plain\"");
  assert.equal(toCsvRow(["a", "b,c", "d\"e"]), "a,\"b,c\",\"d\"\"e\"");
  assert.equal(toCsvRow(["a", "b"], { alwaysQuote: true }), "\"a\",\"b\"");
});

test("toDisplayPath relativizes paths under the project root and leaves others unchanged", () => {
  const root = path.resolve(os.tmpdir(), "report-utils-root");
  assert.equal(toDisplayPath(path.join(root, "src", "App.tsx"), root), "src/App.tsx");
  assert.equal(toDisplayPath(path.join(root, "src", "App.tsx")), path.join(root, "src", "App.tsx").split(path.sep).join("/"));
  assert.equal(toDisplayPath("/elsewhere/lib/util.ts", root), "/elsewhere/lib/util.ts");
  assert.equal(toDisplayPath("src/relative.ts", root), "src/relative.ts");
  assert.equal(toDisplayPath(root, root), root.split(path.sep).join("/"));
});

test("verdictBadge renders symbol plus label and falls back for missing verdicts", () => {
  assert.equal(verdictBadge("pass"), "○ PASS");
  assert.equal(verdictBadge("warn"), "△ WARN");
  assert.equal(verdictBadge("fail"), "× FAIL");
  assert.equal(verdictBadge("partial"), "◐ PARTIAL");
  assert.equal(verdictBadge("manual"), "― MANUAL");
  assert.equal(verdictBadge("not_applicable"), "N/A");
  assert.equal(verdictBadge(undefined), "なし");
});

test("shared test-file matcher links sources to tests across naming conventions", () => {
  const root = path.resolve(os.tmpdir(), "report-utils-matcher");
  const testFiles = [
    path.join(root, "src", "components", "Button.test.tsx"),
    path.join(root, "tests", "features", "OrderPage.spec.tsx"),
    path.join(root, "e2e", "checkout.spec.ts"),
  ];
  const targets = collectTestTargetKeys(testFiles, root);

  assert.deepEqual(buildTestPathConventionKeys(testFiles[0]!, root), ["src/components/button", "components/button"]);
  assert.ok(hasMatchingTestFile(path.join(root, "src", "components", "Button.tsx"), targets, root));
  assert.ok(hasMatchingTestFile(path.join(root, "src", "features", "OrderPage.tsx"), targets, root));
  assert.ok(hasMatchingTestFile(path.join(root, "src", "checkout.ts"), targets, root));
  assert.equal(hasMatchingTestFile(path.join(root, "src", "utils", "format.ts"), targets, root), false);
});

test("analyze report keeps markdown table columns intact for a file path containing a pipe and stamps schemaVersion", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-utils-pipe-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", strict: true, noEmit: true },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "Weird|Name.tsx"), [
    "export const WeirdName = ({ flag }: { flag: boolean }) => {",
    "  const value: any = flag ? 1 : 2;",
    "  return <main>{value}</main>;",
    "};",
  ].join("\n"), "utf8");

  const analyze = await runCli(["analyze", projectRoot, "--output", outputDir, "--prefix", "pipe", "--format", "json,markdown"]);
  assert.equal(analyze.code, 0, analyze.stderr);

  const markdown = await fs.readFile(path.join(outputDir, "pipe_report.md"), "utf8");
  const lines = markdown.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith("| 順位 | ファイル | severity |"));
  assert.ok(headerIndex >= 0, "hot spot table header should be rendered");
  const row = lines.slice(headerIndex + 2).find((line) => line.startsWith("| 1 |"));
  assert.ok(row, "hot spot table should list the analyzed file");
  assert.match(row!, /src\/Weird\\\|Name\.tsx/u);
  assert.equal(splitMarkdownRow(row!).length, splitMarkdownRow(lines[headerIndex]!).length);
  assert.equal(splitMarkdownRow(row!)[1], "src/Weird\\|Name.tsx");

  const report = JSON.parse(await fs.readFile(path.join(outputDir, "pipe_report.json"), "utf8")) as PersistedAnalysisReport;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.ok(report.files.some((file) => file.path === "src/Weird|Name.tsx"));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("quality report JSON carries schemaVersion 1", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-utils-quality-schema-"));
  const outputDir = path.join(projectRoot, "out");

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: [],
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 1,
  }, {
    outputDir,
    prefix: "schema",
    formats: ["json"],
  });

  assert.equal(report.schemaVersion, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(outputDir, "schema_quality_report.json"), "utf8")) as QualityReport;
  assert.equal(persisted.schemaVersion, 1);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("diff rejects a quality report passed as --baseline with a user-facing error instead of a TypeError", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-utils-baseline-kind-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  const qualityBaseline = path.join(projectRoot, "quality_report.json");
  await fs.writeFile(qualityBaseline, JSON.stringify({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    executionTimeMs: 1,
    projectRoot,
    summary: { totalMetrics: 0, derivedMetricCount: 0, passCount: 0, partialCount: 0, partialCategoryCount: 0, warnCount: 0, failCount: 0, manualCount: 0, notApplicableCount: 0, overallVerdict: "not_applicable" },
    categories: [],
  }, null, 2), "utf8");

  const result = await runCli(["diff", projectRoot, "--baseline", qualityBaseline, "--output", outputDir, "--format", "json"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /baseline は analyze が出力した \*_report\.json ではありません/u);
  assert.match(result.stderr, /quality collect が出力した \*_quality_report\.json のようです/u);
  assert.doesNotMatch(result.stderr, /TypeError/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("quality gate rejects an analyze report passed as --baseline", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-utils-quality-baseline-kind-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
  const analysisBaseline = path.join(projectRoot, "analysis_report.json");
  await fs.writeFile(analysisBaseline, JSON.stringify({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    executionTimeMs: 1,
    statistics: { fileCount: 0, totalLines: 0, functionCount: 0, componentCount: 0, averageComplexity: 0 },
    files: [],
    graph: createEmptyGraphMetrics(),
  }, null, 2), "utf8");

  const result = await runCli(["quality", "gate", projectRoot, "--baseline", analysisBaseline, "--output", outputDir, "--format", "json"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /baseline は quality collect が出力した \*_quality_report\.json ではありません/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("baseline schemaVersion newer than the tool is rejected while a missing schemaVersion is accepted", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "report-utils-schema-version-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");

  const baselineShape = {
    timestamp: new Date().toISOString(),
    executionTimeMs: 1,
    statistics: { fileCount: 0, totalLines: 0, functionCount: 0, componentCount: 0, averageComplexity: 0 },
    files: [],
    graph: createEmptyGraphMetrics(),
  };
  const futureBaseline = path.join(projectRoot, "future_report.json");
  await fs.writeFile(futureBaseline, JSON.stringify({ ...baselineShape, schemaVersion: REPORT_SCHEMA_VERSION + 1 }), "utf8");
  const future = await runCli(["diff", projectRoot, "--baseline", futureBaseline, "--output", outputDir, "--format", "json"]);
  assert.equal(future.code, 1);
  assert.match(future.stderr, /スキーマ版 2 はこのツールが扱える版 1 より新しいため読み込めません/u);
  assert.match(future.stderr, /更新してください/u);

  const legacyBaseline = path.join(projectRoot, "legacy_report.json");
  await fs.writeFile(legacyBaseline, JSON.stringify(baselineShape), "utf8");
  const legacy = await runCli(["diff", projectRoot, "--baseline", legacyBaseline, "--output", outputDir, "--format", "json"]);
  assert.notEqual(legacy.code, 1, legacy.stderr);
  assert.doesNotMatch(legacy.stderr, /ではありません|読み込めません/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});
