import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ComplexityAnalyzer, ConfigManager, DependencyAnalyzer, FileScanner, GraphBuilder, QualityDiffGenerator, QualityReportGenerator, ReportGenerator } from "../src/core/index.js";
import type { AnalysisResult, Dependency, GraphMetrics, QualityDiffReport, QualityReport } from "../src/types/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sampleProject = path.join(workspaceRoot, "tests", "fixtures", "sample-app");
const cycleProject = path.join(workspaceRoot, "tests", "fixtures", "cycle-app");
const execFileAsync = promisify(execFile);

function buildGraphMetrics(graph: GraphBuilder, results: Array<{ dependencies: Array<{ isExternal: boolean }> }>) {
  const graphJson = graph.exportToJSON();
  return {
    cycles: graph.detectCycles(),
    totalDependencies: results.reduce((sum, result) => sum + result.dependencies.length, 0),
    externalDependencies: results.reduce(
      (sum, result) => sum + result.dependencies.filter((dependency) => dependency.isExternal).length,
      0,
    ),
    stronglyConnectedComponents: graph.detectStronglyConnectedComponents(),
    weaklyConnectedComponents: graph.detectWeaklyConnectedComponents(),
    topPageRank: Array.from(graph.calculatePageRank().entries()).map(([id, score]) => ({ id, score })),
    topInDegree: [...graphJson.nodes]
      .sort((left, right) => right.inDegree - left.inDegree || left.id.localeCompare(right.id))
      .slice(0, 10)
      .map((node) => ({ id: node.id, degree: node.inDegree })),
    topOutDegree: [...graphJson.nodes]
      .sort((left, right) => right.outDegree - left.outDegree || left.id.localeCompare(right.id))
      .slice(0, 10)
      .map((node) => ({ id: node.id, degree: node.outDegree })),
    largestStronglyConnectedComponentSize: graph.detectStronglyConnectedComponents().reduce(
      (max, component) => Math.max(max, component.length),
      0,
    ),
    warnings: graph.detectCycles().length > 0 ? ["1 dependency cycle(s) detected."] : [],
  };
}

function createAnalysisResult(
  filePath: string,
  component?: { name: string; hasChildren?: boolean },
  overrides?: Partial<AnalysisResult["complexity"]>,
  dependencies: Dependency[] = [],
): AnalysisResult {
  return {
    filePath,
    complexity: {
      filePath,
      totalLines: 10,
      codeLines: 8,
      commentLines: 1,
      functions: [],
      components: component ? [{
        name: component.name,
        jsxElements: 1,
        hooksUsed: [],
        hookCount: 0,
        propsInterface: null,
        hasChildren: component.hasChildren ?? false,
        usesRef: false,
        isForwardRef: false,
        startLine: 1,
        endLine: 10,
        renderComplexity: {
          hasConditionalRender: false,
          hasListRender: false,
          fragmentCount: 0,
          complexity: 0,
        },
      }] : [],
      hooks: [],
      typeMetrics: {
        anyTypeCount: 0,
        unknownTypeCount: 0,
        assertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 0,
        uncheckedPatterns: [],
      },
      overallComplexity: 1,
      ...overrides,
    },
    dependencies,
    dependencyErrors: [],
  };
}

function createDependency(source: string, target: string, isExternal: boolean, type: Dependency["type"] = "import"): Dependency {
  return {
    source,
    target,
    type,
    isExternal,
    modulePath: target,
    range: {
      start: 0,
      end: 0,
      line: 1,
      character: 1,
    },
  };
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

test("DependencyAnalyzer resolves tsconfig path aliases and dynamic imports", async () => {
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(sampleProject, "tsconfig.json")),
    { cacheDir: path.join(sampleProject, ".cache"), enableCache: true },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(sampleProject);
  const appFile = scanResult.parsed.find((file) => file.filePath.endsWith(path.join("src", "App.tsx")));

  assert.ok(appFile);

  const analyzer = new DependencyAnalyzer(sampleProject, config.tsCompilerOptions);
  const extracted = analyzer.extractDependencies(appFile!.sourceFile, appFile!.filePath);

  assert.equal(extracted.internalCount, 3);
  assert.equal(extracted.externalCount, 1);
  assert.ok(extracted.dependencies.some((dep) => dep.type === "dynamic-import"));
  assert.ok(extracted.dependencies.some((dep) => dep.target.endsWith(path.join("src", "components", "Button.tsx"))));

  await fs.rm(config.cacheDir, { recursive: true, force: true });
});

test("ComplexityAnalyzer detects hooks, JSX, and explicit any usage", async () => {
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(sampleProject, "tsconfig.json")),
    { cacheDir: path.join(sampleProject, ".cache"), enableCache: false },
  );
  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(sampleProject);
  const appFile = scanResult.parsed.find((file) => file.filePath.endsWith(path.join("src", "App.tsx")));

  assert.ok(appFile);

  const analyzer = new ComplexityAnalyzer();
  const metrics = analyzer.analyzeFile(appFile!.sourceFile, appFile!.filePath);

  assert.equal(metrics.components.length, 1);
  assert.ok(metrics.hooks.some((hook) => hook.name === "useEffect"));
  assert.ok(metrics.typeMetrics.anyTypeCount >= 1);
  assert.ok(metrics.components[0]?.jsxElements && metrics.components[0].jsxElements >= 3);
});

test("GraphBuilder detects circular dependencies", async () => {
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(cycleProject, "tsconfig.json")),
    { cacheDir: path.join(cycleProject, ".cache"), enableCache: false },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(cycleProject);
  const depAnalyzer = new DependencyAnalyzer(cycleProject, config.tsCompilerOptions);
  const graph = new GraphBuilder();

  for (const parsed of scanResult.parsed) {
    const extracted = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of extracted.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
  }

  const cycles = graph.detectCycles();
  assert.equal(cycles.length, 1);
  assert.equal(graph.topologicalSort(), null);
});

test("ReportGenerator writes json, markdown, csv, and html outputs", async () => {
  const outputDir = path.join(sampleProject, "tmp-report-output");
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(sampleProject, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "fixture",
      outputFormats: ["json", "markdown", "csv", "html"],
      cacheDir: path.join(sampleProject, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(sampleProject);
  const depAnalyzer = new DependencyAnalyzer(sampleProject, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const reportGenerator = new ReportGenerator();
  await reportGenerator.generateReports(results, buildGraphMetrics(graph, results), {
    outputDir,
    prefix: "fixture",
    formats: config.outputFormats,
    complexityThreshold: config.complexityThreshold,
    executionTimeMs: 1234,
    projectRoot: sampleProject,
    skippedFiles: scanResult.skipped,
    scanErrors: scanResult.errors,
    parseIssues: scanResult.parsed
      .filter((parsed) => parsed.metadata.parseDiagnosticCount > 0)
      .map((parsed) => ({ filePath: parsed.filePath, diagnosticCount: parsed.metadata.parseDiagnosticCount })),
    cacheStats: scanResult.cacheStats,
    analysisCacheStats: { hits: 0, misses: results.length },
    incrementalStats: { reusedFiles: 0, recomputedFiles: results.length },
    graphJson: graph.exportToJSON(),
  });

  const files = await fs.readdir(outputDir);
  assert.ok(files.includes("fixture_report.json"));
  assert.ok(files.includes("fixture_report.md"));
  assert.ok(files.includes("fixture_report.html"));
  assert.ok(files.includes("fixture_files.csv"));

  const jsonReport = JSON.parse(await fs.readFile(path.join(outputDir, "fixture_report.json"), "utf8")) as {
    statistics: { fileCount: number };
    incrementalStats?: { reusedFiles: number; recomputedFiles: number };
    decisionSummary?: {
      topHotSpots?: Array<{ path: string; displayPath: string; score: number }>;
      riskSummary?: { complexity: { low: number; medium: number; high: number } };
      typeSafetyAlerts?: { anyCount: number; criticalSignals: number };
    };
    executionTimeMs?: number;
  };
  assert.equal(jsonReport.statistics.fileCount, 4);
  assert.equal(jsonReport.executionTimeMs, 1234);
  assert.equal(jsonReport.incrementalStats?.recomputedFiles, 4);
  assert.ok((jsonReport.decisionSummary?.topHotSpots?.length ?? 0) >= 1);
  assert.ok(jsonReport.decisionSummary?.topHotSpots?.some((item) => item.displayPath === "src/App.tsx"));
  assert.equal(jsonReport.decisionSummary?.riskSummary?.complexity.low, 4);
  assert.ok((jsonReport.decisionSummary?.typeSafetyAlerts?.anyCount ?? 0) >= 1);
  const htmlReport = await fs.readFile(path.join(outputDir, "fixture_report.html"), "utf8");
  const markdownReport = await fs.readFile(path.join(outputDir, "fixture_report.md"), "utf8");
  const filesCsv = await fs.readFile(path.join(outputDir, "fixture_files.csv"), "utf8");
  const componentsCsv = await fs.readFile(path.join(outputDir, "fixture_components.csv"), "utf8");
  assert.doesNotMatch(htmlReport, /cdn\.jsdelivr\.net\/npm\/d3@7/u);
  assert.match(htmlReport, /createElementNS/u);
  assert.match(htmlReport, /Incremental/u);
  assert.match(htmlReport, /file:\/\//u);
  assert.match(htmlReport, /Dependency Graph/u);
  assert.match(markdownReport, /## 意思決定サマリー/u);
  assert.match(markdownReport, /優先順位の高い論点を先頭で整理し、着手判断を早くするためのセクションです。/u);
  assert.match(markdownReport, /## 重点改修候補 Top 5/u);
  assert.match(markdownReport, /## 3x3 マトリクス要約/u);
  assert.match(markdownReport, /コード行数と複雑度の 3x3 マトリクスで、設計負債の位置を俯瞰します。/u);
  assert.match(markdownReport, /## ファイル種別分布/u);
  assert.match(markdownReport, /## リスク分布/u);
  assert.match(markdownReport, /\| 複雑度 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /\| 構造 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /\| 型安全性 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /## 型安全性/u);
  assert.match(markdownReport, /### 外部ライブラリ内訳/u);
  assert.match(markdownReport, /#### Runtime 外部ライブラリ Top 10/u);
  assert.match(markdownReport, /- react: \d+/u);
  assert.match(markdownReport, /## 優先対応タスク/u);
  assert.match(markdownReport, /1\. src\/App\.tsx/u);
  assert.match(markdownReport, /理由: .*fan-out=/u);
  assert.match(markdownReport, /対応: /u);
  assert.match(markdownReport, /- \*\*複雑度リスク\*\*: 高=0, 中=0/u);
  assert.match(markdownReport, /- \*\*構造リスク\*\*: /u);
  assert.match(markdownReport, /- \*\*型安全性リスク\*\*: /u);
  assert.match(markdownReport, /- \*\*実行時間\*\*: 1234ms/u);
  assert.doesNotMatch(markdownReport, /recomputed##/u);
  assert.match(markdownReport, /\| Feature \| 0 \|/u);
  assert.match(markdownReport, /\*\*src\/App\.tsx\*\* 主因=/u);
  assert.match(markdownReport, /\| src\/App\.tsx \| 1 \|/u);
  assert.match(filesCsv, /^File,File Type,Has Test File,Matrix Cluster,Lines,/mu);
  assert.match(filesCsv, /src\/components\/Button\.tsx,UI component,No,S-L,/u);
  assert.match(componentsCsv, /^Component,File,File Type,JSX Elements,/mu);
  assert.match(componentsCsv, /Button,src\/components\/Button\.tsx,UI component,/u);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(config.cacheDir, { recursive: true, force: true });
});

test("ReportGenerator excludes test and story files from type safety summaries", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-type-safety-scope-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "App.tsx"), undefined, {
      typeMetrics: {
        anyTypeCount: 1,
        unknownTypeCount: 0,
        assertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 0,
        uncheckedPatterns: [],
      },
    }),
    createAnalysisResult(path.join(projectRoot, "src", "App.test.tsx"), undefined, {
      typeMetrics: {
        anyTypeCount: 4,
        unknownTypeCount: 0,
        assertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 2,
        uncheckedPatterns: ["@ts-ignore"],
      },
    }),
    createAnalysisResult(path.join(projectRoot, "src", "App.stories.tsx"), undefined, {
      typeMetrics: {
        anyTypeCount: 3,
        unknownTypeCount: 0,
        assertionCount: 2,
        nonNullAssertionCount: 1,
        tsIgnoreCount: 0,
        uncheckedPatterns: ["type-assertion:any", "non-null-assertion"],
      },
    }),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "type-safety-scope",
    formats: ["json", "markdown"],
    complexityThreshold: 10,
    projectRoot,
  });

  const report = JSON.parse(await fs.readFile(path.join(outputDir, "type-safety-scope_report.json"), "utf8")) as {
    decisionSummary?: {
      riskSummary?: { typeSafety: { low: number; medium: number; high: number } };
      typeSafetyAlerts?: { anyCount: number; assertionCount: number; nonNullAssertionCount: number; tsIgnoreCount: number };
    };
  };
  const markdownReport = await fs.readFile(path.join(outputDir, "type-safety-scope_report.md"), "utf8");

  assert.equal(report.decisionSummary?.typeSafetyAlerts?.anyCount, 1);
  assert.equal(report.decisionSummary?.typeSafetyAlerts?.assertionCount, 0);
  assert.equal(report.decisionSummary?.typeSafetyAlerts?.nonNullAssertionCount, 0);
  assert.equal(report.decisionSummary?.typeSafetyAlerts?.tsIgnoreCount, 0);
  assert.deepEqual(report.decisionSummary?.riskSummary?.typeSafety, {
    low: 0,
    medium: 1,
    high: 0,
  });
  assert.match(markdownReport, /\| src\/App\.tsx \| 1 \| 0 \| 0 \| 0 \| 4 \|/u);
  assert.doesNotMatch(markdownReport, /\| src\/App\.test\.tsx \|/u);
  assert.doesNotMatch(markdownReport, /\| src\/App\.stories\.tsx \|/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator writes quality outputs with automatic and manual metrics", async () => {
  const outputDir = path.join(sampleProject, "tmp-quality-output");
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(sampleProject, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality",
      outputFormats: ["json", "markdown", "csv", "html"],
      cacheDir: path.join(sampleProject, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(sampleProject);
  const depAnalyzer = new DependencyAnalyzer(sampleProject, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot: sampleProject,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 567,
    tsConfigPath: path.join(sampleProject, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality",
    formats: config.outputFormats,
  });

  assert.equal(report.categories.length, 12);
  assert.ok(report.summary.totalMetrics >= 40);
  assert.ok(report.categories.some((category) => category.id === "code"));
  assert.ok(report.categories.some((category) => category.metrics.some((metric) => metric.verdict === "manual")));

  const files = await fs.readdir(outputDir);
  assert.ok(files.includes("quality_quality_report.json"));
  assert.ok(files.includes("quality_quality_report.md"));
  assert.ok(files.includes("quality_quality_report.html"));
  assert.ok(files.includes("quality_quality_summary.csv"));

  const jsonReport = JSON.parse(await fs.readFile(path.join(outputDir, "quality_quality_report.json"), "utf8")) as QualityReport;
  assert.equal(jsonReport.executionTimeMs, 567);
  assert.ok(jsonReport.categories.some((category) => category.label === "テスト品質"));
  assert.ok(jsonReport.categories.some((category) =>
    category.metrics.some((metric) => metric.label === "TypeScript型エラー数"))
  );

  const markdownReport = await fs.readFile(path.join(outputDir, "quality_quality_report.md"), "utf8");
  const csvReport = await fs.readFile(path.join(outputDir, "quality_quality_summary.csv"), "utf8");
  const htmlReport = await fs.readFile(path.join(outputDir, "quality_quality_report.html"), "utf8");
  assert.match(markdownReport, /# React 出荷審査 品質レポート/u);
  assert.match(markdownReport, /\| 観点 \| 自動指標数 \| PASS \| WARN \| FAIL \| MANUAL \| 判定 \|/u);
  assert.match(markdownReport, /## セキュリティ品質/u);
  assert.match(csvReport, /^"Category","Metric","Automation","Actual","Threshold","Verdict","Summary"/mu);
  assert.match(htmlReport, /React 出荷審査 品質レポート/u);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(config.cacheDir, { recursive: true, force: true });
});

test("CLI quality collect auto-loads quality.manual.json and merges manual metrics", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-manual-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      jsx: "react-jsx",
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.tsx"), "export const App = () => <main>app</main>;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "requirements.csv"), "id,status\nREQ-1,implemented\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "quality.manual.json"), JSON.stringify({
    metrics: [
      {
        id: "requirements_traceability",
        actual: "100%",
        threshold: "100%",
        verdict: "pass",
        summary: "要件台帳と実装の照合が完了しています。",
        evidence: [
          {
            type: "file",
            label: "requirements",
            filePath: "./requirements.csv",
            value: "要件台帳",
          },
        ],
      },
      {
        id: "residual_bug_count",
        actual: "High=0, Medium=1, Low=2",
        threshold: "High=0",
        verdict: "pass",
        summary: "重大障害は残存していません。",
      },
    ],
  }, null, 2), "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "manual-quality",
    "--format",
    "json",
  ]);

  const report = JSON.parse(await fs.readFile(path.join(outputDir, "manual-quality_quality_report.json"), "utf8")) as QualityReport;
  const functionalCategory = report.categories.find((category) => category.id === "functional");
  const requirementsMetric = functionalCategory!.metrics.find((metric) => metric.id === "requirements_traceability");
  const bugMetric = functionalCategory!.metrics.find((metric) => metric.id === "residual_bug_count");

  assert.equal(requirementsMetric?.automation, "manual");
  assert.equal(requirementsMetric?.verdict, "pass");
  assert.equal(requirementsMetric?.actual, "100%");
  assert.match(requirementsMetric?.evidence?.[0]?.filePath ?? "", /requirements\.csv$/u);
  assert.equal(bugMetric?.verdict, "pass");
  assert.equal(bugMetric?.actual, "High=0, Medium=1, Low=2");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator imports JUnit and LCOV artifacts into test metrics", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-artifacts-"));
  const outputDir = path.join(projectRoot, "out");
  const coverageDir = path.join(projectRoot, "coverage");
  const testResultsDir = path.join(projectRoot, "test-results");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(coverageDir, { recursive: true });
  await fs.mkdir(testResultsDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "value.ts"), "export const value = (input: number) => input + 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "value.test.ts"), "import { value } from './value';\nvoid value(1);\n", "utf8");
  await fs.writeFile(path.join(testResultsDir, "junit.xml"), "<?xml version=\"1.0\" encoding=\"UTF-8\"?><testsuite tests=\"4\" failures=\"0\" errors=\"0\" skipped=\"0\"></testsuite>", "utf8");
  await fs.writeFile(path.join(coverageDir, "lcov.info"), "TN:\nSF:src/value.ts\nLF:10\nLH:9\nend_of_record\n", "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "artifact-quality",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 890,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "artifact-quality",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  assert.ok(testCategory);
  const unitPassMetric = testCategory!.metrics.find((metric) => metric.id === "unit_pass_rate");
  const coverageMetric = testCategory!.metrics.find((metric) => metric.id === "coverage_rate");

  assert.equal(unitPassMetric?.automation, "automatic");
  assert.equal(unitPassMetric?.actual, "100.0%");
  assert.equal(unitPassMetric?.verdict, "pass");
  assert.equal(coverageMetric?.automation, "automatic");
  assert.equal(coverageMetric?.actual, "90.0%");
  assert.equal(coverageMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator imports axe and Lighthouse artifacts into accessibility and performance metrics", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-browser-"));
  const outputDir = path.join(projectRoot, "out");
  const reportsDir = path.join(projectRoot, "reports");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "page.ts"), "export const pageTitle = 'dashboard';\n", "utf8");
  await fs.writeFile(path.join(reportsDir, "axe-results.json"), JSON.stringify({
    violations: [],
    incomplete: [{ id: "landmark-one-main" }],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(reportsDir, "lighthouse-report.json"), JSON.stringify({
    categories: {
      performance: {
        score: 0.92,
      },
    },
    audits: {
      "largest-contentful-paint": {
        numericValue: 2200,
      },
      interactive: {
        numericValue: 3100,
      },
    },
  }, null, 2), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "browser-quality",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 901,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "browser-quality",
    formats: ["json"],
  });

  const accessibilityCategory = report.categories.find((category) => category.id === "accessibility");
  const performanceCategory = report.categories.find((category) => category.id === "performance");
  const wcagMetric = accessibilityCategory!.metrics.find((metric) => metric.id === "wcag_aa");
  const lighthouseMetric = performanceCategory!.metrics.find((metric) => metric.id === "lighthouse_performance");
  const lcpMetric = performanceCategory!.metrics.find((metric) => metric.id === "lcp");
  const ttiMetric = performanceCategory!.metrics.find((metric) => metric.id === "tti");

  assert.equal(wcagMetric?.automation, "automatic");
  assert.equal(wcagMetric?.verdict, "pass");
  assert.match(wcagMetric?.actual ?? "", /critical=0, serious=0, total=0/u);
  assert.equal(lighthouseMetric?.automation, "automatic");
  assert.equal(lighthouseMetric?.actual, "92.0");
  assert.equal(lighthouseMetric?.verdict, "pass");
  assert.equal(lcpMetric?.actual, "2.20s");
  assert.equal(lcpMetric?.verdict, "pass");
  assert.equal(ttiMetric?.actual, "3.10s");
  assert.equal(ttiMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator imports Playwright and Storybook artifacts into UI test metrics", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-ui-tests-"));
  const outputDir = path.join(projectRoot, "out");
  const reportsDir = path.join(projectRoot, "reports");
  const playwrightReportDir = path.join(projectRoot, "playwright-report");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.mkdir(playwrightReportDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "screen.tsx"), "export const Screen = () => <main>screen</main>;\n", "utf8");
  await fs.writeFile(path.join(playwrightReportDir, "results.json"), JSON.stringify({
    suites: [{
      title: "e2e",
      specs: [{
        title: "loads dashboard",
        tests: [
          {
            results: [{ status: "passed" }],
          },
          {
            results: [{ status: "passed" }],
          },
        ],
      }],
    }],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(reportsDir, "storybook-results.json"), JSON.stringify({
    numTotalTests: 3,
    numPassedTests: 3,
    numFailedTests: 0,
    numPendingTests: 0,
  }, null, 2), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "ui-quality",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 913,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "ui-quality",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const storybookMetric = testCategory!.metrics.find((metric) => metric.id === "storybook_pass_rate");
  const playwrightMetric = testCategory!.metrics.find((metric) => metric.id === "e2e_pass_rate");

  assert.equal(storybookMetric?.automation, "automatic");
  assert.equal(storybookMetric?.actual, "100.0%");
  assert.equal(storybookMetric?.verdict, "pass");
  assert.equal(playwrightMetric?.automation, "automatic");
  assert.equal(playwrightMetric?.actual, "100.0%");
  assert.equal(playwrightMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator excludes test and story files from strict code and security checks", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-scope-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const app = 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.test.tsx"), [
    "const leaked: any = 1;",
    "const broken: string = 1;",
    "const apiKey = \"test-secret\";",
    "export const TestStory = () => <div dangerouslySetInnerHTML={{ __html: \"<b>test</b>\" }} />;",
    "void leaked;",
    "void broken;",
    "void apiKey;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.stories.tsx"), [
    "const storyValue: any = 1;",
    "const storyBroken: string = 1;",
    "const secret = \"storybook-secret\";",
    "export const Primary = () => <section dangerouslySetInnerHTML={{ __html: \"<i>story</i>\" }} />;",
    "void storyValue;",
    "void storyBroken;",
    "void secret;",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-scope",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 201,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-scope",
    formats: ["json"],
  });

  const codeCategory = report.categories.find((category) => category.id === "code");
  const securityCategory = report.categories.find((category) => category.id === "security");
  const typeScriptErrorsMetric = codeCategory!.metrics.find((metric) => metric.id === "typescript_errors");
  const typeEscapeMetric = codeCategory!.metrics.find((metric) => metric.id === "type_escape_count");
  const dangerousHtmlMetric = securityCategory!.metrics.find((metric) => metric.id === "dangerous_html");
  const secretIndicatorsMetric = securityCategory!.metrics.find((metric) => metric.id === "secret_indicators");

  assert.equal(typeScriptErrorsMetric?.actual, "0");
  assert.equal(typeScriptErrorsMetric?.verdict, "pass");
  assert.equal(typeEscapeMetric?.actual, "0");
  assert.equal(typeEscapeMetric?.verdict, "pass");
  assert.equal(dangerousHtmlMetric?.actual, "0");
  assert.equal(dangerousHtmlMetric?.verdict, "pass");
  assert.equal(secretIndicatorsMetric?.actual, "0");
  assert.equal(secretIndicatorsMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator imports API and security artifacts into automatic metrics", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-api-security-"));
  const outputDir = path.join(projectRoot, "out");
  const reportsDir = path.join(projectRoot, "reports");

  await fs.mkdir(path.join(projectRoot, "src", "api"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "mocks"), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "openapi.yaml"), "openapi: 3.1.0\ninfo:\n  title: Sample API\n  version: 1.0.0\npaths: {}\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "api", "client.ts"), "import { z } from 'zod';\nconst timeout = 3000;\nconst retry = 2;\nexport const schema = z.object({ timeout: z.number() });\nexport const clientConfig = { timeout, retry };\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "mocks", "handlers.ts"), "import { http } from 'msw';\nexport const handlers = [http.get('/api/orders', () => new Response())];\n", "utf8");
  await fs.writeFile(path.join(reportsDir, "openapi-diff.json"), JSON.stringify({
    breakingDifferences: [],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(reportsDir, "npm-audit.json"), JSON.stringify({
    metadata: {
      vulnerabilities: {
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
      },
    },
  }, null, 2), "utf8");
  await fs.writeFile(path.join(reportsDir, "trivy-results.json"), JSON.stringify({
    Results: [{
      Vulnerabilities: [{
        VulnerabilityID: "CVE-2024-0001",
        Severity: "HIGH",
      }],
    }],
  }, null, 2), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "api-security-quality",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 925,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "api-security-quality",
    formats: ["json"],
  });

  const apiCategory = report.categories.find((category) => category.id === "api");
  const securityCategory = report.categories.find((category) => category.id === "security");
  const openApiMetric = apiCategory!.metrics.find((metric) => metric.id === "openapi_contract");
  const mswMetric = apiCategory!.metrics.find((metric) => metric.id === "msw_alignment");
  const timeoutMetric = apiCategory!.metrics.find((metric) => metric.id === "timeout_retry");
  const zodMetric = apiCategory!.metrics.find((metric) => metric.id === "zod_adoption");
  const vulnerabilityMetric = securityCategory!.metrics.find((metric) => metric.id === "dependency_vulnerabilities");

  assert.equal(openApiMetric?.automation, "automatic");
  assert.equal(openApiMetric?.verdict, "pass");
  assert.equal(mswMetric?.automation, "automatic");
  assert.equal(mswMetric?.verdict, "pass");
  assert.equal(timeoutMetric?.automation, "automatic");
  assert.equal(timeoutMetric?.verdict, "pass");
  assert.equal(zodMetric?.verdict, "pass");
  assert.equal(vulnerabilityMetric?.automation, "automatic");
  assert.equal(vulnerabilityMetric?.verdict, "fail");
  assert.match(vulnerabilityMetric?.actual ?? "", /trivy\(critical=0,high=1\)/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality gate exits with code 2 when automatic quality metrics fail", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-gate-fail-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const apiKey = \"production-secret\";\n", "utf8");

  try {
    await execFileAsync("node", [
      path.join(workspaceRoot, "dist", "src", "cli.js"),
      "quality",
      "gate",
      projectRoot,
      "--output",
      outputDir,
      "--prefix",
      "cli-quality",
      "--format",
      "json,markdown",
    ]);
    assert.fail("quality gate should fail for the security fixture");
  } catch (error) {
    const typedError = error as { code?: number };
    assert.equal(typedError.code, 2);
  }

  const reportPath = path.join(outputDir, "cli-quality_quality_report.json");
  const gateReport = JSON.parse(await fs.readFile(reportPath, "utf8")) as QualityReport;
  assert.equal(gateReport.summary.overallVerdict, "fail");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityDiffGenerator compares quality reports and marks regressions and improvements", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-diff-"));
  const outputDir = path.join(projectRoot, "out");
  const generator = new QualityDiffGenerator();

  const baseline: QualityReport = {
    timestamp: "2026-03-20T00:00:00.000Z",
    executionTimeMs: 100,
    projectRoot,
    summary: {
      totalMetrics: 2,
      passCount: 1,
      warnCount: 0,
      failCount: 0,
      manualCount: 1,
      notApplicableCount: 0,
      overallVerdict: "manual",
    },
    categories: [
      {
        id: "functional",
        label: "機能品質",
        verdict: "manual",
        summary: "手動確認が残っています。",
        metrics: [
          {
            id: "requirements_traceability",
            category: "functional",
            label: "要件適合率",
            actual: "manual",
            threshold: "100%",
            verdict: "manual",
            automation: "manual",
            summary: "台帳未投入",
            evidence: [],
          },
        ],
      },
      {
        id: "code",
        label: "コード品質",
        verdict: "pass",
        summary: "型エラーなし",
        metrics: [
          {
            id: "typescript_errors",
            category: "code",
            label: "TypeScript型エラー数",
            actual: "0",
            threshold: "0",
            verdict: "pass",
            automation: "automatic",
            summary: "型エラーはありません。",
            evidence: [],
          },
        ],
      },
    ],
  };

  const current: QualityReport = {
    timestamp: "2026-03-26T00:00:00.000Z",
    executionTimeMs: 120,
    projectRoot,
    summary: {
      totalMetrics: 3,
      passCount: 1,
      warnCount: 0,
      failCount: 1,
      manualCount: 1,
      notApplicableCount: 0,
      overallVerdict: "fail",
    },
    categories: [
      {
        id: "functional",
        label: "機能品質",
        verdict: "pass",
        summary: "要件照合完了",
        metrics: [
          {
            id: "requirements_traceability",
            category: "functional",
            label: "要件適合率",
            actual: "100%",
            threshold: "100%",
            verdict: "pass",
            automation: "manual",
            summary: "台帳照合完了",
            evidence: [],
          },
        ],
      },
      {
        id: "code",
        label: "コード品質",
        verdict: "fail",
        summary: "型エラーあり",
        metrics: [
          {
            id: "typescript_errors",
            category: "code",
            label: "TypeScript型エラー数",
            actual: "3",
            threshold: "0",
            verdict: "fail",
            automation: "automatic",
            summary: "型エラーを検出しました。",
            evidence: [],
          },
        ],
      },
      {
        id: "security",
        label: "セキュリティ品質",
        verdict: "warn",
        summary: "新規監査項目",
        metrics: [
          {
            id: "dependency_vulnerabilities",
            category: "security",
            label: "依存ライブラリ脆弱性",
            actual: "npm(high=0,critical=0) / trivy(high=0,critical=0)",
            threshold: "High=0, Critical=0",
            verdict: "warn",
            automation: "automatic",
            summary: "新しい監査項目です。",
            evidence: [],
          },
        ],
      },
    ],
  };

  const diff = generator.compare(current, baseline, "/tmp/baseline-quality.json", "/tmp/current-quality.json");
  await generator.writeReports(diff, outputDir, "quality-delta", ["json", "markdown", "html"]);

  assert.equal(diff.summary.regressedMetrics, 1);
  assert.equal(diff.summary.improvedMetrics, 1);
  assert.equal(diff.summary.addedMetrics, 1);
  assert.equal(diff.summary.automaticRegressions, 1);
  const typeScriptDiff = diff.metrics.find((metric) => metric.id === "typescript_errors");
  const traceabilityDiff = diff.metrics.find((metric) => metric.id === "requirements_traceability");
  assert.equal(typeScriptDiff?.trend, "regressed");
  assert.equal(typeScriptDiff?.status, "changed");
  assert.equal(traceabilityDiff?.trend, "improved");
  assert.equal(traceabilityDiff?.status, "changed");

  const files = await fs.readdir(outputDir);
  assert.ok(files.includes("quality-delta_quality_diff.json"));
  assert.ok(files.includes("quality-delta_quality_diff.md"));
  assert.ok(files.includes("quality-delta_quality_diff.html"));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality diff compares current report against baseline quality report", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-diff-cli-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const appName = 'release';\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "release-quality",
    "--format",
    "json",
  ]);

  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const apiKey = \"production-secret\";\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "diff",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "release-quality",
    "--format",
    "json,markdown",
  ]);

  const diff = JSON.parse(
    await fs.readFile(path.join(outputDir, "release-quality_quality_diff.json"), "utf8"),
  ) as QualityDiffReport;
  const secretDiff = diff.metrics.find((metric) => metric.id === "secret_indicators");

  assert.ok(diff.summary.regressedMetrics >= 1);
  assert.ok(diff.summary.automaticRegressions >= 1);
  assert.equal(secretDiff?.trend, "regressed");
  assert.equal(secretDiff?.baselineVerdict, "pass");
  assert.equal(secretDiff?.currentVerdict, "fail");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality gate exits with code 2 when automatic metrics regress from baseline", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-gate-regression-"));
  const outputDir = path.join(projectRoot, "out");
  const baselinePath = path.join(outputDir, "regression-quality_quality_report.json");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const appName = 'release';\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), "import { appName } from './App';\nvoid appName;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "regression-quality",
    "--format",
    "json",
  ]);

  await fs.rm(path.join(projectRoot, "README.md"), { force: true });

  try {
    await execFileAsync("node", [
      path.join(workspaceRoot, "dist", "src", "cli.js"),
      "quality",
      "gate",
      projectRoot,
      "--output",
      outputDir,
      "--prefix",
      "regression-quality",
      "--baseline",
      baselinePath,
      "--format",
      "json,markdown",
    ]);
    assert.fail("quality gate should fail when automatic metrics regress from the baseline");
  } catch (error) {
    const typedError = error as { code?: number };
    assert.equal(typedError.code, 2);
  }

  const diff = JSON.parse(
    await fs.readFile(path.join(outputDir, "regression-quality_quality_diff.json"), "utf8"),
  ) as QualityDiffReport;
  const documentationDiff = diff.metrics.find((metric) => metric.id === "documentation_presence");

  assert.ok(diff.summary.automaticRegressions >= 1);
  assert.equal(documentationDiff?.trend, "regressed");
  assert.equal(documentationDiff?.baselineVerdict, "pass");
  assert.equal(documentationDiff?.currentVerdict, "warn");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality gate allows monitored regression metrics from analyzer config", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-gate-monitoring-"));
  const outputDir = path.join(projectRoot, "out");
  const baselinePath = path.join(outputDir, "monitoring-quality_quality_report.json");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "analyzer.config.json"), JSON.stringify({
    qualityGateMonitoringMetricIds: ["documentation_presence"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const appName = 'release';\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), "import { appName } from './App';\nvoid appName;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "monitoring-quality",
    "--format",
    "json",
  ]);

  await fs.rm(path.join(projectRoot, "README.md"), { force: true });

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "gate",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "monitoring-quality",
    "--baseline",
    baselinePath,
    "--format",
    "json",
  ]);

  const diff = JSON.parse(
    await fs.readFile(path.join(outputDir, "monitoring-quality_quality_diff.json"), "utf8"),
  ) as QualityDiffReport;
  const documentationDiff = diff.metrics.find((metric) => metric.id === "documentation_presence");

  assert.equal(documentationDiff?.trend, "regressed");
  assert.equal(documentationDiff?.baselineVerdict, "pass");
  assert.equal(documentationDiff?.currentVerdict, "warn");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality gate blocking metric list narrows regression gate scope", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-gate-blocking-"));
  const outputDir = path.join(projectRoot, "out");
  const baselinePath = path.join(outputDir, "blocking-quality_quality_report.json");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.ts"), "export const appName = 'release';\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), "import { appName } from './App';\nvoid appName;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "blocking-quality",
    "--format",
    "json",
  ]);

  await fs.rm(path.join(projectRoot, "README.md"), { force: true });

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "gate",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "blocking-quality",
    "--baseline",
    baselinePath,
    "--quality-gate-blocking-metrics",
    "secret_indicators",
    "--format",
    "json",
  ]);

  const diff = JSON.parse(
    await fs.readFile(path.join(outputDir, "blocking-quality_quality_diff.json"), "utf8"),
  ) as QualityDiffReport;
  const documentationDiff = diff.metrics.find((metric) => metric.id === "documentation_presence");

  assert.equal(documentationDiff?.trend, "regressed");
  assert.equal(documentationDiff?.baselineVerdict, "pass");
  assert.equal(documentationDiff?.currentVerdict, "warn");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator classifies test, story, fixture, and config files in csv outputs", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-classification-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "components", "Button.test.tsx"), { name: "ButtonTest" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "Button.stories.tsx"), { name: "ButtonStory" }),
    createAnalysisResult(path.join(projectRoot, "src", "__fixtures__", "Button.fixture.tsx"), { name: "ButtonFixture" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "ui", "Dialog.tsx"), { name: "Dialog" }),
    createAnalysisResult(path.join(projectRoot, "vite.config.ts")),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "classification",
    formats: ["csv"],
    complexityThreshold: 10,
    projectRoot,
  });

  const filesCsv = await fs.readFile(path.join(outputDir, "classification_files.csv"), "utf8");
  const componentsCsv = await fs.readFile(path.join(outputDir, "classification_components.csv"), "utf8");

  assert.match(filesCsv, /src\/components\/Button\.test\.tsx,Test,/u);
  assert.match(filesCsv, /src\/components\/Button\.stories\.tsx,Story,/u);
  assert.match(filesCsv, /src\/__fixtures__\/Button\.fixture\.tsx,Fixture,/u);
  assert.match(filesCsv, /src\/components\/ui\/Dialog\.tsx,UI component,/u);
  assert.match(filesCsv, /vite\.config\.ts,Config,/u);
  assert.match(componentsCsv, /ButtonTest,src\/components\/Button\.test\.tsx,Test,/u);
  assert.match(componentsCsv, /ButtonStory,src\/components\/Button\.stories\.tsx,Story,/u);
  assert.match(componentsCsv, /ButtonFixture,src\/__fixtures__\/Button\.fixture\.tsx,Fixture,/u);
  assert.match(componentsCsv, /Dialog,src\/components\/ui\/Dialog\.tsx,UI component,/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator classifies feature, hook, context, API, barrel, schema, validation, storybook support, and type support files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-file-types-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, ".storybook", "main.js")),
    createAnalysisResult(path.join(projectRoot, ".storybook", "components", "SBMermaid.tsx"), { name: "SBMermaid" }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "chat", "TextChat.tsx"), { name: "TextChat" }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "user", "schemas", "user.schema.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "contexts", "chat", "ChatTurnStore.tsx"), { name: "ChatTurnStore" }),
    createAnalysisResult(path.join(projectRoot, "src", "contexts", "chat", "useChatTurn.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "bases", "api", "fetcher.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "components", "forms", "validations", "common.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "components", "ui", "sidebar.tsx"), { name: "Sidebar" }),
    createAnalysisResult(path.join(projectRoot, "src", "lib", "utils.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "utils", "formatDate.ts")),
    createAnalysisResult(path.join(projectRoot, "src", "components", "index.ts")),
    createAnalysisResult(path.join(projectRoot, "vitest.shims.d.ts")),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "layers",
    formats: ["csv"],
    complexityThreshold: 10,
    projectRoot,
  });

  const filesCsv = await fs.readFile(path.join(outputDir, "layers_files.csv"), "utf8");

  assert.match(filesCsv, /\.storybook\/main\.js,Config,No,S-L,/u);
  assert.match(filesCsv, /\.storybook\/components\/SBMermaid\.tsx,Storybook Support,No,S-L,/u);
  assert.match(filesCsv, /src\/features\/chat\/TextChat\.tsx,Feature,No,S-L,/u);
  assert.match(filesCsv, /src\/features\/user\/schemas\/user\.schema\.ts,Schema,No,S-L,/u);
  assert.match(filesCsv, /src\/contexts\/chat\/ChatTurnStore\.tsx,Context\/State,No,S-L,/u);
  assert.match(filesCsv, /src\/contexts\/chat\/useChatTurn\.ts,Hook,No,S-L,/u);
  assert.match(filesCsv, /src\/bases\/api\/fetcher\.ts,API\/Infrastructure,No,S-L,/u);
  assert.match(filesCsv, /src\/components\/forms\/validations\/common\.ts,Validation,No,S-L,/u);
  assert.match(filesCsv, /src\/components\/ui\/sidebar\.tsx,UI component,No,S-L,/u);
  assert.match(filesCsv, /src\/lib\/utils\.ts,Utils,No,S-L,/u);
  assert.match(filesCsv, /src\/utils\/formatDate\.ts,Utils,No,S-L,/u);
  assert.match(filesCsv, /src\/components\/index\.ts,Barrel,No,S-L,/u);
  assert.match(filesCsv, /vitest\.shims\.d\.ts,Type Support,No,S-L,/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator adds 3x3 size-complexity matrix clusters to files csv", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-matrix-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "small.ts"), undefined, {
      totalLines: 20,
      codeLines: 40,
      overallComplexity: 3,
    }),
    createAnalysisResult(path.join(projectRoot, "src", "medium.ts"), undefined, {
      totalLines: 180,
      codeLines: 180,
      overallComplexity: 8,
    }),
    createAnalysisResult(path.join(projectRoot, "src", "large.ts"), undefined, {
      totalLines: 420,
      codeLines: 420,
      overallComplexity: 14,
    }),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "matrix",
    formats: ["csv"],
    complexityThreshold: 10,
    projectRoot,
  });

  const filesCsv = await fs.readFile(path.join(outputDir, "matrix_files.csv"), "utf8");
  assert.match(filesCsv, /^File,File Type,Has Test File,Matrix Cluster,Lines,/mu);
  assert.match(filesCsv, /src\/small\.ts,Shared,No,S-L,/u);
  assert.match(filesCsv, /src\/medium\.ts,Shared,No,M-M,/u);
  assert.match(filesCsv, /src\/large\.ts,Shared,No,L-H,/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator adds matching test-file presence to files csv", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-test-presence-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "components", "Button.tsx"), { name: "Button" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "Button.test.tsx"), { name: "ButtonTest" }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "OrderPage.tsx"), { name: "OrderPage" }),
    createAnalysisResult(path.join(projectRoot, "tests", "features", "OrderPage.spec.tsx"), { name: "OrderPageSpec" }),
    createAnalysisResult(path.join(projectRoot, "src", "utils", "format.ts")),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "test-presence",
    formats: ["csv"],
    complexityThreshold: 10,
    projectRoot,
  });

  const filesCsv = await fs.readFile(path.join(outputDir, "test-presence_files.csv"), "utf8");
  assert.match(filesCsv, /^File,File Type,Has Test File,Matrix Cluster,Lines,/mu);
  assert.match(filesCsv, /src\/components\/Button\.tsx,UI component,Yes,S-L,/u);
  assert.match(filesCsv, /src\/components\/Button\.test\.tsx,Test,Yes,S-L,/u);
  assert.match(filesCsv, /src\/features\/OrderPage\.tsx,Feature,Yes,S-L,/u);
  assert.match(filesCsv, /src\/utils\/format\.ts,Utils,No,S-L,/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator separates expected and unexpected scan notes and formats actionable recommendations", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-scan-notes-"));
  const outputDir = path.join(projectRoot, "out");
  const reportGenerator = new ReportGenerator();
  const targetFile = path.join(projectRoot, "src", "features", "order", "OrderPage.tsx");
  const results: AnalysisResult[] = [
    createAnalysisResult(
      targetFile,
      { name: "OrderPage" },
      {
        totalLines: 340,
        codeLines: 320,
        overallComplexity: 17,
        functions: [
          { name: "a", cyclomaticComplexity: 6, startLine: 1, endLine: 10, lineCount: 10, branchCount: 2, loopCount: 1, ternaryCount: 0, logicalOpCount: 1, maxNestingDepth: 2, isAsync: false, params: [], riskLevel: "medium" },
          { name: "b", cyclomaticComplexity: 5, startLine: 11, endLine: 20, lineCount: 10, branchCount: 1, loopCount: 1, ternaryCount: 0, logicalOpCount: 1, maxNestingDepth: 2, isAsync: false, params: [], riskLevel: "low" },
          { name: "c", cyclomaticComplexity: 7, startLine: 21, endLine: 30, lineCount: 10, branchCount: 2, loopCount: 1, ternaryCount: 1, logicalOpCount: 1, maxNestingDepth: 3, isAsync: false, params: [], riskLevel: "medium" },
        ],
        hooks: [
          { name: "useEffect", startLine: 2, args: 2, hasDependencies: true },
          { name: "useMemo", startLine: 3, args: 2, hasDependencies: true },
        ],
        typeMetrics: {
          anyTypeCount: 3,
          unknownTypeCount: 0,
          assertionCount: 1,
          nonNullAssertionCount: 0,
          tsIgnoreCount: 0,
          uncheckedPatterns: [],
        },
      },
      Array.from({ length: 12 }, (_, index) =>
        createDependency(targetFile, path.join(projectRoot, "src", "shared", `dep-${index}.ts`), false)
      ),
    ),
  ];

  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "scan-notes",
    formats: ["markdown"],
    complexityThreshold: 10,
    projectRoot,
    skippedFiles: [
      { filePath: path.join(projectRoot, "node_modules", "react", "index.js"), reason: "Excluded pattern match", isDirectory: false },
      { filePath: path.join(projectRoot, "src", "huge.ts"), reason: "File size exceeds 10485760 bytes", isDirectory: false },
    ],
    scanErrors: [
      { filePath: path.join(projectRoot, "src", "broken.ts"), reason: "EACCES: permission denied", timestamp: Date.now() },
    ],
    parseIssues: [
      { filePath: path.join(projectRoot, "src", "invalid.tsx"), diagnosticCount: 2 },
    ],
  });

  const markdownReport = await fs.readFile(path.join(outputDir, "scan-notes_report.md"), "utf8");
  assert.match(markdownReport, /## スキャン結果/u);
  assert.match(markdownReport, /スキャン段階で想定どおり除外されたものと、異常として扱うべき事象を分離して示します。/u);
  assert.match(markdownReport, /### 想定どおりの除外/u);
  assert.match(markdownReport, /### 想定外の除外/u);
  assert.match(markdownReport, /### 想定外のエラー/u);
  assert.match(markdownReport, /### パースエラー/u);
  assert.match(markdownReport, /node_modules\/react\/index\.js \(Excluded pattern match\)/u);
  assert.match(markdownReport, /src\/huge\.ts \(File size exceeds 10485760 bytes\)/u);
  assert.match(markdownReport, /src\/broken\.ts \(EACCES: permission denied\)/u);
  assert.match(markdownReport, /src\/invalid\.tsx \(diagnostics=2\)/u);
  assert.match(markdownReport, /\*\*src\/features\/order\/OrderPage\.tsx\*\*/u);
  assert.match(markdownReport, /理由: matrix=L-H, complexity=17, codeLines=320, functions=3, hooks=2, any=3, dependencyCount=12/u);
  assert.match(markdownReport, /1\. src\/features\/order\/OrderPage\.tsx/u);
  assert.match(markdownReport, /理由: クラスタ=L-H, complexity=17, any=3, fan-out=12, codeLines=320/u);
  assert.match(markdownReport, /対応: /u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("ReportGenerator adds cycle cut candidates to dependency analysis", async () => {
  const outputDir = path.join(cycleProject, "tmp-cycle-report");
  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(cycleProject, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "cycle",
      outputFormats: ["markdown"],
      cacheDir: path.join(cycleProject, ".cache"),
    },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(cycleProject);
  const depAnalyzer = new DependencyAnalyzer(cycleProject, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    for (const dependency of deps.dependencies) {
      if (!dependency.isExternal) {
        graph.addDependency(dependency.source, dependency.target);
      }
    }
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const reportGenerator = new ReportGenerator();
  await reportGenerator.generateReports(results, buildGraphMetrics(graph, results), {
    outputDir,
    prefix: "cycle",
    formats: ["markdown"],
    complexityThreshold: config.complexityThreshold,
    projectRoot: cycleProject,
    skippedFiles: scanResult.skipped,
    scanErrors: scanResult.errors,
    parseIssues: [],
  });

  const markdownReport = await fs.readFile(path.join(outputDir, "cycle_report.md"), "utf8");
  assert.match(markdownReport, /### 循環依存/u);
  assert.match(markdownReport, /切断候補: /u);
  assert.match(markdownReport, /barrel経由: /u);
  assert.match(markdownReport, /shared化候補: /u);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(config.cacheDir, { recursive: true, force: true });
});

test("CLI analyze reuses persisted analysis cache on the second run", async () => {
  const outputDir = path.join(sampleProject, "tmp-cli-cache-output");
  const cacheDir = path.join(sampleProject, ".cli-cache");
  const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");

  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    sampleProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "cache-check",
    "--format",
    "json",
  ], { cwd: workspaceRoot });

  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    sampleProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "cache-check",
    "--format",
    "json",
  ], { cwd: workspaceRoot });

  const report = JSON.parse(await fs.readFile(path.join(outputDir, "cache-check_report.json"), "utf8")) as {
    analysisCacheStats?: { hits: number; misses: number };
    incrementalStats?: { reusedFiles: number; recomputedFiles: number };
  };
  assert.ok(report.analysisCacheStats);
  assert.ok((report.analysisCacheStats?.hits ?? 0) >= 4);
  assert.ok((report.incrementalStats?.reusedFiles ?? 0) >= 4);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(cacheDir, { recursive: true, force: true });
});

test("CLI graph command exports DOT and JSON graph files", async () => {
  const outputDir = path.join(sampleProject, "tmp-graph-output");
  const cacheDir = path.join(sampleProject, ".graph-cache");
  const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");

  await execFileAsync(process.execPath, [
    cliPath,
    "graph",
    sampleProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "graph-check",
  ], { cwd: workspaceRoot });

  const files = await fs.readdir(outputDir);
  assert.ok(files.includes("graph-check_graph.json"));
  assert.ok(files.includes("graph-check_graph.dot"));

  const dot = await fs.readFile(path.join(outputDir, "graph-check_graph.dot"), "utf8");
  assert.match(dot, /digraph Dependencies/u);
  const graphJson = JSON.parse(await fs.readFile(path.join(outputDir, "graph-check_graph.json"), "utf8")) as {
    metrics?: { warnings?: string[] };
    graph?: { nodes?: Array<{ id: string }> };
  };
  assert.ok((graphJson.graph?.nodes?.length ?? 0) >= 1);
  assert.ok(Array.isArray(graphJson.metrics?.warnings));

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(cacheDir, { recursive: true, force: true });
});

test("CLI diff command writes diff reports against a baseline report", async () => {
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-diff-"));
  const outputDir = path.join(tempProject, "reports");
  const cacheDir = path.join(tempProject, ".cache");
  const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");

  await fs.cp(sampleProject, tempProject, { recursive: true });

  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    tempProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "delta",
    "--format",
    "json",
  ], { cwd: workspaceRoot });

  const baselinePath = path.join(outputDir, "delta_report.json");
  const appPath = path.join(tempProject, "src", "App.tsx");
  const original = await fs.readFile(appPath, "utf8");
  await fs.writeFile(
    appPath,
    original.replace(
      "  if (unsafe.children && count > 0) {\n    return <section>{unsafe.children}</section>;\n  }\n",
      "  if (unsafe.children && count > 0) {\n    return <section>{unsafe.children}</section>;\n  }\n\n  if (count > 5 && unsafe.children) {\n    return <aside>{unsafe.children}</aside>;\n  }\n",
    ),
    "utf8",
  );

  await execFileAsync(process.execPath, [
    cliPath,
    "diff",
    tempProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "delta",
    "--format",
    "json",
    "--baseline",
    baselinePath,
  ], { cwd: workspaceRoot });

  const diffReport = JSON.parse(await fs.readFile(path.join(outputDir, "delta_diff.json"), "utf8")) as {
    summary: { changedFiles: number };
    files: Array<{ path: string; status: string; complexityDelta: number }>;
    hotSpotDelta?: {
      changed?: Array<{ path: string; scoreDelta: number; currentDisplayPath: string }>;
      added?: Array<{ path: string }>;
      removed?: Array<{ path: string }>;
    };
    impact?: {
      impactedFiles?: string[];
      changedFiles?: string[];
      prioritizedFiles?: Array<{ path: string; score: number }>;
      subtrees?: Array<{
        root: string;
        impactedFiles: string[];
        metrics?: { maxScore: number };
      }>;
    };
  };
  assert.ok(diffReport.summary.changedFiles >= 1);
  assert.ok(diffReport.files.some((file) => file.path.endsWith(path.join("src", "App.tsx")) && file.status === "changed"));
  assert.ok((diffReport.impact?.changedFiles?.length ?? 0) >= 1);
  assert.ok((diffReport.impact?.impactedFiles?.length ?? 0) >= 1);
  assert.ok((diffReport.impact?.prioritizedFiles?.length ?? 0) >= 1);
  assert.ok((diffReport.impact?.subtrees?.length ?? 0) >= 1);
  assert.ok(typeof diffReport.impact?.subtrees?.[0]?.metrics?.maxScore === "number");
  assert.ok((diffReport.hotSpotDelta?.changed?.length ?? 0) >= 1);
  assert.ok(diffReport.hotSpotDelta?.changed?.some((item) => item.path.endsWith(path.join("src", "App.tsx"))));
  const diffHtml = await fs.readFile(path.join(outputDir, "delta_diff.html"), "utf8");
  const diffMarkdown = await fs.readFile(path.join(outputDir, "delta_diff.md"), "utf8");
  assert.match(diffHtml, /Analysis Diff Report/u);
  assert.match(diffHtml, /Changed Files/u);
  assert.match(diffHtml, /Hot Spot Delta/u);
  assert.match(diffHtml, /Changed Subtree/u);
  assert.match(diffHtml, /impact-focus/u);
  assert.match(diffHtml, /subtree-sort/u);
  assert.match(diffHtml, /subtree-metrics/u);
  assert.match(diffHtml, /impact-score/u);
  assert.match(diffHtml, /file:\/\//u);
  assert.match(diffMarkdown, /## Hot Spot Delta/u);
  assert.match(diffMarkdown, /src\/App\.tsx scoreDelta=/u);

  await fs.rm(tempProject, { recursive: true, force: true });
});

test("CLI diff can fail on impact threshold for CI usage", async () => {
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-impact-threshold-"));
  const outputDir = path.join(tempProject, "reports");
  const cacheDir = path.join(tempProject, ".cache");
  const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");

  await fs.cp(sampleProject, tempProject, { recursive: true });

  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    tempProject,
    "--output",
    outputDir,
    "--cache-dir",
    cacheDir,
    "--prefix",
    "gate",
    "--format",
    "json",
  ], { cwd: workspaceRoot });

  const baselinePath = path.join(outputDir, "gate_report.json");
  const appPath = path.join(tempProject, "src", "App.tsx");
  const original = await fs.readFile(appPath, "utf8");
  await fs.writeFile(
    appPath,
    original.replace(
      "  if (unsafe.children && count > 0) {\n    return <section>{unsafe.children}</section>;\n  }\n",
      "  if (unsafe.children && count > 0) {\n    return <section>{unsafe.children}</section>;\n  }\n\n  if (count > 2 || unsafe.children) {\n    return <aside>{unsafe.children}</aside>;\n  }\n",
    ),
    "utf8",
  );

  let exitCode = 0;
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      "diff",
      tempProject,
      "--output",
      outputDir,
      "--cache-dir",
      cacheDir,
      "--prefix",
      "gate",
      "--format",
      "json",
      "--baseline",
      baselinePath,
      "--impact-threshold",
      "1",
      "--fail-on-impact",
    ], { cwd: workspaceRoot });
  } catch (error) {
    exitCode = (error as { code?: number }).code ?? 0;
  }

  assert.equal(exitCode, 2);

  await fs.rm(tempProject, { recursive: true, force: true });
});
