import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { ApiArtifactAnalyzer } from "./ApiArtifactAnalyzer.js";
import { BrowserAuditAnalyzer } from "./BrowserAuditAnalyzer.js";
import { classifyFileType } from "./FileConventions.js";
import { TestArtifactAnalyzer } from "./TestArtifactAnalyzer.js";
import { TypeCheckAnalyzer } from "./TypeCheckAnalyzer.js";
import { UiTestArtifactAnalyzer } from "./UiTestArtifactAnalyzer.js";
import { SecurityArtifactAnalyzer } from "./SecurityArtifactAnalyzer.js";
import type {
  AnalysisResult,
  Dependency,
  FeatureSummary,
  GraphMetrics,
  ParsedFile,
  ManualQualityMetricInput,
  QualityCategoryId,
  QualityCategoryReport,
  QualityEvidence,
  QualityMetricAggregation,
  QualityMetricReport,
  QualityProfile,
  QualityGateRenderContext,
  QualityReport,
  QualitySummary,
  TestPresenceSettings,
  QualityVerdict,
  WorkspaceSegmentSummary,
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

interface AuditFinding {
  filePath: string;
  line: number;
  text: string;
}

interface I18nFinding extends AuditFinding {
  scope: "product" | "library";
}

interface CategoryDescriptor {
  id: QualityCategoryId;
  label: string;
}

interface VisualConsumerSummary {
  total: number;
  designSystemUsers: number;
  bespokeFiles: AuditFinding[];
  entries: Array<{
    filePath: string;
    hasDesignSystemBacking: boolean;
  }>;
}

interface TestPresenceBucketSummary {
  id: "route" | "feature" | "form" | "ui";
  label: string;
  targetFiles: number;
  matchedFiles: number;
  weightedTarget: number;
  weightedMatched: number;
  rate: number;
}

interface TestPresenceSummary {
  targetFiles: number;
  matchedFiles: number;
  weightedTarget: number;
  weightedMatched: number;
  rate: number;
  buckets: TestPresenceBucketSummary[];
  staticMatchedFiles: number;
  runtimeMatchedFiles: number;
  runtimeExplicitUnmatchedFiles: number;
  noEvidenceUnmatchedFiles: number;
  matches: TestPresenceFileMatch[];
}

interface TestPresenceBucketDescriptor {
  id: TestPresenceBucketSummary["id"];
  label: string;
  metricId: string;
}

interface TestPresenceFileMatch {
  filePath: string;
  bucketId: TestPresenceBucketSummary["id"];
  weight: number;
  matched: boolean;
  matchedBy: "runtime" | "static" | "none";
  reasons: string[];
}

interface TypeEscapeFileSummary {
  filePath: string;
  score: number;
  reasons: string[];
}

interface TypeEscapeStats {
  totalWeightedScore: number;
  averageFileScore: number;
  highRiskFileCount: number;
  analyzedFileCount: number;
  topFiles: TypeEscapeFileSummary[];
}

const QUALITY_CATEGORIES: CategoryDescriptor[] = [
  { id: "functional", label: "機能品質" },
  { id: "uiux", label: "UI/UX品質" },
  { id: "accessibility", label: "アクセシビリティ品質" },
  { id: "performance", label: "パフォーマンス品質" },
  { id: "code", label: "コード品質" },
  { id: "test", label: "テスト品質" },
  { id: "api", label: "API連携品質" },
  { id: "security", label: "セキュリティ品質" },
  { id: "i18n", label: "国際化（i18n）品質" },
  { id: "operations", label: "運用・保守性" },
  { id: "build", label: "ビルド・デプロイ品質" },
  { id: "dependencies", label: "依存関係・ライブラリ品質" },
];

const TEST_PRESENCE_BUCKETS: TestPresenceBucketDescriptor[] = [
  { id: "route", label: "Route", metricId: "route_test_file_presence" },
  { id: "feature", label: "Feature", metricId: "feature_test_file_presence" },
  { id: "form", label: "Form", metricId: "form_test_file_presence" },
  { id: "ui", label: "UI", metricId: "ui_test_file_presence" },
];

const DEFAULT_TEST_PRESENCE_SETTINGS: TestPresenceSettings = {
  thresholds: {
    application: { pass: 80, warn: 50 },
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
  knownCallNames: ["test", "it", "describe", "specify"],
  knownFrameworkModules: ["vitest", "jest", "@jest/globals", "@playwright/test", "cypress"],
};

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
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_report.md`), this.renderMarkdown(report), "utf8");
    }
    if (formats.includes("csv")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_summary.csv`), this.renderCsv(report), "utf8");
    }
    if (formats.includes("html")) {
      await fs.writeFile(path.join(options.outputDir, `${options.prefix}_quality_report.html`), this.renderHtml(report), "utf8");
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
    const strictQualityAnalysisResults = input.analysisResults.filter((result) => this.isStrictQualityCheckTargetFile(result.filePath));
    const strictQualityParsedFiles = input.parsedFiles.filter((parsedFile) => this.isStrictQualityCheckTargetFile(parsedFile.filePath));
    const runPhase = async <T>(
      name: string,
      task: () => Promise<T> | T,
      metadata?: Record<string, unknown>,
    ): Promise<T> => {
      const startedAt = Date.now();
      onProgress?.(`${name} started`, metadata);
      const result = await task();
      onProgress?.(`${name} completed`, {
        ...(metadata ?? {}),
        durationMs: Date.now() - startedAt,
      });
      return result;
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
      runPhase("Quality phase: browser audits", () => new BrowserAuditAnalyzer().analyzeProject(input.projectRoot)),
      runPhase("Quality phase: test artifacts", () => new TestArtifactAnalyzer().analyzeProject(input.projectRoot)),
      runPhase("Quality phase: UI test artifacts", () => new UiTestArtifactAnalyzer().analyzeProject(input.projectRoot)),
      runPhase("Quality phase: API artifacts", () => new ApiArtifactAnalyzer().analyzeProject(input.projectRoot, input.parsedFiles)),
      runPhase("Quality phase: security artifacts", () => new SecurityArtifactAnalyzer().analyzeProject(input.projectRoot)),
      runPhase("Quality phase: dangerous HTML scan", () => this.collectDangerousHtml(strictQualityParsedFiles), { files: strictQualityParsedFiles.length }),
      runPhase("Quality phase: i18n text scan", () => this.collectHardcodedJsxText(input.parsedFiles), { files: input.parsedFiles.length }),
      runPhase("Quality phase: secret scan", () => this.collectSecretIndicators(strictQualityParsedFiles), { files: strictQualityParsedFiles.length }),
      runPhase("Quality phase: visual consumer scan", () => this.collectVisualConsumers(input.analysisResults, input.parsedFiles), { files: input.analysisResults.length }),
      runPhase("Quality phase: responsibility scan", () => this.collectHighResponsibilityComponents(strictQualityAnalysisResults), { files: strictQualityAnalysisResults.length }),
      runPhase("Quality phase: zod adoption scan", () => this.collectZodAdoption(input.parsedFiles), { files: input.parsedFiles.length }),
      runPhase("Quality phase: CI detection", () => this.collectCiPresence(input.projectRoot)),
      runPhase("Quality phase: documentation detection", () => this.collectDocumentationPresence(input.projectRoot)),
      runPhase("Quality phase: dependency summary", () => this.collectExternalPackageCount(input.analysisResults), { files: input.analysisResults.length }),
      runPhase(
        "Quality phase: type check",
        () => new TypeCheckAnalyzer().analyzeProject(input.projectRoot, input.tsConfigPath, {
          includedFilePaths: strictQualityParsedFiles.map((parsedFile) => parsedFile.filePath),
          maxRootNames: input.maxTypeCheckRootNames ?? 5000,
          cacheDir: input.cacheDir,
          onProgress,
        }),
        { files: strictQualityParsedFiles.length },
      ),
    ]);
    const typeCheckSummary = this.filterTypeCheckSummary(rawTypeCheckSummary);
    const typeEscapeStats = this.collectTypeEscapeStats(strictQualityAnalysisResults);
    const testPresenceResults = input.testEvidenceResults ?? input.analysisResults;
    const testPresenceParsedFiles = input.testEvidenceParsedFiles ?? input.parsedFiles;
    const testPresence = await runPhase(
      "Quality phase: test presence scan",
      () => this.collectTestPresence(
        input.analysisResults,
        testPresenceResults,
        testPresenceParsedFiles,
        testArtifactSummary.coverage,
        testArtifactSummary.junit,
        uiTestArtifactSummary.playwright,
      ),
      { files: testPresenceResults.length },
    );
    const workspaceSegments = await runPhase(
      "Quality phase: workspace segment summary",
      () => this.collectWorkspaceSegments(input.analysisResults, testPresence, visualConsumers, highResponsibilityComponents, hardcodedJsxText),
      { files: input.analysisResults.length },
    );
    const featureSummaries = await runPhase(
      "Quality phase: feature summary",
      () => this.collectFeatureSummaries(input.analysisResults, testPresence, visualConsumers, highResponsibilityComponents, hardcodedJsxText),
      { files: input.analysisResults.length },
    );

    const categories = new Map<QualityCategoryId, QualityMetricReport[]>();
    const pushMetric = (metric: QualityMetricReport): void => {
      const bucket = categories.get(metric.category) ?? [];
      bucket.push(metric);
      categories.set(metric.category, bucket);
    };

    for (const metric of this.buildFunctionalMetrics()) {
      pushMetric(metric);
    }
    for (const metric of this.buildUiUxMetrics(visualConsumers)) {
      pushMetric(metric);
    }
    for (const metric of this.buildAccessibilityMetrics(browserAuditSummary)) {
      pushMetric(metric);
    }
    for (const metric of this.buildPerformanceMetrics(browserAuditSummary)) {
      pushMetric(metric);
    }
    for (const metric of this.buildCodeMetrics(typeCheckSummary, input.graphMetrics, highResponsibilityComponents, typeEscapeStats)) {
      pushMetric(metric);
    }
    for (const metric of this.buildTestMetrics(testPresence, testArtifactSummary, uiTestArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of this.buildApiMetrics(zodAdoption, apiArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of this.buildSecurityMetrics(dangerousHtml, secretIndicators, securityArtifactSummary)) {
      pushMetric(metric);
    }
    for (const metric of this.buildI18nMetrics(hardcodedJsxText)) {
      pushMetric(metric);
    }
    for (const metric of this.buildOperationsMetrics(docsPresence)) {
      pushMetric(metric);
    }
    for (const metric of this.buildBuildMetrics(ciPresence)) {
      pushMetric(metric);
    }
    for (const metric of this.buildDependencyMetrics(externalPackageCount, input.graphMetrics)) {
      pushMetric(metric);
    }

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

  private buildFunctionalMetrics(): QualityMetricReport[] {
    return [
      this.manualMetric("functional", "requirements_traceability", "要件適合率", "100%", "要件台帳と実装・テストのトレーサビリティ証跡を投入してください。"),
      this.manualMetric("functional", "happy_path_pass_rate", "正常系シナリオ通過率", "100%", "E2E/JUnit などの実行結果を取り込むまでは自動判定できません。"),
      this.manualMetric("functional", "edge_case_coverage", "異常系・エッジケース網羅率", "100%", "ケース一覧とテスト結果の入力が必要です。"),
      this.manualMetric("functional", "residual_bug_count", "バグ残存数（Severity別）", "High=0", "欠陥管理票の入力が必要です。"),
      this.manualMetric("functional", "logic_correctness", "ビジネスロジックの正当性", "100%", "期待値テーブルまたは承認済みテスト証跡を入力してください。"),
    ];
  }

  private buildUiUxMetrics(visualConsumers: VisualConsumerSummary): QualityMetricReport[] {
    const rate = visualConsumers.total > 0
      ? (visualConsumers.designSystemUsers / visualConsumers.total) * 100
      : 0;
    const rateVerdict = visualConsumers.total === 0
      ? "not_applicable"
      : rate >= 80
        ? "pass"
        : rate >= 50
          ? "warn"
          : "fail";
    const bespokeVerdict = visualConsumers.bespokeFiles.length === 0
      ? "pass"
      : visualConsumers.bespokeFiles.length <= 2
        ? "warn"
        : "fail";

    return [
      this.metric("uiux", "design_system_usage_rate", "デザインシステム準拠率（静的推定）", visualConsumers.total === 0 ? "対象画面なし" : `${rate.toFixed(1)}%`, ">= 80%", rateVerdict, visualConsumers.total === 0 ? "画面コンポーネントがないため対象外です。" : `画面系コンポーネント ${visualConsumers.total} 件中 ${visualConsumers.designSystemUsers} 件が JSX 使用経路上で design-system backing を持ちます。`, [
        this.noteEvidence("対象画面数", String(visualConsumers.total)),
      ]),
      this.metric("uiux", "bespoke_ui_file_count", "独自UI実装ファイル件数（静的推定）", String(visualConsumers.bespokeFiles.length), "0", bespokeVerdict, "JSX 使用経路上で共通UI backing を持たない画面系コンポーネントを数えています。", visualConsumers.bespokeFiles.slice(0, 10).map((item) => this.fileEvidence("独自UI候補", item.filePath, `${item.line}行目: ${item.text}`))),
      this.manualMetric("uiux", "figma_delta", "デザイン一致率", ">= 98%", "スクリーンショット差分または Figma 比較結果の入力が必要です。"),
      this.manualMetric("uiux", "breakpoint_layout", "レイアウト崩れ件数", "0", "breakpoint 別スクリーンショット検証が必要です。"),
      this.manualMetric("uiux", "flow_consistency", "操作フローの一貫性", "逸脱なし", "画面遷移とエラー時フィードバックの手動確認が必要です。"),
    ];
  }

  private buildAccessibilityMetrics(
    browserAuditSummary: Awaited<ReturnType<BrowserAuditAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const axe = browserAuditSummary.axe;
    const wcagMetric = axe
      ? this.metric(
        "accessibility",
        "wcag_aa",
        "WCAG 2.2 AA準拠率（axe推定）",
        `critical=${axe.criticalCount}, serious=${axe.seriousCount}, total=${axe.totalViolations}`,
        "critical=0, serious=0",
        axe.criticalCount === 0 && axe.seriousCount === 0 && axe.totalViolations === 0
          ? "pass"
          : axe.criticalCount === 0 && axe.seriousCount === 0
            ? "warn"
            : "fail",
        "axe JSON の violation impact を集計しています。",
        [
          this.noteEvidence("違反総数", String(axe.totalViolations)),
          this.noteEvidence("incomplete", String(axe.incompleteCount)),
          ...axe.files.map((filePath) => this.fileEvidence("axe", filePath)),
        ],
      )
      : this.manualMetric("accessibility", "wcag_aa", "WCAG 2.2 AA準拠率", "AA", "axe JSON が見つからないため手動入力扱いです。");

    return [
      wcagMetric,
      this.manualMetric("accessibility", "aria_usage", "aria属性の適正利用率", "100%", "自動 lint または axe 証跡が必要です。"),
      this.manualMetric("accessibility", "keyboard_completion", "キーボード操作完結率", "100%", "操作導線の実行証跡が必要です。"),
      this.manualMetric("accessibility", "contrast_ratio", "コントラスト比適合率", "100%", "デザイン監査結果の入力が必要です。"),
      this.manualMetric("accessibility", "screen_reader", "スクリーンリーダー動作確認", "合格", "手動検証結果の入力が必要です。"),
    ];
  }

  private buildPerformanceMetrics(
    browserAuditSummary: Awaited<ReturnType<BrowserAuditAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const lighthouse = browserAuditSummary.lighthouse;
    const performanceMetric = lighthouse
      ? this.metric(
        "performance",
        "lighthouse_performance",
        "Lighthouse Performance",
        lighthouse.performanceScore !== null ? `${lighthouse.performanceScore.toFixed(1)}` : "算出不能",
        ">= 90",
        lighthouse.performanceScore === null
          ? "warn"
          : lighthouse.performanceScore >= 90
            ? "pass"
            : lighthouse.performanceScore >= 75
              ? "warn"
              : "fail",
        "Lighthouse JSON の performance score を最悪値ベースで集計しています。",
        lighthouse.files.map((filePath) => this.fileEvidence("lighthouse", filePath)),
      )
      : this.manualMetric("performance", "lighthouse_performance", "Lighthouse Performance", ">= 90", "Lighthouse JSON が見つからないため手動入力扱いです。");
    const lcpMetric = lighthouse
      ? this.metric(
        "performance",
        "lcp",
        "初期表示時間（LCP）",
        lighthouse.lcpSeconds !== null ? `${lighthouse.lcpSeconds.toFixed(2)}s` : "算出不能",
        "< 2.5s",
        lighthouse.lcpSeconds === null
          ? "warn"
          : lighthouse.lcpSeconds < 2.5
            ? "pass"
            : lighthouse.lcpSeconds < 4
              ? "warn"
              : "fail",
        "Lighthouse JSON の largest-contentful-paint を最悪値ベースで集計しています。",
        [],
      )
      : this.manualMetric("performance", "lcp", "初期表示時間（LCP）", "< 2.5s", "Lighthouse JSON が見つからないため手動入力扱いです。");
    const ttiMetric = lighthouse
      ? this.metric(
        "performance",
        "tti",
        "インタラクティブ時間（TTI）",
        lighthouse.ttiSeconds !== null ? `${lighthouse.ttiSeconds.toFixed(2)}s` : "算出不能",
        "< 3.5s",
        lighthouse.ttiSeconds === null
          ? "warn"
          : lighthouse.ttiSeconds < 3.5
            ? "pass"
            : lighthouse.ttiSeconds < 5
              ? "warn"
              : "fail",
        "Lighthouse JSON の interactive を最悪値ベースで集計しています。",
        [],
      )
      : this.manualMetric("performance", "tti", "インタラクティブ時間（TTI）", "< 3.5s", "Lighthouse JSON が見つからないため手動入力扱いです。");

    return [
      performanceMetric,
      lcpMetric,
      ttiMetric,
      this.manualMetric("performance", "bundle_delta", "JSバンドルサイズ増分", "< +3%", "bundle stats の取込が未実装です。"),
      this.manualMetric("performance", "rerender_rate", "不要再レンダリング発生率", "0", "React Profiler 等の実測結果が必要です。"),
    ];
  }

  private buildCodeMetrics(
    typeCheckSummary: ReturnType<TypeCheckAnalyzer["analyzeProject"]>,
    graphMetrics: GraphMetrics,
    highResponsibilityComponents: AuditFinding[],
    typeEscapeStats: TypeEscapeStats,
  ): QualityMetricReport[] {
    const typeCheckVerdict: QualityVerdict = typeCheckSummary.skippedReason
      ? "manual"
      : typeCheckSummary.totalErrors === 0
        ? "pass"
        : "fail";
    const cycleVerdict: QualityVerdict = graphMetrics.cycles.length === 0 ? "pass" : "fail";
    const responsibilityVerdict: QualityVerdict = highResponsibilityComponents.length === 0
      ? "pass"
      : highResponsibilityComponents.length <= 2
        ? "warn"
        : "fail";
    const strictnessSummary = typeCheckSummary.strictnessSummary;
    const strictnessVerdict: QualityVerdict = !strictnessSummary
      ? "manual"
      : strictnessSummary.strictConfigCount === strictnessSummary.configCount
        ? "pass"
        : strictnessSummary.strictConfigCount > 0
          ? "warn"
          : "fail";
    const typeEscapeVerdict: QualityVerdict = typeEscapeStats.totalWeightedScore === 0
      ? "pass"
      : typeEscapeStats.highRiskFileCount === 0 && typeEscapeStats.averageFileScore <= 2
        ? "warn"
        : "fail";
    const strictnessActual = !strictnessSummary
      ? "unknown"
      : `full=${strictnessSummary.fullyStrictConfigCount}/${strictnessSummary.configCount}, strict=${strictnessSummary.strictConfigCount}/${strictnessSummary.configCount}`;
    const strictnessEvidence = strictnessSummary
      ? strictnessSummary.configs.slice(0, 10).map((config) => this.fileEvidence(
        `strict ${config.enabledOptionCount}/6`,
        config.tsConfigPath,
        `strict=${config.strict}, noImplicitAny=${config.noImplicitAny}, strictNullChecks=${config.strictNullChecks}, noUncheckedIndexedAccess=${config.noUncheckedIndexedAccess}, exactOptionalPropertyTypes=${config.exactOptionalPropertyTypes}, useUnknownInCatchVariables=${config.useUnknownInCatchVariables}`,
      ))
      : [];
    const typeEscapeActual = typeEscapeStats.totalWeightedScore === 0
      ? "0"
      : `${typeEscapeStats.totalWeightedScore.toFixed(1)} (avg ${typeEscapeStats.averageFileScore.toFixed(2)}, high-risk ${typeEscapeStats.highRiskFileCount})`;
    const typeEscapeEvidence = typeEscapeStats.topFiles.map((item) => this.fileEvidence(
      `score ${item.score.toFixed(1)}`,
      item.filePath,
      item.reasons.join(", "),
    ));

    return [
      this.metric("code", "typescript_errors", "TypeScript型エラー数", String(typeCheckSummary.totalErrors), "0", typeCheckVerdict, typeCheckSummary.skippedReason ?? "tsconfig ベースの pre-emit diagnostics を集計しています。", typeCheckSummary.issues.slice(0, 10).map((issue) => this.fileEvidence(`TS${issue.code}`, issue.filePath, `${issue.line}:${issue.character} ${issue.message}`))),
      this.metric("code", "tsconfig_type_safety", "tsconfig型安全設定", strictnessActual, "strict=all configs", strictnessVerdict, strictnessSummary
        ? "strict を主判定とし、noImplicitAny / strictNullChecks / noUncheckedIndexedAccess / exactOptionalPropertyTypes / useUnknownInCatchVariables の補強設定を証跡として集計しています。"
        : "tsconfig 情報が無いため手動確認扱いです。", strictnessEvidence),
      this.manualMetric("code", "eslint_violations", "ESLint違反数", "0", "ESLint 実行結果の取込が未実装です。"),
      this.metric("code", "circular_dependencies", "循環依存数", String(graphMetrics.cycles.length), "0", cycleVerdict, "依存グラフから循環依存を検出しています。", graphMetrics.cycles.slice(0, 5).map((cycle, index) => this.noteEvidence(`cycle-${index + 1}`, cycle.nodes.map((node) => path.basename(node)).join(" -> ")))),
      this.metric("code", "high_responsibility_components", "高責務コンポーネント件数（静的推定）", String(highResponsibilityComponents.length), "0", responsibilityVerdict, "Hooks 数、JSX 要素数、render complexity から分割候補を推定しています。", highResponsibilityComponents.slice(0, 10).map((item) => this.fileEvidence("分割候補", item.filePath, `${item.line}行目: ${item.text}`))),
      this.metric("code", "type_escape_count", "型の逃げ道スコア", typeEscapeActual, "0 / WARN avg<=2 & high-risk=0", typeEscapeVerdict, "any / unsafe assertion / double assertion / non-null / ts directives を、ファイル種別と fan-in を加味して重み付き集計しています。", typeEscapeEvidence.length > 0 ? typeEscapeEvidence : [this.noteEvidence("集計対象", "weighted type escape score")]),
    ];
  }

  private collectTypeEscapeStats(analysisResults: AnalysisResult[]): TypeEscapeStats {
    const inboundDegree = new Map<string, number>();
    for (const result of analysisResults) {
      for (const dependency of result.dependencies) {
        if (dependency.isExternal) {
          continue;
        }
        inboundDegree.set(dependency.target, (inboundDegree.get(dependency.target) ?? 0) + 1);
      }
    }

    const files = analysisResults
      .filter((result) => this.isStrictQualityCheckTargetFile(result.filePath))
      .map((result) => {
        const score = this.getTypeEscapeFileScore(result, inboundDegree.get(result.filePath) ?? 0);
        return {
          filePath: result.filePath,
          score,
          reasons: this.buildTypeEscapeReasons(result, inboundDegree.get(result.filePath) ?? 0),
        };
      });

    const totalWeightedScore = files.reduce((sum, item) => sum + item.score, 0);
    const analyzedFileCount = files.length;
    const averageFileScore = analyzedFileCount > 0 ? totalWeightedScore / analyzedFileCount : 0;
    const highRiskFileCount = files.filter((item) => item.score >= 8).length;

    return {
      totalWeightedScore: Number(totalWeightedScore.toFixed(2)),
      averageFileScore: Number(averageFileScore.toFixed(2)),
      highRiskFileCount,
      analyzedFileCount,
      topFiles: files
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath))
        .slice(0, 10),
    };
  }

  private getTypeEscapeFileScore(result: AnalysisResult, inboundDegree: number): number {
    const metrics = result.complexity.typeMetrics;
    const bareAssertionCount = Math.max(
      0,
      metrics.assertionCount
        - (metrics.unsafeAssertionCount ?? 0)
        - (metrics.doubleAssertionCount ?? 0)
        - (metrics.constAssertionCount ?? 0),
    );
    const rawScore = (metrics.anyTypeCount * 4)
      + ((metrics.unsafeAssertionCount ?? 0) * 4)
      + ((metrics.doubleAssertionCount ?? 0) * 5)
      + (bareAssertionCount * 1.5)
      + (metrics.nonNullAssertionCount * 2)
      + (metrics.tsIgnoreCount * 6)
      + ((metrics.tsExpectErrorCount ?? 0) * 4)
      + ((metrics.tsNoCheckCount ?? 0) * 20);
    const fileTypeMultiplier = this.getTypeEscapeFileWeight(result.filePath);
    const centralityMultiplier = 1 + Math.min(1.5, inboundDegree * 0.15);
    return Number((rawScore * fileTypeMultiplier * centralityMultiplier).toFixed(2));
  }

  private buildTypeEscapeReasons(result: AnalysisResult, inboundDegree: number): string[] {
    const metrics = result.complexity.typeMetrics;
    const reasons: string[] = [];
    if (metrics.anyTypeCount > 0) {
      reasons.push(`any=${metrics.anyTypeCount}`);
    }
    if ((metrics.unsafeAssertionCount ?? 0) > 0) {
      reasons.push(`unsafeAssertion=${metrics.unsafeAssertionCount}`);
    }
    if ((metrics.doubleAssertionCount ?? 0) > 0) {
      reasons.push(`doubleAssertion=${metrics.doubleAssertionCount}`);
    }
    if (metrics.nonNullAssertionCount > 0) {
      reasons.push(`nonNull=${metrics.nonNullAssertionCount}`);
    }
    if (metrics.tsIgnoreCount > 0) {
      reasons.push(`tsIgnore=${metrics.tsIgnoreCount}`);
    }
    if ((metrics.tsExpectErrorCount ?? 0) > 0) {
      reasons.push(`tsExpectError=${metrics.tsExpectErrorCount}`);
    }
    if ((metrics.tsNoCheckCount ?? 0) > 0) {
      reasons.push(`tsNoCheck=${metrics.tsNoCheckCount}`);
    }
    if (inboundDegree > 0) {
      reasons.push(`fanIn=${inboundDegree}`);
    }
    return reasons;
  }

  private getTypeEscapeFileWeight(filePath: string): number {
    switch (this.classifyFileType(filePath)) {
      case "API/Infrastructure":
      case "Context/State":
      case "Hook":
      case "Schema":
      case "Validation":
      case "Type Support":
        return 1.4;
      case "Route":
      case "Feature":
      case "Form":
      case "Layout":
        return 1.2;
      case "Barrel":
        return 0.8;
      default:
        return 1;
    }
  }

  private buildTestMetrics(
    testPresence: TestPresenceSummary,
    testArtifactSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>,
    uiTestArtifactSummary: Awaited<ReturnType<UiTestArtifactAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const verdict = this.testPresenceVerdict(testPresence.targetFiles, testPresence.rate);
    const testPresenceThreshold = this.testPresenceThresholdLabel();
    const junit = testArtifactSummary.junit;
    const coverage = testArtifactSummary.coverage;
    const vitest = testArtifactSummary.vitest;
    const playwright = uiTestArtifactSummary.playwright;
    const storybook = uiTestArtifactSummary.storybook;
    // 通過率の分母はスキップを除いた実行件数。skip 混じりでも失敗 0 なら 100% になる。
    const junitExecuted = junit ? Math.max(0, junit.totalTests - junit.skippedTests) : 0;
    const junitRate = junit && junitExecuted > 0 ? (junit.passedTests / junitExecuted) * 100 : null;
    const coverageRate = coverage?.lineCoverage ?? null;
    const playwrightExecuted = playwright ? Math.max(0, playwright.totalTests - playwright.skippedTests) : 0;
    const playwrightRate = playwright && playwrightExecuted > 0 ? (playwright.passedTests / playwrightExecuted) * 100 : null;
    const storybookExecuted = storybook ? Math.max(0, storybook.totalTests - storybook.skippedTests) : 0;
    const storybookRate = storybook && storybookExecuted > 0 ? (storybook.passedTests / storybookExecuted) * 100 : null;
    const unitPassMetric = junit
      ? this.metric(
        "test",
        "unit_pass_rate",
        "Unitテスト通過率",
        junit.totalTests === 0 ? "0件" : junitExecuted === 0 ? "実行0件（全てスキップ）" : `${junitRate?.toFixed(1)}%`,
        "100%",
        junit.totalTests === 0 || junitExecuted === 0
          ? "warn"
          : junit.failedTests === 0 && junitRate === 100
            ? "pass"
            : "fail",
        "JUnit XML から tests / failures / errors / skipped を集計しています。通過率はスキップを分母から除外して算出します。",
        [
          this.noteEvidence("総テスト数", String(junit.totalTests)),
          this.noteEvidence("失敗数", String(junit.failedTests)),
          this.noteEvidence("スキップ数", String(junit.skippedTests)),
          this.noteEvidence("実行済みテストファイル数", String(junit.executedTestFiles.length)),
          ...junit.files.map((filePath) => this.fileEvidence("junit", filePath)),
        ],
      )
      : vitest
        ? this.metric(
          "test",
          "unit_pass_rate",
          "Unitテスト通過率",
          "Vitest検出 / 結果未収集",
          "100%",
          "manual",
          "Vitest は検出されましたが、JUnit XML などの実行結果が見つからないため通過率は算出できません。",
          [
            ...vitest.files.map((filePath) => this.fileEvidence("vitest", filePath)),
            ...vitest.scripts.map((script) => this.noteEvidence("vitest-script", script)),
          ],
        )
        : this.manualMetric("test", "unit_pass_rate", "Unitテスト通過率", "100%", "JUnit XML が見つからず、Vitest も検出されないため手動入力扱いです。");
    const coverageMetric = coverage
      ? this.metric(
        "test",
        "coverage_rate",
        "テスト網羅率（LCOV line coverage）",
        coverageRate !== null ? `${coverageRate.toFixed(1)}%` : "算出不能",
        ">= 80%",
        coverageRate === null
          ? "warn"
          : coverageRate >= 80
            ? "pass"
            : "fail",
        "LCOV の LF / LH から line coverage を算出しています。",
        [
          this.noteEvidence("対象行数", String(coverage.lineFound)),
          this.noteEvidence("通過行数", String(coverage.lineHit)),
          ...coverage.files.map((filePath) => this.fileEvidence("lcov", filePath)),
        ],
      )
      : this.manualMetric("test", "coverage_rate", "テスト網羅率（LCOV line coverage）", ">= 80%", "LCOV が見つからないため手動入力扱いです。");
    const storybookMetric = storybook
      ? this.metric(
        "test",
        "storybook_pass_rate",
        "Storybook Interactionテスト通過率",
        storybook.totalTests === 0 ? "0件" : storybookExecuted === 0 ? "実行0件（全てスキップ）" : `${storybookRate?.toFixed(1)}%`,
        "100%",
        storybook.totalTests === 0 || storybookExecuted === 0
          ? "warn"
          : storybook.failedTests === 0 && storybookRate === 100
            ? "pass"
            : "fail",
        "Storybook 結果 JSON から通過率を集計しています。通過率はスキップを分母から除外して算出します。",
        [
          this.noteEvidence("総テスト数", String(storybook.totalTests)),
          this.noteEvidence("失敗数", String(storybook.failedTests)),
          this.noteEvidence("スキップ数", String(storybook.skippedTests)),
          ...storybook.files.map((filePath) => this.fileEvidence("storybook", filePath)),
        ],
      )
      : this.manualMetric("test", "storybook_pass_rate", "Storybook Interactionテスト通過率", "100%", "Storybook 結果 JSON が見つからないため手動入力扱いです。");
    const playwrightMetric = playwright
      ? this.metric(
        "test",
        "e2e_pass_rate",
        "E2Eテスト通過率",
        playwright.totalTests === 0 ? "0件" : playwrightExecuted === 0 ? "実行0件（全てスキップ）" : `${playwrightRate?.toFixed(1)}%`,
        "100%",
        playwright.totalTests === 0 || playwrightExecuted === 0
          ? "warn"
          : playwright.failedTests === 0 && playwrightRate === 100
            ? "pass"
            : "fail",
        "Playwright 結果 JSON から通過率を集計しています。通過率はスキップを分母から除外して算出します。",
        [
          this.noteEvidence("総テスト数", String(playwright.totalTests)),
          this.noteEvidence("失敗数", String(playwright.failedTests)),
          this.noteEvidence("スキップ数", String(playwright.skippedTests)),
          this.noteEvidence("実行済みテストファイル数", String(playwright.executedTestFiles.length)),
          ...playwright.files.map((filePath) => this.fileEvidence("playwright", filePath)),
        ],
      )
      : this.manualMetric("test", "e2e_pass_rate", "E2Eテスト通過率", "100%", "Playwright 結果 JSON が見つからないため手動入力扱いです。");

    return [
      this.metric(
        "test",
        "matching_test_file_presence",
        "対応テストファイル存在率（重み付き推定）",
        testPresence.targetFiles === 0 ? "対象ソースなし" : `${testPresence.rate.toFixed(1)}%`,
        testPresenceThreshold,
        verdict,
        "LCOV の per-file 証跡を最優先し、無い場合は JUnit / Playwright の実行済みテストファイル、最後に静的な import / 命名対応から推定しています。Story は主指標に含めません。Route / Feature / Form / UI の内訳は下位指標で確認できます。",
        this.buildTestPresenceEvidence(testPresence),
      ),
      ...testPresence.buckets.map((bucket) => this.buildTestPresenceBucketMetric(bucket)),
      unitPassMetric,
      storybookMetric,
      playwrightMetric,
      coverageMetric,
      this.manualMetric("test", "flaky_rate", "flaky test率", "0%", "再実行統計の入力が必要です。"),
    ];
  }

  private buildApiMetrics(
    zodAdoption: { totalFiles: number; adoptedFiles: number; rate: number },
    apiArtifactSummary: Awaited<ReturnType<ApiArtifactAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const zodThreshold = this.zodAdoptionThreshold();
    const verdict: QualityVerdict = zodAdoption.totalFiles === 0
      ? "not_applicable"
      : this.qualityProfile === "library-repo" && zodAdoption.totalFiles < zodThreshold.minimumApplicableFiles
        ? "not_applicable"
        : zodAdoption.rate >= zodThreshold.pass
          ? "pass"
          : zodAdoption.rate >= zodThreshold.warn
            ? "warn"
            : "fail";
    const openApiMetric = apiArtifactSummary.openApi?.breakingChanges !== null && apiArtifactSummary.openApi
      ? this.metric(
        "api",
        "openapi_contract",
        "APIレスポンス整合性",
        `breaking=${apiArtifactSummary.openApi.breakingChanges}`,
        "breaking=0",
        apiArtifactSummary.openApi.breakingChanges === 0 ? "pass" : "fail",
        "OpenAPI diff / validation JSON から breaking change 数を集計しています。",
        [
          ...apiArtifactSummary.openApi.diffFiles.map((filePath) => this.fileEvidence("openapi-diff", filePath)),
          ...apiArtifactSummary.openApi.specFiles.map((filePath) => this.fileEvidence("openapi-spec", filePath)),
        ],
      )
      : this.metric(
        "api",
        "openapi_contract",
        "APIレスポンス整合性",
        apiArtifactSummary.openApi?.specFiles.length ? "specあり / diffなし" : "証跡未収集",
        "breaking=0",
        "manual",
        apiArtifactSummary.openApi?.specFiles.length
          ? "OpenAPI spec は見つかりましたが diff / validation 証跡がないため手動入力扱いです。"
          : "OpenAPI diff / validation 証跡が見つからないため手動入力扱いです。",
        apiArtifactSummary.openApi?.specFiles.map((filePath) => this.fileEvidence("openapi-spec", filePath)) ?? [],
      );
    const mswMetric = apiArtifactSummary.msw.apiFileCount === 0
      ? this.metric("api", "msw_alignment", "MSWとの整合性（採用シグナル）", "対象API層なし", "N/A", "not_applicable", "API 層ファイルがないため対象外です。", [])
      : this.metric(
        "api",
        "msw_alignment",
        "MSWとの整合性（採用シグナル）",
        `handlers=${apiArtifactSummary.msw.handlerCount}`,
        ">= 1",
        apiArtifactSummary.msw.handlerCount > 0 ? "pass" : "warn",
        "MSW handler 定義の存在を API 層ファイル数に対して評価しています。",
        apiArtifactSummary.msw.handlerFiles.map((filePath) => this.fileEvidence("msw", filePath)),
      );
    const timeoutRetryMetric = apiArtifactSummary.timeoutRetry.apiFileCount === 0
      ? this.metric("api", "timeout_retry", "タイムアウト/リトライ設計有無", "対象API層なし", "N/A", "not_applicable", "API 層ファイルがないため対象外です。", [])
      : this.metric(
        "api",
        "timeout_retry",
        "タイムアウト/リトライ設計有無",
        `${apiArtifactSummary.timeoutRetry.resilientFiles.length}/${apiArtifactSummary.timeoutRetry.apiFileCount} files`,
        ">= 1 file",
        apiArtifactSummary.timeoutRetry.resilientFiles.length > 0 ? "pass" : "warn",
        "AbortController / timeout / retry 系シグナルを API 層ファイルから検出しています。",
        apiArtifactSummary.timeoutRetry.resilientFiles.map((filePath) => this.fileEvidence("timeout-retry", filePath)),
      );

    return [
      openApiMetric,
      this.manualMetric("api", "error_handling", "エラーハンドリング網羅率", "100%", "API エラー時の実行証跡が必要です。"),
      timeoutRetryMetric,
      mswMetric,
      this.metric("api", "zod_adoption", "データ型検証採用率（zod静的推定）", zodAdoption.totalFiles === 0 ? "対象API層なし" : `${zodAdoption.rate.toFixed(1)}%`, this.zodAdoptionThresholdLabel(), verdict, "API / validation / schema 系ファイルで zod import を検出しています。", [
        this.noteEvidence("対象ファイル数", String(zodAdoption.totalFiles)),
        this.noteEvidence("採用ファイル数", String(zodAdoption.adoptedFiles)),
      ]),
    ];
  }

  private buildSecurityMetrics(
    dangerousHtml: AuditFinding[],
    secretIndicators: AuditFinding[],
    securityArtifactSummary: Awaited<ReturnType<SecurityArtifactAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const dangerousVerdict: QualityVerdict = dangerousHtml.length === 0 ? "pass" : "fail";
    const secretVerdict: QualityVerdict = secretIndicators.length === 0 ? "pass" : "fail";
    const vulnerabilityMetric = securityArtifactSummary.tools.length > 0
      ? this.metric(
        "security",
        "dependency_vulnerabilities",
        "依存ライブラリ脆弱性",
        securityArtifactSummary.tools.map((tool) => `${tool.tool}(critical=${tool.critical},high=${tool.high})`).join(", "),
        "critical=0, high=0",
        securityArtifactSummary.tools.some((tool) => tool.critical > 0 || tool.high > 0) ? "fail" : "pass",
        "npm audit / Trivy の JSON 結果をツール別に評価しています。",
        securityArtifactSummary.tools.map((tool) => this.fileEvidence(tool.tool, tool.filePath)),
      )
      : this.manualMetric("security", "dependency_vulnerabilities", "依存ライブラリ脆弱性", "High=0", "npm audit / Trivy 結果の取込が未実装です。");

    return [
      this.metric("security", "dangerous_html", "dangerouslySetInnerHTML使用件数", String(dangerousHtml.length), "0", dangerousVerdict, "JSX 属性 `dangerouslySetInnerHTML` を直接検出しています。", dangerousHtml.slice(0, 10).map((item) => this.fileEvidence("dangerouslySetInnerHTML", item.filePath, `${item.line}行目`))),
      this.manualMetric("security", "csrf_protection", "CSRF対策", "有効", "実行時設定の確認が必要です。"),
      this.manualMetric("security", "auth_flow", "認証・認可フロー検証", "合格", "認証済みシナリオ実行結果が必要です。"),
      vulnerabilityMetric,
      this.metric("security", "secret_indicators", "機密情報露出シグナル件数", String(secretIndicators.length), "0", secretVerdict, "API key / private key 断片の静的パターンを検出しています。", secretIndicators.slice(0, 10).map((item) => this.fileEvidence("secret-pattern", item.filePath, `${item.line}行目: ${item.text}`))),
    ];
  }

  private buildI18nMetrics(hardcodedJsxText: I18nFinding[]): QualityMetricReport[] {
    const productFindings = hardcodedJsxText.filter((item) => item.scope === "product");
    const libraryFindings = hardcodedJsxText.filter((item) => item.scope === "library");
    const i18nThreshold = this.hardcodedTextThreshold();
    const verdict: QualityVerdict = productFindings.length === 0 ? "pass" : productFindings.length <= i18nThreshold.warnMax ? "warn" : "fail";
    const summary = productFindings.length === 0 && libraryFindings.length === 0
      ? "製品文言・共通UIラベルともに未検出です。"
      : `製品文言 ${productFindings.length} 件、共通UIラベル ${libraryFindings.length} 件です。判定は製品文言だけを基準にしています。`;

    return [
      this.metric(
        "i18n",
        "hardcoded_jsx_text",
        "ハードコード製品文言件数（JSX）",
        String(productFindings.length),
        this.hardcodedTextThresholdLabel(),
        verdict,
        summary,
        [
          this.noteEvidence("製品文言件数", String(productFindings.length)),
          this.noteEvidence("共通UIラベル件数", String(libraryFindings.length)),
          ...productFindings.slice(0, 8).map((item) => this.fileEvidence("product-text", item.filePath, `${item.line}行目: ${item.text}`)),
          ...libraryFindings.slice(0, 4).map((item) => this.fileEvidence("library-text", item.filePath, `${item.line}行目: ${item.text}`)),
        ],
      ),
      this.manualMetric("i18n", "translation_keys", "翻訳キー存在率", "100%", "辞書ファイルとの照合が未実装です。"),
      this.manualMetric("i18n", "pseudo_locale", "疑似ロケール対応", "合格", "疑似ロケール実行結果が必要です。"),
      this.manualMetric("i18n", "formatting", "日付/数値フォーマット適正", "合格", "Intl 利用監査が未実装です。"),
      this.manualMetric("i18n", "rtl", "RTL対応", "必要時合格", "RTL 向けレイアウト監査が未実装です。"),
    ];
  }

  private buildOperationsMetrics(docsPresence: { docsCount: number; docFiles: string[] }): QualityMetricReport[] {
    const verdict: QualityVerdict = docsPresence.docsCount > 0 ? "pass" : "warn";

    return [
      this.metric("operations", "documentation_presence", "ドキュメント整備率シグナル", docsPresence.docsCount > 0 ? `${docsPresence.docsCount} 件` : "0 件", ">= 1", verdict, "README / docs / ADR 相当ファイルの存在を見ています。", docsPresence.docFiles.slice(0, 10).map((filePath) => this.fileEvidence("doc", filePath))),
      this.manualMetric("operations", "logging_design", "ログ出力設計", "定義済み", "観測性ポリシーの証跡が必要です。"),
      this.manualMetric("operations", "error_tracking", "エラートラッキング", "定義済み", "Sentry 等の設定証跡が必要です。"),
      this.manualMetric("operations", "feature_flags", "Feature Flag対応", "必要箇所で実装", "Flag 管理台帳の証跡が必要です。"),
      this.manualMetric("operations", "externalized_config", "設定の外部化", "定義済み", "環境変数・設定管理の証跡が必要です。"),
    ];
  }

  private buildBuildMetrics(ciPresence: { hasCi: boolean; files: string[] }): QualityMetricReport[] {
    const verdict: QualityVerdict = ciPresence.hasCi ? "pass" : "warn";

    return [
      this.metric("build", "ci_presence", "CI設定有無", ciPresence.hasCi ? "あり" : "なし", "あり", verdict, "主要な CI 設定ファイルの存在を確認しています。", ciPresence.files.map((filePath) => this.fileEvidence("ci-config", filePath))),
      this.manualMetric("build", "build_time", "ビルド時間", "基準内", "CI 実行結果の取込が未実装です。"),
      this.manualMetric("build", "cache_efficiency", "キャッシュ効率", "基準内", "CI キャッシュ統計の取込が未実装です。"),
      this.manualMetric("build", "rollback", "rollback手順有無", "あり", "運用手順書の証跡が必要です。"),
      this.manualMetric("build", "environment_diff", "環境差異の有無", "差異管理済み", "環境比較結果の入力が必要です。"),
    ];
  }

  private buildDependencyMetrics(externalPackageCount: number, graphMetrics: GraphMetrics): QualityMetricReport[] {
    const dependencyThreshold = this.externalPackageThreshold();
    const externalVerdict: QualityVerdict = externalPackageCount <= dependencyThreshold.pass
      ? "pass"
      : externalPackageCount <= dependencyThreshold.warn
        ? "warn"
        : "fail";

    return [
      this.metric("dependencies", "external_package_count", "外部依存パッケージ数", String(externalPackageCount), this.externalPackageThresholdLabel(), externalVerdict, "import された外部 package 名のユニーク数です。", []),
      this.metric("dependencies", "dependency_cycle_count", "循環依存件数", String(graphMetrics.cycles.length), "0", graphMetrics.cycles.length === 0 ? "pass" : "fail", "依存グラフ観点でのライブラリ品質監査です。", []),
      this.manualMetric("dependencies", "unused_dependencies", "不要依存の有無", "0", "package.json と import 実績の完全照合が未実装です。"),
      this.manualMetric("dependencies", "license_compliance", "ライセンス適合性", "適合", "license scan の取込が未実装です。"),
      this.manualMetric("dependencies", "maintenance_health", "メンテナンス状態", "健全", "更新頻度や保守終了の監査が未実装です。"),
    ];
  }

  private calculateCategoryVerdict(metrics: QualityMetricReport[]): QualityVerdict {
    const primaryMetrics = this.primaryMetrics(metrics);
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
    const primaryMetrics = this.primaryMetrics(metrics);
    const derivedMetrics = this.derivedMetrics(metrics);
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
    const primaryMetrics = this.primaryMetrics(metrics);
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

  private renderMarkdown(report: QualityReport): string {
    const qualityProfile = report.qualityProfile ?? "application";
    const workspaceSegments = report.workspaceSegments ?? [];
    const featureSummaries = report.featureSummaries ?? [];
    const showWorkspaceSegments = this.shouldRenderWorkspaceSegments(workspaceSegments);
    const showFeatureSummaries = this.shouldRenderFeatureSummaries(featureSummaries);
    const priorityMetrics = this.collectPriorityMetrics(report, 8);
    const automaticCoverage = this.calculateAutomaticCoverage(report);
    const measuredSignalStats = this.calculateAutomaticSignalStats(report, false);
    const modeledSignalStats = this.calculateAutomaticSignalStats(report, true);
    const derivedInsights = this.collectNotableDerivedInsights(report, 2);
    const pendingManualMetrics = this.collectPendingManualMetrics(report);
    const automatablePendingMetrics = pendingManualMetrics
      .map((entry) => ({
        categoryLabel: entry.categoryLabel,
        metrics: entry.metrics.filter((metric) => this.isAutomatableManualMetric(metric)),
      }))
      .filter((entry) => entry.metrics.length > 0);
    const manualOnlyPendingMetrics = pendingManualMetrics
      .map((entry) => ({
        categoryLabel: entry.categoryLabel,
        metrics: entry.metrics.filter((metric) => !this.isAutomatableManualMetric(metric)),
      }))
      .filter((entry) => entry.metrics.length > 0);
    const manualOnlyCategories = report.categories.filter((category) => this.isManualOnlyCategory(category));
    const mainCategories = report.categories.filter((category) => !this.isManualOnlyCategory(category));
    const failCategories = report.categories.filter((category) => category.verdict === "fail").map((category) => category.label);
    const warnCategories = report.categories.filter((category) => category.verdict === "warn").map((category) => category.label);
    const partialCategories = report.categories.filter((category) => category.verdict === "partial").map((category) => category.label);
    const blockingMetrics = this.collectBlockingAutomaticMetrics(report, 3);
    const lines: string[] = ["# React 出荷審査 品質レポート", ""];

    // 目次は本文確定後に実際の h2 見出しから生成する (プレースホルダを後で置換)
    lines.push("{{QUALITY_TOC}}", "");

    lines.push(
      "## 判定凡例",
      "",
      "| 状態 | 定義 |",
      "|------|------|",
      "| PASS | 自動判定指標で重大な問題が検出されていない状態 |",
      "| WARN | FAIL ではないが、継続監視または追加対応が必要な状態 |",
      "| FAIL | カテゴリ内に失敗指標が1件以上ある状態 |",
      "| PARTIAL | 自動判定は通るが、手動確認待ちが残っており完了扱いできない状態 |",
      "| MANUAL | 自動判定指標がなく、手動証跡待ちの状態 |",
      "",
      `- 総合判定ルール: ${this.describeOverallVerdictRule()}`,
      "- 信頼度: 高=実測/集計, 中=静的推定, 低=手動入力または未収集",
      "",
    );

    lines.push(
      "## 要点",
      "",
      ...this.buildGateVerdictLines(),
      `- 総合判定: ${this.verdictLabel(report.summary.overallVerdict)}`,
      this.buildBaselineComparisonLine(report),
      `- 自動判定カバレッジ: ${automaticCoverage.automaticCount}/${automaticCoverage.totalCount} 指標 (${automaticCoverage.coverageRate.toFixed(1)}%)`,
      `- 実測ベーススコア: PASS率 ${measuredSignalStats.passRate.toFixed(1)}%（PASS ${measuredSignalStats.pass} / WARN ${measuredSignalStats.warn} / FAIL ${measuredSignalStats.fail} / PARTIAL ${measuredSignalStats.partial}）`,
      `- 推定込みスコア: PASS率 ${modeledSignalStats.passRate.toFixed(1)}%（PASS ${modeledSignalStats.pass} / WARN ${modeledSignalStats.warn} / FAIL ${modeledSignalStats.fail} / PARTIAL ${modeledSignalStats.partial}）`,
      `- 自動阻害指標: ${blockingMetrics.length > 0 ? blockingMetrics.map((entry) => `${entry.categoryLabel}/${entry.metric.label}`).join("、") : "なし"}`,
      `- 注目下位指標: ${derivedInsights.length > 0 ? derivedInsights.map((entry) => `${entry.categoryLabel}/${entry.metric.label} ${entry.metric.actual} (${this.verdictLabel(entry.metric.verdict)})`).join("、") : "なし"}`,
      `- FAILカテゴリ: ${failCategories.length > 0 ? failCategories.join("、") : "なし"}`,
      `- WARNカテゴリ: ${warnCategories.length > 0 ? warnCategories.join("、") : "なし"}`,
      `- PARTIALカテゴリ: ${partialCategories.length > 0 ? partialCategories.join("、") : "なし"}`,
      `- 手動確認待ち: ${report.summary.manualCount} 指標`,
      `- 品質プロファイル: ${qualityProfile}`,
      "",
    );

    lines.push("## 優先対応", "", "失敗と警告だけを先頭に集約しています。", "");
    if (priorityMetrics.length === 0) {
      lines.push("自動判定で直ちに阻害する項目はありません。", "");
    } else {
      lines.push(
        "| 優先度 | 観点 | 指標 | 判定 | 実績 | 基準 | 証跡種別 | 信頼度 | 主対象 | 推奨アクション | 要点 |",
        "|--------|------|------|------|------|------|----------|--------|--------|----------------|------|",
      );
      priorityMetrics.forEach((entry, index) => {
        const metricLabel = this.shouldRenderDetailedMetric(entry.metric)
          ? `[${entry.metric.label}](#${this.metricAnchor(entry.categoryLabel, entry.metric)})`
          : entry.metric.label;
        lines.push(`| ${index + 1} | ${entry.categoryLabel} | ${metricLabel} | ${this.verdictLabel(entry.metric.verdict)} | ${this.escapePipe(entry.metric.actual)} | ${this.escapePipe(entry.metric.threshold)} | ${this.describeEvidenceType(entry.metric)} | ${this.describeConfidenceLevel(entry.metric)} | ${this.escapePipe(this.summarizeMetricTargets(entry.metric, 2))} | ${this.escapePipe(this.truncateText(this.recommendMetricAction(entry.metric), 45))} | ${this.escapePipe(this.truncateText(entry.metric.summary, 45))} |`);
      });
      lines.push("");
    }

    lines.push("## 不足証跡", "", `手動確認待ち ${report.summary.manualCount} 件を「自動収集できるもの」と「人手確認が必要なもの」に分けています。`, "");
    if (pendingManualMetrics.length === 0) {
      lines.push("手動確認待ちの指標はありません。", "");
    } else {
      if (automatablePendingMetrics.length > 0) {
        lines.push("### 自動収集で埋められる証跡", "");
        for (const entry of automatablePendingMetrics) {
          const labels = entry.metrics.slice(0, 5).map((metric) => metric.label).join("、");
          const remainder = entry.metrics.length > 5 ? `、他${entry.metrics.length - 5}件` : "";
          lines.push(`- ${entry.categoryLabel}: ${labels}${remainder}`);
        }
        lines.push("");
      }
      if (manualOnlyPendingMetrics.length > 0) {
        lines.push("### 人手確認が必要な証跡", "");
        for (const entry of manualOnlyPendingMetrics) {
          const labels = entry.metrics.slice(0, 5).map((metric) => metric.label).join("、");
          const remainder = entry.metrics.length > 5 ? `、他${entry.metrics.length - 5}件` : "";
          lines.push(`- ${entry.categoryLabel}: ${labels}${remainder}`);
        }
        lines.push("");
      }
    }

    lines.push(
      "## 集計",
      "",
      "| 観点 | 自動 | FAIL | WARN | PARTIAL | 手動 | 判定 |",
      "|------|------|------|------|---------|------|------|",
    );

    for (const category of report.categories) {
      const primaryMetrics = this.primaryMetrics(category.metrics);
      const autoCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
      const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
      const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
      const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
      const manualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
      lines.push(`| ${category.label} | ${autoCount} | ${failCount} | ${warnCount} | ${partialCount} | ${manualCount} | ${this.verdictLabel(category.verdict)} |`);
    }

    lines.push(
      "",
      `- 総指標数: ${report.summary.totalMetrics}`,
      `- 派生指標数: ${report.summary.derivedMetricCount}`,
      `- PASS: ${report.summary.passCount}`,
      `- PARTIALカテゴリ: ${report.summary.partialCategoryCount}`,
      `- PARTIAL指標: ${report.summary.partialCount}`,
      `- WARN: ${report.summary.warnCount}`,
      `- FAIL: ${report.summary.failCount}`,
      `- MANUAL: ${report.summary.manualCount}`,
      `- OVERALL: ${this.verdictLabel(report.summary.overallVerdict)}`,
      "",
    );

    if (showWorkspaceSegments) {
      lines.push(
        "## ワークスペース内訳",
        "",
        "| セグメント | ファイル数 | コンポーネント数 | 型逃げ件数 | 高責務件数 | 画面系件数 | DS準拠件数 | テスト率 | 製品文言数 |",
        "|------------|------------|------------------|------------|------------|------------|------------|----------|------------|",
      );
      for (const segment of workspaceSegments) {
        lines.push(`| ${segment.label} | ${segment.fileCount} | ${segment.componentCount} | ${segment.typeEscapeCount} | ${segment.highResponsibilityComponentCount} | ${segment.visualConsumerCount} | ${segment.designSystemBackedCount} | ${segment.weightedTestRate.toFixed(1)}% | ${segment.productTextCount} |`);
      }
      lines.push("");
    }

    if (showFeatureSummaries) {
      lines.push(
        "## フィーチャー内訳",
        "",
        "### 規模と複雑度",
        "",
        "| フィーチャー | ファイル数 | コンポーネント数 | 平均複雑度 | 最大複雑度 |",
        "|--------------|------------|------------------|------------|------------|",
      );
      for (const feature of featureSummaries) {
        lines.push(`| ${this.escapePipe(feature.label)} | ${feature.fileCount} | ${feature.componentCount} | ${feature.averageComplexity.toFixed(1)} | ${feature.maxComplexity.toFixed(1)} |`);
      }
      lines.push("", "### 品質リスク", "", "| フィーチャー | 型逃げ件数 | 高責務件数 | 画面系件数 | DS準拠件数 | テスト率 | 製品文言数 |", "|--------------|------------|------------|------------|------------|----------|------------|");
      for (const feature of featureSummaries) {
        lines.push(`| ${this.escapePipe(feature.label)} | ${feature.typeEscapeCount} | ${feature.highResponsibilityComponentCount} | ${feature.visualConsumerCount} | ${feature.designSystemBackedCount} | ${feature.weightedTestRate.toFixed(1)}% | ${feature.productTextCount} |`);
      }
      lines.push("");
    }

    lines.push("## 観点別詳細", "", "証跡は file 証跡優先です。score 表記は降順、それ以外はファイルパスと行番号順で並べています。", "");

    for (const category of mainCategories) {
      const overviewMetrics = this.collectCategoryOverviewMetrics(category.metrics);
      const manualPrimaryMetrics = this.primaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual");
      const testBucketMetrics = category.id === "test" ? this.collectDerivedTestPresenceMetrics(category.metrics) : [];
      lines.push(
        `## ${category.label}`,
        "",
        category.summary,
        "",
      );
      if (overviewMetrics.length === 0) {
        lines.push("自動判定指標はありません。", "");
      } else {
        lines.push(
          "| 指標 | 集計 | 実績 | 基準 | 判定 | 証跡種別 | 信頼度 | 主対象 |",
          "|------|------|------|------|------|----------|--------|--------|",
        );
        for (const metric of overviewMetrics) {
          lines.push(`| ${metric.label} | ${metric.aggregation === "derived" ? "派生" : "親"} | ${this.escapePipe(metric.actual)} | ${this.escapePipe(metric.threshold)} | ${this.verdictLabel(metric.verdict)} | ${this.describeEvidenceType(metric)} | ${this.describeConfidenceLevel(metric)} | ${this.escapePipe(this.summarizeMetricTargets(metric, 2))} |`);
        }
        lines.push("");
      }

      if (manualPrimaryMetrics.length > 0) {
        const labels = manualPrimaryMetrics.slice(0, 4).map((metric) => metric.label).join("、");
        const remainder = manualPrimaryMetrics.length > 4 ? `、他${manualPrimaryMetrics.length - 4}件` : "";
        lines.push(`手動確認待ち ${manualPrimaryMetrics.length} 件: ${labels}${remainder}。詳細は「不足証跡」または付録を参照してください。`, "");
      }

      if (testBucketMetrics.length > 0) {
        lines.push("### 層別テスト対応率", "", "| 層 | 実績 | 基準 | 判定 |", "|----|------|------|------|");
        for (const metric of testBucketMetrics) {
          lines.push(`| ${this.testPresenceLayerLabel(metric)} | ${this.escapePipe(metric.actual)} | ${this.escapePipe(metric.threshold)} | ${this.verdictLabel(metric.verdict)} |`);
        }
        lines.push("");
      }

      const detailedMetrics = category.metrics.filter((metric) =>
        this.shouldRenderDetailedMetric(metric) && !this.isDerivedTestPresenceMetric(metric)
      );
      const hiddenManualMetrics = category.metrics.filter((metric) => metric.verdict === "manual" && !this.shouldRenderDetailedMetric(metric));

      if (detailedMetrics.length === 0) {
        if (hiddenManualMetrics.length > 0) {
          lines.push(`詳細展開は省略しています。手動確認待ち ${hiddenManualMetrics.length} 件は「不足証跡」を参照してください。`, "");
        } else {
          lines.push("追加で確認すべき詳細はありません。", "");
        }
        continue;
      }

      lines.push("### 要確認項目", "");
      for (const metric of detailedMetrics) {
        const sortedEvidence = this.sortEvidenceForDisplay(metric.evidence);
        lines.push(`<a id="${this.metricAnchor(category.label, metric)}"></a>`, `#### ${metric.label}`, "", `- 集計: ${metric.aggregation === "derived" ? "派生" : "親"}`, `- 判定: ${this.verdictLabel(metric.verdict)}`, `- 実績: ${metric.actual}`, `- 基準: ${metric.threshold}`, `- 証跡種別: ${this.describeEvidenceType(metric)}`, `- 信頼度: ${this.describeConfidenceLevel(metric)}`, `- 主対象: ${this.summarizeMetricTargets(metric, 3)}`, `- 推奨アクション: ${this.recommendMetricAction(metric)}`, `- 要点: ${metric.summary}`);
        if (metric.evidence.length > 0) {
          lines.push("- 証跡:");
          for (const evidence of sortedEvidence.slice(0, 3)) {
            lines.push(`  - ${evidence.label}: ${evidence.value}`);
          }
          if (sortedEvidence.length > 3) {
            lines.push(`  - 他${sortedEvidence.length - 3}件`);
          }
        }
        lines.push("");
      }
    }

    if (manualOnlyCategories.length > 0) {
      lines.push("## 付録: 手動確認カテゴリ", "", "自動判定が無い、または対象外のみのカテゴリを付録へ退避しています。", "");
      for (const category of manualOnlyCategories) {
        const primaryMetrics = this.primaryMetrics(category.metrics);
        const labels = primaryMetrics.map((metric) => metric.label).join("、");
        lines.push(`### ${category.label}`, "", `- 判定: ${this.verdictLabel(category.verdict)}`, `- 指標: ${labels}`, `- 補足: ${category.summary}`, "");
      }
    }

    lines.push("## メタデータ", "", `- 生成時刻: ${report.timestamp}`, `- 実行時間: ${report.executionTimeMs}ms`, `- プロジェクト: ${report.projectRoot}`, `- 品質プロファイル: ${qualityProfile}`, "");
    const body = lines.join("\n");
    const headings = Array.from(body.matchAll(/^## (.+)$/gmu)).map((match) => match[1]!);
    const toc = [
      "## 目次",
      "",
      ...headings.map((heading, index) => `${index + 1}. [${heading}](#${this.toMarkdownAnchor(heading)})`),
    ].join("\n");
    return body.replace("{{QUALITY_TOC}}", toc);
  }

  private toMarkdownAnchor(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
  }

  private collectBlockingAutomaticMetrics(
    report: QualityReport,
    limit: number,
  ): Array<{ categoryLabel: string; metric: QualityMetricReport }> {
    return report.categories
      .flatMap((category) =>
        this.primaryMetrics(category.metrics)
          .filter((metric) => metric.automation === "automatic" && metric.verdict === "fail")
          .map((metric) => ({ categoryLabel: category.label, metric }))
      )
      .sort((left, right) => `${left.categoryLabel}:${left.metric.label}`.localeCompare(`${right.categoryLabel}:${right.metric.label}`))
      .slice(0, limit);
  }

  private collectPriorityMetrics(
    report: QualityReport,
    limit: number,
  ): Array<{ categoryLabel: string; metric: QualityMetricReport }> {
    const severityOrder: Record<QualityVerdict, number> = {
      fail: 0,
      warn: 1,
      partial: 2,
      manual: 3,
      pass: 4,
      not_applicable: 5,
    };
    const aggregationOrder: Record<QualityMetricAggregation, number> = {
      primary: 0,
      derived: 1,
    };

    return report.categories
      .flatMap((category) => {
        const primaryProblemMetrics = this.primaryMetrics(category.metrics)
          .filter((metric) => ["fail", "warn", "partial"].includes(metric.verdict));
        if (primaryProblemMetrics.length > 0) {
          return primaryProblemMetrics.map((metric) => ({ categoryLabel: category.label, metric }));
        }

        return this.derivedMetrics(category.metrics)
          .filter((metric) => ["fail", "warn", "partial"].includes(metric.verdict))
          .map((metric) => ({ categoryLabel: category.label, metric }));
      })
      .sort((left, right) => {
        const severityDiff = severityOrder[left.metric.verdict] - severityOrder[right.metric.verdict];
        if (severityDiff !== 0) {
          return severityDiff;
        }
        if (left.metric.aggregation !== right.metric.aggregation) {
          return aggregationOrder[left.metric.aggregation] - aggregationOrder[right.metric.aggregation];
        }
        return `${left.categoryLabel}:${left.metric.label}`.localeCompare(`${right.categoryLabel}:${right.metric.label}`);
      })
      .slice(0, limit);
  }

  private collectPendingManualMetrics(
    report: QualityReport,
  ): Array<{ categoryLabel: string; metrics: QualityMetricReport[] }> {
    return report.categories
      .map((category) => ({
        categoryLabel: category.label,
        metrics: this.primaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual"),
      }))
      .filter((entry) => entry.metrics.length > 0);
  }

  private isManualOnlyCategory(category: QualityCategoryReport): boolean {
    return this.primaryMetrics(category.metrics).every((metric) => ["manual", "not_applicable"].includes(metric.verdict));
  }

  private isAutomatableManualMetric(metric: QualityMetricReport): boolean {
    const text = `${metric.label} ${metric.summary} ${metric.actual} ${metric.threshold}`.toLowerCase();
    return /(axe|lighthouse|lcov|junit|playwright|storybook|openapi|trivy|audit|eslint|json|xml|coverage|ビルド時間|キャッシュ効率|通過率|翻訳キー|bundle|取込|実行結果)/u.test(text);
  }

  private shouldRenderDetailedMetric(metric: QualityMetricReport): boolean {
    return metric.automation === "automatic" && ["fail", "warn", "partial"].includes(metric.verdict);
  }

  private describeEvaluationType(metric: QualityMetricReport): string {
    if (metric.verdict === "not_applicable") {
      return "対象外";
    }
    if (metric.automation === "manual") {
      return metric.evidence.length > 0 ? "手動入力" : "未収集";
    }
    if (/静的推定|静的/u.test(`${metric.label} ${metric.summary}`)) {
      return "静的推定";
    }
    return "実測/集計";
  }

  private describeEvidenceType(metric: QualityMetricReport): string {
    if (metric.verdict === "not_applicable") {
      return "対象外";
    }
    if (metric.automation === "manual") {
      return metric.evidence.length > 0 ? "手動/入力済み" : "手動/未収集";
    }
    return this.describeEvaluationType(metric) === "静的推定" ? "自動/静的推定" : "自動/実測";
  }

  private describeConfidenceLevel(metric: QualityMetricReport): string {
    if (metric.verdict === "not_applicable") {
      return "—";
    }
    if (metric.automation === "manual") {
      return "低";
    }
    return this.describeEvaluationType(metric) === "静的推定" ? "中" : "高";
  }

  private collectCategoryOverviewMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
    return this.primaryMetrics(metrics).filter((metric) => metric.automation === "automatic");
  }

  private collectDerivedTestPresenceMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
    return this.derivedMetrics(metrics)
      .filter((metric) => this.isDerivedTestPresenceMetric(metric))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  private isDerivedTestPresenceMetric(metric: QualityMetricReport): boolean {
    return metric.aggregation === "derived" && /_test_file_presence$/u.test(metric.id);
  }

  private testPresenceLayerLabel(metric: QualityMetricReport): string {
    const mapping: Record<string, string> = {
      route_test_file_presence: "Route",
      feature_test_file_presence: "Feature",
      form_test_file_presence: "Form",
      ui_test_file_presence: "UI",
    };
    return mapping[metric.id] ?? metric.label;
  }

  private summarizeMetricTargets(metric: QualityMetricReport, limit: number): string {
    const targets = this.sortEvidenceForDisplay(metric.evidence)
      .filter((evidence) => evidence.filePath)
      .map((evidence) => this.toDisplayPath(evidence.filePath!))
      .filter((filePath, index, items) => items.indexOf(filePath) === index);
    if (targets.length === 0) {
      return "—";
    }
    const visibleTargets = targets.slice(0, limit);
    const remainder = targets.length > limit ? `、他${targets.length - limit}件` : "";
    return `${visibleTargets.join("、")}${remainder}`;
  }

  private shouldRenderWorkspaceSegments(segments: WorkspaceSegmentSummary[]): boolean {
    const meaningfulSegments = segments.filter((segment) => segment.fileCount > 0 && segment.id !== "other");
    return meaningfulSegments.length >= 2;
  }

  private shouldRenderFeatureSummaries(features: FeatureSummary[]): boolean {
    return features.length >= 2;
  }

  private describeOverallVerdictRule(): string {
    return "FAILカテゴリが1つでもあれば OVERALL=FAIL。FAILが無く WARN があれば WARN、次に PARTIAL、最後に PASS を採用します。";
  }

  private calculateAutomaticCoverage(report: QualityReport): { automaticCount: number; totalCount: number; coverageRate: number } {
    const primaryMetrics = this.primaryMetrics(report.categories.flatMap((category) => category.metrics));
    const automaticCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
    const totalCount = primaryMetrics.length;
    return {
      automaticCount,
      totalCount,
      coverageRate: totalCount > 0 ? (automaticCount / totalCount) * 100 : 0,
    };
  }

  private calculateAutomaticSignalStats(
    report: QualityReport,
    includeStaticEstimates: boolean,
  ): { total: number; pass: number; warn: number; fail: number; partial: number; passRate: number } {
    const metrics = this.primaryMetrics(report.categories.flatMap((category) => category.metrics))
      .filter((metric) => metric.automation === "automatic" && metric.verdict !== "not_applicable")
      .filter((metric) => includeStaticEstimates || this.describeEvaluationType(metric) !== "静的推定");
    const pass = metrics.filter((metric) => metric.verdict === "pass").length;
    const warn = metrics.filter((metric) => metric.verdict === "warn").length;
    const fail = metrics.filter((metric) => metric.verdict === "fail").length;
    const partial = metrics.filter((metric) => metric.verdict === "partial").length;
    const total = metrics.length;
    return {
      total,
      pass,
      warn,
      fail,
      partial,
      passRate: total > 0 ? (pass / total) * 100 : 0,
    };
  }

  private collectNotableDerivedInsights(
    report: QualityReport,
    limit: number,
  ): Array<{ categoryLabel: string; metric: QualityMetricReport }> {
    const verdictOrder: Record<QualityVerdict, number> = {
      fail: 0,
      warn: 1,
      partial: 2,
      manual: 3,
      pass: 4,
      not_applicable: 5,
    };
    return report.categories
      .flatMap((category) =>
        this.derivedMetrics(category.metrics)
          .filter((metric) => ["fail", "warn", "partial"].includes(metric.verdict))
          .map((metric) => ({ categoryLabel: category.label, metric }))
      )
      .sort((left, right) => {
        const verdictDiff = verdictOrder[left.metric.verdict] - verdictOrder[right.metric.verdict];
        if (verdictDiff !== 0) {
          return verdictDiff;
        }
        if (left.metric.id === "feature_test_file_presence" && right.metric.id !== "feature_test_file_presence") {
          return -1;
        }
        if (right.metric.id === "feature_test_file_presence" && left.metric.id !== "feature_test_file_presence") {
          return 1;
        }
        return this.metricNumericActual(left.metric) - this.metricNumericActual(right.metric);
      })
      .slice(0, limit);
  }

  private metricNumericActual(metric: QualityMetricReport): number {
    const match = metric.actual.match(/([0-9]+(?:\.[0-9]+)?)/u);
    return match ? Number.parseFloat(match[1] ?? "0") : Number.POSITIVE_INFINITY;
  }

  private recommendMetricAction(metric: QualityMetricReport): string {
    switch (metric.id) {
      case "zod_adoption":
        return "fetcher/API 層に zod schema を追加し、レスポンスを parse して型境界を固定する。";
      case "design_system_usage_rate":
        return "画面系コンポーネントを共通UI wrapper に寄せ、UI実装境界を一段作る。";
      case "bespoke_ui_file_count":
        return "独自UI候補を components/ui か wrapper 層へ寄せ、画面直下の重複UIを削る。";
      case "type_escape_count":
        return "any と unsafe assertion を unknown + narrowing に置き換え、境界で型を確定する。";
      case "high_responsibility_components":
        return "高責務コンポーネントを state / data-fetch / presentation に分割する。";
      case "hardcoded_jsx_text":
        return "文言を翻訳キーへ移し、dialog・feature 層の直書きを除去する。";
      case "matching_test_file_presence":
        return "Feature 層の未証跡ファイルからテストを追加し、LCOV/JUnit を CI で収集する。";
      case "msw_alignment":
        return "API handlers を MSW で定義し、主要フローのモックを常設する。";
      case "timeout_retry":
        return "fetcher に AbortController / timeout / retry wrapper を導入する。";
      case "ci_presence":
        return "CI workflow を追加し、test・build・artifact 収集を固定化する。";
      default:
        return metric.automation === "manual" ? "証跡を収集して再判定する。" : "主対象ファイルから順に改善し、再解析で差分確認する。";
    }
  }

  private metricAnchor(categoryLabel: string, metric: QualityMetricReport): string {
    return `${this.anchorify(categoryLabel)}-${this.anchorify(metric.id)}`;
  }

  private anchorify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  }

  private sortEvidenceForDisplay(evidence: QualityEvidence[]): QualityEvidence[] {
    return evidence.slice().sort((left, right) => {
      const leftHasFile = left.filePath ? 0 : 1;
      const rightHasFile = right.filePath ? 0 : 1;
      if (leftHasFile !== rightHasFile) {
        return leftHasFile - rightHasFile;
      }

      const leftScore = this.extractEvidenceScore(left);
      const rightScore = this.extractEvidenceScore(right);
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      const leftPath = left.filePath ?? "";
      const rightPath = right.filePath ?? "";
      if (leftPath !== rightPath) {
        return leftPath.localeCompare(rightPath);
      }

      const leftLine = this.extractEvidenceLine(left);
      const rightLine = this.extractEvidenceLine(right);
      if (leftLine !== rightLine) {
        return leftLine - rightLine;
      }

      const leftLabel = `${left.label}: ${left.value}`;
      const rightLabel = `${right.label}: ${right.value}`;
      return leftLabel.localeCompare(rightLabel);
    });
  }

  private extractEvidenceScore(evidence: QualityEvidence): number {
    const source = `${evidence.label} ${evidence.value}`;
    const match = source.match(/score\s+([0-9]+(?:\.[0-9]+)?)/iu);
    return match ? Number.parseFloat(match[1] ?? "0") : Number.NEGATIVE_INFINITY;
  }

  private extractEvidenceLine(evidence: QualityEvidence): number {
    const source = `${evidence.label} ${evidence.value}`;
    const match = source.match(/([0-9]+)行目/u);
    return match ? Number.parseInt(match[1] ?? "0", 10) : Number.MAX_SAFE_INTEGER;
  }

  private truncateText(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }

  private renderCsv(report: QualityReport): string {
    const rows = [
      ["Category", "Metric", "Aggregation", "Automation", "Actual", "Threshold", "Verdict", "Summary"],
      ...report.categories.flatMap((category) =>
        category.metrics.map((metric) => [
          category.label,
          metric.label,
          metric.aggregation,
          metric.automation,
          metric.actual,
          metric.threshold,
          metric.verdict,
          metric.summary,
        ])
      ),
    ];

    return rows.map((row) => row.map((cell) => this.csvCell(cell)).join(",")).join("\n");
  }

  private renderHtml(report: QualityReport): string {
    const qualityProfile = report.qualityProfile ?? "application";
    const workspaceSegments = report.workspaceSegments ?? [];
    const featureSummaries = report.featureSummaries ?? [];
    const showWorkspaceSegments = this.shouldRenderWorkspaceSegments(workspaceSegments);
    const showFeatureSummaries = this.shouldRenderFeatureSummaries(featureSummaries);
    const priorityMetrics = this.collectPriorityMetrics(report, 8);
    const automaticCoverage = this.calculateAutomaticCoverage(report);
    const measuredSignalStats = this.calculateAutomaticSignalStats(report, false);
    const modeledSignalStats = this.calculateAutomaticSignalStats(report, true);
    const derivedInsights = this.collectNotableDerivedInsights(report, 2);
    const pendingManualMetrics = this.collectPendingManualMetrics(report);
    const automatablePendingMetrics = pendingManualMetrics
      .map((entry) => ({
        categoryLabel: entry.categoryLabel,
        metrics: entry.metrics.filter((metric) => this.isAutomatableManualMetric(metric)),
      }))
      .filter((entry) => entry.metrics.length > 0);
    const manualOnlyPendingMetrics = pendingManualMetrics
      .map((entry) => ({
        categoryLabel: entry.categoryLabel,
        metrics: entry.metrics.filter((metric) => !this.isAutomatableManualMetric(metric)),
      }))
      .filter((entry) => entry.metrics.length > 0);
    const manualOnlyCategories = report.categories.filter((category) => this.isManualOnlyCategory(category));
    const mainCategories = report.categories.filter((category) => !this.isManualOnlyCategory(category));
    const failCategories = report.categories.filter((category) => category.verdict === "fail").map((category) => category.label);
    const warnCategories = report.categories.filter((category) => category.verdict === "warn").map((category) => category.label);
    const partialCategories = report.categories.filter((category) => category.verdict === "partial").map((category) => category.label);
    const blockingMetrics = this.collectBlockingAutomaticMetrics(report, 3);
    const renderBulletList = (items: string[]): string => items.length === 0
      ? "<p>なし</p>"
      : `<ul class="bullet-list">${items.map((item) => `<li>${this.escapeHtml(item)}</li>`).join("")}</ul>`;

    const summaryRows = report.categories.map((category) => {
      const primaryMetrics = this.primaryMetrics(category.metrics);
      const autoCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
      const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
      const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
      const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
      const manualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
      return `<tr><td>${this.escapeHtml(category.label)}</td><td>${autoCount}</td><td>${failCount}</td><td>${warnCount}</td><td>${partialCount}</td><td>${manualCount}</td><td>${this.escapeHtml(this.verdictLabel(category.verdict))}</td></tr>`;
    }).join("\n");
    const segmentRows = workspaceSegments.map((segment) =>
      `<tr><td>${this.escapeHtml(segment.label)}</td><td>${segment.fileCount}</td><td>${segment.componentCount}</td><td>${segment.typeEscapeCount}</td><td>${segment.highResponsibilityComponentCount}</td><td>${segment.visualConsumerCount}</td><td>${segment.designSystemBackedCount}</td><td>${segment.weightedTestRate.toFixed(1)}%</td><td>${segment.productTextCount}</td></tr>`
    ).join("\n");
    const featureScaleRows = featureSummaries.map((feature) =>
      `<tr><td>${this.escapeHtml(feature.label)}</td><td>${feature.fileCount}</td><td>${feature.componentCount}</td><td>${feature.averageComplexity.toFixed(1)}</td><td>${feature.maxComplexity.toFixed(1)}</td></tr>`
    ).join("\n");
    const featureRiskRows = featureSummaries.map((feature) =>
      `<tr><td>${this.escapeHtml(feature.label)}</td><td>${feature.typeEscapeCount}</td><td>${feature.highResponsibilityComponentCount}</td><td>${feature.visualConsumerCount}</td><td>${feature.designSystemBackedCount}</td><td>${feature.weightedTestRate.toFixed(1)}%</td><td>${feature.productTextCount}</td></tr>`
    ).join("\n");
    const priorityRows = priorityMetrics.map((entry, index) => {
      const metricLabel = this.shouldRenderDetailedMetric(entry.metric)
        ? `<a href="#${this.escapeHtml(this.metricAnchor(entry.categoryLabel, entry.metric))}">${this.escapeHtml(entry.metric.label)}</a>`
        : this.escapeHtml(entry.metric.label);
      return `<tr><td>${index + 1}</td><td>${this.escapeHtml(entry.categoryLabel)}</td><td>${metricLabel}</td><td>${this.escapeHtml(this.verdictLabel(entry.metric.verdict))}</td><td>${this.escapeHtml(entry.metric.actual)}</td><td>${this.escapeHtml(entry.metric.threshold)}</td><td>${this.escapeHtml(this.describeEvidenceType(entry.metric))}</td><td>${this.escapeHtml(this.describeConfidenceLevel(entry.metric))}</td><td>${this.escapeHtml(this.summarizeMetricTargets(entry.metric, 2))}</td><td>${this.escapeHtml(this.recommendMetricAction(entry.metric))}</td><td>${this.escapeHtml(entry.metric.summary)}</td></tr>`;
    }).join("\n");

    const detailSections = mainCategories.map((category) => {
      const overviewMetrics = this.collectCategoryOverviewMetrics(category.metrics);
      const manualPrimaryMetrics = this.primaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual");
      const testBucketMetrics = category.id === "test" ? this.collectDerivedTestPresenceMetrics(category.metrics) : [];
      const detailedMetrics = category.metrics.filter((metric) =>
        this.shouldRenderDetailedMetric(metric) && !this.isDerivedTestPresenceMetric(metric)
      );
      const hiddenManualMetrics = category.metrics.filter((metric) => metric.verdict === "manual" && !this.shouldRenderDetailedMetric(metric));
      const overviewTable = overviewMetrics.length === 0
        ? "<p>自動判定指標はありません。</p>"
        : `<div class="table-wrap"><table><thead><tr><th>指標</th><th>集計</th><th>実績</th><th>基準</th><th>判定</th><th>証跡種別</th><th>信頼度</th><th>主対象</th></tr></thead><tbody>${overviewMetrics.map((metric) =>
          `<tr><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(metric.aggregation === "derived" ? "派生" : "親")}</td><td>${this.escapeHtml(metric.actual)}</td><td>${this.escapeHtml(metric.threshold)}</td><td>${this.escapeHtml(this.verdictLabel(metric.verdict))}</td><td>${this.escapeHtml(this.describeEvidenceType(metric))}</td><td>${this.escapeHtml(this.describeConfidenceLevel(metric))}</td><td>${this.escapeHtml(this.summarizeMetricTargets(metric, 2))}</td></tr>`
        ).join("\n")}</tbody></table></div>`;
      const manualNote = manualPrimaryMetrics.length > 0
        ? `<p>手動確認待ち ${manualPrimaryMetrics.length} 件: ${this.escapeHtml(manualPrimaryMetrics.slice(0, 4).map((metric) => metric.label).join("、"))}${manualPrimaryMetrics.length > 4 ? `、他${manualPrimaryMetrics.length - 4}件` : ""}。詳細は「不足証跡」または付録を参照してください。</p>`
        : "";
      const testBucketTable = testBucketMetrics.length > 0
        ? `<h3>層別テスト対応率</h3><div class="table-wrap"><table><thead><tr><th>層</th><th>実績</th><th>基準</th><th>判定</th></tr></thead><tbody>${testBucketMetrics.map((metric) =>
          `<tr><td>${this.escapeHtml(this.testPresenceLayerLabel(metric))}</td><td>${this.escapeHtml(metric.actual)}</td><td>${this.escapeHtml(metric.threshold)}</td><td>${this.escapeHtml(this.verdictLabel(metric.verdict))}</td></tr>`
        ).join("\n")}</tbody></table></div>`
        : "";
      const detailCards = detailedMetrics.length === 0
        ? `<p>${hiddenManualMetrics.length > 0 ? `詳細展開は省略しています。手動確認待ち ${hiddenManualMetrics.length} 件は「不足証跡」を参照してください。` : "追加で確認すべき詳細はありません。"}</p>`
        : `<h3>要確認項目</h3><div class="metric-grid">${detailedMetrics.map((metric) => {
          const sortedEvidence = this.sortEvidenceForDisplay(metric.evidence);
          return `<article class="metric-card" id="${this.escapeHtml(this.metricAnchor(category.label, metric))}"><h4>${this.escapeHtml(metric.label)}</h4><ul class="bullet-list"><li>集計: ${this.escapeHtml(metric.aggregation === "derived" ? "派生" : "親")}</li><li>判定: ${this.escapeHtml(this.verdictLabel(metric.verdict))}</li><li>実績: ${this.escapeHtml(metric.actual)}</li><li>基準: ${this.escapeHtml(metric.threshold)}</li><li>証跡種別: ${this.escapeHtml(this.describeEvidenceType(metric))}</li><li>信頼度: ${this.escapeHtml(this.describeConfidenceLevel(metric))}</li><li>主対象: ${this.escapeHtml(this.summarizeMetricTargets(metric, 3))}</li><li>推奨アクション: ${this.escapeHtml(this.recommendMetricAction(metric))}</li><li>要点: ${this.escapeHtml(metric.summary)}</li></ul>${sortedEvidence.length > 0 ? `<div><strong>証跡</strong><ul class="bullet-list">${sortedEvidence.slice(0, 3).map((evidence) => `<li>${this.escapeHtml(`${evidence.label}: ${evidence.value}`)}</li>`).join("")}${sortedEvidence.length > 3 ? `<li>他${sortedEvidence.length - 3}件</li>` : ""}</ul></div>` : ""}</article>`;
        }).join("\n")}</div>`;
      return `<section><h2>${this.escapeHtml(category.label)}</h2><p>${this.escapeHtml(category.summary)}</p>${overviewTable}${manualNote}${testBucketTable}${detailCards}</section>`;
    }).join("\n");
    const appendixSections = manualOnlyCategories.map((category) => {
      const primaryMetrics = this.primaryMetrics(category.metrics);
      return `<section><h3>${this.escapeHtml(category.label)}</h3><ul class="bullet-list"><li>判定: ${this.escapeHtml(this.verdictLabel(category.verdict))}</li><li>指標: ${this.escapeHtml(primaryMetrics.map((metric) => metric.label).join("、"))}</li><li>補足: ${this.escapeHtml(category.summary)}</li></ul></section>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>React 出荷審査 品質レポート</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
    th { background: #f3f4f6; }
    section { margin-top: 28px; }
    .meta { display: flex; gap: 16px; flex-wrap: wrap; }
    .card { border: 1px solid #d1d5db; background: #f9fafb; border-radius: 8px; padding: 12px 16px; min-width: 160px; }
    .table-wrap { overflow-x: auto; }
    .metric-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .metric-card { border: 1px solid #d1d5db; border-radius: 8px; padding: 12px 16px; background: #ffffff; }
    .bullet-list { margin: 8px 0 0 20px; padding: 0; }
    .bullet-list li { margin: 4px 0; }
  </style>
</head>
<body>
  <h1>React 出荷審査 品質レポート</h1>
  <div class="meta">
    <div class="card"><strong>OVERALL</strong><br />${this.escapeHtml(this.verdictLabel(report.summary.overallVerdict))}</div>
    <div class="card"><strong>自動判定カバレッジ</strong><br />${automaticCoverage.automaticCount}/${automaticCoverage.totalCount} (${automaticCoverage.coverageRate.toFixed(1)}%)</div>
    <div class="card"><strong>実測ベーススコア</strong><br />PASS率 ${measuredSignalStats.passRate.toFixed(1)}%</div>
    <div class="card"><strong>推定込みスコア</strong><br />PASS率 ${modeledSignalStats.passRate.toFixed(1)}%</div>
    <div class="card"><strong>FAIL</strong><br />${report.summary.failCount}</div>
    <div class="card"><strong>WARN</strong><br />${report.summary.warnCount}</div>
    <div class="card"><strong>MANUAL</strong><br />${report.summary.manualCount}</div>
    <div class="card"><strong>PROFILE</strong><br />${this.escapeHtml(qualityProfile)}</div>
  </div>
  <section>
    <h2>判定凡例</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>状態</th><th>定義</th></tr>
        </thead>
        <tbody>
          <tr><td>PASS</td><td>自動判定指標で重大な問題が検出されていない状態</td></tr>
          <tr><td>WARN</td><td>FAIL ではないが、継続監視または追加対応が必要な状態</td></tr>
          <tr><td>FAIL</td><td>カテゴリ内に失敗指標が1件以上ある状態</td></tr>
          <tr><td>PARTIAL</td><td>自動判定は通るが、手動確認待ちが残っており完了扱いできない状態</td></tr>
          <tr><td>MANUAL</td><td>自動判定指標がなく、手動証跡待ちの状態</td></tr>
        </tbody>
      </table>
    </div>
    <ul class="bullet-list">
      <li>総合判定ルール: ${this.escapeHtml(this.describeOverallVerdictRule())}</li>
      <li>信頼度: 高=実測/集計, 中=静的推定, 低=手動入力または未収集</li>
    </ul>
  </section>
  <section>
    <h2>要点</h2>
    <ul class="bullet-list">
      <li>総合判定: ${this.escapeHtml(this.verdictLabel(report.summary.overallVerdict))}</li>
      ${this.buildGateVerdictLines().map((line) => `<li>${this.escapeHtml(line.replace(/^[-\s]*/u, "").replace(/\*\*/gu, ""))}</li>`).join("\n      ")}
      <li>${this.escapeHtml(this.buildBaselineComparisonLine(report).replace(/^[-\s]*/u, ""))}</li>
      <li>自動阻害指標: ${this.escapeHtml(blockingMetrics.length > 0 ? blockingMetrics.map((entry) => `${entry.categoryLabel}/${entry.metric.label}`).join("、") : "なし")}</li>
      <li>注目下位指標: ${this.escapeHtml(derivedInsights.length > 0 ? derivedInsights.map((entry) => `${entry.categoryLabel}/${entry.metric.label} ${entry.metric.actual} (${this.verdictLabel(entry.metric.verdict)})`).join("、") : "なし")}</li>
      <li>FAILカテゴリ: ${this.escapeHtml(failCategories.length > 0 ? failCategories.join("、") : "なし")}</li>
      <li>WARNカテゴリ: ${this.escapeHtml(warnCategories.length > 0 ? warnCategories.join("、") : "なし")}</li>
      <li>PARTIALカテゴリ: ${this.escapeHtml(partialCategories.length > 0 ? partialCategories.join("、") : "なし")}</li>
    </ul>
  </section>
  <section>
    <h2>優先対応</h2>
    ${priorityRows.length === 0
      ? "<p>自動判定で直ちに阻害する項目はありません。</p>"
      : `<div class="table-wrap"><table><thead><tr><th>優先度</th><th>観点</th><th>指標</th><th>判定</th><th>実績</th><th>基準</th><th>証跡種別</th><th>信頼度</th><th>主対象</th><th>推奨アクション</th><th>要点</th></tr></thead><tbody>${priorityRows}</tbody></table></div>`}
  </section>
  <section>
    <h2>不足証跡</h2>
    <p>手動確認待ち ${report.summary.manualCount} 件を「自動収集できるもの」と「人手確認が必要なもの」に分けています。</p>
    <h3>自動収集で埋められる証跡</h3>
    ${renderBulletList(automatablePendingMetrics.map((entry) => `${entry.categoryLabel}: ${entry.metrics.slice(0, 5).map((metric) => metric.label).join("、")}${entry.metrics.length > 5 ? `、他${entry.metrics.length - 5}件` : ""}`))}
    <h3>人手確認が必要な証跡</h3>
    ${renderBulletList(manualOnlyPendingMetrics.map((entry) => `${entry.categoryLabel}: ${entry.metrics.slice(0, 5).map((metric) => metric.label).join("、")}${entry.metrics.length > 5 ? `、他${entry.metrics.length - 5}件` : ""}`))}
  </section>
  <section>
    <h2>集計</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>観点</th><th>自動</th><th>FAIL</th><th>WARN</th><th>PARTIAL</th><th>手動</th><th>判定</th></tr>
        </thead>
        <tbody>${summaryRows}</tbody>
      </table>
    </div>
    <ul class="bullet-list">
      <li>総指標数: ${report.summary.totalMetrics}</li>
      <li>派生指標数: ${report.summary.derivedMetricCount}</li>
      <li>PASS: ${report.summary.passCount}</li>
      <li>PARTIALカテゴリ: ${report.summary.partialCategoryCount}</li>
      <li>PARTIAL指標: ${report.summary.partialCount}</li>
      <li>WARN: ${report.summary.warnCount}</li>
      <li>FAIL: ${report.summary.failCount}</li>
      <li>MANUAL: ${report.summary.manualCount}</li>
      <li>OVERALL: ${this.escapeHtml(this.verdictLabel(report.summary.overallVerdict))}</li>
    </ul>
  </section>
  ${showWorkspaceSegments ? `<section><h2>ワークスペース内訳</h2><div class="table-wrap"><table><thead><tr><th>セグメント</th><th>Files</th><th>Components</th><th>Type Escapes</th><th>High Responsibility</th><th>Visual Consumers</th><th>DS Backed</th><th>Test Rate</th><th>Product Text</th></tr></thead><tbody>${segmentRows}</tbody></table></div></section>` : ""}
  ${showFeatureSummaries ? `<section><h2>フィーチャー内訳</h2><h3>規模と複雑度</h3><div class="table-wrap"><table><thead><tr><th>フィーチャー</th><th>Files</th><th>Components</th><th>Avg Complexity</th><th>Max Complexity</th></tr></thead><tbody>${featureScaleRows}</tbody></table></div><h3>品質リスク</h3><div class="table-wrap"><table><thead><tr><th>フィーチャー</th><th>Type Escapes</th><th>High Responsibility</th><th>Visual Consumers</th><th>DS Backed</th><th>Test Rate</th><th>Product Text</th></tr></thead><tbody>${featureRiskRows}</tbody></table></div></section>` : ""}
  ${detailSections}
  ${manualOnlyCategories.length > 0 ? `<section><h2>付録: 手動確認カテゴリ</h2><p>自動判定が無い、または対象外のみのカテゴリを付録へ退避しています。</p>${appendixSections}</section>` : ""}
  <section>
    <h2>メタデータ</h2>
    <ul class="bullet-list">
      <li>生成時刻: ${this.escapeHtml(report.timestamp)}</li>
      <li>実行時間: ${report.executionTimeMs}ms</li>
      <li>プロジェクト: ${this.escapeHtml(report.projectRoot)}</li>
      <li>品質プロファイル: ${this.escapeHtml(qualityProfile)}</li>
    </ul>
  </section>
</body>
</html>`;
  }

  private collectDangerousHtml(parsedFiles: ParsedFile[]): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const parsedFile of parsedFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && this.getJsxAttributeName(node.name) === "dangerouslySetInnerHTML") {
          findings.push({
            filePath: parsedFile.filePath,
            line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
            text: "dangerouslySetInnerHTML",
          });
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(parsedFile.sourceFile, visit);
    }

    return findings;
  }

  private collectHardcodedJsxText(parsedFiles: ParsedFile[]): I18nFinding[] {
    const findings: I18nFinding[] = [];
    const userFacingAttributeNames = new Set([
      "placeholder",
      "title",
      "alt",
      "aria-label",
      "aria-description",
      "aria-placeholder",
      "label",
      "description",
      "helpertext",
      "emptytext",
    ]);

    for (const parsedFile of parsedFiles.filter((item) => this.isI18nTargetFile(item.filePath))) {
      const scope = this.classifyI18nFindingScope(parsedFile.filePath);
      const staticTextBindings = this.collectStaticTextBindings(parsedFile.sourceFile);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node)) {
          const text = node.getText().replace(/\s+/gu, " ").trim();
          if (text && this.isLikelyUserFacingText(text)) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text,
              scope,
            });
          }
        }

        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
          const resolvedText = this.resolveStaticText(node.expression, staticTextBindings);
          const text = resolvedText?.replace(/\s+/gu, " ").trim();
          if (text && this.isLikelyUserFacingText(text)) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text: `{${text}}`,
              scope,
            });
          }
        }

        if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
          const attributeName = this.getJsxAttributeName(node.name);
          if (userFacingAttributeNames.has(attributeName) && this.isLikelyUserFacingText(node.initializer.text)) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text: `${attributeName}="${node.initializer.text}"`,
              scope,
            });
          }
        }

        if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
          const attributeName = this.getJsxAttributeName(node.name);
          const resolvedText = this.resolveStaticText(node.initializer.expression, staticTextBindings);
          const text = resolvedText?.replace(/\s+/gu, " ").trim();
          if (userFacingAttributeNames.has(attributeName) && text && this.isLikelyUserFacingText(text)) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text: `${attributeName}={${text}}`,
              scope,
            });
          }
        }

        ts.forEachChild(node, visit);
      };
      ts.forEachChild(parsedFile.sourceFile, visit);
    }

    return findings;
  }

  private collectSecretIndicators(parsedFiles: ParsedFile[]): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const patterns = [
      /api[_-]?key\s*[:=]\s*['"][^'"\n]+/giu,
      /secret\s*[:=]\s*['"][^'"\n]+/giu,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/gu,
      /AKIA[0-9A-Z]{16}/gu,
    ];

    for (const parsedFile of parsedFiles) {
      for (const pattern of patterns) {
        for (const match of parsedFile.sourceCode.matchAll(pattern)) {
          const index = match.index ?? 0;
          const location = ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, index);
          findings.push({
            filePath: parsedFile.filePath,
            line: location.line + 1,
            text: match[0].slice(0, 80),
          });
        }
      }
    }

    return findings;
  }

  private collectVisualConsumers(analysisResults: AnalysisResult[], parsedFiles: ParsedFile[]): VisualConsumerSummary {
    let total = 0;
    let designSystemUsers = 0;
    const bespokeFiles: AuditFinding[] = [];
    const entries: VisualConsumerSummary["entries"] = [];
    const analysisByFile = new Map(analysisResults.map((result) => [result.filePath, result]));
    const parsedByFile = new Map(parsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));
    const designSystemMemo = new Map<string, boolean>();

    for (const result of analysisResults) {
      if (result.complexity.components.length === 0) {
        continue;
      }

      const fileType = this.classifyFileType(result.filePath);
      if (!this.isVisualConsumerTargetFile(result.filePath)) {
        continue;
      }

      total += 1;
      const hasDesignSystemImport = this.hasDesignSystemBacking(result.filePath, analysisByFile, parsedByFile, designSystemMemo, new Set());
      entries.push({
        filePath: result.filePath,
        hasDesignSystemBacking: hasDesignSystemImport,
      });

      if (hasDesignSystemImport) {
        designSystemUsers += 1;
        continue;
      }

      bespokeFiles.push({
        filePath: result.filePath,
        line: result.complexity.components[0]?.startLine ?? 1,
        text: `${fileType} で JSX 使用経路上の共通UI backing が見つかりません`,
      });
    }

    return {
      total,
      designSystemUsers,
      bespokeFiles,
      entries,
    };
  }

  private collectHighResponsibilityComponents(analysisResults: AnalysisResult[]): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const result of analysisResults) {
      if (!this.isResponsibilityTargetFile(result.filePath)) {
        continue;
      }
      for (const component of result.complexity.components) {
        if (component.hookCount >= 4 || component.jsxElements >= 12 || component.renderComplexity.complexity >= 5) {
          findings.push({
            filePath: result.filePath,
            line: component.startLine,
            text: `${component.name}: hooks=${component.hookCount}, jsx=${component.jsxElements}, render=${component.renderComplexity.complexity}`,
          });
        }
      }
    }

    return findings;
  }

  private collectTestPresence(
    targetResults: AnalysisResult[],
    evidenceResults: AnalysisResult[],
    evidenceParsedFiles: ParsedFile[],
    coverageSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["coverage"],
    junitSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["junit"],
    playwrightSummary: Awaited<ReturnType<UiTestArtifactAnalyzer["analyzeProject"]>>["playwright"],
  ): TestPresenceSummary {
    const targetFiles = targetResults.filter((result) => this.isTestTargetFile(result.filePath));
    const staticMatches = this.collectStaticCoverageEvidence(evidenceResults, evidenceParsedFiles);
    const runtimeMatches = this.collectRuntimeCoverageEvidence(coverageSummary);
    const runtimeExecutionMatches = this.collectRuntimeTestExecutionEvidence(
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
      const weight = this.testCoverageWeight(result.filePath);
      const bucketId = this.testCoverageBucket(result.filePath);
      const bucket = bucketById.get(bucketId);
      const match = this.resolveTestPresenceMatch(result.filePath, bucketId, weight, staticMatches, runtimeMatches, runtimeExecutionMatches);
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

  private collectZodAdoption(parsedFiles: ParsedFile[]): { totalFiles: number; adoptedFiles: number; rate: number } {
    const candidates = parsedFiles.filter((parsedFile) => {
      const normalized = this.toDisplayPath(parsedFile.filePath).replace(/\\/gu, "/").toLowerCase();
      return /(^|\/)(api|infra|service|services|client|clients|repository|repositories|schema|schemas|validation|validations)(\/|$)/u.test(normalized)
        && !this.isTestFile(parsedFile.filePath)
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

  private collectWorkspaceSegments(
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
      const segment = segments.get(this.workspaceSegmentId(result.filePath));
      if (!segment) {
        continue;
      }

      segment.fileCount += 1;
      segment.componentCount += result.complexity.components.length;
      if (this.isStrictQualityCheckTargetFile(result.filePath)) {
        segment.typeEscapeCount += Math.round(this.getTypeEscapeFileScore(result, inboundDegree.get(result.filePath) ?? 0));
      }

      if (this.isTestTargetFile(result.filePath)) {
        segment.testTargetFiles += 1;
        if (matchByFilePath.get(result.filePath)?.matched) {
          segment.matchedTestFiles += 1;
        }
      }
    }

    for (const finding of highResponsibilityComponents) {
      const segment = segments.get(this.workspaceSegmentId(finding.filePath));
      if (segment) {
        segment.highResponsibilityComponentCount += 1;
      }
    }

    for (const finding of hardcodedJsxText.filter((item) => item.scope === "product")) {
      const segment = segments.get(this.workspaceSegmentId(finding.filePath));
      if (segment) {
        segment.productTextCount += 1;
      }
    }

    for (const entry of visualConsumers.entries) {
      const segment = segments.get(this.workspaceSegmentId(entry.filePath));
      if (!segment) {
        continue;
      }

      segment.visualConsumerCount += 1;
      if (entry.hasDesignSystemBacking) {
        segment.designSystemBackedCount += 1;
      }
    }

    const weightedRateBySegment = new Map(
      this.collectSegmentTestRates(testPresence.matches).map((entry) => [entry.id, entry.rate]),
    );

    return segmentDescriptors
      .map((descriptor) => {
        const segment = segments.get(descriptor.id)!;
        segment.weightedTestRate = weightedRateBySegment.get(descriptor.id) ?? 0;
        return segment;
      })
      .filter((segment) => segment.fileCount > 0);
  }

  private collectFeatureSummaries(
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
      const label = this.featureSummaryLabel(filePath);
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
      if (!feature || !this.isStrictQualityCheckTargetFile(result.filePath)) {
        continue;
      }

      feature.fileCount += 1;
      feature.componentCount += result.complexity.components.length;
      feature.complexityTotal += result.complexity.overallComplexity;
      feature.maxComplexity = Math.max(feature.maxComplexity, result.complexity.overallComplexity);
      feature.typeEscapeCount += Math.round(this.getTypeEscapeFileScore(result, inboundDegree.get(result.filePath) ?? 0));

      if (this.isTestTargetFile(result.filePath)) {
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

    const weightedRateByFeature = new Map(this.collectFeatureTestRates(testPresence.matches).map((entry) => [entry.id, entry.rate]));

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

  private collectFeatureTestRates(
    matches: TestPresenceFileMatch[],
  ): Array<{ id: string; rate: number }> {
    const weighted = new Map<string, { target: number; matched: number }>();

    for (const match of matches) {
      const featureId = this.featureSummaryLabel(match.filePath)?.toLowerCase();
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

  private collectSegmentTestRates(
    matches: TestPresenceFileMatch[],
  ): Array<{ id: WorkspaceSegmentSummary["id"]; rate: number }> {
    const weighted = new Map<WorkspaceSegmentSummary["id"], { target: number; matched: number }>();

    for (const match of matches) {
      const id = this.workspaceSegmentId(match.filePath);
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

  private collectStaticCoverageEvidence(
    evidenceResults: AnalysisResult[],
    evidenceParsedFiles: ParsedFile[],
  ): Map<string, Set<string>> {
    const staticMatches = new Map<string, Set<string>>();
    const analysisByFile = new Map(evidenceResults.map((result) => [result.filePath, result]));
    const parsedByFile = new Map(evidenceParsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));

    for (const result of evidenceResults) {
      const parsedFile = parsedByFile.get(result.filePath);
      if (!this.isExecutableTestEvidence(result, parsedFile)) {
        continue;
      }

      const testLabel = this.toDisplayPath(result.filePath);
      for (const key of this.buildTestPathConventionKeys(result.filePath)) {
        this.addCoverageReason(staticMatches, key, `path:${testLabel}`);
      }

      for (const linkedFile of this.collectTransitivelyLinkedSourceFiles(result.filePath, analysisByFile)) {
        for (const key of this.buildSourceMatchKeys(linkedFile.filePath)) {
          this.addCoverageReason(staticMatches, key, `import:${testLabel} depth=${linkedFile.depth}`);
        }
      }
    }

    return staticMatches;
  }

  private collectRuntimeCoverageEvidence(
    coverageSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>["coverage"],
  ): Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }> {
    const runtimeMatches = new Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }>();

    for (const sourceFile of coverageSummary?.sourceFiles ?? []) {
      for (const key of this.buildSourceMatchKeys(sourceFile.filePath)) {
        runtimeMatches.set(key, sourceFile);
      }
    }

    return runtimeMatches;
  }

  private collectRuntimeTestExecutionEvidence(
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
      for (const key of this.buildSourceMatchKeys(result.filePath)) {
        analysisByKey.set(key, result);
      }
    }
    for (const parsedFile of evidenceParsedFiles) {
      for (const key of this.buildSourceMatchKeys(parsedFile.filePath)) {
        parsedByKey.set(key, parsedFile);
      }
    }

    for (const executedTestFile of executedTestFiles) {
      const result = this.resolveEvidenceFile(executedTestFile.filePath, analysisByFile, analysisByKey);
      const parsedFile = this.resolveEvidenceFile(executedTestFile.filePath, parsedByFile, parsedByKey);
      if (!result || !this.isExecutableTestEvidence(result, parsedFile)) {
        continue;
      }

      const testLabel = this.toDisplayPath(result.filePath);
      for (const key of this.buildTestPathConventionKeys(result.filePath)) {
        this.addCoverageReason(runtimeMatches, key, `${executedTestFile.label}-path:${testLabel}`);
      }

      for (const linkedFile of this.collectTransitivelyLinkedSourceFiles(result.filePath, analysisByFile)) {
        for (const key of this.buildSourceMatchKeys(linkedFile.filePath)) {
          this.addCoverageReason(runtimeMatches, key, `${executedTestFile.label}:${testLabel} depth=${linkedFile.depth}`);
        }
      }
    }

    return runtimeMatches;
  }

  private resolveTestPresenceMatch(
    filePath: string,
    bucketId: TestPresenceBucketSummary["id"],
    weight: number,
    staticMatches: Map<string, Set<string>>,
    runtimeMatches: Map<string, { filePath: string; lineFound: number; lineHit: number; lineCoverage: number | null }>,
    runtimeExecutionMatches: Map<string, Set<string>>,
  ): TestPresenceFileMatch {
    const matchKeys = this.buildSourceMatchKeys(filePath);
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
      const runtimeCoverageThreshold = this.testPresenceSettings.runtimeLineCoverageMinPercent;
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

  private addCoverageReason(staticMatches: Map<string, Set<string>>, key: string, reason: string): void {
    const reasons = staticMatches.get(key) ?? new Set<string>();
    reasons.add(reason);
    staticMatches.set(key, reasons);
  }

  private collectTransitivelyLinkedSourceFiles(
    testFilePath: string,
    analysisByFile: Map<string, AnalysisResult>,
  ): Array<{ filePath: string; depth: number }> {
    const rootResult = analysisByFile.get(testFilePath);
    if (!rootResult) {
      return [];
    }

    const maxDepth = this.testPresenceSettings.staticImportTraversalMaxDepth;
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

      if (this.isStaticTestTraversalCandidate(current.filePath)) {
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

  private testPresenceThreshold(): { pass: number; warn: number } {
    const threshold = this.testPresenceSettings.thresholds[this.qualityProfile] ?? DEFAULT_TEST_PRESENCE_SETTINGS.thresholds[this.qualityProfile];
    return {
      pass: threshold.pass,
      warn: threshold.warn,
    };
  }

  private testPresenceThresholdLabel(): string {
    const threshold = this.testPresenceThreshold();
    return `PASS>=${threshold.pass}% / WARN>=${threshold.warn}%`;
  }

  private zodAdoptionThreshold(): { pass: number; warn: number; minimumApplicableFiles: number } {
    return this.qualityProfile === "library-repo"
      ? { pass: 50, warn: 20, minimumApplicableFiles: 10 }
      : { pass: 80, warn: 50, minimumApplicableFiles: 1 };
  }

  private zodAdoptionThresholdLabel(): string {
    const threshold = this.zodAdoptionThreshold();
    return this.qualityProfile === "library-repo"
      ? `PASS>=${threshold.pass}% / WARN>=${threshold.warn}% (files>=${threshold.minimumApplicableFiles})`
      : `PASS>=${threshold.pass}% / WARN>=${threshold.warn}%`;
  }

  private hardcodedTextThreshold(): { warnMax: number } {
    return this.qualityProfile === "library-repo"
      ? { warnMax: 25 }
      : { warnMax: 3 };
  }

  private hardcodedTextThresholdLabel(): string {
    const threshold = this.hardcodedTextThreshold();
    return `0, WARN<=${threshold.warnMax}`;
  }

  private externalPackageThreshold(): { pass: number; warn: number } {
    return this.qualityProfile === "library-repo"
      ? { pass: 80, warn: 160 }
      : { pass: 30, warn: 60 };
  }

  private externalPackageThresholdLabel(): string {
    const threshold = this.externalPackageThreshold();
    return `<= ${threshold.pass} / WARN<=${threshold.warn}`;
  }

  private workspaceSegmentId(filePath: string): WorkspaceSegmentSummary["id"] {
    const normalized = this.toDisplayPath(filePath).toLowerCase();
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

  private featureSummaryLabel(filePath: string): string | undefined {
    const displayPath = this.toDisplayPath(filePath).replace(/\\/gu, "/");
    const segments = displayPath.split("/").filter(Boolean);
    const featureRootIndex = segments.findIndex((segment) => /^(features?|modules?|domains?|scenes?|containers?)$/iu.test(segment));
    if (featureRootIndex < 0 || featureRootIndex >= segments.length - 1) {
      return undefined;
    }

    if (featureRootIndex + 1 < segments.length - 1) {
      return segments.slice(0, featureRootIndex + 2).join("/");
    }

    if (!this.isStrictQualityCheckTargetFile(filePath)) {
      return undefined;
    }

    const terminalSegment = segments[featureRootIndex + 1];
    if (!terminalSegment) {
      return undefined;
    }

    const stem = terminalSegment.replace(/\.[cm]?[jt]sx?$/iu, "");
    return [...segments.slice(0, featureRootIndex + 1), stem].join("/");
  }

  private classifyFileType(filePath: string): string {
    // 分類パターンはパス全体に照合されるため、プロジェクトより上位のディレクトリ名
    // (例: CI の /home/runner/work/app/app) が判定へ混入しないよう相対化してから渡す。
    return classifyFileType(this.toDisplayPath(filePath));
  }

  private isStoryFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return fileType === "Story" || fileType === "Storybook Support";
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

  private isTestFile(filePath: string): boolean {
    const normalized = this.toDisplayPath(filePath).replace(/\\/gu, "/").toLowerCase();
    return /(?:^|\/)(?:tests?|__tests__|e2e|playwright|cypress)(?:\/|$)/u.test(normalized)
      || /\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/u.test(normalized);
  }

  private isTestTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return !["Test", "Story", "Storybook Support", "Fixture", "Config", "Barrel", "Utils", "Type Support"].includes(fileType);
  }

  private isExecutableTestEvidence(result: AnalysisResult, parsedFile?: ParsedFile): boolean {
    if (!this.isTestFile(result.filePath)) {
      return false;
    }

    if (!parsedFile) {
      return /\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/iu.test(result.filePath);
    }

    return this.containsTestLikeCall(parsedFile.sourceFile)
      || (/\.(?:test|spec|e2e|cy|ct)\.[jt]sx?$/iu.test(result.filePath) && this.importsKnownTestFramework(result));
  }

  private containsTestLikeCall(sourceFile: ts.SourceFile): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if (ts.isCallExpression(node) && this.isKnownTestCallExpression(node.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  private isKnownTestCallExpression(expression: ts.LeftHandSideExpression): boolean {
    const names = this.flattenCallExpressionNames(expression);
    if (names.length === 0) {
      return false;
    }

    const knownCallNames = new Set(this.testPresenceSettings.knownCallNames.map((name) => name.toLowerCase()));
    const root = names[0] ?? "";
    const leaf = names[names.length - 1] ?? "";
    return knownCallNames.has(root.toLowerCase())
      || knownCallNames.has(leaf.toLowerCase());
  }

  private flattenCallExpressionNames(expression: ts.LeftHandSideExpression): string[] {
    if (ts.isIdentifier(expression)) {
      return [expression.text];
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return [...this.flattenCallExpressionNames(expression.expression), expression.name.text];
    }
    if (ts.isElementAccessExpression(expression)) {
      return this.flattenCallExpressionNames(expression.expression);
    }
    if (ts.isCallExpression(expression)) {
      return this.flattenCallExpressionNames(expression.expression);
    }
    return [];
  }

  private importsKnownTestFramework(result: AnalysisResult): boolean {
    const knownFrameworkModules = new Set(this.testPresenceSettings.knownFrameworkModules);
    return result.dependencies.some((dependency) =>
      dependency.isExternal && knownFrameworkModules.has(dependency.modulePath)
    );
  }

  private isStaticTestTraversalCandidate(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return !["Test", "Story", "Storybook Support", "Fixture", "Config", "Type Support"].includes(fileType);
  }

  private buildTestPathConventionKeys(filePath: string): string[] {
    const normalizedPath = this.normalizeMatchPath(filePath)
      .split("/")
      .filter((segment) =>
        segment !== "__tests__"
        && segment !== "tests"
        && segment !== "test"
        && segment !== "e2e"
        && segment !== "playwright"
        && segment !== "cypress"
        && segment !== ".storybook"
      )
      .join("/")
      .replace(/\.(test|spec|e2e|cy|ct|stories|story|fixture)$/iu, "");
    const keys = new Set<string>([normalizedPath]);

    if (normalizedPath.startsWith("src/")) {
      keys.add(normalizedPath.slice(4));
    } else if (!normalizedPath.startsWith("/") && normalizedPath.length > 0) {
      keys.add(`src/${normalizedPath}`);
    }

    return Array.from(keys).filter(Boolean);
  }

  private buildSourceMatchKeys(filePath: string): string[] {
    const normalized = this.normalizeMatchPath(filePath);
    const keys = new Set<string>([normalized]);

    if (normalized.startsWith("src/")) {
      keys.add(normalized.slice(4));
    } else if (!normalized.startsWith("/") && normalized.length > 0) {
      keys.add(`src/${normalized}`);
    }

    return Array.from(keys).filter(Boolean);
  }

  private normalizeMatchPath(filePath: string): string {
    const normalized = filePath
      .replace(/\\/gu, "/")
      .replace(/\.[cm]?[jt]sx?$/iu, "");
    if (!path.isAbsolute(normalized)) {
      return normalized.toLowerCase();
    }
    const relative = this.projectRoot
      ? path.relative(this.projectRoot, normalized)
      : normalized;
    const projectRelative = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative.replace(/\\/gu, "/")
      : normalized;

    return projectRelative.toLowerCase();
  }

  private resolveEvidenceFile<T>(
    filePath: string,
    byFilePath: Map<string, T>,
    byMatchKey: Map<string, T>,
  ): T | undefined {
    const direct = byFilePath.get(path.normalize(filePath));
    if (direct) {
      return direct;
    }
    for (const key of this.buildSourceMatchKeys(filePath)) {
      const match = byMatchKey.get(key);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  private isVisualConsumerTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return ["Route", "Feature", "Form"].includes(fileType);
  }

  private isResponsibilityTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return ["Route", "Feature", "Form", "UI component", "Layout"].includes(fileType);
  }

  private isI18nTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return ["Route", "Feature", "Form", "UI component", "Layout", "Shared"].includes(fileType);
  }

  private classifyI18nFindingScope(filePath: string): "product" | "library" {
    const fileType = this.classifyFileType(filePath);
    if (fileType === "UI component") {
      return "library";
    }

    const normalized = this.toDisplayPath(filePath).replace(/\\/gu, "/").toLowerCase();
    if (normalized.includes("/components/ui/")
      || normalized.includes("/shared/ui/")
      || normalized.includes("/components/commons/")) {
      return "library";
    }
    return "product";
  }

  private testCoverageWeight(filePath: string): number {
    const fileType = this.classifyFileType(filePath);
    const weights = this.testPresenceSettings.bucketWeights;
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

  private testPresenceVerdict(targetFiles: number, rate: number): QualityVerdict {
    const threshold = this.testPresenceThreshold();
    if (targetFiles === 0) {
      return "not_applicable";
    }
    if (rate >= threshold.pass) {
      return "pass";
    }
    if (rate >= threshold.warn) {
      return "warn";
    }
    return "fail";
  }

  private buildTestPresenceBucketMetric(bucket: TestPresenceBucketSummary): QualityMetricReport {
    return this.metric(
      "test",
      TEST_PRESENCE_BUCKETS.find((descriptor) => descriptor.id === bucket.id)?.metricId ?? `${bucket.id}_test_file_presence`,
      `${bucket.label}テスト対応率（重み付き推定）`,
      bucket.targetFiles === 0 ? "対象ソースなし" : `${bucket.rate.toFixed(1)}%`,
      this.testPresenceThresholdLabel(),
      this.testPresenceVerdict(bucket.targetFiles, bucket.rate),
      `${bucket.label} 層について、LCOV の per-file 証跡を最優先し、無い場合は JUnit / Playwright の実行済みテストファイル、最後に静的な import / 命名対応から推定しています。Story は主指標に含めません。`,
      [
        this.noteEvidence("対象ソース数", String(bucket.targetFiles)),
        this.noteEvidence("テストありソース数", String(bucket.matchedFiles)),
        this.noteEvidence("対象重み", bucket.weightedTarget.toFixed(1)),
        this.noteEvidence("テストあり重み", bucket.weightedMatched.toFixed(1)),
      ],
      "derived",
    );
  }

  private buildTestPresenceEvidence(testPresence: TestPresenceSummary): QualityEvidence[] {
    const matchedExamples = testPresence.matches
      .filter((match) => match.matched)
      .sort((left, right) => {
        if (left.matchedBy !== right.matchedBy) {
          return left.matchedBy === "runtime" ? -1 : 1;
        }
        return right.weight - left.weight || left.filePath.localeCompare(right.filePath);
      })
      .slice(0, 8)
      .flatMap((match) => this.buildTestMatchEvidence(match));
    const explicitRuntimeMisses = testPresence.matches
      .filter((match) => !match.matched && match.matchedBy === "runtime")
      .sort((left, right) => right.weight - left.weight || left.filePath.localeCompare(right.filePath))
      .slice(0, 4)
      .flatMap((match) => this.buildTestMatchEvidence(match));
    const unmatchedNoEvidence = testPresence.matches
      .filter((match) => !match.matched && match.matchedBy === "none")
      .sort((left, right) => right.weight - left.weight || left.filePath.localeCompare(right.filePath))
      .slice(0, 4)
      .flatMap((match) => this.buildTestMatchEvidence(match));

    return [
      this.noteEvidence("対象ソース数", String(testPresence.targetFiles)),
      this.noteEvidence("テストありソース数", String(testPresence.matchedFiles)),
      this.noteEvidence("対象重み", testPresence.weightedTarget.toFixed(1)),
      this.noteEvidence("テストあり重み", testPresence.weightedMatched.toFixed(1)),
      this.noteEvidence("runtime一致数", String(testPresence.runtimeMatchedFiles)),
      this.noteEvidence("static一致数", String(testPresence.staticMatchedFiles)),
      this.noteEvidence("runtime明示未一致数", String(testPresence.runtimeExplicitUnmatchedFiles)),
      this.noteEvidence("証跡未検出数", String(testPresence.noEvidenceUnmatchedFiles)),
      ...testPresence.buckets.map((bucket) => this.noteEvidence(`${bucket.label}重み`, `${bucket.weightedMatched.toFixed(1)} / ${bucket.weightedTarget.toFixed(1)} (${bucket.rate.toFixed(1)}%)`)),
      ...matchedExamples,
      ...explicitRuntimeMisses,
      ...unmatchedNoEvidence,
    ];
  }

  private buildTestMatchEvidence(match: TestPresenceFileMatch): QualityEvidence[] {
    const label = this.testMatchEvidenceLabel(match);
    return match.reasons
      .slice(0, 2)
      .map((reason) => this.fileEvidence(label, match.filePath, reason));
  }

  private testMatchEvidenceLabel(match: TestPresenceFileMatch): string {
    const primaryReason = match.reasons[0] ?? "";
    if (!match.matched) {
      return match.matchedBy === "runtime" ? "runtime-test-gap" : "test-gap";
    }
    if (primaryReason.startsWith("lcov:")) {
      return "lcov-covered";
    }
    if (primaryReason.startsWith("junit:") || primaryReason.startsWith("junit-path:") || primaryReason.startsWith("playwright:") || primaryReason.startsWith("playwright-path:")) {
      return "runtime-test-link";
    }
    return "test-link";
  }

  private testCoverageBucket(filePath: string): TestPresenceBucketSummary["id"] {
    const fileType = this.classifyFileType(filePath);
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

  private hasDesignSystemBacking(
    filePath: string,
    analysisByFile: Map<string, AnalysisResult>,
    parsedByFile: Map<string, ParsedFile>,
    memo: Map<string, boolean>,
    visiting: Set<string>,
  ): boolean {
    if (memo.has(filePath)) {
      return memo.get(filePath) ?? false;
    }
    if (visiting.has(filePath)) {
      return false;
    }

    const result = analysisByFile.get(filePath);
    const parsedFile = parsedByFile.get(filePath);
    if (!result) {
      memo.set(filePath, false);
      return false;
    }

    visiting.add(filePath);
    const hasBacking = parsedFile
      ? this.fileUsesDesignSystemBacking(parsedFile, result, analysisByFile, parsedByFile, memo, visiting)
      : false;
    visiting.delete(filePath);
    memo.set(filePath, hasBacking);
    return hasBacking;
  }

  private fileUsesDesignSystemBacking(
    parsedFile: ParsedFile,
    result: AnalysisResult,
    analysisByFile: Map<string, AnalysisResult>,
    parsedByFile: Map<string, ParsedFile>,
    memo: Map<string, boolean>,
    visiting: Set<string>,
  ): boolean {
    const usedJsxReferences = this.collectUsedJsxReferences(parsedFile.sourceFile);
    if (usedJsxReferences.size === 0) {
      return false;
    }

    const dependencyByStart = new Map(
      result.dependencies
        .filter((dependency) => dependency.type === "import")
        .map((dependency) => [dependency.range.start, dependency] as const),
    );

    for (const statement of parsedFile.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        continue;
      }

      const dependency = dependencyByStart.get(statement.getStart());
      if (!dependency) {
        continue;
      }

      const importedNames = this.collectImportedBindings(statement.importClause);
      if (!importedNames.some((name) => usedJsxReferences.has(name))) {
        continue;
      }

      if (this.isDesignSystemDependency(dependency)) {
        return true;
      }

      if (!dependency.isExternal && this.hasDesignSystemBacking(dependency.target, analysisByFile, parsedByFile, memo, visiting)) {
        return true;
      }
    }

    return false;
  }

  private collectUsedJsxReferences(sourceFile: ts.SourceFile): Set<string> {
    const references = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const reference = this.jsxTagReference(node.tagName);
        if (reference) {
          references.add(reference);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return references;
  }

  private jsxTagReference(tagName: ts.JsxTagNameExpression): string | null {
    if (ts.isIdentifier(tagName)) {
      return tagName.text;
    }
    if (ts.isPropertyAccessExpression(tagName)) {
      return this.flattenPropertyAccessRoot(tagName);
    }
    return null;
  }

  private flattenPropertyAccessRoot(expression: ts.PropertyAccessExpression): string | null {
    let current: ts.Expression = expression;
    while (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current.text : null;
  }

  private collectImportedBindings(importClause: ts.ImportClause): string[] {
    const bindings: string[] = [];
    if (importClause.name) {
      bindings.push(importClause.name.text);
    }

    const namedBindings = importClause.namedBindings;
    if (!namedBindings) {
      return bindings;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      bindings.push(namedBindings.name.text);
      return bindings;
    }

    for (const element of namedBindings.elements) {
      bindings.push(element.name.text);
    }

    return bindings;
  }

  private isDesignSystemDependency(dependency: Dependency): boolean {
    const normalizedModule = dependency.modulePath.replace(/\\/gu, "/").toLowerCase();
    const normalizedTarget = dependency.target.replace(/\\/gu, "/").toLowerCase();
    return normalizedModule.includes("components/ui")
      || normalizedModule.includes("shared/ui")
      || normalizedModule.includes("components/commons")
      || normalizedModule.includes("design-system")
      || normalizedTarget.includes("/components/ui/")
      || normalizedTarget.includes("/shared/ui/")
      || normalizedTarget.includes("/components/commons/");
  }

  private isLikelyUserFacingText(text: string): boolean {
    return /\p{Letter}/u.test(text);
  }

  private collectStaticTextBindings(sourceFile: ts.SourceFile): Map<string, string> {
    const bindings = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const resolved = this.resolveStaticText(node.initializer, bindings);
        if (resolved) {
          bindings.set(node.name.text, resolved);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return bindings;
  }

  private resolveStaticText(
    expression: ts.Expression | undefined,
    bindings: Map<string, string>,
  ): string | null {
    if (!expression) {
      return null;
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    if (ts.isParenthesizedExpression(expression)) {
      return this.resolveStaticText(expression.expression, bindings);
    }
    if (ts.isIdentifier(expression)) {
      return bindings.get(expression.text) ?? null;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.resolveStaticText(expression.left, bindings);
      const right = this.resolveStaticText(expression.right, bindings);
      if (left === null || right === null) {
        return null;
      }
      return `${left}${right}`;
    }
    if (ts.isTemplateExpression(expression)) {
      let resolved = expression.head.text;
      for (const span of expression.templateSpans) {
        const value = this.resolveStaticText(span.expression, bindings);
        if (value === null) {
          return null;
        }
        resolved += value + span.literal.text;
      }
      return resolved;
    }
    return null;
  }

  private manualMetric(
    category: QualityCategoryId,
    id: string,
    label: string,
    threshold: string,
    summary: string,
  ): QualityMetricReport {
    return this.metric(category, id, label, "証跡未収集", threshold, "manual", summary, []);
  }

  private metric(
    category: QualityCategoryId,
    id: string,
    label: string,
    actual: string,
    threshold: string,
    verdict: QualityVerdict,
    summary: string,
    evidence: QualityEvidence[],
    aggregation: QualityMetricAggregation = "primary",
  ): QualityMetricReport {
    return {
      id,
      category,
      label,
      aggregation,
      actual,
      threshold,
      verdict,
      automation: verdict === "manual" ? "manual" : "automatic",
      summary,
      evidence,
    };
  }

  private fileEvidence(label: string, filePath: string, value?: string): QualityEvidence {
    return {
      type: "file",
      label,
      filePath,
      value: value ? `${filePath}: ${value}` : filePath,
    };
  }

  private buildBaselineComparisonLine(report: QualityReport): string {
    const context = this.gateContext;
    if (!context?.baselinePath) {
      return "- 前回比: N/A（ベースライン未設定）";
    }
    const baselineLabel = context.baselineOverallVerdict ? this.verdictLabel(context.baselineOverallVerdict) : "不明";
    const currentLabel = this.verdictLabel(report.summary.overallVerdict);
    return `- 前回比: ${baselineLabel} -> ${currentLabel}（悪化 ${context.regressedCount ?? 0} 件 / 改善 ${context.improvedCount ?? 0} 件、ベースライン: ${this.toDisplayPath(context.baselinePath)}）`;
  }

  private buildGateVerdictLines(): string[] {
    const context = this.gateContext;
    if (!context || context.mode !== "gate") {
      return [];
    }
    if (context.gateVerdict !== "fail") {
      return ["- **ゲート判定: PASS**（自動FAILなし、ベースライン悪化なし）"];
    }

    const lines = [
      `- **ゲート判定: FAIL**（自動FAIL ${context.failingAutomaticMetrics.length} 件 / ベースライン悪化 ${context.blockingRegressions.length} 件、終了コード 2）`,
    ];
    for (const offender of context.failingAutomaticMetrics.slice(0, 5)) {
      lines.push(`  - 阻害: ${offender.category} / ${offender.label} — 実績 ${offender.actual}（基準 ${offender.threshold}）`);
    }
    for (const regression of context.blockingRegressions.slice(0, 5)) {
      lines.push(`  - 悪化: ${regression.category} / ${regression.label} — ${regression.baselineVerdict} -> ${regression.currentVerdict}`);
    }
    const hiddenCount = Math.max(0, context.failingAutomaticMetrics.length - 5) + Math.max(0, context.blockingRegressions.length - 5);
    if (hiddenCount > 0) {
      lines.push(`  - ほか ${hiddenCount} 件は観点別詳細を参照`);
    }
    return lines;
  }

  private toDisplayPath(filePath: string): string {
    // 分類・照合ヘルパーから同じパスに対して繰り返し呼ばれるためメモ化する
    const cached = this.displayPathCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    const normalized = filePath.split(path.sep).join("/");
    let displayPath = normalized;
    if (this.projectRoot && path.isAbsolute(filePath)) {
      const relativePath = path.relative(this.projectRoot, filePath);
      if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        displayPath = relativePath.split(path.sep).join("/");
      }
    }

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

  private noteEvidence(label: string, value: string): QualityEvidence {
    return {
      type: "note",
      label,
      value,
    };
  }

  private primaryMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
    return metrics.filter((metric) => metric.aggregation !== "derived");
  }

  private derivedMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
    return metrics.filter((metric) => metric.aggregation === "derived");
  }

  private verdictMark(verdict: QualityVerdict): string {
    switch (verdict) {
      case "pass":
        return "○";
      case "partial":
        return "◐";
      case "warn":
        return "△";
      case "fail":
        return "×";
      case "manual":
        return "手動";
      default:
        return "対象外";
    }
  }

  private verdictLabel(verdict: QualityVerdict): string {
    switch (verdict) {
      case "pass":
        return "PASS";
      case "partial":
        return "PARTIAL";
      case "warn":
        return "WARN";
      case "fail":
        return "FAIL";
      case "manual":
        return "MANUAL";
      default:
        return "N/A";
    }
  }

  private csvCell(value: string): string {
    return `"${value.replace(/"/gu, "\"\"")}"`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  private escapePipe(value: string): string {
    return value.replace(/\|/gu, "\\|");
  }

  private getJsxAttributeName(name: ts.JsxAttributeName): string {
    return ts.isIdentifier(name) ? name.text : name.name.text;
  }
}
