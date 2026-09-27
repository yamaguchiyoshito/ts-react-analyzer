import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditDirectoryPurposes,
  ComplexityAnalyzer,
  ConfigManager,
  DependencyAnalyzer,
  FileScanner,
  QualityReportGenerator,
  TestArtifactAnalyzer,
  TypeCheckAnalyzer,
} from "../src/core/index.js";
import type { AnalysisResult, Dependency, FunctionMetrics, GraphMetrics } from "../src/types/index.js";

function createFunctionMetrics(name: string): FunctionMetrics {
  return {
    name,
    cyclomaticComplexity: 2,
    startLine: 1,
    endLine: 5,
    lineCount: 5,
    branchCount: 1,
    loopCount: 0,
    ternaryCount: 0,
    logicalOpCount: 0,
    maxNestingDepth: 1,
    isAsync: false,
    params: [],
    riskLevel: "low",
  };
}

function createDependency(
  source: string,
  target: string,
  isExternal: boolean,
  isTypeOnly?: boolean,
): Dependency {
  return {
    source,
    target,
    type: "import",
    isExternal,
    modulePath: target,
    ...(isTypeOnly === undefined ? {} : { isTypeOnly }),
    range: { start: 0, end: 0, line: 1, character: 1 },
  };
}

function createAnalysisResult(
  filePath: string,
  options: {
    componentNames?: string[];
    functions?: FunctionMetrics[];
    hooks?: string[];
    dependencies?: Dependency[];
    codeLines?: number;
    overallComplexity?: number;
  } = {},
): AnalysisResult {
  return {
    filePath,
    complexity: {
      filePath,
      totalLines: (options.codeLines ?? 8) + 2,
      codeLines: options.codeLines ?? 8,
      commentLines: 1,
      functions: options.functions ?? [],
      components: (options.componentNames ?? []).map((name) => ({
        name,
        jsxElements: 1,
        hooksUsed: [],
        hookCount: 0,
        propsInterface: null,
        hasChildren: false,
        usesRef: false,
        isForwardRef: false,
        startLine: 1,
        endLine: 10,
        renderComplexity: { hasConditionalRender: false, hasListRender: false, fragmentCount: 0, complexity: 0 },
      })),
      hooks: (options.hooks ?? []).map((name) => ({ name, startLine: 1, args: 0, hasDependencies: false })),
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
      overallComplexity: options.overallComplexity ?? 1,
    },
    dependencies: options.dependencies ?? [],
    dependencyErrors: [],
  };
}

function rulesFor(results: AnalysisResult[], filePath: string, options?: Parameters<typeof auditDirectoryPurposes>[2]): string[] {
  return auditDirectoryPurposes(results, undefined, options).findings
    .filter((finding) => finding.filePath === filePath)
    .map((finding) => finding.rule);
}

test("auditDirectoryPurposes accepts a component folder index that defines its own component", () => {
  const folderIndex = createAnalysisResult("src/components/Button/index.tsx", { componentNames: ["Button"] });
  const mismatchedIndex = createAnalysisResult("src/components/Card/index.tsx", { componentNames: ["Avatar"] });
  const lowerCaseFolder = createAnalysisResult("src/components/button/index.tsx", { componentNames: ["Button"] });
  const barrelWithHelper = createAnalysisResult("src/components/index.ts", { functions: [createFunctionMetrics("legacyHelper")] });
  const results = [folderIndex, mismatchedIndex, lowerCaseFolder, barrelWithHelper];

  assert.deepEqual(rulesFor(results, "src/components/Button/index.tsx"), []);
  assert.deepEqual(rulesFor(results, "src/components/Card/index.tsx"), ["implementation-in-barrel"]);
  assert.deepEqual(rulesFor(results, "src/components/button/index.tsx"), ["implementation-in-barrel"]);
  assert.deepEqual(rulesFor(results, "src/components/index.ts"), ["implementation-in-barrel"]);
});

test("auditDirectoryPurposes ignores type-only React and infrastructure imports", () => {
  const schemaTypeOnly = createAnalysisResult("src/schemas/user.schema.ts", {
    dependencies: [createDependency("src/schemas/user.schema.ts", "react", true, true)],
  });
  const schemaRuntime = createAnalysisResult("src/schemas/order.schema.ts", {
    dependencies: [createDependency("src/schemas/order.schema.ts", "react", true, false)],
  });
  const schemaLegacyShape = createAnalysisResult("src/schemas/legacy.schema.ts", {
    dependencies: [createDependency("src/schemas/legacy.schema.ts", "react", true)],
  });
  const uiTypeOnly = createAnalysisResult("src/components/UserCard.tsx", {
    componentNames: ["UserCard"],
    dependencies: [createDependency("src/components/UserCard.tsx", "src/api/client.ts", false, true)],
  });
  const uiRuntime = createAnalysisResult("src/components/OrderCard.tsx", {
    componentNames: ["OrderCard"],
    dependencies: [createDependency("src/components/OrderCard.tsx", "src/api/client.ts", false)],
  });
  const results = [schemaTypeOnly, schemaRuntime, schemaLegacyShape, uiTypeOnly, uiRuntime];

  assert.deepEqual(rulesFor(results, "src/schemas/user.schema.ts"), []);
  assert.deepEqual(rulesFor(results, "src/schemas/order.schema.ts"), ["react-in-data-layer"]);
  // isTypeOnly が無い旧形式の依存はこれまでどおり実行時依存として扱う
  assert.deepEqual(rulesFor(results, "src/schemas/legacy.schema.ts"), ["react-in-data-layer"]);
  assert.deepEqual(rulesFor(results, "src/components/UserCard.tsx"), []);
  assert.deepEqual(rulesFor(results, "src/components/OrderCard.tsx"), ["ui-depends-on-infrastructure"]);
});

test("auditDirectoryPurposes derives route and shared limits from the configured complexity threshold", () => {
  const route = createAnalysisResult("src/app/dashboard/page.tsx", { overallComplexity: 15 });
  const lightRoute = createAnalysisResult("src/app/settings/page.tsx", { overallComplexity: 9 });
  const shared = createAnalysisResult("src/misc/legacy.ts", { codeLines: 10, overallComplexity: 6 });
  const results = [route, lightRoute, shared];

  // 既定値 (Route 12 / Shared 8) は従来どおり
  assert.deepEqual(rulesFor(results, "src/app/dashboard/page.tsx"), ["heavy-logic-in-route"]);
  assert.deepEqual(rulesFor(results, "src/app/settings/page.tsx"), []);
  assert.deepEqual(rulesFor(results, "src/misc/legacy.ts"), []);

  // complexityThreshold を渡すと Route はその値、Shared はその 2/3 (切り上げ) を上限にする
  assert.deepEqual(rulesFor(results, "src/app/dashboard/page.tsx", { complexityThreshold: 20 }), []);
  assert.deepEqual(rulesFor(results, "src/app/settings/page.tsx", { complexityThreshold: 8 }), ["heavy-logic-in-route"]);
  assert.deepEqual(rulesFor(results, "src/misc/legacy.ts", { complexityThreshold: 8 }), ["unclassified-shared-growth"]);

  // 個別の上限は complexityThreshold より優先される
  assert.deepEqual(
    rulesFor(results, "src/app/dashboard/page.tsx", { complexityThreshold: 20, routeComplexityLimit: 10 }),
    ["heavy-logic-in-route"],
  );
  const finding = auditDirectoryPurposes(results, undefined, { complexityThreshold: 8 }).findings
    .find((item) => item.filePath === "src/app/settings/page.tsx");
  assert.match(finding?.issue ?? "", /上限 8/u);
});

async function writeTsProject(projectRoot: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

const baseCompilerOptions = {
  strict: true,
  noEmit: true,
  target: "ES2020",
  module: "ESNext",
  moduleResolution: "Bundler",
  types: [],
};

test("TypeCheckAnalyzer reports zero checked files when the root-name limit skips the check", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accuracy-typecheck-limit-"));
  try {
    await writeTsProject(projectRoot, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b: string = 2;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: baseCompilerOptions, include: ["src/**/*.ts"] }),
    });

    const summary = new TypeCheckAnalyzer().analyzeProject(projectRoot, path.join(projectRoot, "tsconfig.json"), {
      maxRootNames: 1,
    });

    assert.equal(summary.checkedFiles, 0);
    assert.equal(summary.skippedFiles, 2);
    assert.equal(summary.totalErrors, 0);
    assert.match(summary.skippedReason ?? "", /上限 1 を超える/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("TypeCheckAnalyzer keeps the skip reason when only some tsconfigs were checked", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accuracy-typecheck-partial-"));
  try {
    await writeTsProject(projectRoot, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c: string = 3;\n",
      "scripts/build.ts": "export const build = () => 1;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: baseCompilerOptions, include: ["src/**/*.ts"] }),
      "tsconfig.node.json": JSON.stringify({ compilerOptions: baseCompilerOptions, include: ["scripts/**/*.ts"] }),
    });

    const analyzer = new TypeCheckAnalyzer();
    // tsconfig.json (3 ファイル) は上限超過でスキップ、tsconfig.node.json (1 ファイル) だけ検査される
    const partial = analyzer.analyzeProject(projectRoot, undefined, { maxRootNames: 2 });
    assert.equal(partial.checkedFiles, 1);
    assert.equal(partial.skippedFiles, 3);
    assert.equal(partial.totalErrors, 0);
    assert.ok(partial.skippedReason, "partial skip must be surfaced");
    assert.match(partial.skippedReason!, /tsconfig\.json: TypeScript 対象が 3 ファイルで上限 2 を超える/u);

    // 上限に収まれば両方検査され、スキップ理由は付かず c.ts の型エラーが出る
    const full = analyzer.analyzeProject(projectRoot, undefined, { maxRootNames: 10 });
    assert.equal(full.checkedFiles, 4);
    assert.equal(full.skippedReason, undefined);
    assert.equal(full.skippedFiles, undefined);
    assert.equal(full.totalErrors, 1);

    // 検査対象が元々無い tsconfig のスキップは、他が検査できていれば従来どおり表面化しない
    const scoped = analyzer.analyzeProject(projectRoot, undefined, {
      includedFilePaths: [path.join(projectRoot, "src", "a.ts")],
    });
    assert.equal(scoped.checkedFiles, 1);
    assert.equal(scoped.skippedReason, undefined);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

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

test("QualityReportGenerator does not report a pass when only part of the type check ran", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accuracy-quality-partial-typecheck-"));
  try {
    const outputDir = path.join(projectRoot, "out");
    await writeTsProject(projectRoot, {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c: string = 3;\n",
      "scripts/build.ts": "export const build = () => 1;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: baseCompilerOptions, include: ["src/**/*.ts"] }),
      "tsconfig.node.json": JSON.stringify({ compilerOptions: baseCompilerOptions, include: ["scripts/**/*.ts"] }),
    });

    const configManager = new ConfigManager();
    const config = configManager.mergeConfigs(configManager.getDefaults(), {
      outputDir,
      filePrefix: "quality-partial",
      outputFormats: ["json"],
      cacheDir: path.join(projectRoot, ".cache"),
      enableCache: false,
    });
    const scanResult = await new FileScanner(config).scanProject(projectRoot);
    const depAnalyzer = new DependencyAnalyzer(projectRoot, config.tsCompilerOptions);
    const complexityAnalyzer = new ComplexityAnalyzer();
    const results = scanResult.parsed.map((parsed) => {
      const deps = depAnalyzer.extractDependencies(parsed.sourceFile, parsed.filePath);
      return {
        filePath: parsed.filePath,
        complexity: complexityAnalyzer.analyzeFile(parsed.sourceFile, parsed.filePath),
        dependencies: deps.dependencies,
        dependencyErrors: deps.errors,
      };
    });
    assert.ok(results.some((result) => result.filePath.endsWith(path.join("scripts", "build.ts"))));

    // tsconfig.json (3 ファイル) は上限超過でスキップ、tsconfig.node.json (1 ファイル) だけ通る状況
    const report = await new QualityReportGenerator().generateReports({
      projectRoot,
      analysisResults: results,
      parsedFiles: scanResult.parsed,
      graphMetrics: createEmptyGraphMetrics(),
      executionTimeMs: 10,
      maxTypeCheckRootNames: 2,
    }, {
      outputDir,
      prefix: "quality-partial",
      formats: ["json"],
      onProgress: () => undefined,
    });

    const codeCategory = report.categories.find((category) => category.id === "code");
    const typeScriptMetric = codeCategory?.metrics.find((metric) => metric.id === "typescript_errors");
    assert.ok(typeScriptMetric);
    assert.notEqual(typeScriptMetric!.verdict, "pass");
    assert.ok(["warn", "manual"].includes(typeScriptMetric!.verdict), typeScriptMetric!.verdict);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("TestArtifactAnalyzer parses single-quoted JUnit attributes and ignores failures inside CDATA and output blocks", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accuracy-junit-"));
  try {
    await writeTsProject(projectRoot, {
      "junit.xml": [
        "<?xml version='1.0' encoding='UTF-8'?>",
        "<testsuites>",
        "  <testsuite name='suite' tests='4' failures='1' errors='0' skipped='1'>",
        "    <testcase name='ok' classname='a' file='src/a.test.ts' time='0.01'/>",
        "    <testcase name='bad' classname='a' time='0.02'>",
        "      <failure message='boom'><![CDATA[Expected <error> but got </testcase> <failure>]]></failure>",
        "    </testcase>",
        "    <testcase name='skip' classname='a'><skipped/></testcase>",
        "    <testcase name='noisy' classname='a'>",
        "      <system-out><![CDATA[<failure> printed in log]]></system-out>",
        "      <system-err>console: <error>not a real error</error></system-err>",
        "    </testcase>",
        "    <!-- <failure message=\"commented out\"/> -->",
        "  </testsuite>",
        "</testsuites>",
        "",
      ].join("\n"),
      "reports/results.xml": [
        "<testsuites>",
        "  <testsuite name = 'suite-only' tests = '5' failures='2' errors='1' skipped='1' file='src/b.test.ts'>",
        "    <system-out><![CDATA[<failure> <error> <skipped/>]]></system-out>",
        "  </testsuite>",
        "</testsuites>",
        "",
      ].join("\n"),
    });

    const summary = await new TestArtifactAnalyzer().analyzeProject(projectRoot);
    assert.ok(summary.junit);
    // junit.xml: testcase 4 件 (失敗 1 / スキップ 1 / 成功 2)、results.xml: suite 属性から 5 件 (失敗 3 / スキップ 1)
    assert.equal(summary.junit!.totalTests, 9);
    assert.equal(summary.junit!.failedTests, 4);
    assert.equal(summary.junit!.skippedTests, 2);
    assert.equal(summary.junit!.passedTests, 3);
    assert.deepEqual(summary.junit!.executedTestFiles, [
      path.join(projectRoot, "src", "a.test.ts"),
      path.join(projectRoot, "src", "b.test.ts"),
    ]);
    assert.deepEqual(summary.warnings, []);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("TestArtifactAnalyzer dedupes LCOV records that appear in several coverage files", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "accuracy-lcov-"));
  try {
    await writeTsProject(projectRoot, {
      "coverage/lcov.info": [
        "TN:",
        "SF:src/a.ts",
        "LF:10",
        "LH:5",
        "end_of_record",
        "",
      ].join("\n"),
      "lcov.info": [
        "TN:",
        "SF:src/a.ts",
        "LF:10",
        "LH:5",
        "end_of_record",
        "SF:src/b.ts",
        "LF:4",
        "LH:4",
        "end_of_record",
        "SF:src/b.ts",
        "LF:4",
        "LH:2",
        "end_of_record",
        "",
      ].join("\n"),
    });

    const summary = await new TestArtifactAnalyzer().analyzeProject(projectRoot);
    assert.ok(summary.coverage);
    assert.equal(summary.coverage!.files.length, 2);
    assert.deepEqual(
      summary.coverage!.sourceFiles.map((item) => [path.relative(projectRoot, item.filePath), item.lineFound, item.lineHit]),
      [["src/a.ts", 10, 5], ["src/b.ts", 4, 4]],
    );
    assert.equal(summary.coverage!.lineFound, 14);
    assert.equal(summary.coverage!.lineHit, 9);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
