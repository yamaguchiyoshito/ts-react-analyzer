import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditDirectoryPurposes,
  classifyFileType,
  FILE_TYPE_PURPOSES,
  getFileTypePurpose,
  KNOWN_FILE_TYPES,
  ReportGenerator,
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

function createAnalysisResult(
  filePath: string,
  options: {
    componentName?: string;
    functions?: FunctionMetrics[];
    hooks?: Array<{ name: string }>;
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
      components: options.componentName
        ? [{
          name: options.componentName,
          jsxElements: 1,
          hooksUsed: [],
          hookCount: 0,
          propsInterface: null,
          hasChildren: false,
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
        }]
        : [],
      hooks: (options.hooks ?? []).map((hook) => ({
        name: hook.name,
        startLine: 1,
        args: 0,
        hasDependencies: false,
      })),
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

function createDependency(source: string, target: string, isExternal: boolean): Dependency {
  return {
    source,
    target,
    type: "import",
    isExternal,
    modulePath: target,
    range: { start: 0, end: 0, line: 1, character: 1 },
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

test("FILE_TYPE_PURPOSES defines a purpose for every known file type", () => {
  assert.equal(FILE_TYPE_PURPOSES.length, KNOWN_FILE_TYPES.length);
  for (const fileType of KNOWN_FILE_TYPES) {
    const definition = getFileTypePurpose(fileType);
    assert.ok(definition, `missing purpose definition for ${fileType}`);
    assert.ok(definition!.purpose.length > 0);
    assert.ok(definition!.directoryHints.length > 0);
    assert.ok(definition!.expectation.length > 0);
  }

  const representativePaths = [
    "src/app/page.tsx",
    "src/schemas/user.schema.ts",
    "src/features/orders/OrderList.tsx",
    "src/validations/user.validator.ts",
    "src/layouts/Shell.tsx",
    "src/components/forms/LoginForm.tsx",
    "src/components/ui/Button.tsx",
    ".storybook/decorators.tsx",
    "src/contexts/AuthProvider.tsx",
    "src/hooks/useModal.ts",
    "src/api/client.ts",
    "src/utils/format.ts",
    "src/global.d.ts",
    "src/components/index.ts",
    "src/misc/legacy.ts",
    "src/App.test.tsx",
    "src/Button.stories.tsx",
    "tests/fixtures/user.fixture.ts",
    "vite.config.ts",
  ];
  for (const filePath of representativePaths) {
    const fileType = classifyFileType(filePath);
    assert.ok(getFileTypePurpose(fileType), `no purpose definition for ${fileType} (${filePath})`);
  }
});

test("auditDirectoryPurposes flags files that contradict their directory purpose", () => {
  const results: AnalysisResult[] = [
    createAnalysisResult("src/utils/Badge.tsx", { componentName: "Badge" }),
    createAnalysisResult("src/schemas/user.schema.ts", {
      dependencies: [createDependency("src/schemas/user.schema.ts", "react", true)],
    }),
    createAnalysisResult("src/components/index.ts", { functions: [createFunctionMetrics("legacyHelper")] }),
    createAnalysisResult("src/components/UserCard.tsx", {
      componentName: "UserCard",
      dependencies: [createDependency("src/components/UserCard.tsx", "src/api/client.ts", false)],
    }),
    createAnalysisResult("src/app/dashboard/page.tsx", { overallComplexity: 15 }),
    createAnalysisResult("src/hooks/useModal.tsx", { componentName: "ModalHost" }),
    createAnalysisResult("src/misc/legacy.ts", { codeLines: 60 }),
    createAnalysisResult("src/components/Button.tsx", { componentName: "Button" }),
  ];

  const audit = auditDirectoryPurposes(results);
  const rules = audit.findings.map((finding) => finding.rule);

  assert.ok(rules.includes("component-in-non-ui-layer"));
  assert.ok(rules.includes("react-in-data-layer"));
  assert.ok(rules.includes("implementation-in-barrel"));
  assert.ok(rules.includes("ui-depends-on-infrastructure"));
  assert.ok(rules.includes("heavy-logic-in-route"));
  assert.ok(rules.includes("jsx-in-hook"));
  assert.ok(rules.includes("unclassified-shared-growth"));
  assert.ok(!audit.findings.some((finding) => finding.filePath === "src/components/Button.tsx"));

  assert.equal(audit.summary.high, 2);
  assert.equal(audit.summary.medium, 4);
  assert.equal(audit.summary.low, 1);
  assert.equal(audit.findings.length, 7);

  const severities = audit.findings.map((finding) => finding.severity);
  const order = { high: 0, medium: 1, low: 2 } as const;
  for (let index = 1; index < severities.length; index += 1) {
    assert.ok(order[severities[index - 1]!] <= order[severities[index]!]);
  }

  for (const finding of audit.findings) {
    assert.ok(finding.purpose.length > 0);
    assert.ok(finding.issue.length > 0);
    assert.ok(finding.suggestion.length > 0);
  }
});

test("ReportGenerator emits directory purpose section and audit output", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-directory-purpose-"));
  const outputDir = path.join(projectRoot, "out");
  const results: AnalysisResult[] = [
    createAnalysisResult(path.join(projectRoot, "src", "utils", "Badge.tsx"), { componentName: "Badge" }),
    createAnalysisResult(path.join(projectRoot, "src", "components", "Button.tsx"), { componentName: "Button" }),
  ];

  const reportGenerator = new ReportGenerator();
  await reportGenerator.generateReports(results, createEmptyGraphMetrics(), {
    outputDir,
    prefix: "purpose",
    formats: ["json", "markdown"],
    complexityThreshold: 10,
    projectRoot,
  });

  const markdownReport = await fs.readFile(path.join(outputDir, "purpose_report.md"), "utf8");
  assert.match(markdownReport, /7\. ディレクトリ目的と改善提案/u);
  assert.match(markdownReport, /## ディレクトリ目的と改善提案/u);
  assert.match(markdownReport, /### 種別ごとの目的定義/u);
  assert.match(markdownReport, /\| Utils \| 特定機能に依存しない汎用処理を提供する \|/u);
  assert.match(markdownReport, /### 目的に沿った改善提案/u);
  assert.match(markdownReport, /\| src\/utils\/Badge\.tsx \| Utils \| high \|/u);

  const jsonReport = JSON.parse(await fs.readFile(path.join(outputDir, "purpose_report.json"), "utf8")) as {
    directoryPurposeAudit?: {
      findings: Array<{ filePath: string; rule: string; severity: string }>;
      summary: { high: number; medium: number; low: number };
    };
  };
  assert.equal(jsonReport.directoryPurposeAudit?.summary.high, 1);
  assert.equal(jsonReport.directoryPurposeAudit?.findings[0]?.filePath, "src/utils/Badge.tsx");
  assert.equal(jsonReport.directoryPurposeAudit?.findings[0]?.rule, "component-in-non-ui-layer");

  await fs.rm(projectRoot, { recursive: true, force: true });
});
