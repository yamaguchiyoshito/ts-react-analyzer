import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { ApiArtifactAnalyzer } from "./ApiArtifactAnalyzer.js";
import { BrowserAuditAnalyzer } from "./BrowserAuditAnalyzer.js";
import { TestArtifactAnalyzer } from "./TestArtifactAnalyzer.js";
import { TypeCheckAnalyzer } from "./TypeCheckAnalyzer.js";
import { UiTestArtifactAnalyzer } from "./UiTestArtifactAnalyzer.js";
import { SecurityArtifactAnalyzer } from "./SecurityArtifactAnalyzer.js";
import type {
  AnalysisResult,
  GraphMetrics,
  ParsedFile,
  ManualQualityMetricInput,
  QualityCategoryId,
  QualityCategoryReport,
  QualityEvidence,
  QualityMetricReport,
  QualityReport,
  QualitySummary,
  QualityVerdict,
} from "../types/index.js";

interface QualityGenerationInput {
  projectRoot: string;
  analysisResults: AnalysisResult[];
  parsedFiles: ParsedFile[];
  graphMetrics: GraphMetrics;
  executionTimeMs: number;
  tsConfigPath?: string;
  manualInputs?: ManualQualityMetricInput[];
}

interface QualityGenerationOptions {
  outputDir: string;
  prefix: string;
  formats: Array<"json" | "markdown" | "csv" | "html" | "all">;
}

interface AuditFinding {
  filePath: string;
  line: number;
  text: string;
}

interface CategoryDescriptor {
  id: QualityCategoryId;
  label: string;
}

interface VisualConsumerSummary {
  total: number;
  designSystemUsers: number;
  bespokeFiles: AuditFinding[];
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

export class QualityReportGenerator {
  async generateReports(input: QualityGenerationInput, options: QualityGenerationOptions): Promise<QualityReport> {
    await fs.mkdir(options.outputDir, { recursive: true });

    const report = await this.buildReport(input);
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

  private async buildReport(input: QualityGenerationInput): Promise<QualityReport> {
    const strictQualityAnalysisResults = input.analysisResults.filter((result) => this.isStrictQualityCheckTargetFile(result.filePath));
    const strictQualityParsedFiles = input.parsedFiles.filter((parsedFile) => this.isStrictQualityCheckTargetFile(parsedFile.filePath));
    const typeCheckSummary = this.filterTypeCheckSummary(new TypeCheckAnalyzer().analyzeProject(input.projectRoot, input.tsConfigPath));
    const browserAuditSummary = await new BrowserAuditAnalyzer().analyzeProject(input.projectRoot);
    const testArtifactSummary = await new TestArtifactAnalyzer().analyzeProject(input.projectRoot);
    const uiTestArtifactSummary = await new UiTestArtifactAnalyzer().analyzeProject(input.projectRoot);
    const apiArtifactSummary = await new ApiArtifactAnalyzer().analyzeProject(input.projectRoot, input.parsedFiles);
    const securityArtifactSummary = await new SecurityArtifactAnalyzer().analyzeProject(input.projectRoot);
    const dangerousHtml = this.collectDangerousHtml(strictQualityParsedFiles);
    const hardcodedJsxText = this.collectHardcodedJsxText(input.parsedFiles);
    const secretIndicators = this.collectSecretIndicators(strictQualityParsedFiles);
    const visualConsumers = this.collectVisualConsumers(input.analysisResults);
    const highResponsibilityComponents = this.collectHighResponsibilityComponents(strictQualityAnalysisResults);
    const typeEscapeTotal = strictQualityAnalysisResults.reduce(
      (sum, result) => sum
        + result.complexity.typeMetrics.anyTypeCount
        + result.complexity.typeMetrics.assertionCount
        + result.complexity.typeMetrics.nonNullAssertionCount
        + result.complexity.typeMetrics.tsIgnoreCount,
      0,
    );
    const testPresence = this.collectTestPresence(input.analysisResults);
    const zodAdoption = this.collectZodAdoption(input.parsedFiles);
    const ciPresence = await this.collectCiPresence(input.projectRoot);
    const docsPresence = await this.collectDocumentationPresence(input.projectRoot);
    const externalPackageCount = this.collectExternalPackageCount(input.analysisResults);

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
    for (const metric of this.buildCodeMetrics(typeCheckSummary, input.graphMetrics, highResponsibilityComponents, typeEscapeTotal)) {
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
    const mergedCategoryReports = this.applyManualInputs(categoryReports, input.manualInputs ?? []);

    return {
      timestamp: new Date().toISOString(),
      executionTimeMs: input.executionTimeMs,
      projectRoot: input.projectRoot,
      summary: this.calculateSummary(mergedCategoryReports),
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
      this.metric("uiux", "design_system_usage_rate", "デザインシステム準拠率（静的推定）", visualConsumers.total === 0 ? "対象画面なし" : `${rate.toFixed(1)}%`, ">= 80%", rateVerdict, visualConsumers.total === 0 ? "画面コンポーネントがないため対象外です。" : `画面系コンポーネント ${visualConsumers.total} 件中 ${visualConsumers.designSystemUsers} 件が design-system import を持ちます。`, [
        this.noteEvidence("対象画面数", String(visualConsumers.total)),
      ]),
      this.metric("uiux", "bespoke_ui_file_count", "独自UI実装ファイル件数（静的推定）", String(visualConsumers.bespokeFiles.length), "0", bespokeVerdict, "共通UI import を持たない画面系コンポーネントを数えています。", visualConsumers.bespokeFiles.slice(0, 10).map((item) => this.fileEvidence("独自UI候補", item.filePath, `${item.line}行目: ${item.text}`))),
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
    typeEscapeTotal: number,
  ): QualityMetricReport[] {
    const typeCheckVerdict: QualityVerdict = typeCheckSummary.totalErrors === 0 ? "pass" : "fail";
    const cycleVerdict: QualityVerdict = graphMetrics.cycles.length === 0 ? "pass" : "fail";
    const responsibilityVerdict: QualityVerdict = highResponsibilityComponents.length === 0
      ? "pass"
      : highResponsibilityComponents.length <= 2
        ? "warn"
        : "fail";
    const typeEscapeVerdict: QualityVerdict = typeEscapeTotal === 0 ? "pass" : typeEscapeTotal <= 3 ? "warn" : "fail";

    return [
      this.metric("code", "typescript_errors", "TypeScript型エラー数", String(typeCheckSummary.totalErrors), "0", typeCheckVerdict, typeCheckSummary.skippedReason ?? "tsconfig ベースの pre-emit diagnostics を集計しています。", typeCheckSummary.issues.slice(0, 10).map((issue) => this.fileEvidence(`TS${issue.code}`, issue.filePath, `${issue.line}:${issue.character} ${issue.message}`))),
      this.manualMetric("code", "eslint_violations", "ESLint違反数", "0", "ESLint 実行結果の取込が未実装です。"),
      this.metric("code", "circular_dependencies", "循環依存数", String(graphMetrics.cycles.length), "0", cycleVerdict, "依存グラフから循環依存を検出しています。", graphMetrics.cycles.slice(0, 5).map((cycle, index) => this.noteEvidence(`cycle-${index + 1}`, cycle.nodes.map((node) => path.basename(node)).join(" -> ")))),
      this.metric("code", "high_responsibility_components", "高責務コンポーネント件数（静的推定）", String(highResponsibilityComponents.length), "0", responsibilityVerdict, "Hooks 数、JSX 要素数、render complexity から分割候補を推定しています。", highResponsibilityComponents.slice(0, 10).map((item) => this.fileEvidence("分割候補", item.filePath, `${item.line}行目: ${item.text}`))),
      this.metric("code", "type_escape_count", "型の逃げ道件数", String(typeEscapeTotal), "0", typeEscapeVerdict, "any / assertion / non-null / ts-ignore の合計です。", [this.noteEvidence("集計対象", "any + assertion + non-null + ts-ignore")]),
    ];
  }

  private buildTestMetrics(
    testPresence: { targetFiles: number; matchedFiles: number; rate: number },
    testArtifactSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>,
    uiTestArtifactSummary: Awaited<ReturnType<UiTestArtifactAnalyzer["analyzeProject"]>>,
  ): QualityMetricReport[] {
    const verdict: QualityVerdict = testPresence.targetFiles === 0
      ? "not_applicable"
      : testPresence.rate >= 80
        ? "pass"
        : testPresence.rate >= 50
          ? "warn"
          : "fail";
    const junit = testArtifactSummary.junit;
    const coverage = testArtifactSummary.coverage;
    const playwright = uiTestArtifactSummary.playwright;
    const storybook = uiTestArtifactSummary.storybook;
    const junitRate = junit && junit.totalTests > 0 ? (junit.passedTests / junit.totalTests) * 100 : null;
    const coverageRate = coverage?.lineCoverage ?? null;
    const playwrightRate = playwright && playwright.totalTests > 0 ? (playwright.passedTests / playwright.totalTests) * 100 : null;
    const storybookRate = storybook && storybook.totalTests > 0 ? (storybook.passedTests / storybook.totalTests) * 100 : null;
    const unitPassMetric = junit
      ? this.metric(
        "test",
        "unit_pass_rate",
        "Unitテスト通過率",
        junit.totalTests > 0 ? `${junitRate?.toFixed(1)}%` : "0件",
        "100%",
        junit.totalTests === 0
          ? "warn"
          : junit.failedTests === 0 && junitRate === 100
            ? "pass"
            : "fail",
        "JUnit XML から tests / failures / errors / skipped を集計しています。",
        [
          this.noteEvidence("総テスト数", String(junit.totalTests)),
          this.noteEvidence("失敗数", String(junit.failedTests)),
          this.noteEvidence("スキップ数", String(junit.skippedTests)),
          ...junit.files.map((filePath) => this.fileEvidence("junit", filePath)),
        ],
      )
      : this.manualMetric("test", "unit_pass_rate", "Unitテスト通過率", "100%", "JUnit XML が見つからないため手動入力扱いです。");
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
        storybook.totalTests > 0 ? `${storybookRate?.toFixed(1)}%` : "0件",
        "100%",
        storybook.totalTests === 0
          ? "warn"
          : storybook.failedTests === 0 && storybookRate === 100
            ? "pass"
            : "fail",
        "Storybook 結果 JSON から通過率を集計しています。",
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
        playwright.totalTests > 0 ? `${playwrightRate?.toFixed(1)}%` : "0件",
        "100%",
        playwright.totalTests === 0
          ? "warn"
          : playwright.failedTests === 0 && playwrightRate === 100
            ? "pass"
            : "fail",
        "Playwright 結果 JSON から通過率を集計しています。",
        [
          this.noteEvidence("総テスト数", String(playwright.totalTests)),
          this.noteEvidence("失敗数", String(playwright.failedTests)),
          this.noteEvidence("スキップ数", String(playwright.skippedTests)),
          ...playwright.files.map((filePath) => this.fileEvidence("playwright", filePath)),
        ],
      )
      : this.manualMetric("test", "e2e_pass_rate", "E2Eテスト通過率", "100%", "Playwright 結果 JSON が見つからないため手動入力扱いです。");

    return [
      this.metric("test", "matching_test_file_presence", "対応テストファイル存在率（静的推定）", testPresence.targetFiles === 0 ? "対象ソースなし" : `${testPresence.rate.toFixed(1)}%`, ">= 80%", verdict, "ファイル対応関係からテスト有無を推定しています。", [
        this.noteEvidence("対象ソース数", String(testPresence.targetFiles)),
        this.noteEvidence("テストありソース数", String(testPresence.matchedFiles)),
      ]),
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
    const verdict: QualityVerdict = zodAdoption.totalFiles === 0
      ? "not_applicable"
      : zodAdoption.rate >= 80
        ? "pass"
        : zodAdoption.rate >= 50
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
      this.metric("api", "zod_adoption", "データ型検証採用率（zod静的推定）", zodAdoption.totalFiles === 0 ? "対象API層なし" : `${zodAdoption.rate.toFixed(1)}%`, ">= 80%", verdict, "API / validation / schema 系ファイルで zod import を検出しています。", [
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

  private buildI18nMetrics(hardcodedJsxText: AuditFinding[]): QualityMetricReport[] {
    const verdict: QualityVerdict = hardcodedJsxText.length === 0 ? "pass" : hardcodedJsxText.length <= 3 ? "warn" : "fail";

    return [
      this.metric("i18n", "hardcoded_jsx_text", "ハードコード文字列件数（JSX）", String(hardcodedJsxText.length), "0", verdict, "JSX テキストノードと JSX 属性内の文字列リテラルを集計しています。", hardcodedJsxText.slice(0, 10).map((item) => this.fileEvidence("hardcoded-text", item.filePath, `${item.line}行目: ${item.text}`))),
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
    const externalVerdict: QualityVerdict = externalPackageCount <= 30 ? "pass" : externalPackageCount <= 60 ? "warn" : "fail";

    return [
      this.metric("dependencies", "external_package_count", "外部依存パッケージ数", String(externalPackageCount), "<= 30", externalVerdict, "import された外部 package 名のユニーク数です。", []),
      this.metric("dependencies", "dependency_cycle_count", "循環依存件数", String(graphMetrics.cycles.length), "0", graphMetrics.cycles.length === 0 ? "pass" : "fail", "依存グラフ観点でのライブラリ品質監査です。", []),
      this.manualMetric("dependencies", "unused_dependencies", "不要依存の有無", "0", "package.json と import 実績の完全照合が未実装です。"),
      this.manualMetric("dependencies", "license_compliance", "ライセンス適合性", "適合", "license scan の取込が未実装です。"),
      this.manualMetric("dependencies", "maintenance_health", "メンテナンス状態", "健全", "更新頻度や保守終了の監査が未実装です。"),
    ];
  }

  private calculateCategoryVerdict(metrics: QualityMetricReport[]): QualityVerdict {
    if (metrics.some((metric) => metric.verdict === "fail")) {
      return "fail";
    }
    if (metrics.some((metric) => metric.verdict === "warn")) {
      return "warn";
    }
    if (metrics.some((metric) => metric.verdict === "pass")) {
      return "pass";
    }
    if (metrics.some((metric) => metric.verdict === "manual")) {
      return "manual";
    }
    return "not_applicable";
  }

  private summarizeCategory(metrics: QualityMetricReport[]): string {
    const autoMetrics = metrics.filter((metric) => metric.automation === "automatic");
    const failCount = metrics.filter((metric) => metric.verdict === "fail").length;
    const warnCount = metrics.filter((metric) => metric.verdict === "warn").length;
    const manualCount = metrics.filter((metric) => metric.verdict === "manual").length;

    if (autoMetrics.length === 0) {
      return `自動判定指標はありません。手動入力待ち ${manualCount} 件です。`;
    }

    return `自動判定 ${autoMetrics.length} 件。FAIL ${failCount} 件、WARN ${warnCount} 件、MANUAL ${manualCount} 件です。`;
  }

  private calculateSummary(categories: QualityCategoryReport[]): QualitySummary {
    const metrics = categories.flatMap((category) => category.metrics);
    const passCount = metrics.filter((metric) => metric.verdict === "pass").length;
    const warnCount = metrics.filter((metric) => metric.verdict === "warn").length;
    const failCount = metrics.filter((metric) => metric.verdict === "fail").length;
    const manualCount = metrics.filter((metric) => metric.verdict === "manual").length;
    const notApplicableCount = metrics.filter((metric) => metric.verdict === "not_applicable").length;

    let overallVerdict: QualityVerdict = "pass";
    if (failCount > 0) {
      overallVerdict = "fail";
    } else if (warnCount > 0) {
      overallVerdict = "warn";
    } else if (passCount === 0 && manualCount > 0) {
      overallVerdict = "manual";
    }

    return {
      totalMetrics: metrics.length,
      passCount,
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

  private renderMarkdown(report: QualityReport): string {
    const lines: string[] = [
      "# React 出荷審査 品質レポート",
      "",
      "| 観点 | 自動指標数 | PASS | WARN | FAIL | MANUAL | 判定 |",
      "|------|------------|------|------|------|--------|------|",
    ];

    for (const category of report.categories) {
      const autoCount = category.metrics.filter((metric) => metric.automation === "automatic").length;
      const passCount = category.metrics.filter((metric) => metric.verdict === "pass").length;
      const warnCount = category.metrics.filter((metric) => metric.verdict === "warn").length;
      const failCount = category.metrics.filter((metric) => metric.verdict === "fail").length;
      const manualCount = category.metrics.filter((metric) => metric.verdict === "manual").length;
      lines.push(`| ${category.label} | ${autoCount} | ${passCount} | ${warnCount} | ${failCount} | ${manualCount} | ${this.verdictMark(category.verdict)} |`);
    }

    lines.push(
      "",
      "## 集計",
      "",
      `- 総指標数: ${report.summary.totalMetrics}`,
      `- PASS: ${report.summary.passCount}`,
      `- WARN: ${report.summary.warnCount}`,
      `- FAIL: ${report.summary.failCount}`,
      `- MANUAL: ${report.summary.manualCount}`,
      `- OVERALL: ${this.verdictLabel(report.summary.overallVerdict)}`,
      "",
    );

    for (const category of report.categories) {
      lines.push(
        `## ${category.label}`,
        "",
        category.summary,
        "",
        "| 指標 | 実績 | 基準 | 判定 | 方式 |",
        "|------|------|------|------|------|",
      );
      for (const metric of category.metrics) {
        lines.push(`| ${metric.label} | ${this.escapePipe(metric.actual)} | ${this.escapePipe(metric.threshold)} | ${this.verdictMark(metric.verdict)} | ${metric.automation} |`);
      }
      lines.push("");
      for (const metric of category.metrics) {
        lines.push(`### ${metric.label}`, "", `- 判定: ${this.verdictLabel(metric.verdict)}`, `- 説明: ${metric.summary}`);
        if (metric.evidence.length > 0) {
          lines.push("- 証跡:");
          for (const evidence of metric.evidence) {
            lines.push(`  - ${evidence.label}: ${evidence.value}`);
          }
        }
        lines.push("");
      }
    }

    lines.push("## メタデータ", "", `- 生成時刻: ${report.timestamp}`, `- 実行時間: ${report.executionTimeMs}ms`, `- プロジェクト: ${report.projectRoot}`, "");
    return lines.join("\n");
  }

  private renderCsv(report: QualityReport): string {
    const rows = [
      ["Category", "Metric", "Automation", "Actual", "Threshold", "Verdict", "Summary"],
      ...report.categories.flatMap((category) =>
        category.metrics.map((metric) => [
          category.label,
          metric.label,
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
    const rows = report.categories.map((category) => {
      const autoCount = category.metrics.filter((metric) => metric.automation === "automatic").length;
      const passCount = category.metrics.filter((metric) => metric.verdict === "pass").length;
      const warnCount = category.metrics.filter((metric) => metric.verdict === "warn").length;
      const failCount = category.metrics.filter((metric) => metric.verdict === "fail").length;
      const manualCount = category.metrics.filter((metric) => metric.verdict === "manual").length;
      return `<tr><td>${this.escapeHtml(category.label)}</td><td>${autoCount}</td><td>${passCount}</td><td>${warnCount}</td><td>${failCount}</td><td>${manualCount}</td><td>${this.escapeHtml(this.verdictLabel(category.verdict))}</td></tr>`;
    }).join("\n");

    const detailSections = report.categories.map((category) => {
      const metricRows = category.metrics.map((metric) =>
        `<tr><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(metric.actual)}</td><td>${this.escapeHtml(metric.threshold)}</td><td>${this.escapeHtml(this.verdictLabel(metric.verdict))}</td><td>${this.escapeHtml(metric.automation)}</td></tr>`
      ).join("\n");
      return `<section><h2>${this.escapeHtml(category.label)}</h2><p>${this.escapeHtml(category.summary)}</p><table><thead><tr><th>指標</th><th>実績</th><th>基準</th><th>判定</th><th>方式</th></tr></thead><tbody>${metricRows}</tbody></table></section>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>React 出荷審査 品質レポート</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
    th { background: #f3f4f6; }
    section { margin-top: 28px; }
    .meta { display: flex; gap: 16px; flex-wrap: wrap; }
    .card { border: 1px solid #d1d5db; background: #f9fafb; border-radius: 8px; padding: 12px 16px; }
  </style>
</head>
<body>
  <h1>React 出荷審査 品質レポート</h1>
  <div class="meta">
    <div class="card"><strong>OVERALL</strong><br />${this.escapeHtml(this.verdictLabel(report.summary.overallVerdict))}</div>
    <div class="card"><strong>PASS</strong><br />${report.summary.passCount}</div>
    <div class="card"><strong>WARN</strong><br />${report.summary.warnCount}</div>
    <div class="card"><strong>FAIL</strong><br />${report.summary.failCount}</div>
    <div class="card"><strong>MANUAL</strong><br />${report.summary.manualCount}</div>
  </div>
  <table>
    <thead>
      <tr><th>観点</th><th>自動指標数</th><th>PASS</th><th>WARN</th><th>FAIL</th><th>MANUAL</th><th>判定</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${detailSections}
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

  private collectHardcodedJsxText(parsedFiles: ParsedFile[]): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const parsedFile of parsedFiles) {
      const visit = (node: ts.Node): void => {
        if (ts.isJsxText(node)) {
          const text = node.getText().replace(/\s+/gu, " ").trim();
          if (text) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text,
            });
          }
        }

        if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
          const attributeName = this.getJsxAttributeName(node.name);
          if (!["className", "id", "href", "src", "role", "variant", "size", "type", "name"].includes(attributeName)) {
            findings.push({
              filePath: parsedFile.filePath,
              line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
              text: `${attributeName}="${node.initializer.text}"`,
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

  private collectVisualConsumers(analysisResults: AnalysisResult[]): VisualConsumerSummary {
    let total = 0;
    let designSystemUsers = 0;
    const bespokeFiles: AuditFinding[] = [];

    for (const result of analysisResults) {
      if (result.complexity.components.length === 0) {
        continue;
      }

      const fileType = this.classifyFileType(result.filePath);
      if (["Test", "Story", "Fixture", "Config", "UI component"].includes(fileType)) {
        continue;
      }

      total += 1;
      const hasDesignSystemImport = result.dependencies.some((dependency) => {
        const normalizedModule = dependency.modulePath.replace(/\\/gu, "/");
        const normalizedTarget = dependency.target.replace(/\\/gu, "/");
        return normalizedModule.includes("components/ui")
          || normalizedModule.includes("shared/ui")
          || normalizedModule.includes("design-system")
          || normalizedTarget.includes("/components/ui/")
          || normalizedTarget.includes("/shared/ui/");
      });

      if (hasDesignSystemImport) {
        designSystemUsers += 1;
        continue;
      }

      bespokeFiles.push({
        filePath: result.filePath,
        line: result.complexity.components[0]?.startLine ?? 1,
        text: `${fileType} で共通UI import が見つかりません`,
      });
    }

    return {
      total,
      designSystemUsers,
      bespokeFiles,
    };
  }

  private collectHighResponsibilityComponents(analysisResults: AnalysisResult[]): AuditFinding[] {
    const findings: AuditFinding[] = [];

    for (const result of analysisResults) {
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

  private collectTestPresence(analysisResults: AnalysisResult[]): { targetFiles: number; matchedFiles: number; rate: number } {
    const targetFiles = analysisResults.filter((result) => this.isTestTargetFile(result.filePath));
    const testKeys = new Set<string>();

    for (const result of analysisResults) {
      if (this.isTestFile(result.filePath)) {
        testKeys.add(this.toTestKey(result.filePath));
        testKeys.add(path.basename(this.toTestKey(result.filePath)));
      }
    }

    let matchedFiles = 0;
    for (const result of targetFiles) {
      const testKey = this.toTestKey(result.filePath);
      if (testKeys.has(testKey) || testKeys.has(path.basename(testKey))) {
        matchedFiles += 1;
      }
    }

    return {
      targetFiles: targetFiles.length,
      matchedFiles,
      rate: targetFiles.length > 0 ? (matchedFiles / targetFiles.length) * 100 : 0,
    };
  }

  private collectZodAdoption(parsedFiles: ParsedFile[]): { totalFiles: number; adoptedFiles: number; rate: number } {
    const candidates = parsedFiles.filter((parsedFile) => {
      const normalized = parsedFile.filePath.replace(/\\/gu, "/").toLowerCase();
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

  private classifyFileType(filePath: string): string {
    const normalized = filePath.replace(/\\/gu, "/");
    const lower = normalized.toLowerCase();
    const base = path.basename(lower);

    if (this.isTestFile(filePath)) {
      return "Test";
    }
    if (/\.stories\.[jt]sx?$/u.test(lower) || lower.includes("/storybook/")) {
      return "Story";
    }
    if (lower.includes("__fixtures__") || /\.fixture\.[jt]sx?$/u.test(lower)) {
      return "Fixture";
    }
    if (/(^|\/)(vite|webpack|rollup|eslint|jest|vitest|playwright|babel|tailwind|postcss|tsconfig)(\.|$)/u.test(base) || lower.includes("/config/")) {
      return "Config";
    }
    if (lower.includes("/components/ui/") || lower.includes("/shared/ui/")) {
      return "UI component";
    }
    if (lower.includes("/layouts/") || lower.includes("/layout/")) {
      return "Layout";
    }
    if (lower.includes("/forms/") || lower.includes("/form/")) {
      return "Form";
    }
    if (lower.includes("/features/") || lower.includes("/feature/")) {
      return "Feature";
    }
    if (lower.includes("/routes/") || /\/app\/.+\/page\.[jt]sx?$/u.test(lower)) {
      return "Route";
    }
    if (lower.includes("/hooks/") || /^use[a-z0-9-]+/u.test(base)) {
      return "Hook";
    }
    if (lower.includes("/schemas/") || lower.includes("/schema/")) {
      return "Schema";
    }
    if (lower.includes("/validations/") || lower.includes("/validation/")) {
      return "Validation";
    }
    if (lower.includes("/api/") || lower.includes("/infra/") || lower.includes("/service/") || lower.includes("/client/") || lower.includes("/repository/")) {
      return "API/Infrastructure";
    }
    if (lower.includes("/utils/") || lower.includes("/lib/")) {
      return "Utils";
    }
    if (lower.endsWith("/index.ts") || lower.endsWith("/index.tsx") || lower.endsWith("/index.js") || lower.endsWith("/index.jsx")) {
      return "Barrel";
    }
    if (lower.includes("/components/")) {
      return "UI component";
    }
    return "Shared";
  }

  private isStoryFile(filePath: string): boolean {
    return this.classifyFileType(filePath) === "Story";
  }

  private isStrictQualityCheckTargetFile(filePath: string): boolean {
    return !this.isTestFile(filePath) && !this.isStoryFile(filePath);
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
    const normalized = filePath.replace(/\\/gu, "/").toLowerCase();
    return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/u.test(normalized) || /\.(?:test|spec)\.[jt]sx?$/u.test(normalized);
  }

  private isTestTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return !["Test", "Story", "Fixture", "Config", "Barrel"].includes(fileType);
  }

  private toTestKey(filePath: string): string {
    const normalized = filePath.replace(/\\/gu, "/");
    return normalized
      .replace(/(^|\/)(src|tests?)\//u, "$1")
      .replace(/\.(?:test|spec|stories|story|fixture)\.[jt]sx?$/u, "")
      .replace(/\.[jt]sx?$/u, "");
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
  ): QualityMetricReport {
    return {
      id,
      category,
      label,
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

  private noteEvidence(label: string, value: string): QualityEvidence {
    return {
      type: "note",
      label,
      value,
    };
  }

  private verdictMark(verdict: QualityVerdict): string {
    switch (verdict) {
      case "pass":
        return "○";
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
