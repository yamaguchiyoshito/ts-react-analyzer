import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

import { ComplexityAnalyzer, DiffGenerator, ReportGenerator } from "../src/core/index.js";
import type { AnalysisDiffReport, AnalysisResult, GraphMetrics, PersistedAnalysisReport } from "../src/types/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sampleProject = path.join(workspaceRoot, "tests", "fixtures", "sample-app");
const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");
const execFileAsync = promisify(execFile);

async function sha256Of(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFileAsync("node", [cliPath, ...args])
    .then((result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }))
    .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof error.code === "number" ? error.code : -1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
}

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

function createFunctionMetric(name: string, startLine: number): AnalysisResult["complexity"]["functions"][number] {
  return {
    name,
    cyclomaticComplexity: 1,
    startLine,
    endLine: startLine + 2,
    lineCount: 3,
    branchCount: 0,
    loopCount: 0,
    ternaryCount: 0,
    logicalOpCount: 0,
    maxNestingDepth: 0,
    isAsync: false,
    params: [],
    riskLevel: "low",
  };
}

function createAnalysisResult(
  filePath: string,
  options: { functionNames: string[]; codeLines: number; overallComplexity: number },
): AnalysisResult {
  return {
    filePath,
    complexity: {
      filePath,
      totalLines: options.codeLines + 2,
      codeLines: options.codeLines,
      commentLines: 1,
      functions: options.functionNames.map((name, index) => createFunctionMetric(name, index * 3 + 1)),
      components: [],
      hooks: [],
      typeMetrics: {
        anyTypeCount: 0,
        unknownTypeCount: 0,
        assertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 0,
        uncheckedPatterns: [],
      },
      scoreBreakdown: {
        averageFunctionComplexity: 0,
        peakFunctionComplexity: 0,
        topFunctionAverage: 0,
        averageRenderComplexity: 0,
        peakRenderComplexity: 0,
        hookPressure: 0,
        peakNestingDepth: 0,
        elevatedFunctionCount: 0,
        weightedScore: options.overallComplexity,
      },
      overallComplexity: options.overallComplexity,
    },
    dependencies: [],
    dependencyErrors: [],
  };
}

async function buildPersistedReport(
  projectRoot: string,
  prefix: string,
  results: AnalysisResult[],
): Promise<PersistedAnalysisReport> {
  return new ReportGenerator().generateReports(results, createEmptyGraphMetrics(), {
    outputDir: path.join(projectRoot, "out", prefix),
    prefix,
    formats: ["json"],
    complexityThreshold: 10,
    projectRoot,
  });
}

test("CLI diff keeps the baseline intact and reports the same change on repeated runs", async () => {
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-diff-baseline-keep-"));
  try {
    const outputDir = path.join(tempProject, "reports");
    const cacheDir = path.join(tempProject, ".cache");
    await fs.cp(sampleProject, tempProject, { recursive: true });

    const analyzeResult = await runCli([
      "analyze", tempProject,
      "--output", outputDir, "--prefix", "analysis", "--cache-dir", cacheDir, "--format", "json",
    ]);
    assert.equal(analyzeResult.code, 0, analyzeResult.stderr);

    const baselinePath = path.join(outputDir, "analysis_report.json");
    const baselineHash = await sha256Of(baselinePath);

    // helper.ts に関数を 1 つ丸ごと追加する (複雑度は変わらず、関数数と行数だけが増える)
    const helperPath = path.join(tempProject, "src", "utils", "helper.ts");
    await fs.appendFile(helperPath, "\nexport function addedHelper(value: number) {\n  return value * 3;\n}\n", "utf8");

    const diffArgs = [
      "diff", tempProject,
      "--output", outputDir, "--prefix", "analysis", "--cache-dir", cacheDir, "--format", "json",
      "--baseline", baselinePath,
    ];

    for (const attempt of [1, 2]) {
      const diffResult = await runCli(diffArgs);
      assert.equal(diffResult.code, 0, `attempt ${attempt}: ${diffResult.stderr}`);

      const diffReport = JSON.parse(await fs.readFile(path.join(outputDir, "analysis_diff.json"), "utf8")) as AnalysisDiffReport;
      const helperEntry = diffReport.files.find((file) => file.path === "src/utils/helper.ts");
      assert.equal(helperEntry?.status, "changed", `attempt ${attempt}: helper.ts should be reported as changed`);
      assert.equal(helperEntry?.functionCountDelta, 1, `attempt ${attempt}: one function was added`);
      assert.ok((helperEntry?.codeLinesDelta ?? 0) > 0, `attempt ${attempt}: code lines should increase`);
      assert.ok(diffReport.summary.changedFiles >= 1, `attempt ${attempt}: summary should count the change`);
      assert.equal(diffReport.currentPath, path.join(outputDir, "analysis_current_report.json"));

      // baseline は 2 回実行しても同一内容のまま
      assert.equal(await sha256Of(baselinePath), baselineHash, `attempt ${attempt}: baseline must not be overwritten`);
      assert.match(diffResult.stdout, /analysis_current_report\.json/u);
      assert.match(diffResult.stdout, /baseline .* は上書きされません/u);
    }

    const outputFiles = await fs.readdir(outputDir);
    assert.ok(outputFiles.includes("analysis_current_report.json"));
    assert.ok(outputFiles.includes("analysis_diff.json"));
    assert.ok(outputFiles.includes("analysis_diff.md"));
    assert.ok(outputFiles.includes("analysis_diff.html"));
    // 旧挙動のように現在レポートを baseline 名で書いていないこと
    const currentReport = JSON.parse(await fs.readFile(path.join(outputDir, "analysis_current_report.json"), "utf8")) as PersistedAnalysisReport;
    const baselineReport = JSON.parse(await fs.readFile(baselinePath, "utf8")) as PersistedAnalysisReport;
    const currentHelper = currentReport.files.find((file) => file.path === "src/utils/helper.ts");
    const baselineHelper = baselineReport.files.find((file) => file.path === "src/utils/helper.ts");
    assert.equal((currentHelper?.complexity.functions.length ?? 0) - (baselineHelper?.complexity.functions.length ?? 0), 1);

    // diff 自身の出力ファイルを baseline に指定した場合は上書き前に止まる
    const selfBaselineResult = await runCli([
      "diff", tempProject,
      "--output", outputDir, "--prefix", "analysis", "--cache-dir", cacheDir, "--format", "json",
      "--baseline", path.join(outputDir, "analysis_current_report.json"),
    ]);
    assert.equal(selfBaselineResult.code, 1);
    assert.match(selfBaselineResult.stderr, /baseline が diff の出力ファイルと同じパスです/u);
  } finally {
    await fs.rm(tempProject, { recursive: true, force: true });
  }
});

test("DiffGenerator marks a file as changed when only a function was added", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-diff-function-count-"));
  try {
    const filePath = path.join(projectRoot, "src", "utils", "helper.ts");
    const baseline = await buildPersistedReport(projectRoot, "baseline", [
      createAnalysisResult(filePath, { functionNames: ["helper"], codeLines: 6, overallComplexity: 3 }),
    ]);
    const current = await buildPersistedReport(projectRoot, "current", [
      createAnalysisResult(filePath, { functionNames: ["helper", "addedHelper"], codeLines: 9, overallComplexity: 3 }),
    ]);

    const diff = new DiffGenerator().compare(current, baseline, "baseline.json", "current.json", { projectRoot });
    const entry = diff.files.find((file) => file.path === "src/utils/helper.ts");

    assert.equal(entry?.status, "changed");
    assert.equal(entry?.complexityDelta, 0);
    assert.equal(entry?.dependencyDelta, 0);
    assert.equal(entry?.functionCountDelta, 1);
    assert.equal(entry?.codeLinesDelta, 3);
    assert.equal(diff.summary.changedFiles, 1);
    assert.equal(diff.summary.unchangedFiles, 0);

    // まったく同じ内容なら unchanged のまま
    const same = new DiffGenerator().compare(baseline, baseline, "baseline.json", "baseline.json", { projectRoot });
    assert.equal(same.files[0]?.status, "unchanged");
    assert.equal(same.files[0]?.functionCountDelta, 0);
    assert.equal(same.files[0]?.codeLinesDelta, 0);

    // Markdown / HTML の変更ファイル表に新しい列が出る
    const outputDir = path.join(projectRoot, "out", "diff");
    await new DiffGenerator().writeReports(diff, outputDir, "delta", { projectRoot });
    const markdown = await fs.readFile(path.join(outputDir, "delta_diff.md"), "utf8");
    const html = await fs.readFile(path.join(outputDir, "delta_diff.html"), "utf8");
    assert.match(markdown, /\| ファイル \| 状態 \| 複雑度Δ \| 依存Δ \| 関数数Δ \| 行数Δ \| 警告差分 \|/u);
    assert.match(markdown, /\| src\/utils\/helper\.ts \| 変更 \| 0 \| 0 \| \+1 \| \+3 \| — \|/u);
    assert.match(html, /<th>Function Delta<\/th><th>Code Lines Delta<\/th>/u);
    assert.match(html, /<td>changed<\/td><td>0<\/td><td>0<\/td><td>1<\/td><td>3<\/td>/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("DiffGenerator HTML escapes hostile file names in both server-rendered and client-rendered markup", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-diff-xss-"));
  try {
    const hostileName = "<img src=x onerror=alert(1)>.ts";
    const hostilePath = path.join(projectRoot, "src", hostileName);
    const safePath = path.join(projectRoot, "src", "safe.ts");

    const baseline = await buildPersistedReport(projectRoot, "baseline", [
      createAnalysisResult(safePath, { functionNames: ["safe"], codeLines: 4, overallComplexity: 1 }),
    ]);
    // 悪意あるファイル名は current 側にだけ存在し、changed files / impact の JSON にも載る
    const current = await buildPersistedReport(projectRoot, "current", [
      createAnalysisResult(safePath, { functionNames: ["safe"], codeLines: 4, overallComplexity: 1 }),
      createAnalysisResult(hostilePath, { functionNames: ["evil"], codeLines: 4, overallComplexity: 9 }),
    ]);

    const diff = new DiffGenerator().compare(current, baseline, "baseline.json", "current.json", { projectRoot });
    assert.ok(diff.impact.changedFiles.some((file) => file.includes("onerror")), "hostile file should be part of the changed set");

    const outputDir = path.join(projectRoot, "out", "diff");
    await new DiffGenerator().writeReports(diff, outputDir, "xss", { projectRoot });
    const html = await fs.readFile(path.join(outputDir, "xss_diff.html"), "utf8");

    // 生の <img ...> がページ内のどこにも現れない (テーブル・属性・JSON blob すべて)
    assert.doesNotMatch(html, /<img src=x onerror/u);
    // サーバ側描画はエスケープ済み、JSON blob は < で < を潰している
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.ts/u);
    assert.match(html, /\\u003cimg src=x onerror=alert\(1\)>\.ts/u);
    // クライアント側スクリプトは esc() を通してから innerHTML に流し込む
    assert.match(html, /function esc\(value\)/u);
    assert.match(html, /esc\(toHref\(item\.path\)\)/u);
    assert.match(html, /esc\(item\.path\)/u);
    assert.match(html, /data-focus-root=\\"" \+ esc\(item\.root\)/u);
    assert.match(html, /esc\(item\.reasons\.join\(", "\)\)/u);
    // changed / impacted の集合も同じシリアライザ経由で埋め込まれる (生の JSON.stringify ではない)
    const changedLine = html.split("\n").find((line) => line.includes("const changed = new Set("));
    assert.ok(changedLine, "changed set should be embedded");
    assert.doesNotMatch(changedLine!, /<img/u);
    assert.match(changedLine!, /\\u003cimg/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("ComplexityAnalyzer counts the body expression of expression-bodied arrow functions", () => {
  const source = `
    export const pick = (a: number) => a > 1 ? 1 : 2;
    export const both = (a: boolean, b: boolean) => a && b;
    export const pickBlock = (a: number) => { return a > 1 ? 1 : 2; };
    export const outer = (a: boolean) => (b: boolean) => a && b;
  `;
  const sourceFile = ts.createSourceFile("arrows.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const metrics = new ComplexityAnalyzer().analyzeFile(sourceFile, "/virtual/arrows.ts");

  const pick = metrics.functions.find((fn) => fn.name === "pick");
  const both = metrics.functions.find((fn) => fn.name === "both");
  const pickBlock = metrics.functions.find((fn) => fn.name === "pickBlock");
  const outer = metrics.functions.find((fn) => fn.name === "outer");
  const inner = metrics.functions.filter((fn) => fn.startLine === outer?.startLine && fn !== outer);

  // 式本体の三項演算子はブロック本体と同じく cc=2 / ternaryCount=1 になる
  assert.equal(pick?.cyclomaticComplexity, 2);
  assert.equal(pick?.ternaryCount, 1);
  assert.equal(pick?.branchCount, 1);
  assert.equal(pickBlock?.cyclomaticComplexity, 2);
  assert.equal(pickBlock?.ternaryCount, 1);

  // 式本体の論理演算子も数える
  assert.equal(both?.logicalOpCount, 1);
  assert.equal(both?.cyclomaticComplexity, 2);

  // ネストした関数の境界は保たれる: outer は inner の && を計上しない
  assert.equal(outer?.logicalOpCount, 0);
  assert.equal(outer?.cyclomaticComplexity, 1);
  assert.equal(inner.length, 1);
  assert.equal(inner[0]?.logicalOpCount, 1);
  assert.equal(inner[0]?.cyclomaticComplexity, 2);
});
