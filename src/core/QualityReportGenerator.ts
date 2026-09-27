import fs from "node:fs/promises";
import path from "node:path";

import { ApiArtifactAnalyzer } from "./ApiArtifactAnalyzer.js";
import { BrowserAuditAnalyzer } from "./BrowserAuditAnalyzer.js";
import { classifyFileType } from "./FileConventions.js";
import { TestArtifactAnalyzer } from "./TestArtifactAnalyzer.js";
import { TypeCheckAnalyzer, type TypeCheckSummary } from "./TypeCheckAnalyzer.js";
import { UiTestArtifactAnalyzer } from "./UiTestArtifactAnalyzer.js";
import { SecurityArtifactAnalyzer } from "./SecurityArtifactAnalyzer.js";
import { REPORT_SCHEMA_VERSION, toDisplayPath } from "./ReportUtils.js";
import {
  collectDangerousHtml,
  collectHardcodedJsxText,
  collectHighResponsibilityComponents,
  collectSecretIndicators,
  collectVisualConsumers,
} from "./quality/JsxAnalysis.js";
import {
  buildAccessibilityMetrics,
  buildApiMetrics,
  buildBuildMetrics,
  buildCodeMetrics,
  buildDependencyMetrics,
  buildFunctionalMetrics,
  buildI18nMetrics,
  buildOperationsMetrics,
  buildPerformanceMetrics,
  buildSecurityMetrics,
  buildTestMetrics,
  buildUiUxMetrics,
  collectTypeEscapeStats,
  selectDerivedMetrics,
  noteEvidence,
  selectPrimaryMetrics,
} from "./quality/MetricBuilders.js";
import {
  DEFAULT_TEST_PRESENCE_SETTINGS,
  QUALITY_CATEGORIES,
  type QualityAnalysisContext,
  type QualityRenderContext,
  type TestPresenceSummary,
} from "./quality/QualityReportModel.js";
import { renderCsv, renderHtml, renderMarkdown } from "./quality/QualityReportRenderer.js";
import { collectTestPresence, isTestFile } from "./quality/TestPresenceCollector.js";
import { collectFeatureSummaries, collectWorkspaceSegments } from "./quality/WorkspaceSummaries.js";
import type {
  AnalysisResult,
  GraphMetrics,
  ParsedFile,
  ManualQualityMetricInput,
  QualityCategoryId,
  QualityCategoryReport,
  QualityEvidence,
  QualityMetricReport,
  QualityProfile,
  QualityGateRenderContext,
  QualityReport,
  QualitySummary,
  TestPresenceSettings,
  QualityVerdict,
} from "../types/index.js";

interface QualityGenerationInput {
  projectRoot: string;
  analysisResults: AnalysisResult[];
  parsedFiles: ParsedFile[];
  testEvidenceResults?: AnalysisResult[];
  testEvidenceParsedFiles?: ParsedFile[];
  graphMetrics: GraphMetrics;
  executionTimeMs: number;
  qualityProfile?: QualityProfile;
  testPresenceSettings?: TestPresenceSettings;
  maxTypeCheckRootNames?: number;
  tsConfigPath?: string;
  cacheDir?: string;
  manualInputs?: ManualQualityMetricInput[];
}

interface QualityGenerationOptions {
  outputDir: string;
  prefix: string;
  formats: Array<"json" | "markdown" | "csv" | "html" | "all">;
  onProgress?: (message: string, metadata?: Record<string, unknown>) => void;
  // レポート構築後・書き出し前に呼ばれ、gate 判定やベースライン比較の結果を
  // レポート本文 (要点の「ゲート判定」「前回比」) に反映するためのフック
  gate?: (report: QualityReport) => QualityGateRenderContext | undefined;
}

interface PhaseFailure {
  name: string;
  message: string;
}

const PHASE_NAMES = {
  browserAudits: "Quality phase: browser audits",
  testArtifacts: "Quality phase: test artifacts",
  uiTestArtifacts: "Quality phase: UI test artifacts",
  apiArtifacts: "Quality phase: API artifacts",
  securityArtifacts: "Quality phase: security artifacts",
  dangerousHtml: "Quality phase: dangerous HTML scan",
  i18nText: "Quality phase: i18n text scan",
  secretScan: "Quality phase: secret scan",
  visualConsumers: "Quality phase: visual consumer scan",
  responsibility: "Quality phase: responsibility scan",
  zodAdoption: "Quality phase: zod adoption scan",
  ciDetection: "Quality phase: CI detection",
  documentation: "Quality phase: documentation detection",
  dependencySummary: "Quality phase: dependency summary",
  typeCheck: "Quality phase: type check",
  testPresence: "Quality phase: test presence scan",
  workspaceSegments: "Quality phase: workspace segment summary",
  featureSummaries: "Quality phase: feature summary",
} as const;

// フェーズが失敗したときに「収集失敗」へ落とす指標。フェーズの fallback 値は
// 空の集計結果なので、そのまま判定すると 0 件 = pass に見えてしまう。
const PHASE_METRIC_IDS: Record<string, string[]> = {
  [PHASE_NAMES.browserAudits]: ["wcag_aa", "lighthouse_performance", "lcp", "tti"],
  [PHASE_NAMES.testArtifacts]: ["unit_pass_rate", "coverage_rate"],
  [PHASE_NAMES.uiTestArtifacts]: ["storybook_pass_rate", "e2e_pass_rate"],
  [PHASE_NAMES.apiArtifacts]: ["openapi_contract", "timeout_retry", "msw_alignment"],
  [PHASE_NAMES.securityArtifacts]: ["dependency_vulnerabilities"],
  [PHASE_NAMES.dangerousHtml]: ["dangerous_html"],
  [PHASE_NAMES.i18nText]: ["hardcoded_jsx_text"],
  [PHASE_NAMES.secretScan]: ["secret_indicators"],
  [PHASE_NAMES.visualConsumers]: ["design_system_usage_rate", "bespoke_ui_file_count"],
  [PHASE_NAMES.responsibility]: ["high_responsibility_components"],
  [PHASE_NAMES.zodAdoption]: ["zod_adoption"],
  [PHASE_NAMES.ciDetection]: ["ci_presence"],
  [PHASE_NAMES.documentation]: ["documentation_presence"],
  [PHASE_NAMES.dependencySummary]: ["external_package_count"],
  [PHASE_NAMES.typeCheck]: ["typescript_errors", "tsconfig_type_safety"],
  [PHASE_NAMES.testPresence]: [
    "matching_test_file_presence",
    "route_test_file_presence",
    "feature_test_file_presence",
    "form_test_file_presence",
    "ui_test_file_presence",
  ],
};

const ARTIFACT_WARNING_EVIDENCE_LABEL = "取込警告";

/**
 * 品質レポート生成のオーケストレーター。フェーズの実行順・失敗時のフォールバック・
 * カテゴリ判定・書き出しを担い、個別の収集や指標構築、描画は quality/ 配下の
 * モジュールに委譲する。
 */
export class QualityReportGenerator {
  private projectRoot?: string;
  private gateContext?: QualityGateRenderContext;
  private readonly displayPathCache = new Map<string, string>();
  private qualityProfile: QualityProfile = "application";
  private testPresenceSettings: TestPresenceSettings = {
    thresholds: {
      application: { ...DEFAULT_TEST_PRESENCE_SETTINGS.thresholds.application },
      "library-repo": { ...DEFAULT_TEST_PRESENCE_SETTINGS.thresholds["library-repo"] },
    },
    bucketWeights: { ...DEFAULT_TEST_PRESENCE_SETTINGS.bucketWeights },
    staticImportTraversalMaxDepth: DEFAULT_TEST_PRESENCE_SETTINGS.staticImportTraversalMaxDepth,
    runtimeLineCoverageMinPercent: DEFAULT_TEST_PRESENCE_SETTINGS.runtimeLineCoverageMinPercent,
    knownCallNames: [...DEFAULT_TEST_PRESENCE_SETTINGS.knownCallNames],
    knownFrameworkModules: [...DEFAULT_TEST_PRESENCE_SETTINGS.knownFrameworkModules],
  };
  // 解析モジュールへ渡す状態のスナップショット。buildReport で入力を反映した直後に作り直す
  private context: QualityAnalysisContext = this.createAnalysisContext();

  private createAnalysisContext(): QualityAnalysisContext {
    return {
      projectRoot: this.projectRoot,
      qualityProfile: this.qualityProfile,
      testPresenceSettings: this.testPresenceSettings,
      toDisplayPath: (filePath) => this.toDisplayPath(filePath),
      classifyFileType: (filePath) => this.classifyFileType(filePath),
      isStrictQualityCheckTargetFile: (filePath) => this.isStrictQualityCheckTargetFile(filePath),
    };
  }

  private renderContext(): QualityRenderContext {
    return {
      gateContext: this.gateContext,
      toDisplayPath: (filePath) => this.toDisplayPath(filePath),
    };
  }

  async generateReports(input: QualityGenerationInput, options: QualityGenerationOptions): Promise<QualityReport> {
    const startedAt = Date.now();
    await fs.mkdir(options.outputDir, { recursive: true });

    const report = await this.buildReport(input, options.onProgress);
    report.executionTimeMs = Math.max(report.executionTimeMs, input.executionTimeMs + (Date.now() - startedAt));
    this.gateContext = options.gate?.(report);
    const formats = options.formats.includes("all")
      ? ["json", "markdown", "csv", "html"]
      : options.formats;

    if (formats.includes("json")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_report.json`), JSON.stringify(report, null, 2), "utf8");
    }
    if (formats.includes("markdown")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_report.md`), renderMarkdown(this.renderContext(), report), "utf8");
    }
    if (formats.includes("csv")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_summary.csv`), renderCsv(report), "utf8");
    }
    if (formats.includes("html")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_report.html`), renderHtml(this.renderContext(), report), "utf8");
    }

    return report;
  }

  private async buildReport(
    input: QualityGenerationInput,
    onProgress?: (message: string, metadata?: Record<string, unknown>) => void,
  ): Promise<QualityReport> {
    this.projectRoot = path.resolve(input.projectRoot);
    this.displayPathCache.clear();
    this.qualityProfile = input.qualityProfile ?? "application";
    this.testPresenceSettings = this.cloneTestPresenceSettings(input.testPresenceSettings ?? DEFAULT_TEST_PRESENCE_SETTINGS);
    this.context = this.createAnalysisContext();
    const strictQualityAnalysisResults = input.analysisResults.filter((result) => this.isStrictQualityCheckTargetFile(result.filePath));
    const strictQualityParsedFiles = input.parsedFiles.filter((parsedFile) => this.isStrictQualityCheckTargetFile(parsedFile.filePath));
    // フェーズが 1 つ失敗しても残りの指標は報告する。失敗したフェーズは記録し、
    // 依存する指標を後段で manual (収集失敗) に落とす。Promise.all 配下で
    // 例外を素通しすると、成果物 1 つの破損でレポート全体が消える。
    const phaseFailures: PhaseFailure[] = [];
    const runPhase = async <T>(
      name: string,
      task: () => Promise<T> | T,
      fallback: () => T,
      metadata?: Record<string, unknown>,
    ): Promise<T> => {
      const startedAt = Date.now();
      onProgress?.(`${name} started`, metadata);
      try {
        const result = await task();
        onProgress?.(`${name} completed`, {
          ...(metadata ?? {}),
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        phaseFailures.push({ name, message });
        onProgress?.(`${name} failed`, {
          ...(metadata ?? {}),
          durationMs: Date.now() - startedAt,
          error: message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
        return fallback();
      }
    };
    // 型検査は同期実行でイベントループを塞ぐため配列の最後に置き、
    // アーティファクト走査などの非同期 I/O を先に発行させる
    const [
      browserAuditSummary,
      testArtifactSummary,
      uiTestArtifactSummary,
      apiArtifactSummary,
      securityArtifactSummary,
      dangerousHtml,
      hardcodedJsxText,
      secretIndicators,
      visualConsumers,
      highResponsibilityComponents,
      zodAdoption,
      ciPresence,
      docsPresence,
      externalPackageCount,
      rawTypeCheckSummary,
    ] = await Promise.all([
      runPhase(
        PHASE_NAMES.browserAudits,
        () => new BrowserAuditAnalyzer().analyzeProject(input.projectRoot),
        () => ({ axe: null, lighthouse: null, warnings: [] }),
      ),
      runPhase(
        PHASE_NAMES.testArtifacts,
        () => new TestArtifactAnalyzer().analyzeProject(input.projectRoot),
        () => ({ junit: null, coverage: null, vitest: null, warnings: [] }),
      ),
      runPhase(
        PHASE_NAMES.uiTestArtifacts,
        () => new UiTestArtifactAnalyzer().analyzeProject(input.projectRoot),
        () => ({ playwright: null, storybook: null, warnings: [] }),
      ),
      runPhase(
        PHASE_NAMES.apiArtifacts,
        () => new ApiArtifactAnalyzer().analyzeProject(input.projectRoot, input.parsedFiles),
        () => ({
          openApi: null,
          msw: { apiFileCount: 0, handlerFiles: [], handlerCount: 0 },
          timeoutRetry: { apiFileCount: 0, resilientFiles: [] },
          warnings: [],
        }),
      ),
      runPhase(
        PHASE_NAMES.securityArtifacts,
        () => new SecurityArtifactAnalyzer().analyzeProject(input.projectRoot),
        () => ({ tools: [], warnings: [] }),
      ),
      runPhase(PHASE_NAMES.dangerousHtml, () => collectDangerousHtml(strictQualityParsedFiles), () => [], { files: strictQualityParsedFiles.length }),
      runPhase(PHASE_NAMES.i18nText, () => collectHardcodedJsxText(this.context, input.parsedFiles), () => [], { files: input.parsedFiles.length }),
      runPhase(PHASE_NAMES.secretScan, () => collectSecretIndicators(strictQualityParsedFiles), () => [], { files: strictQualityParsedFiles.length }),
      runPhase(
        PHASE_NAMES.visualConsumers,
        () => collectVisualConsumers(this.context, input.analysisResults, input.parsedFiles),
        () => ({ total: 0, designSystemUsers: 0, bespokeFiles: [], entries: [] }),
        { files: input.analysisResults.length },
      ),
      runPhase(PHASE_NAMES.responsibility, () => collectHighResponsibilityComponents(this.context, strictQualityAnalysisResults), () => [], { files: strictQualityAnalysisResults.length }),
      runPhase(PHASE_NAMES.zodAdoption, () => this.collectZodAdoption(input.parsedFiles), () => ({ totalFiles: 0, adoptedFiles: 0, rate: 0 }), { files: input.parsedFiles.length }),
      runPhase(PHASE_NAMES.ciDetection, () => this.collectCiPresence(input.projectRoot), () => ({ hasCi: false, files: [] })),
      runPhase(PHASE_NAMES.documentation, () => this.collectDocumentationPresence(input.projectRoot), () => ({ docsCount: 0, docFiles: [] })),
      runPhase(PHASE_NAMES.dependencySummary, () => this.collectExternalPackageCount(input.analysisResults), () => 0, { files: input.analysisResults.length }),
      runPhase(
        PHASE_NAMES.typeCheck,
        () => new TypeCheckAnalyzer().analyzeProject(input.projectRoot, input.tsConfigPath, {
          includedFilePaths: strictQualityParsedFiles.map((parsedFile) => parsedFile.filePath),
          maxRootNames: input.maxTypeCheckRootNames ?? 5000,
          cacheDir: input.cacheDir,
          onProgress,
        }),
        // 型検査が例外で落ちても manual に格下げするだけで、レポート全体は止めない
        (): TypeCheckSummary => ({
          totalErrors: 0,
          checkedFiles: 0,
          issues: [],
          tsConfigPath: input.tsConfigPath,
          skippedReason: "収集失敗: 型検査が例外で中断しました。",
        }),
        { files: strictQualityParsedFiles.length },
      ),
    ]);
    this.reportArtifactWarnings(onProgress, [
      [PHASE_NAMES.browserAudits, browserAuditSummary.warnings],
      [PHASE_NAMES.testArtifacts, testArtifactSummary.warnings],
      [PHASE_NAMES.uiTestArtifacts, uiTestArtifactSummary.warnings],
      [PHASE_NAMES.apiArtifacts, apiArtifactSummary.warnings],
      [PHASE_NAMES.securityArtifacts, securityArtifactSummary.warnings],
    ]);
    const typeCheckSummary = this.filterTypeCheckSummary(rawTypeCheckSummary);
    const typeEscapeStats = collectTypeEscapeStats(this.context, strictQualityAnalysisResults);
    const testPresenceResults = input.testEvidenceResults ?? input.analysisResults;
    const testPresenceParsedFiles = input.testEvidenceParsedFiles ?? input.parsedFiles;
    const testPresence = await runPhase(
      PHASE_NAMES.testPresence,
      () => collectTestPresence(this.context, 
        input.analysisResults,
        testPresenceResults,
        testPresenceParsedFiles,
        testArtifactSummary.coverage,
        testArtifactSummary.junit,
        uiTestArtifactSummary.playwright,
      ),
      (): TestPresenceSummary => ({
        targetFiles: 0,
        matchedFiles: 0,
        weightedTarget: 0,
        weightedMatched: 0,
        rate: 0,
        buckets: [],
        staticMatchedFiles: 0,
        runtimeMatchedFiles: 0,
        runtimeExplicitUnmatchedFiles: 0,
        noEvidenceUnmatchedFiles: 0,
        matches: [],
      }),
      { files: testPresenceResults.length },
    );
    const workspaceSegments = await runPhase(
      PHASE_NAMES.workspaceSegments,
      () => collectWorkspaceSegments(this.context, input.analysisResults, testPresence, visualConsumers, highResponsibilityComponents, hardcodedJsxText),
      () => [],
      { files: input.analysisResults.length },
    );
    const featureSummaries = await runPhase(
      PHASE_NAMES.featureSummaries,
      () => collectFeatureSummaries(this.context, input.analysisResults, testPresence, visualConsumers, highResponsibilityComponents, hardcodedJsxText),
      () => [],
      { files: input.analysisResults.length },
    );

    const categories = new Map<QualityCategoryId, QualityMetricReport[]>();
    const pushMetric = (metric: QualityMetricReport): void => {
      const bucket = categories.get(metric.category) ?? [];
      bucket.push(metric);
      categories.set(metric.category, bucket);
    };

    for (const metric of buildFunctionalMetrics()) {
      pushMetric(metric);
    }
    for (const metric of buildUiUxMetrics(visualConsumers)) {
      pushMetric(metric);
    }
    for (const metric of buildAccessibilityMetrics(browserAuditSummary)) {
      pushMetric(metric);
    }
    for (const metric of buildPerformanceMetrics(browserAuditSummary)) {
      pushMetric(metric);
    }
    for (const metric of buildCodeMetrics(typeCheckSummary, input.graphMetrics, highResponsibilityComponents, typeEscapeStats)) {
      pushMetric(metric);
    }
    for (const metric of buildTestMetrics(this.context, testPresence, testArtifactSummary, uiTestArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of buildApiMetrics(this.context, zodAdoption, apiArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of buildSecurityMetrics(dangerousHtml, secretIndicators, securityArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of buildI18nMetrics(this.context, hardcodedJsxText)) {
      pushMetric(metric);
    }
    for (const metric of buildOperationsMetrics(docsPresence)) {
      pushMetric(metric);
    }
    for (const metric of buildBuildMetrics(ciPresence)) {
      pushMetric(metric);
    }
    for (const metric of buildDependencyMetrics(this.context, externalPackageCount, input.graphMetrics)) {
      pushMetric(metric);
    }

    this.attachArtifactWarnings(categories, {
      browserAudits: browserAuditSummary.warnings,
      testArtifacts: testArtifactSummary.warnings,
      uiTestArtifacts: uiTestArtifactSummary.warnings,
      apiArtifacts: apiArtifactSummary.warnings,
      securityArtifacts: securityArtifactSummary.warnings,
    });
    this.applyPhaseFailures(categories, phaseFailures);

    const categoryReports = QUALITY_CATEGORIES.map((category) => {
      const metrics = categories.get(category.id) ?? [];
      return {
        id: category.id,
        label: category.label,
        verdict: this.calculateCategoryVerdict(metrics),
        summary: this.summarizeCategory(metrics),
        metrics,
      } satisfies QualityCategoryReport;
    });
    const mergedCategoryReports = this.normalizeEvidenceDisplayPaths(
      this.applyManualInputs(categoryReports, input.manualInputs ?? []),
    );

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      executionTimeMs: input.executionTimeMs,
      projectRoot: input.projectRoot,
      qualityProfile: this.qualityProfile,
      summary: this.calculateSummary(mergedCategoryReports),
      workspaceSegments,
      featureSummaries,
      categories: mergedCategoryReports,
    };
  }

  private calculateCategoryVerdict(metrics: QualityMetricReport[]): QualityVerdict {
    const primaryMetrics = selectPrimaryMetrics(metrics);
    const resolvedMetrics = primaryMetrics.filter((metric) => !["manual", "not_applicable"].includes(metric.verdict));
    const pendingManualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;

    if (primaryMetrics.some((metric) => metric.verdict === "fail")) {
      return "fail";
    }
    if (primaryMetrics.some((metric) => metric.verdict === "warn")) {
      return "warn";
    }
    if (primaryMetrics.some((metric) => metric.verdict === "partial")) {
      return "partial";
    }
    if (primaryMetrics.length === 0 || resolvedMetrics.length === 0) {
      if (pendingManualCount > 0) {
        return "manual";
      }
      return primaryMetrics.length === 0 ? "not_applicable" : "not_applicable";
    }
    if (pendingManualCount > 0) {
      return "partial";
    }
    if (resolvedMetrics.some((metric) => metric.verdict === "pass")) {
      return "pass";
    }
    return "not_applicable";
  }

  private summarizeCategory(metrics: QualityMetricReport[]): string {
    const primaryMetrics = selectPrimaryMetrics(metrics);
    const derivedMetrics = selectDerivedMetrics(metrics);
    const autoMetrics = primaryMetrics.filter((metric) => metric.automation === "automatic");
    const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
    const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
    const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
    const pendingManualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
    const derivedFailCount = derivedMetrics.filter((metric) => metric.verdict === "fail").length;
    const derivedWarnCount = derivedMetrics.filter((metric) => metric.verdict === "warn").length;

    if (autoMetrics.length === 0) {
      return derivedMetrics.length > 0
        ? `自動判定指標はありません。手動入力待ち ${pendingManualCount} 件、診断指標 ${derivedMetrics.length} 件です。`
        : `自動判定指標はありません。手動入力待ち ${pendingManualCount} 件です。`;
    }

    const derivedSummary = derivedMetrics.length > 0
      ? ` 診断指標 ${derivedMetrics.length} 件（FAIL ${derivedFailCount} / WARN ${derivedWarnCount}）です。`
      : "";
    return `自動判定 ${autoMetrics.length} 件。FAIL ${failCount} 件、WARN ${warnCount} 件、PARTIAL ${partialCount} 件、MANUAL ${pendingManualCount} 件です。${derivedSummary}`;
  }

  private calculateSummary(categories: QualityCategoryReport[]): QualitySummary {
    const metrics = categories.flatMap((category) => category.metrics);
    const primaryMetrics = selectPrimaryMetrics(metrics);
    const passCount = primaryMetrics.filter((metric) => metric.verdict === "pass").length;
    const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
    const partialCategoryCount = categories.filter((category) => category.verdict === "partial").length;
    const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
    const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
    const manualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
    const notApplicableCount = primaryMetrics.filter((metric) => metric.verdict === "not_applicable").length;
    const categoryVerdicts = categories.map((category) => category.verdict);

    let overallVerdict: QualityVerdict = "pass";
    if (categoryVerdicts.includes("fail")) {
      overallVerdict = "fail";
    } else if (categoryVerdicts.includes("warn")) {
      overallVerdict = "warn";
    } else if (categoryVerdicts.includes("partial") || (categoryVerdicts.includes("pass") && categoryVerdicts.includes("manual"))) {
      overallVerdict = "partial";
    } else if (categoryVerdicts.includes("pass")) {
      overallVerdict = "pass";
    } else if (passCount === 0 && manualCount > 0) {
      overallVerdict = "manual";
    } else if (categoryVerdicts.every((verdict) => verdict === "not_applicable")) {
      overallVerdict = "not_applicable";
    }

    return {
      totalMetrics: primaryMetrics.length,
      derivedMetricCount: metrics.length - primaryMetrics.length,
      passCount,
      partialCount,
      partialCategoryCount,
      warnCount,
      failCount,
      manualCount,
      notApplicableCount,
      overallVerdict,
    };
  }

  private applyManualInputs(
    categories: QualityCategoryReport[],
    manualInputs: ManualQualityMetricInput[],
  ): QualityCategoryReport[] {
    if (manualInputs.length === 0) {
      return categories;
    }

    const inputMap = new Map(manualInputs.map((input) => [input.id, input]));

    return categories.map((category) => {
      const metrics = category.metrics.map((metric) => {
        const manualInput = inputMap.get(metric.id);
        if (!manualInput || metric.automation !== "manual") {
          return metric;
        }

        return {
          ...metric,
          actual: manualInput.actual ?? metric.actual,
          threshold: manualInput.threshold ?? metric.threshold,
          verdict: manualInput.verdict ?? metric.verdict,
          summary: manualInput.summary ?? metric.summary,
          evidence: manualInput.evidence && manualInput.evidence.length > 0 ? manualInput.evidence : metric.evidence,
          automation: "manual",
        } satisfies QualityMetricReport;
      });

      return {
        ...category,
        metrics,
        verdict: this.calculateCategoryVerdict(metrics),
        summary: this.summarizeCategory(metrics),
      };
    });
  }

  private normalizeEvidenceDisplayPaths(categories: QualityCategoryReport[]): QualityCategoryReport[] {
    return categories.map((category) => ({
      ...category,
      metrics: category.metrics.map((metric) => ({
        ...metric,
        evidence: metric.evidence.map((evidence) => this.normalizeEvidenceDisplayValue(evidence)),
      })),
    }));
  }

  private normalizeEvidenceDisplayValue(evidence: QualityEvidence): QualityEvidence {
    if (evidence.type !== "file" || !evidence.filePath) {
      return evidence;
    }

    const displayPath = this.toDisplayPath(evidence.filePath);
    if (evidence.value === evidence.filePath) {
      return {
        ...evidence,
        filePath: displayPath,
        value: displayPath,
      };
    }

    const prefixedValue = `${evidence.filePath}: `;
    if (evidence.value.startsWith(prefixedValue)) {
      return {
        ...evidence,
        filePath: displayPath,
        value: `${displayPath}: ${evidence.value.slice(prefixedValue.length)}`,
      };
    }

    return {
      ...evidence,
      filePath: displayPath,
    };
  }

  private collectZodAdoption(parsedFiles: ParsedFile[]): { totalFiles: number; adoptedFiles: number; rate: number } {
    const candidates = parsedFiles.filter((parsedFile) => {
      const normalized = this.toDisplayPath(parsedFile.filePath).replace(/\\/gu, "/").toLowerCase();
      return /(^|\/)(api|infra|service|services|client|clients|repository|repositories|schema|schemas|validation|validations)(\/|$)/u.test(normalized)
        && !isTestFile(this.context, parsedFile.filePath)
        && !/stories?\./u.test(normalized);
    });
    const adoptedFiles = candidates.filter((parsedFile) => /from\s+["']zod["']/u.test(parsedFile.sourceCode)).length;

    return {
      totalFiles: candidates.length,
      adoptedFiles,
      rate: candidates.length > 0 ? (adoptedFiles / candidates.length) * 100 : 0,
    };
  }

  private async collectCiPresence(projectRoot: string): Promise<{ hasCi: boolean; files: string[] }> {
    const candidates = [
      ".github/workflows",
      ".gitlab-ci.yml",
      ".circleci/config.yml",
      "circle.yml",
      "Jenkinsfile",
      "azure-pipelines.yml",
    ];
    const files: string[] = [];

    for (const candidate of candidates) {
      try {
        await fs.access(path.join(projectRoot, candidate));
        files.push(path.join(projectRoot, candidate));
      } catch {
        // noop
      }
    }

    return {
      hasCi: files.length > 0,
      files,
    };
  }

  private async collectDocumentationPresence(projectRoot: string): Promise<{ docsCount: number; docFiles: string[] }> {
    const candidates = [
      "README.md",
      "README.ja.md",
      "docs",
      "adr",
      "ADR",
    ];
    const docFiles: string[] = [];

    for (const candidate of candidates) {
      const resolved = path.join(projectRoot, candidate);
      try {
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          docFiles.push(resolved);
        } else if (stat.isFile()) {
          docFiles.push(resolved);
        }
      } catch {
        // noop
      }
    }

    return {
      docsCount: docFiles.length,
      docFiles,
    };
  }

  private collectExternalPackageCount(analysisResults: AnalysisResult[]): number {
    const packages = new Set<string>();

    for (const result of analysisResults) {
      for (const dependency of result.dependencies) {
        if (!dependency.isExternal) {
          continue;
        }
        const normalized = dependency.target.trim();
        if (normalized) {
          packages.add(normalized);
        }
      }
    }

    return packages.size;
  }

  private classifyFileType(filePath: string): string {
    // 分類パターンはパス全体に照合されるため、プロジェクトより上位のディレクトリ名
    // (例: CI の /home/runner/work/app/app) が判定へ混入しないよう相対化してから渡す。
    return classifyFileType(this.toDisplayPath(filePath));
  }

  private isStrictQualityCheckTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return !["Test", "Story", "Storybook Support", "Fixture", "Config"].includes(fileType);
  }

  private filterTypeCheckSummary(
    summary: ReturnType<TypeCheckAnalyzer["analyzeProject"]>,
  ): ReturnType<TypeCheckAnalyzer["analyzeProject"]> {
    if (summary.skippedReason) {
      return summary;
    }

    const issues = summary.issues.filter((issue) => this.isStrictQualityCheckTargetFile(issue.filePath));
    return {
      ...summary,
      totalErrors: issues.length,
      issues,
    };
  }

  private reportArtifactWarnings(
    onProgress: ((message: string, metadata?: Record<string, unknown>) => void) | undefined,
    entries: Array<[phase: string, warnings: string[]]>,
  ): void {
    for (const [phase, warnings] of entries) {
      for (const warning of warnings) {
        onProgress?.(`${phase} warning`, { warning });
      }
    }
  }

  /**
   * 読めなかった / 形式が違った成果物を、その成果物が根拠になる指標の証跡に残す。
   * 手動判定に留まった理由がレポートだけで分かるようにするため。
   */
  private attachArtifactWarnings(
    categories: Map<QualityCategoryId, QualityMetricReport[]>,
    warnings: {
      browserAudits: string[];
      testArtifacts: string[];
      uiTestArtifacts: string[];
      apiArtifacts: string[];
      securityArtifacts: string[];
    },
  ): void {
    const byMetricId = new Map<string, string[]>();
    const add = (metricId: string, entries: string[]): void => {
      if (entries.length === 0) {
        return;
      }
      byMetricId.set(metricId, [...(byMetricId.get(metricId) ?? []), ...entries]);
    };
    const partition = (entries: string[], predicate: (entry: string) => boolean): [string[], string[]] => [
      entries.filter((entry) => predicate(entry)),
      entries.filter((entry) => !predicate(entry)),
    ];

    const [lighthouseWarnings, axeWarnings] = partition(warnings.browserAudits, (entry) => /lighthouse/iu.test(entry.split(":")[0] ?? entry));
    add("wcag_aa", axeWarnings);
    add("lighthouse_performance", lighthouseWarnings);
    const [coverageWarnings, junitWarnings] = partition(warnings.testArtifacts, (entry) => /lcov/iu.test(entry.split(":")[0] ?? entry));
    add("unit_pass_rate", junitWarnings);
    add("coverage_rate", coverageWarnings);
    const [storybookWarnings, playwrightWarnings] = partition(warnings.uiTestArtifacts, (entry) => /storybook/iu.test(entry.split(":")[0] ?? entry));
    add("storybook_pass_rate", storybookWarnings);
    add("e2e_pass_rate", playwrightWarnings);
    add("openapi_contract", warnings.apiArtifacts);
    add("dependency_vulnerabilities", warnings.securityArtifacts);

    if (byMetricId.size === 0) {
      return;
    }

    for (const [category, metrics] of categories) {
      categories.set(category, metrics.map((metric) => {
        const entries = byMetricId.get(metric.id);
        if (!entries || entries.length === 0) {
          return metric;
        }
        return {
          ...metric,
          summary: `${metric.summary} 取り込めなかった成果物が ${entries.length} 件あります (証跡「${ARTIFACT_WARNING_EVIDENCE_LABEL}」を参照)。`,
          evidence: [
            ...metric.evidence,
            ...entries.map((entry) => noteEvidence(ARTIFACT_WARNING_EVIDENCE_LABEL, entry)),
          ],
        };
      }));
    }
  }

  /**
   * 失敗したフェーズに依存する指標を「収集失敗」の manual に落とす。
   * fallback の空集計で pass に見せないこと、baseline 比較で証跡喪失として
   * 検出できることの両方を狙っている。
   */
  private applyPhaseFailures(
    categories: Map<QualityCategoryId, QualityMetricReport[]>,
    failures: PhaseFailure[],
  ): void {
    if (failures.length === 0) {
      return;
    }

    const failureByMetricId = new Map<string, PhaseFailure>();
    for (const failure of failures) {
      for (const metricId of PHASE_METRIC_IDS[failure.name] ?? []) {
        if (!failureByMetricId.has(metricId)) {
          failureByMetricId.set(metricId, failure);
        }
      }
    }

    for (const [category, metrics] of categories) {
      categories.set(category, metrics.map((metric) => {
        const failure = failureByMetricId.get(metric.id);
        if (!failure) {
          return metric;
        }
        return {
          ...metric,
          actual: "収集失敗",
          verdict: "manual",
          automation: "manual",
          summary: `収集失敗: ${failure.message}`,
          evidence: [
            noteEvidence("失敗フェーズ", failure.name),
            noteEvidence("エラー", failure.message),
          ],
        } satisfies QualityMetricReport;
      }));
    }
  }

  private toDisplayPath(filePath: string): string {
    // 分類・照合ヘルパーから同じパスに対して繰り返し呼ばれるためメモ化する
    const cached = this.displayPathCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    const displayPath = toDisplayPath(filePath, this.projectRoot);
    this.displayPathCache.set(filePath, displayPath);
    return displayPath;
  }

  private cloneTestPresenceSettings(settings: TestPresenceSettings): TestPresenceSettings {
    return {
      thresholds: {
        application: { ...settings.thresholds.application },
        "library-repo": { ...settings.thresholds["library-repo"] },
      },
      bucketWeights: { ...settings.bucketWeights },
      staticImportTraversalMaxDepth: settings.staticImportTraversalMaxDepth,
      runtimeLineCoverageMinPercent: settings.runtimeLineCoverageMinPercent,
      knownCallNames: [...settings.knownCallNames],
      knownFrameworkModules: [...settings.knownFrameworkModules],
    };
  }
}
