import type { AnalysisResult, FeatureSummary, WorkspaceSegmentSummary } from "../../types/index.js";
import { getTypeEscapeFileScore } from "./MetricBuilders.js";
import type {
  AuditFinding,
  I18nFinding,
  QualityAnalysisContext,
  TestPresenceFileMatch,
  TestPresenceSummary,
  VisualConsumerSummary,
} from "./QualityReportModel.js";
import { isTestTargetFile } from "./TestPresenceCollector.js";

/**
 * ワークスペース (apps/ packages/ src/) とフィーチャー (features/<name> など) の
 * 単位で、型逃げ・高責務・画面系・テスト率・製品文言を集約する。
 */

export function collectWorkspaceSegments(
  ctx: QualityAnalysisContext,
  analysisResults: AnalysisResult[],
  testPresence: TestPresenceSummary,
  visualConsumers: VisualConsumerSummary,
  highResponsibilityComponents: AuditFinding[],
  hardcodedJsxText: I18nFinding[],
): WorkspaceSegmentSummary[] {
  const segmentDescriptors: Array<{ id: WorkspaceSegmentSummary["id"]; label: string }> = [
    { id: "apps", label: "apps/*" },
    { id: "packages", label: "packages/*" },
    { id: "src", label: "src/*" },
    { id: "other", label: "other" },
  ];
  const segments = new Map<WorkspaceSegmentSummary["id"], WorkspaceSegmentSummary>(
    segmentDescriptors.map((descriptor) => [descriptor.id, {
      id: descriptor.id,
      label: descriptor.label,
      fileCount: 0,
      componentCount: 0,
      typeEscapeCount: 0,
      highResponsibilityComponentCount: 0,
      visualConsumerCount: 0,
      designSystemBackedCount: 0,
      testTargetFiles: 0,
      matchedTestFiles: 0,
      weightedTestRate: 0,
      productTextCount: 0,
    }]),
  );
  const matchByFilePath = new Map(testPresence.matches.map((match) => [match.filePath, match]));
  const inboundDegree = new Map<string, number>();

  for (const result of analysisResults) {
    for (const dependency of result.dependencies) {
      if (dependency.isExternal) {
        continue;
      }
      inboundDegree.set(dependency.target, (inboundDegree.get(dependency.target) ?? 0) + 1);
    }
  }

  for (const result of analysisResults) {
    const segment = segments.get(workspaceSegmentId(ctx, result.filePath));
    if (!segment) {
      continue;
    }

    segment.fileCount += 1;
    segment.componentCount += result.complexity.components.length;
    if (ctx.isStrictQualityCheckTargetFile(result.filePath)) {
      segment.typeEscapeCount += Math.round(getTypeEscapeFileScore(ctx, result, inboundDegree.get(result.filePath) ?? 0));
    }

    if (isTestTargetFile(ctx, result.filePath)) {
      segment.testTargetFiles += 1;
      if (matchByFilePath.get(result.filePath)?.matched) {
        segment.matchedTestFiles += 1;
      }
    }
  }

  for (const finding of highResponsibilityComponents) {
    const segment = segments.get(workspaceSegmentId(ctx, finding.filePath));
    if (segment) {
      segment.highResponsibilityComponentCount += 1;
    }
  }

  for (const finding of hardcodedJsxText.filter((item) => item.scope === "product")) {
    const segment = segments.get(workspaceSegmentId(ctx, finding.filePath));
    if (segment) {
      segment.productTextCount += 1;
    }
  }

  for (const entry of visualConsumers.entries) {
    const segment = segments.get(workspaceSegmentId(ctx, entry.filePath));
    if (!segment) {
      continue;
    }

    segment.visualConsumerCount += 1;
    if (entry.hasDesignSystemBacking) {
      segment.designSystemBackedCount += 1;
    }
  }

  const weightedRateBySegment = new Map(
    collectSegmentTestRates(ctx, testPresence.matches).map((entry) => [entry.id, entry.rate]),
  );

  return segmentDescriptors
    .map((descriptor) => {
      const segment = segments.get(descriptor.id)!;
      segment.weightedTestRate = weightedRateBySegment.get(descriptor.id) ?? 0;
      return segment;
    })
    .filter((segment) => segment.fileCount > 0);
}

export function collectFeatureSummaries(
  ctx: QualityAnalysisContext,
  analysisResults: AnalysisResult[],
  testPresence: TestPresenceSummary,
  visualConsumers: VisualConsumerSummary,
  highResponsibilityComponents: AuditFinding[],
  hardcodedJsxText: I18nFinding[],
): FeatureSummary[] {
  const features = new Map<string, FeatureSummary & { complexityTotal: number }>();
  const matchByFilePath = new Map(testPresence.matches.map((match) => [match.filePath, match]));
  const inboundDegree = new Map<string, number>();

  for (const result of analysisResults) {
    for (const dependency of result.dependencies) {
      if (dependency.isExternal) {
        continue;
      }
      inboundDegree.set(dependency.target, (inboundDegree.get(dependency.target) ?? 0) + 1);
    }
  }

  const ensureFeature = (filePath: string): (FeatureSummary & { complexityTotal: number }) | undefined => {
    const label = featureSummaryLabel(ctx, filePath);
    if (!label) {
      return undefined;
    }

    const id = label.toLowerCase();
    const existing = features.get(id);
    if (existing) {
      return existing;
    }

    const summary = {
      id,
      label,
      fileCount: 0,
      componentCount: 0,
      averageComplexity: 0,
      maxComplexity: 0,
      complexityTotal: 0,
      typeEscapeCount: 0,
      highResponsibilityComponentCount: 0,
      visualConsumerCount: 0,
      designSystemBackedCount: 0,
      testTargetFiles: 0,
      matchedTestFiles: 0,
      weightedTestRate: 0,
      productTextCount: 0,
    } satisfies FeatureSummary & { complexityTotal: number };
    features.set(id, summary);
    return summary;
  };

  for (const result of analysisResults) {
    const feature = ensureFeature(result.filePath);
    if (!feature || !ctx.isStrictQualityCheckTargetFile(result.filePath)) {
      continue;
    }

    feature.fileCount += 1;
    feature.componentCount += result.complexity.components.length;
    feature.complexityTotal += result.complexity.overallComplexity;
    feature.maxComplexity = Math.max(feature.maxComplexity, result.complexity.overallComplexity);
    feature.typeEscapeCount += Math.round(getTypeEscapeFileScore(ctx, result, inboundDegree.get(result.filePath) ?? 0));

    if (isTestTargetFile(ctx, result.filePath)) {
      feature.testTargetFiles += 1;
      if (matchByFilePath.get(result.filePath)?.matched) {
        feature.matchedTestFiles += 1;
      }
    }
  }

  for (const finding of highResponsibilityComponents) {
    const feature = ensureFeature(finding.filePath);
    if (feature) {
      feature.highResponsibilityComponentCount += 1;
    }
  }

  for (const finding of hardcodedJsxText.filter((item) => item.scope === "product")) {
    const feature = ensureFeature(finding.filePath);
    if (feature) {
      feature.productTextCount += 1;
    }
  }

  for (const entry of visualConsumers.entries) {
    const feature = ensureFeature(entry.filePath);
    if (!feature) {
      continue;
    }

    feature.visualConsumerCount += 1;
    if (entry.hasDesignSystemBacking) {
      feature.designSystemBackedCount += 1;
    }
  }

  const weightedRateByFeature = new Map(collectFeatureTestRates(ctx, testPresence.matches).map((entry) => [entry.id, entry.rate]));

  return Array.from(features.values())
    .map((feature) => ({
      ...feature,
      averageComplexity: feature.fileCount > 0 ? feature.complexityTotal / feature.fileCount : 0,
      weightedTestRate: weightedRateByFeature.get(feature.id) ?? 0,
    }))
    .filter((feature) => feature.fileCount > 0)
    .sort((left, right) =>
      right.typeEscapeCount - left.typeEscapeCount
      || right.highResponsibilityComponentCount - left.highResponsibilityComponentCount
      || right.maxComplexity - left.maxComplexity
      || left.label.localeCompare(right.label)
    )
    .map(({ complexityTotal: _complexityTotal, ...feature }) => feature);
}

export function collectFeatureTestRates(
  ctx: QualityAnalysisContext,
  matches: TestPresenceFileMatch[],
): Array<{ id: string; rate: number }> {
  const weighted = new Map<string, { target: number; matched: number }>();

  for (const match of matches) {
    const featureId = featureSummaryLabel(ctx, match.filePath)?.toLowerCase();
    if (!featureId) {
      continue;
    }

    const bucket = weighted.get(featureId) ?? { target: 0, matched: 0 };
    bucket.target += match.weight;
    if (match.matched) {
      bucket.matched += match.weight;
    }
    weighted.set(featureId, bucket);
  }

  return Array.from(weighted.entries()).map(([id, bucket]) => ({
    id,
    rate: bucket.target > 0 ? (bucket.matched / bucket.target) * 100 : 0,
  }));
}

export function collectSegmentTestRates(
  ctx: QualityAnalysisContext,
  matches: TestPresenceFileMatch[],
): Array<{ id: WorkspaceSegmentSummary["id"]; rate: number }> {
  const weighted = new Map<WorkspaceSegmentSummary["id"], { target: number; matched: number }>();

  for (const match of matches) {
    const id = workspaceSegmentId(ctx, match.filePath);
    const bucket = weighted.get(id) ?? { target: 0, matched: 0 };
    bucket.target += match.weight;
    if (match.matched) {
      bucket.matched += match.weight;
    }
    weighted.set(id, bucket);
  }

  return Array.from(weighted.entries()).map(([id, bucket]) => ({
    id,
    rate: bucket.target > 0 ? (bucket.matched / bucket.target) * 100 : 0,
  }));
}

export function workspaceSegmentId(ctx: QualityAnalysisContext, filePath: string): WorkspaceSegmentSummary["id"] {
  const normalized = ctx.toDisplayPath(filePath).toLowerCase();
  if (normalized.startsWith("apps/")) {
    return "apps";
  }
  if (normalized.startsWith("packages/")) {
    return "packages";
  }
  if (normalized.startsWith("src/")) {
    return "src";
  }
  return "other";
}

export function featureSummaryLabel(ctx: QualityAnalysisContext, filePath: string): string | undefined {
  const displayPath = ctx.toDisplayPath(filePath).replace(/\\/gu, "/");
  const segments = displayPath.split("/").filter(Boolean);
  const featureRootIndex = segments.findIndex((segment) => /^(features?|modules?|domains?|scenes?|containers?)$/iu.test(segment));
  if (featureRootIndex < 0 || featureRootIndex >= segments.length - 1) {
    return undefined;
  }

  if (featureRootIndex + 1 < segments.length - 1) {
    return segments.slice(0, featureRootIndex + 2).join("/");
  }

  if (!ctx.isStrictQualityCheckTargetFile(filePath)) {
    return undefined;
  }

  const terminalSegment = segments[featureRootIndex + 1];
  if (!terminalSegment) {
    return undefined;
  }

  const stem = terminalSegment.replace(/\.[cm]?[jt]sx?$/iu, "");
  return [...segments.slice(0, featureRootIndex + 1), stem].join("/");
}
