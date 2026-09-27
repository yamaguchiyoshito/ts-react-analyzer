import path from "node:path";

import type { ApiArtifactAnalyzer } from "../ApiArtifactAnalyzer.js";
import type { BrowserAuditAnalyzer } from "../BrowserAuditAnalyzer.js";
import type { SecurityArtifactAnalyzer } from "../SecurityArtifactAnalyzer.js";
import type { TestArtifactAnalyzer } from "../TestArtifactAnalyzer.js";
import type { TypeCheckAnalyzer, TypeCheckSummary } from "../TypeCheckAnalyzer.js";
import type { UiTestArtifactAnalyzer } from "../UiTestArtifactAnalyzer.js";
import type {
  AnalysisResult,
  GraphMetrics,
  QualityCategoryId,
  QualityEvidence,
  QualityMetricAggregation,
  QualityMetricReport,
  QualityVerdict,
} from "../../types/index.js";
import {
  DEFAULT_TEST_PRESENCE_SETTINGS,
  TEST_PRESENCE_BUCKETS,
  type AuditFinding,
  type I18nFinding,
  type QualityAnalysisContext,
  type TestPresenceBucketSummary,
  type TestPresenceFileMatch,
  type TestPresenceSummary,
  type TypeEscapeStats,
  type VisualConsumerSummary,
} from "./QualityReportModel.js";

/**
 * 観点 (カテゴリ) ごとの指標を組み立てる純粋関数群。収集結果 (成果物サマリー、
 * 静的走査の所見) を受け取り QualityMetricReport の配列を返す。閾値はプロファイル
 * (application / library-repo) と testPresenceSettings に依存するため ctx から引く。
 */

export function buildFunctionalMetrics(): QualityMetricReport[] {
  return [
    manualMetric("functional", "requirements_traceability", "要件適合率", "100%", "要件台帳と実装・テストのトレーサビリティ証跡を投入してください。"),
    manualMetric("functional", "happy_path_pass_rate", "正常系シナリオ通過率", "100%", "E2E/JUnit などの実行結果を取り込むまでは自動判定できません。"),
    manualMetric("functional", "edge_case_coverage", "異常系・エッジケース網羅率", "100%", "ケース一覧とテスト結果の入力が必要です。"),
    manualMetric("functional", "residual_bug_count", "バグ残存数（Severity別）", "High=0", "欠陥管理票の入力が必要です。"),
    manualMetric("functional", "logic_correctness", "ビジネスロジックの正当性", "100%", "期待値テーブルまたは承認済みテスト証跡を入力してください。"),
  ];
}

export function buildUiUxMetrics(visualConsumers: VisualConsumerSummary): QualityMetricReport[] {
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
    metric("uiux", "design_system_usage_rate", "デザインシステム準拠率（静的推定）", visualConsumers.total === 0 ? "対象画面なし" : `${rate.toFixed(1)}%`, ">= 80%", rateVerdict, visualConsumers.total === 0 ? "画面コンポーネントがないため対象外です。" : `画面系コンポーネント ${visualConsumers.total} 件中 ${visualConsumers.designSystemUsers} 件が JSX 使用経路上で design-system backing を持ちます。`, [
      noteEvidence("対象画面数", String(visualConsumers.total)),
    ]),
    metric("uiux", "bespoke_ui_file_count", "独自UI実装ファイル件数（静的推定）", String(visualConsumers.bespokeFiles.length), "0", bespokeVerdict, "JSX 使用経路上で共通UI backing を持たない画面系コンポーネントを数えています。", visualConsumers.bespokeFiles.slice(0, 10).map((item) => fileEvidence("独自UI候補", item.filePath, `${item.line}行目: ${item.text}`))),
    manualMetric("uiux", "figma_delta", "デザイン一致率", ">= 98%", "スクリーンショット差分または Figma 比較結果の入力が必要です。"),
    manualMetric("uiux", "breakpoint_layout", "レイアウト崩れ件数", "0", "breakpoint 別スクリーンショット検証が必要です。"),
    manualMetric("uiux", "flow_consistency", "操作フローの一貫性", "逸脱なし", "画面遷移とエラー時フィードバックの手動確認が必要です。"),
  ];
}

export function buildAccessibilityMetrics(
  browserAuditSummary: Awaited<ReturnType<BrowserAuditAnalyzer["analyzeProject"]>>,
): QualityMetricReport[] {
  const axe = browserAuditSummary.axe;
  const wcagMetric = axe
    ? metric(
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
        noteEvidence("違反総数", String(axe.totalViolations)),
        noteEvidence("incomplete", String(axe.incompleteCount)),
        ...axe.files.map((filePath) => fileEvidence("axe", filePath)),
      ],
    )
    : manualMetric("accessibility", "wcag_aa", "WCAG 2.2 AA準拠率", "AA", "axe JSON が見つからないため手動入力扱いです。");

  return [
    wcagMetric,
    manualMetric("accessibility", "aria_usage", "aria属性の適正利用率", "100%", "自動 lint または axe 証跡が必要です。"),
    manualMetric("accessibility", "keyboard_completion", "キーボード操作完結率", "100%", "操作導線の実行証跡が必要です。"),
    manualMetric("accessibility", "contrast_ratio", "コントラスト比適合率", "100%", "デザイン監査結果の入力が必要です。"),
    manualMetric("accessibility", "screen_reader", "スクリーンリーダー動作確認", "合格", "手動検証結果の入力が必要です。"),
  ];
}

export function buildPerformanceMetrics(
  browserAuditSummary: Awaited<ReturnType<BrowserAuditAnalyzer["analyzeProject"]>>,
): QualityMetricReport[] {
  const lighthouse = browserAuditSummary.lighthouse;
  const performanceMetric = lighthouse
    ? metric(
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
      lighthouse.files.map((filePath) => fileEvidence("lighthouse", filePath)),
    )
    : manualMetric("performance", "lighthouse_performance", "Lighthouse Performance", ">= 90", "Lighthouse JSON が見つからないため手動入力扱いです。");
  const lcpMetric = lighthouse
    ? metric(
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
    : manualMetric("performance", "lcp", "初期表示時間（LCP）", "< 2.5s", "Lighthouse JSON が見つからないため手動入力扱いです。");
  const ttiMetric = lighthouse
    ? metric(
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
    : manualMetric("performance", "tti", "インタラクティブ時間（TTI）", "< 3.5s", "Lighthouse JSON が見つからないため手動入力扱いです。");

  return [
    performanceMetric,
    lcpMetric,
    ttiMetric,
    manualMetric("performance", "bundle_delta", "JSバンドルサイズ増分", "< +3%", "bundle stats の取込が未実装です。"),
    manualMetric("performance", "rerender_rate", "不要再レンダリング発生率", "0", "React Profiler 等の実測結果が必要です。"),
  ];
}

export function buildCodeMetrics(
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
    ? strictnessSummary.configs.slice(0, 10).map((config) => fileEvidence(
      `strict ${config.enabledOptionCount}/6`,
      config.tsConfigPath,
      `strict=${config.strict}, noImplicitAny=${config.noImplicitAny}, strictNullChecks=${config.strictNullChecks}, noUncheckedIndexedAccess=${config.noUncheckedIndexedAccess}, exactOptionalPropertyTypes=${config.exactOptionalPropertyTypes}, useUnknownInCatchVariables=${config.useUnknownInCatchVariables}`,
    ))
    : [];
  const typeEscapeActual = typeEscapeStats.totalWeightedScore === 0
    ? "0"
    : `${typeEscapeStats.totalWeightedScore.toFixed(1)} (avg ${typeEscapeStats.averageFileScore.toFixed(2)}, high-risk ${typeEscapeStats.highRiskFileCount})`;
  const typeEscapeEvidence = typeEscapeStats.topFiles.map((item) => fileEvidence(
    `score ${item.score.toFixed(1)}`,
    item.filePath,
    item.reasons.join(", "),
  ));

  return [
    metric("code", "typescript_errors", "TypeScript型エラー数", String(typeCheckSummary.totalErrors), "0", typeCheckVerdict, typeCheckSummary.skippedReason ?? "tsconfig ベースの pre-emit diagnostics を集計しています。", buildTypeCheckEvidence(typeCheckSummary)),
    metric("code", "tsconfig_type_safety", "tsconfig型安全設定", strictnessActual, "strict=all configs", strictnessVerdict, strictnessSummary
      ? "strict を主判定とし、noImplicitAny / strictNullChecks / noUncheckedIndexedAccess / exactOptionalPropertyTypes / useUnknownInCatchVariables の補強設定を証跡として集計しています。"
      : "tsconfig 情報が無いため手動確認扱いです。", strictnessEvidence),
    manualMetric("code", "eslint_violations", "ESLint違反数", "0", "ESLint 実行結果の取込が未実装です。"),
    metric("code", "circular_dependencies", "循環依存数", String(graphMetrics.cycles.length), "0", cycleVerdict, "依存グラフから循環依存を検出しています。", graphMetrics.cycles.slice(0, 5).map((cycle, index) => noteEvidence(`cycle-${index + 1}`, cycle.nodes.map((node) => path.basename(node)).join(" -> ")))),
    metric("code", "high_responsibility_components", "高責務コンポーネント件数（静的推定）", String(highResponsibilityComponents.length), "0", responsibilityVerdict, "Hooks 数、JSX 要素数、render complexity から分割候補を推定しています。", highResponsibilityComponents.slice(0, 10).map((item) => fileEvidence("分割候補", item.filePath, `${item.line}行目: ${item.text}`))),
    metric("code", "type_escape_count", "型の逃げ道スコア", typeEscapeActual, "0 / WARN avg<=2 & high-risk=0", typeEscapeVerdict, "any / unsafe assertion / double assertion / non-null / ts directives を、ファイル種別と fan-in を加味して重み付き集計しています。", typeEscapeEvidence.length > 0 ? typeEscapeEvidence : [noteEvidence("集計対象", "weighted type escape score")]),
  ];
}

export function collectTypeEscapeStats(ctx: QualityAnalysisContext, analysisResults: AnalysisResult[]): TypeEscapeStats {
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
    .filter((result) => ctx.isStrictQualityCheckTargetFile(result.filePath))
    .map((result) => {
      const score = getTypeEscapeFileScore(ctx, result, inboundDegree.get(result.filePath) ?? 0);
      return {
        filePath: result.filePath,
        score,
        reasons: buildTypeEscapeReasons(result, inboundDegree.get(result.filePath) ?? 0),
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

export function getTypeEscapeFileScore(ctx: QualityAnalysisContext, result: AnalysisResult, inboundDegree: number): number {
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
  const fileTypeMultiplier = getTypeEscapeFileWeight(ctx, result.filePath);
  const centralityMultiplier = 1 + Math.min(1.5, inboundDegree * 0.15);
  return Number((rawScore * fileTypeMultiplier * centralityMultiplier).toFixed(2));
}

export function buildTypeEscapeReasons(result: AnalysisResult, inboundDegree: number): string[] {
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

export function getTypeEscapeFileWeight(ctx: QualityAnalysisContext, filePath: string): number {
  switch (ctx.classifyFileType(filePath)) {
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

export function buildTestMetrics(
  ctx: QualityAnalysisContext,
  testPresence: TestPresenceSummary,
  testArtifactSummary: Awaited<ReturnType<TestArtifactAnalyzer["analyzeProject"]>>,
  uiTestArtifactSummary: Awaited<ReturnType<UiTestArtifactAnalyzer["analyzeProject"]>>,
): QualityMetricReport[] {
  const verdict = testPresenceVerdict(ctx, testPresence.targetFiles, testPresence.rate);
  const testPresenceThreshold = testPresenceThresholdLabel(ctx);
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
    ? metric(
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
        noteEvidence("総テスト数", String(junit.totalTests)),
        noteEvidence("失敗数", String(junit.failedTests)),
        noteEvidence("スキップ数", String(junit.skippedTests)),
        noteEvidence("実行済みテストファイル数", String(junit.executedTestFiles.length)),
        ...junit.files.map((filePath) => fileEvidence("junit", filePath)),
      ],
    )
    : vitest
      ? metric(
        "test",
        "unit_pass_rate",
        "Unitテスト通過率",
        "Vitest検出 / 結果未収集",
        "100%",
        "manual",
        "Vitest は検出されましたが、JUnit XML などの実行結果が見つからないため通過率は算出できません。",
        [
          ...vitest.files.map((filePath) => fileEvidence("vitest", filePath)),
          ...vitest.scripts.map((script) => noteEvidence("vitest-script", script)),
        ],
      )
      : manualMetric("test", "unit_pass_rate", "Unitテスト通過率", "100%", "JUnit XML が見つからず、Vitest も検出されないため手動入力扱いです。");
  const coverageMetric = coverage
    ? metric(
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
        noteEvidence("対象行数", String(coverage.lineFound)),
        noteEvidence("通過行数", String(coverage.lineHit)),
        ...coverage.files.map((filePath) => fileEvidence("lcov", filePath)),
      ],
    )
    : manualMetric("test", "coverage_rate", "テスト網羅率（LCOV line coverage）", ">= 80%", "LCOV が見つからないため手動入力扱いです。");
  const storybookMetric = storybook
    ? metric(
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
        noteEvidence("総テスト数", String(storybook.totalTests)),
        noteEvidence("失敗数", String(storybook.failedTests)),
        noteEvidence("スキップ数", String(storybook.skippedTests)),
        ...storybook.files.map((filePath) => fileEvidence("storybook", filePath)),
      ],
    )
    : manualMetric("test", "storybook_pass_rate", "Storybook Interactionテスト通過率", "100%", "Storybook 結果 JSON が見つからないため手動入力扱いです。");
  const playwrightMetric = playwright
    ? metric(
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
        noteEvidence("総テスト数", String(playwright.totalTests)),
        noteEvidence("失敗数", String(playwright.failedTests)),
        noteEvidence("スキップ数", String(playwright.skippedTests)),
        noteEvidence("実行済みテストファイル数", String(playwright.executedTestFiles.length)),
        ...playwright.files.map((filePath) => fileEvidence("playwright", filePath)),
      ],
    )
    : manualMetric("test", "e2e_pass_rate", "E2Eテスト通過率", "100%", "Playwright 結果 JSON が見つからないため手動入力扱いです。");

  return [
    metric(
      "test",
      "matching_test_file_presence",
      "対応テストファイル存在率（重み付き推定）",
      testPresence.targetFiles === 0 ? "対象ソースなし" : `${testPresence.rate.toFixed(1)}%`,
      testPresenceThreshold,
      verdict,
      "LCOV の per-file 証跡を最優先し、無い場合は JUnit / Playwright の実行済みテストファイル、最後に静的な import / 命名対応から推定しています。Story は主指標に含めません。Route / Feature / Form / UI の内訳は下位指標で確認できます。",
      buildTestPresenceEvidence(testPresence),
    ),
    ...testPresence.buckets.map((bucket) => buildTestPresenceBucketMetric(ctx, bucket)),
    unitPassMetric,
    storybookMetric,
    playwrightMetric,
    coverageMetric,
    manualMetric("test", "flaky_rate", "flaky test率", "0%", "再実行統計の入力が必要です。"),
  ];
}

export function buildApiMetrics(
  ctx: QualityAnalysisContext,
  zodAdoption: { totalFiles: number; adoptedFiles: number; rate: number },
  apiArtifactSummary: Awaited<ReturnType<ApiArtifactAnalyzer["analyzeProject"]>>,
): QualityMetricReport[] {
  const zodThreshold = zodAdoptionThreshold(ctx);
  const verdict: QualityVerdict = zodAdoption.totalFiles === 0
    ? "not_applicable"
    : ctx.qualityProfile === "library-repo" && zodAdoption.totalFiles < zodThreshold.minimumApplicableFiles
      ? "not_applicable"
      : zodAdoption.rate >= zodThreshold.pass
        ? "pass"
        : zodAdoption.rate >= zodThreshold.warn
          ? "warn"
          : "fail";
  const openApiMetric = apiArtifactSummary.openApi?.breakingChanges !== null && apiArtifactSummary.openApi
    ? metric(
      "api",
      "openapi_contract",
      "APIレスポンス整合性",
      `breaking=${apiArtifactSummary.openApi.breakingChanges}`,
      "breaking=0",
      apiArtifactSummary.openApi.breakingChanges === 0 ? "pass" : "fail",
      "OpenAPI diff / validation JSON から breaking change 数を集計しています。",
      [
        ...apiArtifactSummary.openApi.diffFiles.map((filePath) => fileEvidence("openapi-diff", filePath)),
        ...apiArtifactSummary.openApi.specFiles.map((filePath) => fileEvidence("openapi-spec", filePath)),
      ],
    )
    : metric(
      "api",
      "openapi_contract",
      "APIレスポンス整合性",
      apiArtifactSummary.openApi?.specFiles.length ? "specあり / diffなし" : "証跡未収集",
      "breaking=0",
      "manual",
      apiArtifactSummary.openApi?.specFiles.length
        ? "OpenAPI spec は見つかりましたが diff / validation 証跡がないため手動入力扱いです。"
        : "OpenAPI diff / validation 証跡が見つからないため手動入力扱いです。",
      apiArtifactSummary.openApi?.specFiles.map((filePath) => fileEvidence("openapi-spec", filePath)) ?? [],
    );
  const mswMetric = apiArtifactSummary.msw.apiFileCount === 0
    ? metric("api", "msw_alignment", "MSWとの整合性（採用シグナル）", "対象API層なし", "N/A", "not_applicable", "API 層ファイルがないため対象外です。", [])
    : metric(
      "api",
      "msw_alignment",
      "MSWとの整合性（採用シグナル）",
      `handlers=${apiArtifactSummary.msw.handlerCount}`,
      ">= 1",
      apiArtifactSummary.msw.handlerCount > 0 ? "pass" : "warn",
      "MSW handler 定義の存在を API 層ファイル数に対して評価しています。",
      apiArtifactSummary.msw.handlerFiles.map((filePath) => fileEvidence("msw", filePath)),
    );
  const timeoutRetryMetric = apiArtifactSummary.timeoutRetry.apiFileCount === 0
    ? metric("api", "timeout_retry", "タイムアウト/リトライ設計有無", "対象API層なし", "N/A", "not_applicable", "API 層ファイルがないため対象外です。", [])
    : metric(
      "api",
      "timeout_retry",
      "タイムアウト/リトライ設計有無",
      `${apiArtifactSummary.timeoutRetry.resilientFiles.length}/${apiArtifactSummary.timeoutRetry.apiFileCount} files`,
      ">= 1 file",
      apiArtifactSummary.timeoutRetry.resilientFiles.length > 0 ? "pass" : "warn",
      "AbortController / timeout / retry 系シグナルを API 層ファイルから検出しています。",
      apiArtifactSummary.timeoutRetry.resilientFiles.map((filePath) => fileEvidence("timeout-retry", filePath)),
    );

  return [
    openApiMetric,
    manualMetric("api", "error_handling", "エラーハンドリング網羅率", "100%", "API エラー時の実行証跡が必要です。"),
    timeoutRetryMetric,
    mswMetric,
    metric("api", "zod_adoption", "データ型検証採用率（zod静的推定）", zodAdoption.totalFiles === 0 ? "対象API層なし" : `${zodAdoption.rate.toFixed(1)}%`, zodAdoptionThresholdLabel(ctx), verdict, "API / validation / schema 系ファイルで zod import を検出しています。", [
      noteEvidence("対象ファイル数", String(zodAdoption.totalFiles)),
      noteEvidence("採用ファイル数", String(zodAdoption.adoptedFiles)),
    ]),
  ];
}

export function buildSecurityMetrics(
  dangerousHtml: AuditFinding[],
  secretIndicators: AuditFinding[],
  securityArtifactSummary: Awaited<ReturnType<SecurityArtifactAnalyzer["analyzeProject"]>>,
): QualityMetricReport[] {
  const dangerousVerdict: QualityVerdict = dangerousHtml.length === 0 ? "pass" : "fail";
  const secretVerdict: QualityVerdict = secretIndicators.length === 0 ? "pass" : "fail";
  const vulnerabilityMetric = securityArtifactSummary.tools.length > 0
    ? metric(
      "security",
      "dependency_vulnerabilities",
      "依存ライブラリ脆弱性",
      securityArtifactSummary.tools.map((tool) => `${tool.tool}(critical=${tool.critical},high=${tool.high})`).join(", "),
      "critical=0, high=0",
      securityArtifactSummary.tools.some((tool) => tool.critical > 0 || tool.high > 0) ? "fail" : "pass",
      "npm audit / Trivy の JSON 結果をツール別に評価しています。",
      securityArtifactSummary.tools.map((tool) => fileEvidence(tool.tool, tool.filePath)),
    )
    : manualMetric("security", "dependency_vulnerabilities", "依存ライブラリ脆弱性", "High=0", "npm audit / Trivy 結果の取込が未実装です。");

  return [
    metric("security", "dangerous_html", "dangerouslySetInnerHTML使用件数", String(dangerousHtml.length), "0", dangerousVerdict, "JSX 属性 `dangerouslySetInnerHTML` を直接検出しています。", dangerousHtml.slice(0, 10).map((item) => fileEvidence("dangerouslySetInnerHTML", item.filePath, `${item.line}行目`))),
    manualMetric("security", "csrf_protection", "CSRF対策", "有効", "実行時設定の確認が必要です。"),
    manualMetric("security", "auth_flow", "認証・認可フロー検証", "合格", "認証済みシナリオ実行結果が必要です。"),
    vulnerabilityMetric,
    metric("security", "secret_indicators", "機密情報露出シグナル件数", String(secretIndicators.length), "0", secretVerdict, "API key / private key 断片の静的パターンを検出しています。", secretIndicators.slice(0, 10).map((item) => fileEvidence("secret-pattern", item.filePath, `${item.line}行目: ${item.text}`))),
  ];
}

export function buildI18nMetrics(ctx: QualityAnalysisContext, hardcodedJsxText: I18nFinding[]): QualityMetricReport[] {
  const productFindings = hardcodedJsxText.filter((item) => item.scope === "product");
  const libraryFindings = hardcodedJsxText.filter((item) => item.scope === "library");
  const i18nThreshold = hardcodedTextThreshold(ctx);
  const verdict: QualityVerdict = productFindings.length === 0 ? "pass" : productFindings.length <= i18nThreshold.warnMax ? "warn" : "fail";
  const summary = productFindings.length === 0 && libraryFindings.length === 0
    ? "製品文言・共通UIラベルともに未検出です。"
    : `製品文言 ${productFindings.length} 件、共通UIラベル ${libraryFindings.length} 件です。判定は製品文言だけを基準にしています。`;

  return [
    metric(
      "i18n",
      "hardcoded_jsx_text",
      "ハードコード製品文言件数（JSX）",
      String(productFindings.length),
      hardcodedTextThresholdLabel(ctx),
      verdict,
      summary,
      [
        noteEvidence("製品文言件数", String(productFindings.length)),
        noteEvidence("共通UIラベル件数", String(libraryFindings.length)),
        ...productFindings.slice(0, 8).map((item) => fileEvidence("product-text", item.filePath, `${item.line}行目: ${item.text}`)),
        ...libraryFindings.slice(0, 4).map((item) => fileEvidence("library-text", item.filePath, `${item.line}行目: ${item.text}`)),
      ],
    ),
    manualMetric("i18n", "translation_keys", "翻訳キー存在率", "100%", "辞書ファイルとの照合が未実装です。"),
    manualMetric("i18n", "pseudo_locale", "疑似ロケール対応", "合格", "疑似ロケール実行結果が必要です。"),
    manualMetric("i18n", "formatting", "日付/数値フォーマット適正", "合格", "Intl 利用監査が未実装です。"),
    manualMetric("i18n", "rtl", "RTL対応", "必要時合格", "RTL 向けレイアウト監査が未実装です。"),
  ];
}

export function buildOperationsMetrics(docsPresence: { docsCount: number; docFiles: string[] }): QualityMetricReport[] {
  const verdict: QualityVerdict = docsPresence.docsCount > 0 ? "pass" : "warn";

  return [
    metric("operations", "documentation_presence", "ドキュメント整備率シグナル", docsPresence.docsCount > 0 ? `${docsPresence.docsCount} 件` : "0 件", ">= 1", verdict, "README / docs / ADR 相当ファイルの存在を見ています。", docsPresence.docFiles.slice(0, 10).map((filePath) => fileEvidence("doc", filePath))),
    manualMetric("operations", "logging_design", "ログ出力設計", "定義済み", "観測性ポリシーの証跡が必要です。"),
    manualMetric("operations", "error_tracking", "エラートラッキング", "定義済み", "Sentry 等の設定証跡が必要です。"),
    manualMetric("operations", "feature_flags", "Feature Flag対応", "必要箇所で実装", "Flag 管理台帳の証跡が必要です。"),
    manualMetric("operations", "externalized_config", "設定の外部化", "定義済み", "環境変数・設定管理の証跡が必要です。"),
  ];
}

export function buildBuildMetrics(ciPresence: { hasCi: boolean; files: string[] }): QualityMetricReport[] {
  const verdict: QualityVerdict = ciPresence.hasCi ? "pass" : "warn";

  return [
    metric("build", "ci_presence", "CI設定有無", ciPresence.hasCi ? "あり" : "なし", "あり", verdict, "主要な CI 設定ファイルの存在を確認しています。", ciPresence.files.map((filePath) => fileEvidence("ci-config", filePath))),
    manualMetric("build", "build_time", "ビルド時間", "基準内", "CI 実行結果の取込が未実装です。"),
    manualMetric("build", "cache_efficiency", "キャッシュ効率", "基準内", "CI キャッシュ統計の取込が未実装です。"),
    manualMetric("build", "rollback", "rollback手順有無", "あり", "運用手順書の証跡が必要です。"),
    manualMetric("build", "environment_diff", "環境差異の有無", "差異管理済み", "環境比較結果の入力が必要です。"),
  ];
}

export function buildDependencyMetrics(ctx: QualityAnalysisContext, externalPackageCount: number, graphMetrics: GraphMetrics): QualityMetricReport[] {
  const dependencyThreshold = externalPackageThreshold(ctx);
  const externalVerdict: QualityVerdict = externalPackageCount <= dependencyThreshold.pass
    ? "pass"
    : externalPackageCount <= dependencyThreshold.warn
      ? "warn"
      : "fail";

  return [
    metric("dependencies", "external_package_count", "外部依存パッケージ数", String(externalPackageCount), externalPackageThresholdLabel(ctx), externalVerdict, "import された外部 package 名のユニーク数です。", []),
    // コード品質の「循環依存数」と同一事象のため、二重に FAIL 計上しない参照 (派生) 指標にする
    metric("dependencies", "dependency_cycle_count", "循環依存件数（コード品質と同一事象）", String(graphMetrics.cycles.length), "0", graphMetrics.cycles.length === 0 ? "pass" : "fail", "コード品質カテゴリの「循環依存数」と同じ検出結果の参照表示です。対応はコード品質側で行ってください。", [], "derived"),
    manualMetric("dependencies", "unused_dependencies", "不要依存の有無", "0", "package.json と import 実績の完全照合が未実装です。"),
    manualMetric("dependencies", "license_compliance", "ライセンス適合性", "適合", "license scan の取込が未実装です。"),
    manualMetric("dependencies", "maintenance_health", "メンテナンス状態", "健全", "更新頻度や保守終了の監査が未実装です。"),
  ];
}

export function testPresenceThreshold(ctx: QualityAnalysisContext): { pass: number; warn: number } {
  const threshold = ctx.testPresenceSettings.thresholds[ctx.qualityProfile] ?? DEFAULT_TEST_PRESENCE_SETTINGS.thresholds[ctx.qualityProfile];
  return {
    pass: threshold.pass,
    warn: threshold.warn,
  };
}

export function testPresenceThresholdLabel(ctx: QualityAnalysisContext): string {
  const threshold = testPresenceThreshold(ctx);
  return `PASS>=${threshold.pass}% / WARN>=${threshold.warn}%`;
}

export function zodAdoptionThreshold(ctx: QualityAnalysisContext): { pass: number; warn: number; minimumApplicableFiles: number } {
  return ctx.qualityProfile === "library-repo"
    ? { pass: 50, warn: 20, minimumApplicableFiles: 10 }
    : { pass: 80, warn: 50, minimumApplicableFiles: 1 };
}

export function zodAdoptionThresholdLabel(ctx: QualityAnalysisContext): string {
  const threshold = zodAdoptionThreshold(ctx);
  return ctx.qualityProfile === "library-repo"
    ? `PASS>=${threshold.pass}% / WARN>=${threshold.warn}% (files>=${threshold.minimumApplicableFiles})`
    : `PASS>=${threshold.pass}% / WARN>=${threshold.warn}%`;
}

export function hardcodedTextThreshold(ctx: QualityAnalysisContext): { warnMax: number } {
  return ctx.qualityProfile === "library-repo"
    ? { warnMax: 25 }
    : { warnMax: 3 };
}

export function hardcodedTextThresholdLabel(ctx: QualityAnalysisContext): string {
  const threshold = hardcodedTextThreshold(ctx);
  return `0, WARN<=${threshold.warnMax}`;
}

export function externalPackageThreshold(ctx: QualityAnalysisContext): { pass: number; warn: number } {
  return ctx.qualityProfile === "library-repo"
    ? { pass: 80, warn: 160 }
    : { pass: 30, warn: 60 };
}

export function externalPackageThresholdLabel(ctx: QualityAnalysisContext): string {
  const threshold = externalPackageThreshold(ctx);
  return `<= ${threshold.pass} / WARN<=${threshold.warn}`;
}

export function testPresenceVerdict(ctx: QualityAnalysisContext, targetFiles: number, rate: number): QualityVerdict {
  const threshold = testPresenceThreshold(ctx);
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

export function buildTestPresenceBucketMetric(ctx: QualityAnalysisContext, bucket: TestPresenceBucketSummary): QualityMetricReport {
  return metric(
    "test",
    TEST_PRESENCE_BUCKETS.find((descriptor) => descriptor.id === bucket.id)?.metricId ?? `${bucket.id}_test_file_presence`,
    `${bucket.label}テスト対応率（重み付き推定）`,
    bucket.targetFiles === 0 ? "対象ソースなし" : `${bucket.rate.toFixed(1)}%`,
    testPresenceThresholdLabel(ctx),
    testPresenceVerdict(ctx, bucket.targetFiles, bucket.rate),
    `${bucket.label} 層について、LCOV の per-file 証跡を最優先し、無い場合は JUnit / Playwright の実行済みテストファイル、最後に静的な import / 命名対応から推定しています。Story は主指標に含めません。`,
    [
      noteEvidence("対象ソース数", String(bucket.targetFiles)),
      noteEvidence("テストありソース数", String(bucket.matchedFiles)),
      noteEvidence("対象重み", bucket.weightedTarget.toFixed(1)),
      noteEvidence("テストあり重み", bucket.weightedMatched.toFixed(1)),
    ],
    "derived",
  );
}

export function buildTestPresenceEvidence(testPresence: TestPresenceSummary): QualityEvidence[] {
  const matchedExamples = testPresence.matches
    .filter((match) => match.matched)
    .sort((left, right) => {
      if (left.matchedBy !== right.matchedBy) {
        return left.matchedBy === "runtime" ? -1 : 1;
      }
      return right.weight - left.weight || left.filePath.localeCompare(right.filePath);
    })
    .slice(0, 8)
    .flatMap((match) => buildTestMatchEvidence(match));
  const explicitRuntimeMisses = testPresence.matches
    .filter((match) => !match.matched && match.matchedBy === "runtime")
    .sort((left, right) => right.weight - left.weight || left.filePath.localeCompare(right.filePath))
    .slice(0, 4)
    .flatMap((match) => buildTestMatchEvidence(match));
  const unmatchedNoEvidence = testPresence.matches
    .filter((match) => !match.matched && match.matchedBy === "none")
    .sort((left, right) => right.weight - left.weight || left.filePath.localeCompare(right.filePath))
    .slice(0, 4)
    .flatMap((match) => buildTestMatchEvidence(match));

  return [
    noteEvidence("対象ソース数", String(testPresence.targetFiles)),
    noteEvidence("テストありソース数", String(testPresence.matchedFiles)),
    noteEvidence("対象重み", testPresence.weightedTarget.toFixed(1)),
    noteEvidence("テストあり重み", testPresence.weightedMatched.toFixed(1)),
    noteEvidence("runtime一致数", String(testPresence.runtimeMatchedFiles)),
    noteEvidence("static一致数", String(testPresence.staticMatchedFiles)),
    noteEvidence("runtime明示未一致数", String(testPresence.runtimeExplicitUnmatchedFiles)),
    noteEvidence("証跡未検出数", String(testPresence.noEvidenceUnmatchedFiles)),
    ...testPresence.buckets.map((bucket) => noteEvidence(`${bucket.label}重み`, `${bucket.weightedMatched.toFixed(1)} / ${bucket.weightedTarget.toFixed(1)} (${bucket.rate.toFixed(1)}%)`)),
    ...matchedExamples,
    ...explicitRuntimeMisses,
    ...unmatchedNoEvidence,
  ];
}

export function buildTestMatchEvidence(match: TestPresenceFileMatch): QualityEvidence[] {
  const label = testMatchEvidenceLabel(match);
  return match.reasons
    .slice(0, 2)
    .map((reason) => fileEvidence(label, match.filePath, reason));
}

export function testMatchEvidenceLabel(match: TestPresenceFileMatch): string {
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

export function manualMetric(
  category: QualityCategoryId,
  id: string,
  label: string,
  threshold: string,
  summary: string,
): QualityMetricReport {
  return metric(category, id, label, "証跡未収集", threshold, "manual", summary, []);
}

export function metric(
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

export function fileEvidence(label: string, filePath: string, value?: string): QualityEvidence {
  return {
    type: "file",
    label,
    filePath,
    value: value ? `${filePath}: ${value}` : filePath,
  };
}

export function buildTypeCheckEvidence(typeCheckSummary: TypeCheckSummary): QualityEvidence[] {
  if (typeCheckSummary.issues.length === 0) {
    return [];
  }

  // 個別 issue の羅列より先にエラーコード別の内訳を出し、実態を掴めるようにする。
  // モジュール解決系 (TS2307/TS2875 など) は依存未インストールの環境要因であることが
  // 多いため、その可能性を注記する。
  const MODULE_RESOLUTION_CODES = new Set([2307, 2792, 2875]);
  const countsByCode = new Map<number, number>();
  for (const issue of typeCheckSummary.issues) {
    countsByCode.set(issue.code, (countsByCode.get(issue.code) ?? 0) + 1);
  }
  const breakdown = Array.from(countsByCode.entries())
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([code, count]) => `TS${code}: ${count}件`)
    .join(", ");
  const evidence: QualityEvidence[] = [noteEvidence("エラーコード別内訳", breakdown)];
  const moduleResolutionCount = typeCheckSummary.issues.filter((issue) => MODULE_RESOLUTION_CODES.has(issue.code)).length;
  if (moduleResolutionCount > 0) {
    evidence.push(noteEvidence(
      "注記",
      `モジュール解決エラー ${moduleResolutionCount} 件は依存パッケージ未インストールなど環境要因の可能性があります`,
    ));
  }
  evidence.push(...typeCheckSummary.issues.slice(0, 10).map((issue) =>
    fileEvidence(`TS${issue.code}`, issue.filePath, `${issue.line}:${issue.character} ${issue.message}`)));
  return evidence;
}

export function noteEvidence(label: string, value: string): QualityEvidence {
  return {
    type: "note",
    label,
    value,
  };
}

export function selectPrimaryMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
  return metrics.filter((metric) => metric.aggregation !== "derived");
}

export function selectDerivedMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
  return metrics.filter((metric) => metric.aggregation === "derived");
}
