import path from "node:path";
import ts from "typescript";

import type { TestArtifactAnalyzer } from "../TestArtifactAnalyzer.js";
import type { UiTestArtifactAnalyzer } from "../UiTestArtifactAnalyzer.js";
import { buildSourceMatchKeys, buildTestPathConventionKeys } from "../ReportUtils.js";
import type { AnalysisResult, ParsedFile } from "../../types/index.js";
import {
  TEST_PRESENCE_BUCKETS,
  type QualityAnalysisContext,
  type TestPresenceBucketSummary,
  type TestPresenceFileMatch,
  type TestPresenceSummary,
} from "./QualityReportModel.js";

/**
 * 「対応テストファイル存在率」の収集。LCOV の per-file 証跡 → JUnit / Playwright の
 * 実行済みテストファイル → 静的な import / 命名対応 の優先順で、ソースごとに
 * テスト証跡の有無と根拠を決める。
 */

export function collectTestPresence(
  ctx: QualityAnalysisContext,
  targetResults: AnalysisResult[],
  evidenceResults: AnalysisResult[],
  evidenceParsedFiles: ParsedFile[],
  coverageSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["coverage"],
  junitSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["junit"],
  playwrightSummary: Awaited<ReturnType<UiTestArtifactAnalyzer["analyzeProject"]>>["playwright"],
): TestPresenceSummary {
  const targetFiles = targetResults.filter((result) => isTestTargetFile(ctx, result.filePath));
  const staticMatches = collectStaticCoverageEvidence(ctx, evidenceResults, evidenceParsedFiles);
  const runtimeMatches = collectRuntimeCoverageEvidence(ctx, coverageSummary);
  const runtimeExecutionMatches = collectRuntimeTestExecutionEvidence(ctx, 
    evidenceResults,
    evidenceParsedFiles,
    [
      ...(junitSummary?.executedTestFiles ?? []).map((filePath) => ({ filePath, label: "junit" as const })),
      ...(playwrightSummary?.executedTestFiles ?? []).map((filePath) => ({ filePath, label: "playwright" as const })),
    ],
  );
  const buckets = TEST_PRESENCE_BUCKETS.map<TestPresenceBucketSummary>((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    targetFiles: 0,
    matchedFiles: 0,
    weightedTarget: 0,
    weightedMatched: 0,
    rate: 0,
  }));
  const bucketById = new Map(buckets.map((bucket) => [bucket.id, bucket]));

  let matchedFiles = 0;
  let weightedTarget = 0;
  let weightedMatched = 0;
  let staticMatchedFiles = 0;
  let runtimeMatchedFiles = 0;
  let runtimeExplicitUnmatchedFiles = 0;
  let noEvidenceUnmatchedFiles = 0;
  const matches: TestPresenceFileMatch[] = [];
  for (const result of targetFiles) {
    const weight = testCoverageWeight(ctx, result.filePath);
    const bucketId = testCoverageBucket(ctx, result.filePath);
    const bucket = bucketById.get(bucketId);
    const match = resolveTestPresenceMatch(ctx, result.filePath, bucketId, weight, staticMatches, runtimeMatches, runtimeExecutionMatches);
    weightedTarget += weight;
    bucket!.targetFiles += 1;
    bucket!.weightedTarget += weight;
    if (match.matched) {
      matchedFiles += 1;
      weightedMatched += weight;
      bucket!.matchedFiles += 1;
      bucket!.weightedMatched += weight;
    }
    if (match.matchedBy === "runtime") {
      if (match.matched) {
        runtimeMatchedFiles += 1;
      } else {
        runtimeExplicitUnmatchedFiles += 1;
      }
    } else if (match.matchedBy === "static" && match.matched) {
      staticMatchedFiles += 1;
    } else if (match.matchedBy === "none") {
      noEvidenceUnmatchedFiles += 1;
    }
    matches.push(match);
  }

  for (const bucket of buckets) {
    bucket.rate = bucket.weightedTarget > 0 ? (bucket.weightedMatched / bucket.weightedTarget) * 100 : 0;
  }

  return {
    targetFiles: targetFiles.length,
    matchedFiles,
    weightedTarget,
    weightedMatched,
    rate: weightedTarget > 0 ? (weightedMatched / weightedTarget) * 100 : 0,
    buckets,
    staticMatchedFiles,
    runtimeMatchedFiles,
    runtimeExplicitUnmatchedFiles,
    noEvidenceUnmatchedFiles,
    matches,
  };
}

export function collectStaticCoverageEvidence(
  ctx: QualityAnalysisContext,
  evidenceResults: AnalysisResult[],
  evidenceParsedFiles: ParsedFile[],
): Map<string, Set<string>> {
  const staticMatches = new Map<string, Set<string>>();
  const analysisByFile = new Map(evidenceResults.map((result) => [result.filePath, result]));
  const parsedByFile = new Map(evidenceParsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));

  for (const result of evidenceResults) {
    const parsedFile = parsedByFile.get(result.filePath);
    if (!isExecutableTestEvidence(ctx, result, parsedFile)) {
      continue;
    }

    const testLabel = ctx.toDisplayPath(result.filePath);
    for (const key of buildTestPathConventionKeys(result.filePath, ctx.projectRoot)) {
      addCoverageReason(staticMatches, key, `path:${testLabel}`);
    }

    for (const linkedFile of collectTransitivelyLinkedSourceFiles(ctx, result.filePath, analysisByFile)) {
      for (const key of buildSourceMatchKeys(linkedFile.filePath, ctx.projectRoot)) {
        addCoverageReason(staticMatches, key, `import:${testLabel} depth=${linkedFile.depth}`);
      }
    }
  }

  return staticMatches;
}

export function collectRuntimeCoverageEvidence(
  ctx: QualityAnalysisContext,
  coverageSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["coverage"],
): Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }> {
  const runtimeMatches = new Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }>();

  for (const sourceFile of coverageSummary?.sourceFiles ?? []) {
    for (const key of buildSourceMatchKeys(sourceFile.filePath, ctx.projectRoot)) {
      runtimeMatches.set(key, sourceFile);
    }
  }

  return runtimeMatches;
}

export function collectRuntimeTestExecutionEvidence(
  ctx: QualityAnalysisContext,
  evidenceResults: AnalysisResult[],
  evidenceParsedFiles: ParsedFile[],
  executedTestFiles: Array<{ filePath: string; label: "junit" | "playwright" }>,
): Map<string, Set<string>> {
  const runtimeMatches = new Map<string, Set<string>>();
  const analysisByFile = new Map(evidenceResults.map((result) => [result.filePath, result]));
  const parsedByFile = new Map(evidenceParsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));
  const analysisByKey = new Map<string, AnalysisResult>();
  const parsedByKey = new Map<string, ParsedFile>();

  for (const result of evidenceResults) {
    for (const key of buildSourceMatchKeys(result.filePath, ctx.projectRoot)) {
      analysisByKey.set(key, result);
    }
  }
  for (const parsedFile of evidenceParsedFiles) {
    for (const key of buildSourceMatchKeys(parsedFile.filePath, ctx.projectRoot)) {
      parsedByKey.set(key, parsedFile);
    }
  }

  for (const executedTestFile of executedTestFiles) {
    const result = resolveEvidenceFile(ctx, executedTestFile.filePath, analysisByFile, analysisByKey);
    const parsedFile = resolveEvidenceFile(ctx, executedTestFile.filePath, parsedByFile, parsedByKey);
    if (!result || !isExecutableTestEvidence(ctx, result, parsedFile)) {
      continue;
    }

    const testLabel = ctx.toDisplayPath(result.filePath);
    for (const key of buildTestPathConventionKeys(result.filePath, ctx.projectRoot)) {
      addCoverageReason(runtimeMatches, key, `${executedTestFile.label}-path:${testLabel}`);
    }

    for (const linkedFile of collectTransitivelyLinkedSourceFiles(ctx, result.filePath, analysisByFile)) {
      for (const key of buildSourceMatchKeys(linkedFile.filePath, ctx.projectRoot)) {
        addCoverageReason(runtimeMatches, key, `${executedTestFile.label}:${testLabel} depth=${linkedFile.depth}`);
      }
    }
  }

  return runtimeMatches;
}

export function resolveTestPresenceMatch(
  ctx: QualityAnalysisContext,
  filePath: string,
  bucketId: TestPresenceBucketSummary["id"],
  weight: number,
  staticMatches: Map<string, Set<string>>,
  runtimeMatches: Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }>,
  runtimeExecutionMatches: Map<string, Set<string>>,
): TestPresenceFileMatch {
  const matchKeys = buildSourceMatchKeys(filePath, ctx.projectRoot);
  const runtimeMatch = matchKeys
    .map((key) => runtimeMatches.get(key))
    .find((entry): entry is { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null } => Boolean(entry));
  const runtimeExecutionReasons = Array.from(new Set(
    matchKeys.flatMap((key) => Array.from(runtimeExecutionMatches.get(key) ?? [])),
  )).sort();
  const staticReasons = Array.from(new Set(
    matchKeys.flatMap((key) => Array.from(staticMatches.get(key) ?? [])),
  )).sort();

  if (runtimeMatch) {
    const runtimeCoverageThreshold = ctx.testPresenceSettings.runtimeLineCoverageMinPercent;
    const runtimeCoverage = runtimeMatch.lineCoverage ?? 0;
    const coverageReason = `lcov:${runtimeMatch.lineHit}/${runtimeMatch.lineFound}${runtimeMatch.lineCoverage !== null ? ` (${runtimeCoverage.toFixed(1)}%)` : ""}${runtimeCoverageThreshold > 0 ? ` min=${runtimeCoverageThreshold.toFixed(1)}%` : ""}`;
    return {
      filePath,
      bucketId,
      weight,
      matched: runtimeMatch.lineHit > 0 && runtimeCoverage >= runtimeCoverageThreshold,
      matchedBy: "runtime",
      reasons: [coverageReason, ...runtimeExecutionReasons.slice(0, 1), ...staticReasons.slice(0, 1)],
    };
  }

  if (runtimeExecutionReasons.length > 0) {
    return {
      filePath,
      bucketId,
      weight,
      matched: true,
      matchedBy: "runtime",
      reasons: runtimeExecutionReasons,
    };
  }

  if (staticReasons.length > 0) {
    return {
      filePath,
      bucketId,
      weight,
      matched: true,
      matchedBy: "static",
      reasons: staticReasons,
    };
  }

  return {
    filePath,
    bucketId,
    weight,
    matched: false,
    matchedBy: "none",
    reasons: ["no runtime or static evidence"],
  };
}

export function addCoverageReason(staticMatches: Map<string, Set<string>>, key: string, reason: string): void {
  const reasons = staticMatches.get(key) ?? new Set<string>();
  reasons.add(reason);
  staticMatches.set(key, reasons);
}

export function collectTransitivelyLinkedSourceFiles(
  ctx: QualityAnalysisContext,
  testFilePath: string,
  analysisByFile: Map<string, AnalysisResult>,
): Array<{ filePath: string; depth: number }> {
  const rootResult = analysisByFile.get(testFilePath);
  if (!rootResult) {
    return [];
  }

  const maxDepth = ctx.testPresenceSettings.staticImportTraversalMaxDepth;
  const queue = rootResult.dependencies
    .filter((dependency) => !dependency.isExternal)
    .map((dependency) => ({ filePath: dependency.target, depth: 0 }));
  const linkedFiles: Array<{ filePath: string; depth: number }> = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.filePath)) {
      continue;
    }
    visited.add(current.filePath);

    if (isStaticTestTraversalCandidate(ctx, current.filePath)) {
      linkedFiles.push(current);
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const nextResult = analysisByFile.get(current.filePath);
    if (!nextResult) {
      continue;
    }

    for (const dependency of nextResult.dependencies) {
      if (!dependency.isExternal) {
        queue.push({ filePath: dependency.target, depth: current.depth + 1 });
      }
    }
  }

  return linkedFiles;
}

export function isTestFile(ctx: QualityAnalysisContext, filePath: string): boolean {
  const normalized = ctx.toDisplayPath(filePath).replace(/\\/gu, "/").toLowerCase();
  return /(?:^|\/)(?:tests?|__tests__|e2e|playwright|cypress)(?:\/|$)/u.test(normalized)
    || /\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/u.test(normalized);
}

export function isTestTargetFile(ctx: QualityAnalysisContext, filePath: string): boolean {
  const fileType = ctx.classifyFileType(filePath);
  return !["Test", "Story", "Storybook Support", "Fixture", "Config", "Barrel", "Utils", "Type Support"].includes(fileType);
}

export function isExecutableTestEvidence(ctx: QualityAnalysisContext, result: AnalysisResult, parsedFile?: ParsedFile): boolean {
  if (!isTestFile(ctx, result.filePath)) {
    return false;
  }

  if (!parsedFile) {
    return /\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/iu.test(result.filePath);
  }

  return containsTestLikeCall(ctx, parsedFile.sourceFile)
    || (/\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/iu.test(result.filePath) && importsKnownTestFramework(ctx, result));
}

export function containsTestLikeCall(ctx: QualityAnalysisContext, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && isKnownTestCallExpression(ctx, node.expression)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function isKnownTestCallExpression(ctx: QualityAnalysisContext, expression: ts.LeftHandSideExpression): boolean {
  const names = flattenCallExpressionNames(expression);
  if (names.length === 0) {
    return false;
  }

  const knownCallNames = new Set(ctx.testPresenceSettings.knownCallNames.map((name) => name.toLowerCase()));
  const root = names[0] ?? "";
  const leaf = names[names.length - 1] ?? "";
  return knownCallNames.has(root.toLowerCase())
    || knownCallNames.has(leaf.toLowerCase());
}

export function flattenCallExpressionNames(expression: ts.LeftHandSideExpression): string[] {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return [...flattenCallExpressionNames(expression.expression), expression.name.text];
  }
  if (ts.isElementAccessExpression(expression)) {
    return flattenCallExpressionNames(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return flattenCallExpressionNames(expression.expression);
  }
  return [];
}

export function importsKnownTestFramework(ctx: QualityAnalysisContext, result: AnalysisResult): boolean {
  const knownFrameworkModules = new Set(ctx.testPresenceSettings.knownFrameworkModules);
  return result.dependencies.some((dependency) =>
    dependency.isExternal && knownFrameworkModules.has(dependency.modulePath)
  );
}

export function isStaticTestTraversalCandidate(ctx: QualityAnalysisContext, filePath: string): boolean {
  const fileType = ctx.classifyFileType(filePath);
  return !["Test", "Story", "Storybook Support", "Fixture", "Config", "Type Support"].includes(fileType);
}

export function resolveEvidenceFile<T>(
  ctx: QualityAnalysisContext,
  filePath: string,
  byFilePath: Map<string, T>,
  byMatchKey: Map<string, T>,
): T | undefined {
  const direct = byFilePath.get(path.normalize(filePath));
  if (direct) {
    return direct;
  }
  for (const key of buildSourceMatchKeys(filePath, ctx.projectRoot)) {
    const match = byMatchKey.get(key);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function testCoverageWeight(ctx: QualityAnalysisContext, filePath: string): number {
  const fileType = ctx.classifyFileType(filePath);
  const weights = ctx.testPresenceSettings.bucketWeights;
  switch (fileType) {
    case "Route":
      return weights.route;
    case "Feature":
      return weights.feature;
    case "Form":
      return weights.form;
    case "Layout":
      return weights.layout;
    case "API/Infrastructure":
      return weights.api;
    case "Schema":
      return weights.schema;
    case "Validation":
      return weights.validation;
    case "Hook":
      return weights.hook;
    case "Context/State":
      return weights.context;
    case "UI component":
      return weights.ui;
    case "Shared":
      return weights.shared;
    default:
      return weights.ui;
  }
}

export function testCoverageBucket(ctx: QualityAnalysisContext, filePath: string): TestPresenceBucketSummary["id"] {
  const fileType = ctx.classifyFileType(filePath);
  switch (fileType) {
    case "Route":
      return "route";
    case "Form":
      return "form";
    case "UI component":
    case "Layout":
    case "Shared":
      return "ui";
    case "Feature":
    case "Hook":
    case "Context/State":
    case "API/Infrastructure":
    case "Schema":
    case "Validation":
    default:
      return "feature";
  }
}
