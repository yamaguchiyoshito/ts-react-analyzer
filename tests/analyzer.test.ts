import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";

import { ComplexityAnalyzer, ConfigManager, DependencyAnalyzer, FileScanner, GraphBuilder, QualityDiffGenerator, QualityReportGenerator, ReportGenerator, TypeCheckAnalyzer } from "../src/core/index.js";
import type { AnalysisResult, Dependency, GraphMetrics, PersistedAnalysisReport, QualityDiffReport, QualityReport } from "../src/types/index.js";

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
      scoreBreakdown: {
        averageFunctionComplexity: 0,
        peakFunctionComplexity: 0,
        topFunctionAverage: 0,
        averageRenderComplexity: 0,
        peakRenderComplexity: 0,
        hookPressure: 0,
        peakNestingDepth: 0,
        elevatedFunctionCount: 0,
        weightedScore: 1,
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

test("DependencyAnalyzer resolves aliases from the nearest nested tsconfig in monorepos", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-monorepo-alias-"));
  const appRoot = path.join(projectRoot, "apps", "demo");
  const srcDir = path.join(appRoot, "src");
  const componentsDir = path.join(srcDir, "components");
  await fs.mkdir(componentsDir, { recursive: true });

  const appFilePath = path.join(srcDir, "App.tsx");
  const buttonFilePath = path.join(componentsDir, "Button.tsx");
  const tsConfigPath = path.join(appRoot, "tsconfig.json");

  await fs.writeFile(buttonFilePath, "export const Button = () => <button />;\n", "utf8");
  await fs.writeFile(appFilePath, "import { Button } from '@/components/Button';\nexport const App = () => <Button />;\n", "utf8");
  await fs.writeFile(tsConfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      baseUrl: ".",
      paths: {
        "@/*": ["src/*"],
      },
    },
    include: ["src"],
  }, null, 2), "utf8");

  const scanner = new FileScanner({
    excludePatterns: [],
    maxFileSizeBytes: 1024 * 1024,
    cacheDir: path.join(projectRoot, ".cache"),
    enableCache: false,
  });
  const scanResult = await scanner.scanProject(projectRoot);
  const appFile = scanResult.parsed.find((file) => file.filePath === appFilePath);

  assert.ok(appFile);

  const analyzer = new DependencyAnalyzer(projectRoot, {});
  const extracted = analyzer.extractDependencies(appFile!.sourceFile, appFile!.filePath);

  assert.equal(extracted.internalCount, 1);
  assert.equal(extracted.externalCount, 0);
  assert.equal(extracted.dependencies[0]?.target, buttonFilePath);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("DependencyAnalyzer resolves aliases from nearest tsconfig variant files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-tsconfig-variant-"));
  const appRoot = path.join(projectRoot, "apps", "demo");
  const srcDir = path.join(appRoot, "src");
  const sharedDir = path.join(srcDir, "shared");
  await fs.mkdir(sharedDir, { recursive: true });

  const appFilePath = path.join(srcDir, "App.tsx");
  const labelFilePath = path.join(sharedDir, "label.ts");
  await fs.writeFile(labelFilePath, "export const label = 'demo';\n", "utf8");
  await fs.writeFile(appFilePath, "import { label } from '@app/shared/label';\nexport const App = () => <main>{label}</main>;\n", "utf8");
  await fs.writeFile(path.join(appRoot, "tsconfig.app.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      baseUrl: ".",
      paths: {
        "@app/*": ["src/*"],
      },
    },
    include: ["src"],
  }, null, 2), "utf8");

  const scanner = new FileScanner({
    excludePatterns: [],
    maxFileSizeBytes: 1024 * 1024,
    cacheDir: path.join(projectRoot, ".cache"),
    enableCache: false,
  });
  const scanResult = await scanner.scanProject(projectRoot);
  const appFile = scanResult.parsed.find((file) => file.filePath === appFilePath);

  assert.ok(appFile);

  const analyzer = new DependencyAnalyzer(projectRoot, {});
  const extracted = analyzer.extractDependencies(appFile!.sourceFile, appFile!.filePath);

  assert.equal(extracted.internalCount, 1);
  assert.equal(extracted.dependencies[0]?.target, labelFilePath);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("DependencyAnalyzer keeps side-effect imports in the dependency graph", () => {
  const source = [
    "import './polyfills';",
    "import { start } from './start';",
    "start();",
  ].join("\n");
  const sourceFile = ts.createSourceFile("/virtual/src/App.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analyzer = new DependencyAnalyzer("/virtual", {});
  const extracted = analyzer.extractDependencies(sourceFile, "/virtual/src/App.ts");

  assert.equal(extracted.sideEffectImports, 1);
  assert.ok(extracted.dependencies.some((dependency) =>
    dependency.type === "side-effect-import" && dependency.target === "/virtual/src/polyfills"
  ));
});

test("ConfigManager converts tsconfig exclude globs into anchored patterns", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-exclude-glob-"));
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "checkout.ts"), "export const checkout = 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "buildHelpers.ts"), "export const helper = 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "out", "generated.ts"), "export const generated = 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
    },
    include: ["src"],
    exclude: ["node_modules", "build", "out"],
  }, null, 2), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    { cacheDir: path.join(projectRoot, ".cache"), enableCache: false },
  );

  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const parsedPaths = scanResult.parsed.map((file) => file.filePath);

  assert.ok(parsedPaths.some((filePath) => filePath.endsWith(path.join("src", "checkout.ts"))));
  assert.ok(parsedPaths.some((filePath) => filePath.endsWith(path.join("src", "buildHelpers.ts"))));
  assert.ok(!parsedPaths.some((filePath) => filePath.includes(`${path.sep}out${path.sep}`)));

  await fs.rm(projectRoot, { recursive: true, force: true });
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

test("ComplexityAnalyzer classifies ts directives and unsafe assertion patterns", () => {
  const source = `
    // @ts-ignore legacy shim
    // @ts-expect-error temporary mismatch
    // @ts-nocheck file-level suppression

    const value = foo as any;
    const stable = { a: 1 } as const;
    const converted = foo as unknown as string;
    const current = ref.current!;
  `;
  const sourceFile = ts.createSourceFile("unsafe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analyzer = new ComplexityAnalyzer();
  const metrics = analyzer.analyzeFile(sourceFile, "/virtual/unsafe.ts");

  assert.equal(metrics.typeMetrics.tsIgnoreCount, 1);
  assert.equal(metrics.typeMetrics.tsExpectErrorCount, 1);
  assert.equal(metrics.typeMetrics.tsNoCheckCount, 1);
  assert.ok((metrics.typeMetrics.unsafeAssertionCount ?? 0) >= 2);
  assert.equal(metrics.typeMetrics.doubleAssertionCount, 1);
  assert.equal(metrics.typeMetrics.constAssertionCount, 1);
  assert.equal(metrics.typeMetrics.nonNullAssertionCount, 1);
  assert.ok(metrics.typeMetrics.uncheckedPatterns.includes("@ts-expect-error"));
  assert.ok(metrics.typeMetrics.uncheckedPatterns.includes("@ts-nocheck"));
  assert.ok(metrics.typeMetrics.uncheckedPatterns.includes("double-assertion"));
});

test("ComplexityAnalyzer does not double-count nested function branches into the parent", () => {
  const source = `
    export function Parent() {
      const onClick = () => {
        if (Math.random() > 0.5) {
          return 1;
        }
        return 0;
      };
      return onClick;
    }
  `;
  const sourceFile = ts.createSourceFile("nested.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const metrics = new ComplexityAnalyzer().analyzeFile(sourceFile, "/virtual/nested.ts");

  const parent = metrics.functions.find((fn) => fn.name === "Parent");
  const handler = metrics.functions.find((fn) => fn.name !== "Parent");

  // onClick 内の if は onClick 側 (cc=2) にのみ計上され、Parent は cc=1 のまま
  assert.equal(parent?.cyclomaticComplexity, 1);
  assert.equal(handler?.cyclomaticComplexity, 2);
});

test("ComplexityAnalyzer counts switch case clauses without counting the switch itself", () => {
  const source = `
    export function pick(kind: string) {
      switch (kind) {
        case "a":
          return 1;
        case "b":
          return 2;
        default:
          return 0;
      }
    }
  `;
  const sourceFile = ts.createSourceFile("switch.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const metrics = new ComplexityAnalyzer().analyzeFile(sourceFile, "/virtual/switch.ts");

  // 標準的な cyclomatic complexity: 1 + case 2 個 = 3 (default と switch 自体は数えない)
  assert.equal(metrics.functions[0]?.cyclomaticComplexity, 3);
});

test("ComplexityAnalyzer weights peak complexity, nesting, and hook pressure into file score", () => {
  const source = `
    import { useEffect, useMemo, useState } from "react";

    export function Dashboard({ items }: { items: number[] }) {
      const [count] = useState(0);

      useEffect(() => {
        void count;
      }, [count]);

      const total = useMemo(() => items.reduce((sum, item) => sum + item, 0), [items]);

      const decide = () => {
        if (count > 0) {
          for (const item of items) {
            if (item > 1 && item < 5) {
              if (total > 10 || item === count) {
                return item;
              }
            }
          }
        }

        return 0;
      };

      return (
        <section>
          {items.length > 0 && items.map((item) => <div key={item}>{item}</div>)}
          <span>{decide()}</span>
        </section>
      );
    }
  `;
  const sourceFile = ts.createSourceFile("Dashboard.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const analyzer = new ComplexityAnalyzer();
  const metrics = analyzer.analyzeFile(sourceFile, "/virtual/Dashboard.tsx");

  assert.ok(metrics.overallComplexity >= 12);
  assert.ok(metrics.scoreBreakdown.peakFunctionComplexity >= 7);
  assert.ok(metrics.scoreBreakdown.peakNestingDepth >= 4);
  assert.ok(metrics.scoreBreakdown.hookPressure >= 2);
  assert.ok(metrics.scoreBreakdown.elevatedFunctionCount >= 1);
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
      topHotSpots?: Array<{ path: string; displayPath: string; score: number; complexityDrivers?: string[] }>;
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
  assert.ok(jsonReport.decisionSummary?.topHotSpots?.every((item) => (item.complexityDrivers?.length ?? 0) >= 1));
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
  assert.match(markdownReport, /## 目次/u);
  assert.match(markdownReport, /## 要点/u);
  assert.match(markdownReport, /最初の 30 秒で読むべき情報だけを先頭に集約しています。/u);
  assert.match(markdownReport, /## 優先対応 Top 5/u);
  assert.match(markdownReport, /## 3x3 マトリクス要約/u);
  assert.match(markdownReport, /コード行数と複雑度の 3x3 マトリクスで、設計負債の位置を俯瞰します。/u);
  assert.match(markdownReport, /## ファイル種別分布/u);
  assert.match(markdownReport, /## リスク概況/u);
  assert.match(markdownReport, /\| 複雑度 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /\| 構造 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /\| 型安全性 \| \d+ \| \d+ \| \d+ \|/u);
  assert.match(markdownReport, /## 型安全性/u);
  assert.match(markdownReport, /### スコア上位ファイル/u);
  assert.match(markdownReport, /### 外部ライブラリ内訳/u);
  assert.match(markdownReport, /#### Runtime 外部ライブラリ Top 10/u);
  assert.match(markdownReport, /- react: \d+/u);
  assert.match(markdownReport, /\| 順位 \| ファイル \| severity \| 主因 \| score \| 複雑度 \| 依存 \| any \| Hooks \| クラスタ \| 推奨対応 \|/u);
  assert.match(markdownReport, /\| 1 \| src\/App\.tsx \|/u);
  assert.match(markdownReport, /### 最優先ファイルの補足/u);
  assert.match(markdownReport, /- \*\*score帯\*\*: /u);
  assert.match(markdownReport, /- \*\*複雑度内訳\*\*: weighted=/u);
  assert.match(markdownReport, /- \*\*推奨対応\*\*: /u);
  assert.match(markdownReport, /- \*\*複雑度リスク\*\*: 高=0, 中=0/u);
  assert.match(markdownReport, /- \*\*構造リスク\*\*: /u);
  assert.match(markdownReport, /- \*\*型安全性の警戒信号\*\*: /u);
  assert.match(markdownReport, /## 実行サマリー/u);
  assert.match(markdownReport, /- \*\*実行時間\*\*: 1234ms/u);
  assert.doesNotMatch(markdownReport, /recomputed##/u);
  assert.match(markdownReport, /0 件の種別 \d+ 件は省略しています。/u);
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
  assert.match(markdownReport, /\| src\/App\.tsx \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 4 \|/u);
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
  assert.ok(report.executionTimeMs >= 567);
  assert.equal(jsonReport.executionTimeMs, report.executionTimeMs);
  assert.ok(jsonReport.categories.some((category) => category.label === "テスト品質"));
  assert.ok(jsonReport.categories.some((category) =>
    category.metrics.some((metric) => metric.label === "TypeScript型エラー数"))
  );

  const markdownReport = await fs.readFile(path.join(outputDir, "quality_quality_report.md"), "utf8");
  const csvReport = await fs.readFile(path.join(outputDir, "quality_quality_summary.csv"), "utf8");
  const htmlReport = await fs.readFile(path.join(outputDir, "quality_quality_report.html"), "utf8");
  assert.match(markdownReport, /# React 出荷審査 品質レポート/u);
  assert.match(markdownReport, /## 判定凡例/u);
  assert.match(markdownReport, /## 要点/u);
  assert.match(markdownReport, /## 優先対応/u);
  assert.match(markdownReport, /## 不足証跡/u);
  assert.match(markdownReport, /前回比: N\/A（ベースライン未設定）/u);
  assert.match(markdownReport, /\| 観点 \| 自動 \| FAIL \| WARN \| PARTIAL \| 手動 \| 判定 \|/u);
  assert.match(markdownReport, /\| 優先度 \| 観点 \| 指標 \| 判定 \| 実績 \| 基準 \| 証跡種別 \| 信頼度 \| 主対象 \| 推奨アクション \| 要点 \|/u);
  assert.match(markdownReport, /\| 指標 \| 集計 \| 実績 \| 基準 \| 判定 \| 証跡種別 \| 信頼度 \| 主対象 \|/u);
  assert.match(markdownReport, /## セキュリティ品質/u);
  assert.match(csvReport, /^"Category","Metric","Aggregation","Automation","Actual","Threshold","Verdict","Summary"/mu);
  assert.match(htmlReport, /React 出荷審査 品質レポート/u);
  assert.match(htmlReport, /判定凡例/u);
  assert.match(htmlReport, /自動判定カバレッジ/u);

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
  assert.equal(requirementsMetric?.evidence?.[0]?.filePath, "requirements.csv");
  assert.equal(requirementsMetric?.evidence?.[0]?.value, "要件台帳");
  assert.equal(bugMetric?.verdict, "pass");
  assert.equal(bugMetric?.actual, "High=0, Medium=1, Low=2");
  assert.equal(functionalCategory?.verdict, "partial");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator renders automatic file evidences with project-relative paths", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-relative-paths-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".github", "workflows"), { recursive: true });
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
  await fs.writeFile(path.join(projectRoot, "README.md"), "# sample\n", "utf8");
  await fs.writeFile(path.join(projectRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "App.tsx"), "export const App = () => <main>app</main>;\n", "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "relative-paths",
    "--format",
    "json",
  ]);

  const report = JSON.parse(await fs.readFile(path.join(outputDir, "relative-paths_quality_report.json"), "utf8")) as QualityReport;
  const operationsCategory = report.categories.find((category) => category.id === "operations");
  const buildCategory = report.categories.find((category) => category.id === "build");
  const docsMetric = operationsCategory!.metrics.find((metric) => metric.id === "documentation_presence");
  const ciMetric = buildCategory!.metrics.find((metric) => metric.id === "ci_presence");
  const escapedRoot = projectRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  assert.equal(docsMetric?.evidence?.[0]?.filePath, "README.md");
  assert.equal(ciMetric?.evidence?.[0]?.filePath, ".github/workflows");
  assert.equal(docsMetric?.evidence?.[0]?.value, "README.md");
  assert.equal(ciMetric?.evidence?.[0]?.value, ".github/workflows");
  assert.doesNotMatch(docsMetric?.evidence?.[0]?.value ?? "", new RegExp(`^${escapedRoot}`));
  assert.doesNotMatch(ciMetric?.evidence?.[0]?.value ?? "", new RegExp(`^${escapedRoot}`));

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

test("QualityReportGenerator avoids double-counting nested JUnit suites", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-junit-nested-"));
  const outputDir = path.join(projectRoot, "out");
  const testResultsDir = path.join(projectRoot, "test-results");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
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
  await fs.writeFile(path.join(projectRoot, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(testResultsDir, "junit.xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<testsuites>",
    "  <testsuite name=\"root\" tests=\"2\" failures=\"1\" errors=\"0\" skipped=\"0\">",
    "    <testsuite name=\"child\" tests=\"2\" failures=\"1\" errors=\"0\" skipped=\"0\">",
    "      <testcase classname=\"value\" name=\"ok\" file=\"src/value.test.ts\"><system-out /></testcase>",
    "      <testcase classname=\"value\" name=\"ng\" file=\"src/value.test.ts\"><failure message=\"ng\" /></testcase>",
    "    </testsuite>",
    "  </testsuite>",
    "</testsuites>",
  ].join("\n"), "utf8");

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: [],
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 10,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "nested-junit",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const unitPassMetric = testCategory?.metrics.find((metric) => metric.id === "unit_pass_rate");

  assert.equal(unitPassMetric?.actual, "50.0%");
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "総テスト数" && item.value === "2"));
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "失敗数" && item.value === "1"));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator counts self-closing JUnit testcases correctly", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-junit-selfclosing-"));
  const outputDir = path.join(projectRoot, "out");
  const testResultsDir = path.join(projectRoot, "test-results");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
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
  await fs.writeFile(path.join(projectRoot, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(testResultsDir, "junit.xml"), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<testsuites>",
    "  <testsuite name=\"unit\" tests=\"3\" failures=\"0\" errors=\"0\" skipped=\"1\">",
    "    <testcase classname=\"value\" name=\"ok1\" file=\"src/value.test.ts\"/>",
    "    <testcase classname=\"value\" name=\"ok2\" file=\"src/value.test.ts\" />",
    "    <testcase classname=\"value\" name=\"sk\" file=\"src/value.test.ts\"><skipped/></testcase>",
    "  </testsuite>",
    "</testsuites>",
  ].join("\n"), "utf8");

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: [],
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 10,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "selfclosing-junit",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const unitPassMetric = testCategory?.metrics.find((metric) => metric.id === "unit_pass_rate");

  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "総テスト数" && item.value === "3"));
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "失敗数" && item.value === "0"));
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "スキップ数" && item.value === "1"));
  // スキップは分母から除外されるため、失敗 0 件なら通過率 100% で pass になる
  assert.equal(unitPassMetric?.actual, "100.0%");
  assert.equal(unitPassMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator ignores non-executable helper files inside test directories", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-test-helpers-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "features"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "features", "__tests__"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "features", "UserCard.tsx"), [
    "export function UserCard() {",
    "  return <section>User</section>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "features", "__tests__", "UserCard.tsx"), [
    "import { render } from \"@testing-library/react\";",
    "import { UserCard } from \"../UserCard\";",
    "",
    "export function renderUserCard() {",
    "  return render(<UserCard />);",
    "}",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "helper-quality",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "helper-quality",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");

  assert.equal(overallMetric?.actual, "0.0%");
  assert.equal(overallMetric?.verdict, "fail");
  assert.equal(overallMetric?.evidence.find((item) => item.label === "static一致数")?.value, "0");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator classifies files relative to projectRoot even under test-like parent directories", async () => {
  const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-abs-path-"));
  const projectRoot = path.join(baseRoot, "test", "app");
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "features"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "features", "UserCard.tsx"), [
    "export function UserCard() {",
    "  return <section>User</section>;",
    "}",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "abs-path",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
      enableCache: false,
    },
  );
  const scanner = new FileScanner(config);
  const scanResult = await scanner.scanProject(projectRoot);
  const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graph = new GraphBuilder();
  const results = scanResult.parsed.map((parsed) => {
    const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
    return {
      filePath: parsed.filePath,
      complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
      dependencies: deps.dependencies,
      dependencyErrors: deps.errors,
    };
  });

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 10,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "abs-path",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");

  // 上位ディレクトリ名 "test" の影響で UserCard.tsx がテストファイル扱いになると
  // 対象ソースが 0 件になり actual が N/A になる。プロジェクト相対で分類されていれば
  // Feature としてテスト対象に数えられ、テスト未整備 (0.0% / fail) と判定される。
  assert.equal(overallMetric?.actual, "0.0%");
  assert.equal(overallMetric?.verdict, "fail");

  await fs.rm(baseRoot, { recursive: true, force: true });
});

test("QualityReportGenerator uses JUnit executed test files as runtime evidence", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-junit-runtime-"));
  const outputDir = path.join(projectRoot, "out");
  const reportsDir = path.join(projectRoot, "reports");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__"), { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import Page from \"../app/page\";",
    "",
    "test(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(reportsDir, "junit.xml"), [
    "<testsuites>",
    "  <testsuite name=\"unit\" tests=\"1\" failures=\"0\" errors=\"0\" skipped=\"0\">",
    "    <testcase name=\"Page\" file=\"src/__tests__/page.test.tsx\" />",
    "  </testsuite>",
    "</testsuites>",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "junit-runtime",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    testEvidenceResults: results,
    testEvidenceParsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "junit-runtime",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");

  assert.equal(overallMetric?.actual, "100.0%");
  assert.equal(overallMetric?.evidence.find((item) => item.label === "runtime一致数")?.value, "1");
  assert.equal(overallMetric?.evidence.find((item) => item.label === "static一致数")?.value, "0");
  assert.ok(overallMetric?.evidence.some((item) =>
    item.label === "runtime-test-link" && /junit:src\/__tests__\/page\.test\.tsx depth=0/u.test(item.value)
  ));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator uses Playwright executed test files as runtime evidence", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-playwright-runtime-"));
  const outputDir = path.join(projectRoot, "out");
  const reportDir = path.join(projectRoot, "playwright-report");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "tests", "e2e"), { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src", "tests"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "tests", "e2e", "page.spec.ts"), [
    "import { expect, test } from \"@playwright/test\";",
    "import Page from \"../../src/app/page\";",
    "",
    "test(\"Page\", async () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(reportDir, "results.json"), JSON.stringify({
    tests: [
      {
        location: {
          file: "tests/e2e/page.spec.ts",
        },
        results: [{ status: "passed" }],
      },
    ],
  }, null, 2), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "playwright-runtime",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    testEvidenceResults: results,
    testEvidenceParsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "playwright-runtime",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");

  assert.equal(overallMetric?.actual, "100.0%");
  assert.equal(overallMetric?.evidence.find((item) => item.label === "runtime一致数")?.value, "1");
  assert.ok(overallMetric?.evidence.some((item) =>
    item.label === "runtime-test-link" && /playwright:tests\/e2e\/page\.spec\.ts depth=0/u.test(item.value)
  ));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator applies custom test presence settings for callable test DSLs", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-custom-test-settings-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "page.case.tsx"), [
    "import { expect } from \"vitest\";",
    "import Page from \"../app/page\";",
    "",
    "scenario(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "custom-test-settings",
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

  const defaultReport = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "custom-test-settings-default",
    formats: ["json"],
  });

  const customReport = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
    testPresenceSettings: {
      thresholds: {
        application: { pass: 55, warn: 20 },
        "library-repo": { pass: 60, warn: 25 },
      },
      bucketWeights: {
        route: 5,
        feature: 4,
        form: 3,
        layout: 2,
        api: 2,
        schema: 2,
        validation: 2,
        hook: 2,
        context: 2,
        ui: 1,
        shared: 1,
      },
      staticImportTraversalMaxDepth: 3,
      runtimeLineCoverageMinPercent: 0,
      knownCallNames: ["scenario"],
      knownFrameworkModules: ["vitest", "jest", "@jest/globals", "@playwright/test", "cypress"],
    },
  }, {
    outputDir,
    prefix: "custom-test-settings-enabled",
    formats: ["json"],
  });

  const defaultMetric = defaultReport.categories
    .find((category) => category.id === "test")
    ?.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const customMetric = customReport.categories
    .find((category) => category.id === "test")
    ?.metrics.find((metric) => metric.id === "matching_test_file_presence");

  assert.equal(defaultMetric?.actual, "0.0%");
  assert.equal(defaultMetric?.verdict, "fail");
  assert.equal(customMetric?.actual, "100.0%");
  assert.equal(customMetric?.verdict, "pass");
  assert.equal(customMetric?.threshold, "PASS>=55% / WARN>=20%");
  assert.ok(customMetric?.evidence.some((item) =>
    item.label === "test-link" && /import:src\/__tests__\/page\.case\.tsx depth=0/u.test(item.value)
  ));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator prioritizes LCOV per-file evidence over static test links", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-lcov-priority-"));
  const outputDir = path.join(projectRoot, "out");
  const coverageDir = path.join(projectRoot, "coverage");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__"), { recursive: true });
  await fs.mkdir(coverageDir, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import Page from \"../app/page\";",
    "",
    "test(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(coverageDir, "lcov.info"), [
    "TN:",
    "SF:src/app/page.tsx",
    "LF:10",
    "LH:0",
    "end_of_record",
    "",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "lcov-priority",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "lcov-priority",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const routeMetric = testCategory?.metrics.find((metric) => metric.id === "route_test_file_presence");

  assert.equal(overallMetric?.actual, "0.0%");
  assert.equal(overallMetric?.verdict, "fail");
  assert.equal(routeMetric?.actual, "0.0%");
  assert.equal(routeMetric?.verdict, "fail");
  assert.equal(overallMetric?.evidence.find((item) => item.label === "runtime明示未一致数")?.value, "1");
  assert.ok(overallMetric?.evidence.some((item) =>
    item.label === "runtime-test-gap" && /lcov:0\/10/u.test(item.value)
  ));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator detects Vitest when JUnit XML is absent", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-vitest-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "vitest-sample",
    private: true,
    scripts: {
      test: "vitest run",
      "test:unit": "vitest",
    },
    devDependencies: {
      vitest: "^3.0.0",
    },
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "vitest.config.ts"), "export default {};\n", "utf8");
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
  await fs.writeFile(path.join(projectRoot, "src", "value.test.ts"), "import { describe, expect, test } from 'vitest';\nvoid describe; void expect; void test;\n", "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "vitest-quality",
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
    executionTimeMs: 500,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "vitest-quality",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const unitPassMetric = testCategory!.metrics.find((metric) => metric.id === "unit_pass_rate");

  assert.equal(unitPassMetric?.automation, "manual");
  assert.equal(unitPassMetric?.actual, "Vitest検出 / 結果未収集");
  assert.equal(unitPassMetric?.summary, "Vitest は検出されましたが、JUnit XML などの実行結果が見つからないため通過率は算出できません。");
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "vitest" && item.filePath === "package.json"));
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "vitest" && item.filePath === "vitest.config.ts"));
  assert.ok(unitPassMetric?.evidence.some((item) => item.label === "vitest-script" && /test:unit: vitest/u.test(item.value)));

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
  const i18nCategory = report.categories.find((category) => category.id === "i18n");
  const typeScriptErrorsMetric = codeCategory!.metrics.find((metric) => metric.id === "typescript_errors");
  const tsconfigTypeSafetyMetric = codeCategory!.metrics.find((metric) => metric.id === "tsconfig_type_safety");
  const typeEscapeMetric = codeCategory!.metrics.find((metric) => metric.id === "type_escape_count");
  const dangerousHtmlMetric = securityCategory!.metrics.find((metric) => metric.id === "dangerous_html");
  const secretIndicatorsMetric = securityCategory!.metrics.find((metric) => metric.id === "secret_indicators");
  const hardcodedTextMetric = i18nCategory!.metrics.find((metric) => metric.id === "hardcoded_jsx_text");

  assert.equal(typeScriptErrorsMetric?.actual, "0");
  assert.equal(typeScriptErrorsMetric?.verdict, "pass");
  assert.equal(tsconfigTypeSafetyMetric?.verdict, "pass");
  assert.match(tsconfigTypeSafetyMetric?.actual ?? "", /full=0\/1, strict=1\/1/u);
  assert.equal(typeEscapeMetric?.actual, "0");
  assert.equal(typeEscapeMetric?.verdict, "pass");
  assert.equal(dangerousHtmlMetric?.actual, "0");
  assert.equal(dangerousHtmlMetric?.verdict, "pass");
  assert.equal(secretIndicatorsMetric?.actual, "0");
  assert.equal(secretIndicatorsMetric?.verdict, "pass");
  assert.equal(hardcodedTextMetric?.actual, "0");
  assert.equal(hardcodedTextMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator weights unsafe type escapes and tsconfig gaps", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-type-safety-quality-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "src", "api"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "features"), { recursive: true });

  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "api", "client.ts"), `
    // @ts-expect-error temporary coercion
    export const client = JSON.parse("{}") as unknown as { id: string };
  `, "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "features", "screen.ts"), `
    import { client } from "../api/client";
    export function screen(props: unknown) {
      const unsafe = props as any;
      return unsafe ?? client;
    }
  `, "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "index.ts"), `
    export { client } from "./api/client";
    export { screen } from "./features/screen";
  `, "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "type-safety-quality",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "type-safety-quality",
    formats: ["json"],
  });

  const codeCategory = report.categories.find((category) => category.id === "code");
  const strictnessMetric = codeCategory?.metrics.find((metric) => metric.id === "tsconfig_type_safety");
  const typeEscapeMetric = codeCategory?.metrics.find((metric) => metric.id === "type_escape_count");

  assert.equal(strictnessMetric?.verdict, "pass");
  assert.match(strictnessMetric?.actual ?? "", /full=0\/1, strict=1\/1/u);
  assert.equal(typeEscapeMetric?.verdict, "fail");
  assert.doesNotMatch(typeEscapeMetric?.actual ?? "", /^0$/u);
  assert.match(typeEscapeMetric?.summary ?? "", /unsafe assertion/u);
  assert.ok((typeEscapeMetric?.evidence.length ?? 0) >= 1);
  assert.ok(typeEscapeMetric?.evidence.some((evidence) => evidence.filePath?.endsWith(path.join("src", "api", "client.ts"))));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator uses test imports as coverage evidence and ignores story files and storybook support noise", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-heuristics-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "components", "ui"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "shared"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "forms"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".storybook", "components"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src", ".storybook"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Input.tsx"), [
    "type InputProps = { placeholder?: string; title?: string; lang?: string };",
    "export function Input(props: InputProps) {",
    "  return <input {...props} />;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "shared", "TextField.tsx"), [
    "import { Input } from \"../ui/Input\";",
    "",
    "type TextFieldProps = { placeholder?: string; title?: string };",
    "",
    "export function TextField(props: TextFieldProps) {",
    "  return <Input {...props} lang=\"en\" />;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "forms", "InputName.tsx"), [
    "import { TextField } from \"../shared/TextField\";",
    "",
    "export function InputName() {",
    "  return <TextField placeholder=\"1970\" title=\"1\" />;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Input.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import { Input } from \"./Input\";",
    "",
    "test(\"Input\", () => {",
    "  expect(Input).toBeDefined();",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "InputName.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import { InputName } from \"../components/forms/InputName\";",
    "",
    "test(\"InputName\", () => {",
    "  expect(InputName).toBeDefined();",
    "});",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Input.stories.tsx"), [
    "import { Input } from \"./Input\";",
    "",
    "export const Primary = () => <Input placeholder=\"1970\" title=\"1\" />;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "shared", "TextField.stories.tsx"), [
    "import { TextField } from \"./TextField\";",
    "",
    "export const Primary = () => <TextField placeholder=\"1970\" title=\"1\" />;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "forms", "InputName.stories.tsx"), [
    "import { InputName } from \"./InputName\";",
    "",
    "export const Primary = () => <InputName />;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, ".storybook", "components", "SBMermaid.tsx"), [
    "import { useEffect, useMemo, useReducer, useRef, useState } from \"react\";",
    "",
    "export function SBMermaid() {",
    "  const ref = useRef<HTMLDivElement | null>(null);",
    "  const [count, setCount] = useState(0);",
    "  const [flag, toggle] = useReducer((value) => !value, false);",
    "  const items = useMemo(() => [\"story helper\"], []);",
    "  useEffect(() => {",
    "    if (ref.current) {",
    "      setCount(ref.current.childElementCount);",
    "    }",
    "  }, []);",
    "  return (",
    "    <section ref={ref}>",
    "      <header>Storybook helper text</header>",
    "      <button onClick={toggle}>toggle</button>",
    "      <div>{items.join(\",\")}</div>",
    "      <footer>{String(flag)}:{count}</footer>",
    "    </section>",
    "  );",
    "}",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-heuristics",
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
    executionTimeMs: 222,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-heuristics",
    formats: ["json"],
  });

  const uiCategory = report.categories.find((category) => category.id === "uiux");
  const codeCategory = report.categories.find((category) => category.id === "code");
  const testCategory = report.categories.find((category) => category.id === "test");
  const i18nCategory = report.categories.find((category) => category.id === "i18n");

  const designSystemMetric = uiCategory!.metrics.find((metric) => metric.id === "design_system_usage_rate");
  const bespokeMetric = uiCategory!.metrics.find((metric) => metric.id === "bespoke_ui_file_count");
  const responsibilityMetric = codeCategory!.metrics.find((metric) => metric.id === "high_responsibility_components");
  const testPresenceMetric = testCategory!.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const hardcodedTextMetric = i18nCategory!.metrics.find((metric) => metric.id === "hardcoded_jsx_text");

  assert.equal(designSystemMetric?.actual, "100.0%");
  assert.equal(designSystemMetric?.verdict, "pass");
  assert.equal(bespokeMetric?.actual, "0");
  assert.equal(bespokeMetric?.verdict, "pass");
  assert.equal(responsibilityMetric?.actual, "0");
  assert.equal(responsibilityMetric?.verdict, "pass");
  assert.equal(testPresenceMetric?.actual, "80.0%");
  assert.equal(testPresenceMetric?.verdict, "pass");
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "UI重み" && item.value === "1.0 / 2.0 (50.0%)"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "Form重み" && item.value === "3.0 / 3.0 (100.0%)"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "static一致数" && item.value === "2"));
  assert.ok(testPresenceMetric?.evidence.some((item) =>
    item.label === "test-link" && /import:src\/__tests__\/InputName\.test\.tsx depth=0/u.test(item.value)
  ));
  assert.equal(hardcodedTextMetric?.actual, "0");
  assert.equal(hardcodedTextMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator keeps static evidence through test helper files without expanding into full production transitive closure", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-helper-static-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__", "helpers"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "import { Card } from \"../ui/Card\";",
    "",
    "export default function Page() {",
    "  return <Card />;",
    "}",
  ].join("\n"), "utf8");
  await fs.mkdir(path.join(projectRoot, "src", "ui"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "src", "ui", "Card.tsx"), "export function Card() { return <section />; }\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "helpers", "renderPage.tsx"), [
    "import Page from \"../../app/page\";",
    "export function renderPage() {",
    "  return Page;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import { renderPage } from \"./helpers/renderPage\";",
    "",
    "test(\"Page\", () => {",
    "  expect(renderPage()).toBeDefined();",
    "});",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-helper-static",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 50,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-helper-static",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const testPresenceMetric = testCategory!.metrics.find((metric) => metric.id === "matching_test_file_presence");

  assert.equal(testPresenceMetric?.actual, "83.3%");
  assert.ok(testPresenceMetric?.evidence.some((item) =>
    item.label === "test-link" && /import:src\/__tests__\/page\.test\.tsx depth=1/u.test(item.value)
  ));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "証跡未検出数" && item.value === "1"));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator ignores unused design-system imports when JSX does not use them", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-unused-ds-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "ui"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Button.tsx"), "export function Button() { return <button />; }\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "import { Button } from \"../components/ui/Button\";",
    "",
    "export default function Page() {",
    "  void Button;",
    "  return <main>plain page</main>;",
    "}",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-unused-ds",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 50,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-unused-ds",
    formats: ["json"],
  });

  const uiCategory = report.categories.find((category) => category.id === "uiux");
  const designSystemMetric = uiCategory!.metrics.find((metric) => metric.id === "design_system_usage_rate");
  const bespokeMetric = uiCategory!.metrics.find((metric) => metric.id === "bespoke_ui_file_count");

  assert.equal(designSystemMetric?.actual, "0.0%");
  assert.equal(designSystemMetric?.verdict, "fail");
  assert.equal(bespokeMetric?.actual, "1");
  assert.equal(bespokeMetric?.verdict, "warn");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator weights route and feature coverage above UI primitives", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-weighted-tests-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: [],
  }, null, 2), "utf8");

  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "app", "page.tsx"), { name: "Page" }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "UserCard.tsx"), { name: "UserCard" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "ui", "Dialog.tsx"), { name: "DialogCloseButton" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "ui", "Dialog.test.tsx"), { name: "DialogTest" }),
  ];

  const qualityReportGenerator = new QualityReportGenerator();
  const report = await qualityReportGenerator.generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 144,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-weighted-tests",
    formats: ["json"],
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const testPresenceMetric = testCategory!.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const routeMetric = testCategory!.metrics.find((metric) => metric.id === "route_test_file_presence");
  const featureMetric = testCategory!.metrics.find((metric) => metric.id === "feature_test_file_presence");
  const formMetric = testCategory!.metrics.find((metric) => metric.id === "form_test_file_presence");
  const uiMetric = testCategory!.metrics.find((metric) => metric.id === "ui_test_file_presence");

  assert.equal(testPresenceMetric?.actual, "10.0%");
  assert.equal(testPresenceMetric?.verdict, "fail");
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "対象重み" && item.value === "10.0"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "テストあり重み" && item.value === "1.0"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "Route重み" && item.value === "0.0 / 5.0 (0.0%)"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "Feature重み" && item.value === "0.0 / 4.0 (0.0%)"));
  assert.ok(testPresenceMetric?.evidence.some((item) => item.label === "UI重み" && item.value === "1.0 / 1.0 (100.0%)"));
  assert.equal(routeMetric?.actual, "0.0%");
  assert.equal(routeMetric?.verdict, "fail");
  assert.equal(featureMetric?.actual, "0.0%");
  assert.equal(featureMetric?.verdict, "fail");
  assert.equal(formMetric?.actual, "対象ソースなし");
  assert.equal(formMetric?.verdict, "not_applicable");
  assert.equal(uiMetric?.actual, "100.0%");
  assert.equal(uiMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator marks partially automated categories as PARTIAL when automatic findings are clean", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-partial-clean-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "ui"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".github", "workflows"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");
  await fs.writeFile(path.join(projectRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "react-env.d.ts"), [
    "type ElementProps = {",
    "  children?: unknown;",
    "  [key: string]: unknown;",
    "};",
    "",
    "declare namespace JSX {",
    "  interface IntrinsicElements {",
    "    [elemName: string]: ElementProps;",
    "  }",
    "}",
    "",
    "declare module \"react/jsx-runtime\" {",
    "  export const Fragment: unknown;",
    "  export function jsx(...args: unknown[]): unknown;",
    "  export function jsxs(...args: unknown[]): unknown;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Dialog.tsx"), [
    "export function DialogCloseButton() {",
    "  return <button type=\"button\">Close</button>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Dialog.stories.tsx"), [
    "import { DialogCloseButton } from \"./Dialog\";",
    "",
    "export const Primary = () => <DialogCloseButton />;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "import { DialogCloseButton } from \"../components/ui/Dialog\";",
    "",
    "export default function Page() {",
    "  return <main><DialogCloseButton /></main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import Page from \"./page\";",
    "",
    "test(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-partial-clean",
      outputFormats: ["json", "markdown"],
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
    executionTimeMs: 333,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-partial-clean",
    formats: ["json", "markdown"],
  });

  const operationsCategory = report.categories.find((category) => category.id === "operations");
  const buildCategory = report.categories.find((category) => category.id === "build");
  const i18nCategory = report.categories.find((category) => category.id === "i18n");
  const hardcodedTextMetric = i18nCategory!.metrics.find((metric) => metric.id === "hardcoded_jsx_text");
  const markdownReport = await fs.readFile(path.join(outputDir, "quality-partial-clean_quality_report.md"), "utf8");

  assert.equal(operationsCategory?.verdict, "partial");
  assert.equal(buildCategory?.verdict, "partial");
  assert.equal(report.summary.overallVerdict, "partial");
  assert.equal(report.summary.partialCount, 0);
  assert.ok((report.summary.partialCategoryCount ?? 0) > 0);
  assert.equal(hardcodedTextMetric?.actual, "0");
  assert.equal(hardcodedTextMetric?.verdict, "pass");
  assert.match(markdownReport, /- PARTIALカテゴリ: [1-9][0-9]*/u);
  assert.match(markdownReport, /- PARTIAL指標: 0/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator separates product and library i18n text in the same metric", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-partial-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "ui"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".github", "workflows"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");
  await fs.writeFile(path.join(projectRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "react-env.d.ts"), [
    "type ElementProps = {",
    "  children?: unknown;",
    "  [key: string]: unknown;",
    "};",
    "",
    "declare namespace JSX {",
    "  interface IntrinsicElements {",
    "    [elemName: string]: ElementProps;",
    "  }",
    "}",
    "",
    "declare module \"react/jsx-runtime\" {",
    "  export const Fragment: unknown;",
    "  export function jsx(...args: unknown[]): unknown;",
    "  export function jsxs(...args: unknown[]): unknown;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "import { DialogCloseButton } from \"../components/ui/Dialog\";",
    "",
    "export default function Page() {",
    "  return <main><h1>Welcome</h1><DialogCloseButton /></main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Dialog.tsx"), [
    "export function DialogCloseButton() {",
    "  return <button type=\"button\">Close</button>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "ui", "Dialog.stories.tsx"), [
    "import { DialogCloseButton } from \"./Dialog\";",
    "",
    "export const Primary = () => <DialogCloseButton />;",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import Page from \"./page\";",
    "",
    "test(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-partial",
      outputFormats: ["json", "markdown"],
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
    executionTimeMs: 333,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-partial",
    formats: ["json", "markdown"],
  });

  const operationsCategory = report.categories.find((category) => category.id === "operations");
  const buildCategory = report.categories.find((category) => category.id === "build");
  const i18nCategory = report.categories.find((category) => category.id === "i18n");
  const hardcodedTextMetric = i18nCategory!.metrics.find((metric) => metric.id === "hardcoded_jsx_text");

  assert.equal(operationsCategory?.verdict, "partial");
  assert.equal(buildCategory?.verdict, "partial");
  assert.equal(report.summary.overallVerdict, "warn");
  assert.equal(report.summary.partialCount, 0);
  assert.ok((report.summary.partialCategoryCount ?? 0) > 0);
  assert.equal(hardcodedTextMetric?.actual, "1");
  assert.equal(hardcodedTextMetric?.verdict, "warn");
  assert.match(hardcodedTextMetric?.summary ?? "", /製品文言 1 件、共通UIラベル 1 件/u);
  assert.ok(hardcodedTextMetric?.evidence.some((item) => item.label === "product-text"));
  assert.ok(hardcodedTextMetric?.evidence.some((item) => item.label === "library-text"));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator detects static JSX expression text bindings", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-i18n-expression-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "react-env.d.ts"), [
    "type ElementProps = {",
    "  children?: unknown;",
    "  [key: string]: unknown;",
    "};",
    "",
    "declare namespace JSX {",
    "  interface IntrinsicElements {",
    "    [elemName: string]: ElementProps;",
    "  }",
    "}",
    "",
    "declare module \"react/jsx-runtime\" {",
    "  export const Fragment: unknown;",
    "  export function jsx(...args: unknown[]): unknown;",
    "  export function jsxs(...args: unknown[]): unknown;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  const cta = \"Submit order\";",
    "  const helper = \"Need review\";",
    "  return <main><button title={helper}>{cta}</button></main>;",
    "}",
  ].join("\n"), "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromTSConfig(path.join(projectRoot, "tsconfig.json")),
    {
      outputDir,
      filePrefix: "quality-i18n-expression",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 20,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "quality-i18n-expression",
    formats: ["json"],
  });

  const i18nCategory = report.categories.find((category) => category.id === "i18n");
  const hardcodedTextMetric = i18nCategory!.metrics.find((metric) => metric.id === "hardcoded_jsx_text");

  assert.equal(hardcodedTextMetric?.actual, "2");
  assert.ok(hardcodedTextMetric?.evidence.some((item) => item.label === "product-text" && /\{Submit order\}/u.test(item.value)));
  assert.ok(hardcodedTextMetric?.evidence.some((item) => item.label === "product-text" && /title=\{Need review\}/u.test(item.value)));

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
      derivedMetricCount: 0,
      passCount: 1,
      partialCount: 0,
      partialCategoryCount: 0,
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
            aggregation: "primary",
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
            aggregation: "primary",
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
      derivedMetricCount: 0,
      passCount: 1,
      partialCount: 0,
      partialCategoryCount: 0,
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
            aggregation: "primary",
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
            aggregation: "primary",
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
            aggregation: "primary",
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

test("CLI quality gate ignores derived automatic failures when primary metrics pass", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-gate-derived-only-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "components", "ui"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "README.md"), "# Release checklist\n", "utf8");
  for (let index = 0; index < 20; index += 1) {
    const componentName = `Dialog${index}`;
    await fs.writeFile(
      path.join(projectRoot, "src", "components", "ui", `${componentName}.tsx`),
      `export function ${componentName}() { return null; }\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(projectRoot, "src", "components", "ui", `${componentName}.test.tsx`),
      [
        "import { expect, test } from \"vitest\";",
        `import { ${componentName} } from "./${componentName}";`,
        "",
        `test("${componentName}", () => {`,
        `  expect(${componentName}).toBeDefined();`,
        "});",
      ].join("\n"),
      "utf8",
    );
  }
  await fs.writeFile(
    path.join(projectRoot, "src", "app", "page.tsx"),
    [
      "import { Dialog0 } from \"../components/ui/Dialog0\";",
      "",
      "export default function Page() {",
      "  return Dialog0();",
      "}",
    ].join("\n"),
    "utf8",
  );

  const result = await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "gate",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "derived-only",
    "--format",
    "json",
  ]);

  assert.match(result.stdout, /Quality analysis completed/u);

  const report = JSON.parse(
    await fs.readFile(path.join(outputDir, "derived-only_quality_report.json"), "utf8"),
  ) as QualityReport;
  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const routeMetric = testCategory?.metrics.find((metric) => metric.id === "route_test_file_presence");

  assert.equal(report.summary.failCount, 0);
  assert.equal(report.summary.totalMetrics + report.summary.derivedMetricCount, testCategory ? report.categories.flatMap((category) => category.metrics).length : 0);
  assert.equal(overallMetric?.verdict, "pass");
  assert.equal(routeMetric?.aggregation, "derived");
  assert.equal(routeMetric?.verdict, "fail");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI quality collect keeps test evidence under source-only and matches __tests__ imports", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-source-only-tests-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.mkdir(path.join(projectRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src", "__tests__"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "app", "page.tsx"), [
    "export default function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "__tests__", "page.test.tsx"), [
    "import { expect, test } from \"vitest\";",
    "import Page from \"../app/page\";",
    "",
    "test(\"Page\", () => {",
    "  expect(Page).toBeDefined();",
    "});",
  ].join("\n"), "utf8");

  await execFileAsync("node", [
    path.join(workspaceRoot, "dist", "src", "cli.js"),
    "quality",
    "collect",
    projectRoot,
    "--analysis-scope",
    "source-only",
    "--output",
    outputDir,
    "--prefix",
    "source-only-tests",
    "--format",
    "json",
  ]);

  const report = JSON.parse(
    await fs.readFile(path.join(outputDir, "source-only-tests_quality_report.json"), "utf8"),
  ) as QualityReport;
  const testCategory = report.categories.find((category) => category.id === "test");
  const overallMetric = testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence");
  const routeMetric = testCategory?.metrics.find((metric) => metric.id === "route_test_file_presence");

  assert.equal(overallMetric?.actual, "100.0%");
  assert.equal(overallMetric?.verdict, "pass");
  assert.equal(routeMetric?.actual, "100.0%");
  assert.equal(routeMetric?.verdict, "pass");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityDiffGenerator excludes derived regressions from primary summary counts", () => {
  const generator = new QualityDiffGenerator();
  const baseline: QualityReport = {
    timestamp: "2026-03-20T00:00:00.000Z",
    executionTimeMs: 100,
    projectRoot: "/tmp/project",
    summary: {
      totalMetrics: 1,
      derivedMetricCount: 1,
      passCount: 1,
      partialCount: 0,
      partialCategoryCount: 0,
      warnCount: 0,
      failCount: 0,
      manualCount: 0,
      notApplicableCount: 0,
      overallVerdict: "pass",
    },
    categories: [
      {
        id: "test",
        label: "テスト品質",
        verdict: "pass",
        summary: "総合テストは合格",
        metrics: [
          {
            id: "matching_test_file_presence",
            category: "test",
            label: "対応テストファイル存在率",
            aggregation: "primary",
            actual: "85.0%",
            threshold: ">= 80%",
            verdict: "pass",
            automation: "automatic",
            summary: "総合指標",
            evidence: [],
          },
          {
            id: "route_test_file_presence",
            category: "test",
            label: "Routeテスト対応率",
            aggregation: "derived",
            actual: "100.0%",
            threshold: ">= 80%",
            verdict: "pass",
            automation: "automatic",
            summary: "診断指標",
            evidence: [],
          },
        ],
      },
    ],
  };
  const current: QualityReport = {
    timestamp: "2026-03-26T00:00:00.000Z",
    executionTimeMs: 120,
    projectRoot: "/tmp/project",
    summary: {
      totalMetrics: 1,
      derivedMetricCount: 1,
      passCount: 1,
      partialCount: 0,
      partialCategoryCount: 0,
      warnCount: 0,
      failCount: 0,
      manualCount: 0,
      notApplicableCount: 0,
      overallVerdict: "pass",
    },
    categories: [
      {
        id: "test",
        label: "テスト品質",
        verdict: "pass",
        summary: "総合テストは合格",
        metrics: [
          {
            id: "matching_test_file_presence",
            category: "test",
            label: "対応テストファイル存在率",
            aggregation: "primary",
            actual: "85.0%",
            threshold: ">= 80%",
            verdict: "pass",
            automation: "automatic",
            summary: "総合指標",
            evidence: [],
          },
          {
            id: "route_test_file_presence",
            category: "test",
            label: "Routeテスト対応率",
            aggregation: "derived",
            actual: "0.0%",
            threshold: ">= 80%",
            verdict: "fail",
            automation: "automatic",
            summary: "診断指標",
            evidence: [],
          },
        ],
      },
    ],
  };

  const diff = generator.compare(current, baseline, "/tmp/baseline-quality.json", "/tmp/current-quality.json");
  const routeDiff = diff.metrics.find((metric) => metric.id === "route_test_file_presence");

  assert.equal(routeDiff?.trend, "regressed");
  assert.equal(routeDiff?.currentAggregation, "derived");
  assert.equal(diff.summary.regressedMetrics, 0);
  assert.equal(diff.summary.automaticRegressions, 0);
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
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), [
    "import { expect, test } from \"vitest\";",
    "import { appName } from './App';",
    "",
    "test('appName', () => {",
    "  expect(appName).toBe('release');",
    "});",
    "",
  ].join("\n"), "utf8");
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
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), [
    "import { expect, test } from \"vitest\";",
    "import { appName } from './App';",
    "",
    "test('appName', () => {",
    "  expect(appName).toBe('release');",
    "});",
    "",
  ].join("\n"), "utf8");
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
  await fs.writeFile(path.join(projectRoot, "src", "App.test.ts"), [
    "import { expect, test } from \"vitest\";",
    "import { appName } from './App';",
    "",
    "test('appName', () => {",
    "  expect(appName).toBe('release');",
    "});",
    "",
  ].join("\n"), "utf8");
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
    createAnalysisResult(path.join(projectRoot, "test", "bundling", "scripts", "fixtureTemplateValues.js")),
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
  assert.match(filesCsv, /test\/bundling\/scripts\/fixtureTemplateValues\.js,Test,/u);
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
    createAnalysisResult(path.join(projectRoot, "packages", "mui-material", "src", "Button", "Button.tsx"), { name: "Button" }),
    createAnalysisResult(path.join(projectRoot, "packages", "mui-material", "src", "Button", "index.ts")),
    createAnalysisResult(path.join(projectRoot, "packages", "mui-material", "src", "Slider", "useSlider.ts")),
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
  assert.match(filesCsv, /packages\/mui-material\/src\/Button\/Button\.tsx,UI component,No,S-L,/u);
  assert.match(filesCsv, /packages\/mui-material\/src\/Button\/index\.ts,Barrel,No,S-L,/u);
  assert.match(filesCsv, /packages\/mui-material\/src\/Slider\/useSlider\.ts,Hook,No,S-L,/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("CLI analyze applies source-only analysis scope before report generation", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-source-scope-"));
  const outputDir = path.join(projectRoot, "out");
  const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");

  await fs.mkdir(path.join(projectRoot, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "test"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".storybook"), { recursive: true });

  await fs.writeFile(path.join(projectRoot, "src", "components", "Button.tsx"), "export const Button = () => <button />;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "test", "Button.test.tsx"), "export const testCase = 1;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "src", "components", "Button.stories.tsx"), "export const Story = {};\n", "utf8");
  await fs.writeFile(path.join(projectRoot, ".storybook", "main.ts"), "export default {};\n", "utf8");

  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    projectRoot,
    "--output",
    outputDir,
    "--prefix",
    "source-scope",
    "--analysis-scope",
    "source-only",
    "--format",
    "json",
  ]);

  const report = JSON.parse(
    await fs.readFile(path.join(outputDir, "source-scope_report.json"), "utf8"),
  ) as PersistedAnalysisReport;

  assert.equal(report.statistics.fileCount, 1);
  assert.equal(report.files.length, 1);
  assert.match(report.files[0]?.path ?? "", /src\/components\/Button\.tsx$/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer scopes root files when includedFilePaths are provided", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-scope-"));
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });

  const okFile = path.join(srcDir, "ok.ts");
  const brokenFile = path.join(srcDir, "broken.ts");
  const tsConfigPath = path.join(projectRoot, "tsconfig.json");

  await fs.writeFile(okFile, "export const ok: string = 'ok';\n", "utf8");
  await fs.writeFile(brokenFile, "export const broken: string = 42;\n", "utf8");
  await fs.writeFile(tsConfigPath, JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const fullSummary = analyzer.analyzeProject(projectRoot, tsConfigPath);
  const scopedSummary = analyzer.analyzeProject(projectRoot, tsConfigPath, {
    includedFilePaths: [okFile],
  });

  assert.equal(fullSummary.totalErrors, 1);
  assert.equal(scopedSummary.totalErrors, 0);
  assert.equal(scopedSummary.checkedFiles, 1);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer keeps projectReferences during scoped type checks", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-project-refs-"));
  const srcDir = path.join(projectRoot, "src");
  const sharedDir = path.join(projectRoot, "packages", "shared", "src");
  const sharedRoot = path.join(projectRoot, "packages", "shared");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });

  const appFile = path.join(srcDir, "main.ts");
  const sharedFile = path.join(sharedDir, "index.ts");
  const tsConfigPath = path.join(projectRoot, "tsconfig.json");
  const sharedTsConfigPath = path.join(sharedRoot, "tsconfig.json");

  await fs.writeFile(sharedFile, "export const broken: string = 42;\nexport type Shared = { label: string };\n", "utf8");
  await fs.writeFile(path.join(sharedRoot, "package.json"), JSON.stringify({
    name: "shared",
    types: "./src/index.ts",
  }, null, 2), "utf8");
  await fs.writeFile(appFile, "import type { Shared } from \"shared\";\nexport const value: Shared = { label: \"ok\" };\n", "utf8");
  await fs.writeFile(sharedTsConfigPath, JSON.stringify({
    compilerOptions: {
      composite: true,
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
      strict: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf8");
  await fs.writeFile(tsConfigPath, JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      baseUrl: ".",
      paths: {
        shared: ["./packages/shared"],
      },
    },
    include: ["src/**/*.ts"],
    references: [{ path: "./packages/shared/tsconfig.json" }],
  }, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const summary = analyzer.analyzeProject(projectRoot, tsConfigPath, {
    includedFilePaths: [appFile],
  });

  assert.equal(summary.totalErrors, 1);
  assert.equal(summary.checkedFiles, 1);
  assert.equal(summary.issues[0]?.code, 6305);
  assert.ok(summary.issues[0]?.filePath.endsWith(path.join("src", "main.ts")));
  assert.ok(summary.issues.every((issue) => !issue.filePath.endsWith(path.join("packages", "shared", "src", "index.ts"))));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer discovers nested tsconfig files in monorepos", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-monorepo-"));
  const appARoot = path.join(projectRoot, "apps", "app-a");
  const appBRoot = path.join(projectRoot, "apps", "app-b");
  await fs.mkdir(path.join(appARoot, "src"), { recursive: true });
  await fs.mkdir(path.join(appBRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(appARoot, "src", "ok.ts"), "export const ok: string = 'ok';\n", "utf8");
  await fs.writeFile(path.join(appBRoot, "src", "broken.ts"), "export const broken: string = 42;\n", "utf8");

  const tsConfig = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src/**/*.ts"],
  };
  await fs.writeFile(path.join(appARoot, "tsconfig.json"), JSON.stringify(tsConfig, null, 2), "utf8");
  await fs.writeFile(path.join(appBRoot, "tsconfig.json"), JSON.stringify(tsConfig, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const summary = analyzer.analyzeProject(projectRoot);

  assert.equal(summary.totalErrors, 1);
  assert.equal(summary.checkedFiles, 2);
  assert.equal(summary.skippedReason, undefined);
  assert.ok(summary.issues.some((issue) => issue.filePath.endsWith(path.join("app-b", "src", "broken.ts"))));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer falls back to workspace discovery when an explicit root tsconfig is missing", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-fallback-"));
  const appRoot = path.join(projectRoot, "apps", "app-a");
  await fs.mkdir(path.join(appRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(appRoot, "src", "ok.ts"), "export const ok: string = 'ok';\n", "utf8");
  await fs.writeFile(path.join(appRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const summary = analyzer.analyzeProject(projectRoot, path.join(projectRoot, "tsconfig.json"));

  assert.equal(summary.totalErrors, 0);
  assert.equal(summary.checkedFiles, 1);
  assert.equal(summary.skippedReason, undefined);
  assert.equal(summary.strictnessSummary?.configCount, 1);
  assert.equal(summary.strictnessSummary?.strictConfigCount, 1);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer discovers tsconfig dot-variant files and ignores support-only base configs", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-dot-config-"));
  const appRoot = path.join(projectRoot, "apps", "app-a");
  await fs.mkdir(path.join(appRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(projectRoot, "tsconfig.base.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
  }, null, 2), "utf8");
  await fs.writeFile(path.join(appRoot, "src", "broken.ts"), "export const broken: string = 42;\n", "utf8");
  await fs.writeFile(path.join(appRoot, "tsconfig.json"), JSON.stringify({
    extends: "../../tsconfig.base.json",
    references: [{ path: "./tsconfig.app.json" }],
  }, null, 2), "utf8");
  await fs.writeFile(path.join(appRoot, "tsconfig.app.json"), JSON.stringify({
    extends: "../../tsconfig.base.json",
    include: ["src/**/*.ts"],
  }, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const summary = analyzer.analyzeProject(projectRoot);

  assert.equal(summary.totalErrors, 1);
  assert.equal(summary.checkedFiles, 1);
  assert.equal(summary.strictnessSummary?.configCount, 1);
  assert.ok(summary.strictnessSummary?.configs[0]?.tsConfigPath.endsWith(path.join("app-a", "tsconfig.app.json")));
  assert.ok(summary.issues.some((issue) => issue.filePath.endsWith(path.join("app-a", "src", "broken.ts"))));

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("TypeCheckAnalyzer skips oversized scoped type checks when maxRootNames is exceeded", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-typecheck-limit-"));
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });

  const fileA = path.join(srcDir, "a.ts");
  const fileB = path.join(srcDir, "b.ts");
  const tsConfigPath = path.join(projectRoot, "tsconfig.json");

  await fs.writeFile(fileA, "export const a = 1;\n", "utf8");
  await fs.writeFile(fileB, "export const b = 2;\n", "utf8");
  await fs.writeFile(tsConfigPath, JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["src/**/*.ts"],
  }, null, 2), "utf8");

  const analyzer = new TypeCheckAnalyzer();
  const summary = analyzer.analyzeProject(projectRoot, tsConfigPath, {
    includedFilePaths: [fileA, fileB],
    maxRootNames: 1,
  });

  assert.equal(summary.totalErrors, 0);
  assert.equal(summary.checkedFiles, 2);
  assert.match(summary.skippedReason ?? "", /上限 1 を超える/u);

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator marks TypeScript metric as manual when type check is skipped", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-typecheck-skip-"));
  const outputDir = path.join(projectRoot, "out");
  const srcDir = path.join(projectRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });

  await fs.writeFile(path.join(srcDir, "App.tsx"), "export const App = () => <main />;\n", "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    {
      outputDir,
      filePrefix: "quality-typecheck-skip",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
  }, {
    outputDir,
    prefix: "quality-typecheck-skip",
    formats: ["json"],
    onProgress: () => undefined,
  });

  const codeCategory = report.categories.find((category) => category.id === "code");
  const typeScriptMetric = codeCategory?.metrics.find((metric) => metric.id === "typescript_errors");

  assert.equal(typeScriptMetric?.verdict, "manual");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator applies library profile thresholds and emits workspace segments", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-library-profile-"));
  const outputDir = path.join(projectRoot, "out");
  await fs.mkdir(path.join(projectRoot, "apps", "demo"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "packages", "ui"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "packages", "core", "api"), { recursive: true });

  await fs.writeFile(path.join(projectRoot, "apps", "demo", "page.tsx"), "export default function Page() { return <main>Hello</main>; }\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "packages", "ui", "Button.tsx"), "export function Button() { return <button>Button</button>; }\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "packages", "ui", "Button.test.tsx"), "export const buttonTest = true;\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "packages", "core", "api", "client.ts"), "export async function client() { return fetch('/api'); }\n", "utf8");

  const configManager = new ConfigManager();
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    {
      outputDir,
      filePrefix: "library-profile",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
      qualityProfile: "library-repo",
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

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: scanResult.parsed,
    graphMetrics: buildGraphMetrics(graph, results),
    executionTimeMs: 100,
    qualityProfile: "library-repo",
    maxTypeCheckRootNames: 10,
  }, {
    outputDir,
    prefix: "library-profile",
    formats: ["json"],
    onProgress: () => undefined,
  });

  const testCategory = report.categories.find((category) => category.id === "test");
  const apiCategory = report.categories.find((category) => category.id === "api");
  const dependencyCategory = report.categories.find((category) => category.id === "dependencies");
  const segmentLabels = new Set((report.workspaceSegments ?? []).map((segment) => segment.label));

  assert.equal(report.qualityProfile, "library-repo");
  assert.ok(segmentLabels.has("apps/*"));
  assert.ok(segmentLabels.has("packages/*"));
  assert.equal(testCategory?.metrics.find((metric) => metric.id === "matching_test_file_presence")?.threshold, "PASS>=60% / WARN>=25%");
  assert.equal(apiCategory?.metrics.find((metric) => metric.id === "zod_adoption")?.verdict, "not_applicable");
  assert.equal(dependencyCategory?.metrics.find((metric) => metric.id === "external_package_count")?.threshold, "<= 80 / WARN<=160");

  await fs.rm(projectRoot, { recursive: true, force: true });
});

test("QualityReportGenerator emits feature summaries in quality reports", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-quality-features-"));
  const outputDir = path.join(projectRoot, "out");

  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: [],
  }, null, 2), "utf8");

  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "features", "user", "UserPage.tsx"), { name: "UserPage" }, {
      overallComplexity: 4,
    }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "user", "schemas", "user.schema.ts"), undefined, {
      overallComplexity: 2,
    }),
    createAnalysisResult(path.join(projectRoot, "src", "features", "billing", "BillingPage.tsx"), { name: "BillingPage" }, {
      overallComplexity: 7,
    }),
    createAnalysisResult(path.join(projectRoot, "tests", "features", "billing", "BillingPage.spec.tsx"), { name: "BillingPageSpec" }),
  ];

  const report = await new QualityReportGenerator().generateReports({
    projectRoot,
    analysisResults: results,
    parsedFiles: [],
    graphMetrics: createEmptyGraphMetrics(),
    executionTimeMs: 100,
    tsConfigPath: path.join(projectRoot, "tsconfig.json"),
  }, {
    outputDir,
    prefix: "feature-summary",
    formats: ["json", "markdown", "html"],
    onProgress: () => undefined,
  });

  const featureLabels = new Set((report.featureSummaries ?? []).map((feature) => feature.label));
  const userFeature = report.featureSummaries?.find((feature) => feature.label === "src/features/user");
  const billingFeature = report.featureSummaries?.find((feature) => feature.label === "src/features/billing");

  assert.ok(featureLabels.has("src/features/user"));
  assert.ok(featureLabels.has("src/features/billing"));
  assert.equal(userFeature?.fileCount, 2);
  assert.equal(userFeature?.averageComplexity, 3);
  assert.equal(userFeature?.maxComplexity, 4);
  assert.equal(billingFeature?.fileCount, 1);
  assert.equal(billingFeature?.weightedTestRate, 100);

  const markdownReport = await fs.readFile(path.join(outputDir, "feature-summary_quality_report.md"), "utf8");
  const htmlReport = await fs.readFile(path.join(outputDir, "feature-summary_quality_report.html"), "utf8");

  assert.match(markdownReport, /## フィーチャー内訳/u);
  assert.match(markdownReport, /### 規模と複雑度/u);
  assert.match(markdownReport, /### 品質リスク/u);
  assert.match(markdownReport, /\| src\/features\/user \| 2 \| 1 \| 3\.0 \| 4\.0 \|/u);
  assert.match(markdownReport, /\| src\/features\/billing \| 1 \| 1 \| 7\.0 \| 7\.0 \|/u);
  assert.match(htmlReport, /フィーチャー内訳/u);
  assert.match(htmlReport, /規模と複雑度/u);
  assert.match(htmlReport, /品質リスク/u);
  assert.match(htmlReport, /src\/features\/billing/u);

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
  assert.match(markdownReport, /外部依存、生成物、設定除外、要調査項目を分離して、調べるべきものだけが残るようにしています。/u);
  assert.match(markdownReport, /### 設定どおりの除外/u);
  assert.match(markdownReport, /### 要調査の除外/u);
  assert.match(markdownReport, /### スキャンエラー/u);
  assert.match(markdownReport, /### パースエラー/u);
  assert.match(markdownReport, /node_modules\/react\/index\.js \(Excluded pattern match\)/u);
  assert.match(markdownReport, /src\/huge\.ts \(File size exceeds 10485760 bytes\)/u);
  assert.match(markdownReport, /src\/broken\.ts \(EACCES: permission denied\)/u);
  assert.match(markdownReport, /src\/invalid\.tsx \(diagnostics=2\)/u);
  assert.match(markdownReport, /\| 1 \| src\/features\/order\/OrderPage\.tsx \| Critical \| 構造 \| 141 \|/u);
  assert.match(markdownReport, /- \*\*対象\*\*: src\/features\/order\/OrderPage\.tsx/u);
  assert.match(markdownReport, /- \*\*score帯\*\*: Critical/u);
  assert.match(markdownReport, /- \*\*複雑度内訳\*\*: weighted=17, peakFn=7, top3avg=6, nesting=3, hookPressure=2/u);
  assert.match(markdownReport, /- \*\*推奨対応\*\*: explicit anyの除去 \+ unsafe castの局所化/u);

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
      changed?: Array<{
        path: string;
        scoreDelta: number;
        currentDisplayPath: string;
        complexityDriverDelta?: string[];
        currentComplexityDrivers?: string[];
        baselineComplexityDrivers?: string[];
      }>;
      added?: Array<{ path: string; complexityDrivers?: string[] }>;
      removed?: Array<{ path: string; complexityDrivers?: string[] }>;
    };
    impact?: {
      impactedFiles?: string[];
      changedFiles?: string[];
      prioritizedFiles?: Array<{
        path: string;
        score: number;
        complexityPressure?: number;
        complexitySignals?: string[];
        reasons?: string[];
      }>;
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
  assert.ok(diffReport.impact?.prioritizedFiles?.some((item) =>
    item.path.endsWith(path.join("src", "App.tsx")) && (item.complexityPressure ?? 0) > 0
  ));
  assert.ok(diffReport.impact?.prioritizedFiles?.some((item) =>
    item.path.endsWith(path.join("src", "App.tsx")) && (item.complexitySignals?.some((signal) => signal.startsWith("weighted=+")) ?? false)
  ));
  assert.ok((diffReport.impact?.subtrees?.length ?? 0) >= 1);
  assert.ok(typeof diffReport.impact?.subtrees?.[0]?.metrics?.maxScore === "number");
  assert.ok((diffReport.hotSpotDelta?.changed?.length ?? 0) >= 1);
  assert.ok(diffReport.hotSpotDelta?.changed?.some((item) => item.path.endsWith(path.join("src", "App.tsx"))));
  assert.ok(diffReport.hotSpotDelta?.changed?.some((item) =>
    item.path.endsWith(path.join("src", "App.tsx")) && (item.complexityDriverDelta?.some((driver) => driver.startsWith("weighted=")) ?? false)
  ));
  assert.ok(diffReport.hotSpotDelta?.changed?.every((item) => (item.currentComplexityDrivers?.length ?? 0) >= 1));
  assert.ok(diffReport.hotSpotDelta?.changed?.every((item) => (item.baselineComplexityDrivers?.length ?? 0) >= 1));
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
  assert.match(diffHtml, /complexityPressure=/u);
  assert.match(diffHtml, /file:\/\//u);
  assert.match(diffHtml, /drivers=weighted=/u);
  assert.match(diffHtml, /Added Hot Spots/u);
  assert.match(diffHtml, /Removed Hot Spots/u);
  assert.match(diffHtml, /weighted=\+/u);
  assert.match(diffMarkdown, /## Hot Spot Delta/u);
  assert.match(diffMarkdown, /src\/App\.tsx scoreDelta=/u);
  assert.match(diffMarkdown, /drivers=weighted=/u);
  assert.match(diffMarkdown, /complexityPressure=/u);
  assert.match(diffMarkdown, /weighted=\+/u);

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
