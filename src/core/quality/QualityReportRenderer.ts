import { csvCell, escapeHtml, escapeMarkdownCell, REPORT_BASE_CSS, verdictBadge } from "../ReportUtils.js";
import type {
  FeatureSummary,
  QualityCategoryReport,
  QualityEvidence,
  QualityMetricAggregation,
  QualityMetricReport,
  QualityReport,
  QualityVerdict,
  WorkspaceSegmentSummary,
} from "../../types/index.js";
import { selectDerivedMetrics, selectPrimaryMetrics } from "./MetricBuilders.js";
import type { QualityRenderContext } from "./QualityReportModel.js";

/**
 * QualityReport を markdown / csv / html に描画する。判定済みのレポートだけを
 * 入力にとり、解析状態には依存しない (gate 判定と表示パスの整形だけ ctx から受ける)。
 */

export function renderMarkdown(ctx: QualityRenderContext, report: QualityReport): string {
  const qualityProfile = report.qualityProfile ?? "application";
  const workspaceSegments = report.workspaceSegments ?? [];
  const featureSummaries = report.featureSummaries ?? [];
  const showWorkspaceSegments = shouldRenderWorkspaceSegments(workspaceSegments);
  const showFeatureSummaries = shouldRenderFeatureSummaries(featureSummaries);
  const priorityMetrics = collectPriorityMetrics(report, 8);
  const automaticCoverage = calculateAutomaticCoverage(report);
  const measuredSignalStats = calculateAutomaticSignalStats(report, false);
  const modeledSignalStats = calculateAutomaticSignalStats(report, true);
  const derivedInsights = collectNotableDerivedInsights(report, 2);
  const pendingManualMetrics = collectPendingManualMetrics(report);
  const automatablePendingMetrics = pendingManualMetrics
    .map((entry) => ({
      categoryLabel: entry.categoryLabel,
      metrics: entry.metrics.filter((metric) => isAutomatableManualMetric(metric)),
    }))
    .filter((entry) => entry.metrics.length > 0);
  const manualOnlyPendingMetrics = pendingManualMetrics
    .map((entry) => ({
      categoryLabel: entry.categoryLabel,
      metrics: entry.metrics.filter((metric) => !isAutomatableManualMetric(metric)),
    }))
    .filter((entry) => entry.metrics.length > 0);
  const manualOnlyCategories = report.categories.filter((category) => isManualOnlyCategory(category));
  const mainCategories = report.categories.filter((category) => !isManualOnlyCategory(category));
  const failCategories = report.categories.filter((category) => category.verdict === "fail").map((category) => category.label);
  const warnCategories = report.categories.filter((category) => category.verdict === "warn").map((category) => category.label);
  const partialCategories = report.categories.filter((category) => category.verdict === "partial").map((category) => category.label);
  const blockingMetrics = collectBlockingAutomaticMetrics(report, 3);
  const lines: string[] = ["# React 出荷審査 品質レポート", ""];

  // 目次は本文確定後に実際の h2 見出しから生成する (プレースホルダを後で置換)
  lines.push("{{QUALITY_TOC}}", "");

  lines.push(
    "## 判定凡例",
    "",
    "| 記号 | 状態 | 定義 |",
    "|------|------|------|",
    "| ○ | PASS | 自動判定指標で重大な問題が検出されていない状態 |",
    "| △ | WARN | FAIL ではないが、継続監視または追加対応が必要な状態 |",
    "| × | FAIL | カテゴリ内に失敗指標が1件以上ある状態 |",
    "| ◐ | PARTIAL | 自動判定は通るが、手動確認待ちが残っており完了扱いできない状態 |",
    "| ― | MANUAL | 自動判定指標がなく、手動証跡待ちの状態 |",
    "",
    `- 総合判定ルール: ${describeOverallVerdictRule()}`,
    "- 信頼度: 高=実測/集計, 中=静的推定, 低=手動入力または未収集",
    "- 集計「親」= カテゴリ判定と件数集計に使う主指標 / 「派生」= 親の内訳や参照 (総合判定には使わない診断情報)",
    "- カテゴリの PARTIAL は、指標単体の PARTIAL が無くても手動確認待ちが残っている場合に付きます",
    "",
  );

  lines.push(
    "## 要点",
    "",
    ...buildGateVerdictLines(ctx),
    `- 総合判定: ${verdictBadge(report.summary.overallVerdict)}`,
    buildBaselineComparisonLine(ctx, report),
    `- 自動判定カバレッジ: ${automaticCoverage.automaticCount}/${automaticCoverage.totalCount} 指標 (${automaticCoverage.coverageRate.toFixed(1)}%)`,
    `- 実測ベーススコア: PASS率 ${measuredSignalStats.passRate.toFixed(1)}%（PASS ${measuredSignalStats.pass} / WARN ${measuredSignalStats.warn} / FAIL ${measuredSignalStats.fail} / PARTIAL ${measuredSignalStats.partial}）`,
    `- 推定込みスコア: PASS率 ${modeledSignalStats.passRate.toFixed(1)}%（PASS ${modeledSignalStats.pass} / WARN ${modeledSignalStats.warn} / FAIL ${modeledSignalStats.fail} / PARTIAL ${modeledSignalStats.partial}）`,
    `- 自動阻害指標: ${blockingMetrics.length > 0 ? blockingMetrics.map((entry) => `${entry.categoryLabel}/${entry.metric.label}`).join("、") : "なし"}`,
    `- 注目下位指標: ${derivedInsights.length > 0 ? derivedInsights.map((entry) => `${entry.categoryLabel}/${entry.metric.label} ${entry.metric.actual} (${verdictBadge(entry.metric.verdict)})`).join("、") : "なし"}`,
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
    // 列を絞って読める幅に収め、推奨アクションは省略せず表の直下に全文を出す
    lines.push(
      "| 優先度 | 観点 | 指標 | 判定 | 実績 | 基準 | 主対象 |",
      "|--------|------|------|------|------|------|--------|",
    );
    priorityMetrics.forEach((entry, index) => {
      const metricLabel = shouldRenderDetailedMetric(entry.metric)
        ? `[${entry.metric.label}](#${metricAnchor(entry.categoryLabel, entry.metric)})`
        : entry.metric.label;
      lines.push(`| ${index + 1} | ${entry.categoryLabel} | ${metricLabel} | ${verdictBadge(entry.metric.verdict)} | ${escapeMarkdownCell(entry.metric.actual)} | ${escapeMarkdownCell(entry.metric.threshold)} | ${escapeMarkdownCell(summarizeMetricTargets(ctx, entry.metric, 2))} |`);
    });
    lines.push("", "### 推奨アクション", "");
    priorityMetrics.forEach((entry, index) => {
      lines.push(`${index + 1}. **${entry.metric.label}** (${verdictBadge(entry.metric.verdict)} ${entry.metric.actual}) — ${recommendMetricAction(entry.metric)}`);
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
    const primaryMetrics = selectPrimaryMetrics(category.metrics);
    const autoCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
    const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
    const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
    const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
    const manualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
    lines.push(`| ${category.label} | ${autoCount} | ${failCount} | ${warnCount} | ${partialCount} | ${manualCount} | ${verdictBadge(category.verdict)} |`);
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
    `- OVERALL: ${verdictBadge(report.summary.overallVerdict)}`,
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
      lines.push(`| ${escapeMarkdownCell(feature.label)} | ${feature.fileCount} | ${feature.componentCount} | ${feature.averageComplexity.toFixed(1)} | ${feature.maxComplexity.toFixed(1)} |`);
    }
    lines.push("", "### 品質リスク", "", "| フィーチャー | 型逃げ件数 | 高責務件数 | 画面系件数 | DS準拠件数 | テスト率 | 製品文言数 |", "|--------------|------------|------------|------------|------------|----------|------------|");
    for (const feature of featureSummaries) {
      lines.push(`| ${escapeMarkdownCell(feature.label)} | ${feature.typeEscapeCount} | ${feature.highResponsibilityComponentCount} | ${feature.visualConsumerCount} | ${feature.designSystemBackedCount} | ${feature.weightedTestRate.toFixed(1)}% | ${feature.productTextCount} |`);
    }
    lines.push("");
  }

  lines.push("## 観点別詳細", "", "証跡は file 証跡優先です。score 表記は降順、それ以外はファイルパスと行番号順で並べています。", "");

  for (const category of mainCategories) {
    const overviewMetrics = collectCategoryOverviewMetrics(category.metrics);
    const manualPrimaryMetrics = selectPrimaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual");
    const testBucketMetrics = category.id === "test" ? collectDerivedTestPresenceMetrics(category.metrics) : [];
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
        lines.push(`| ${metric.label} | ${metric.aggregation === "derived" ? "派生" : "親"} | ${escapeMarkdownCell(metric.actual)} | ${escapeMarkdownCell(metric.threshold)} | ${verdictBadge(metric.verdict)} | ${describeEvidenceType(metric)} | ${describeConfidenceLevel(metric)} | ${escapeMarkdownCell(summarizeMetricTargets(ctx, metric, 2))} |`);
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
        lines.push(`| ${testPresenceLayerLabel(metric)} | ${escapeMarkdownCell(metric.actual)} | ${escapeMarkdownCell(metric.threshold)} | ${verdictBadge(metric.verdict)} |`);
      }
      lines.push("");
    }

    const detailedMetrics = category.metrics.filter((metric) =>
      shouldRenderDetailedMetric(metric) && !isDerivedTestPresenceMetric(metric)
    );
    const hiddenManualMetrics = category.metrics.filter((metric) => metric.verdict === "manual" && !shouldRenderDetailedMetric(metric));

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
      const sortedEvidence = sortEvidenceForDisplay(metric.evidence);
      lines.push(`<a id="${metricAnchor(category.label, metric)}"></a>`, `#### ${metric.label}`, "", `- 指標ID: \`${metric.id}\` (gate の blocking / monitoring 指定に使う ID)`, `- 集計: ${metric.aggregation === "derived" ? "派生" : "親"}`, `- 判定: ${verdictBadge(metric.verdict)}`, `- 実績: ${escapeMarkdownCell(metric.actual)}`, `- 基準: ${escapeMarkdownCell(metric.threshold)}`, `- 証跡種別: ${describeEvidenceType(metric)}`, `- 信頼度: ${describeConfidenceLevel(metric)}`, `- 主対象: ${escapeMarkdownCell(summarizeMetricTargets(ctx, metric, 3))}`, `- 推奨アクション: ${recommendMetricAction(metric)}`, `- 要点: ${escapeMarkdownCell(metric.summary)}`);
      if (metric.evidence.length > 0) {
        // 「他N件」だけだと実績値 (例: 108 件) との対応が読めないため、分母を明記する
        lines.push(sortedEvidence.length > 3 ? `- 証跡（代表 3 件 / 収集 ${sortedEvidence.length} 件）:` : "- 証跡:");
        for (const evidence of sortedEvidence.slice(0, 3)) {
          lines.push(`  - ${escapeMarkdownCell(`${evidence.label}: ${evidence.value}`)}`);
        }
        if (sortedEvidence.length > 3) {
          lines.push(`  - 残り ${sortedEvidence.length - 3} 件は JSON レポートを参照`);
        }
      }
      lines.push("");
    }
  }

  if (manualOnlyCategories.length > 0) {
    lines.push("## 付録: 手動確認カテゴリ", "", "自動判定が無い、または対象外のみのカテゴリを付録へ退避しています。", "");
    for (const category of manualOnlyCategories) {
      const primaryMetrics = selectPrimaryMetrics(category.metrics);
      const labels = primaryMetrics.map((metric) => metric.label).join("、");
      lines.push(`### ${category.label}`, "", `- 判定: ${verdictBadge(category.verdict)}`, `- 指標: ${labels}`, `- 補足: ${category.summary}`, "");
    }
  }

  lines.push("## メタデータ", "", `- 生成時刻: ${report.timestamp}`, `- 実行時間: ${report.executionTimeMs}ms`, `- プロジェクト: ${report.projectRoot}`, `- 品質プロファイル: ${qualityProfile}`, "");
  const body = lines.join("\n");
  const headings = Array.from(body.matchAll(/^## (.+)$/gmu)).map((match) => match[1]!);
  const toc = [
    "## 目次",
    "",
    ...headings.map((heading, index) => `${index + 1}. [${heading}](#${toMarkdownAnchor(heading)})`),
  ].join("\n");
  return body.replace("{{QUALITY_TOC}}", toc);
}

export function toMarkdownAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

export function collectBlockingAutomaticMetrics(
  report: QualityReport,
  limit: number,
): Array<{ categoryLabel: string; metric: QualityMetricReport }> {
  return report.categories
    .flatMap((category) =>
      selectPrimaryMetrics(category.metrics)
        .filter((metric) => metric.automation === "automatic" && metric.verdict === "fail")
        .map((metric) => ({ categoryLabel: category.label, metric }))
    )
    .sort((left, right) => `${left.categoryLabel}:${left.metric.label}`.localeCompare(`${right.categoryLabel}:${right.metric.label}`))
    .slice(0, limit);
}

export function collectPriorityMetrics(
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
      const primaryProblemMetrics = selectPrimaryMetrics(category.metrics)
        .filter((metric) => ["fail", "warn", "partial"].includes(metric.verdict));
      if (primaryProblemMetrics.length > 0) {
        return primaryProblemMetrics.map((metric) => ({ categoryLabel: category.label, metric }));
      }

      return selectDerivedMetrics(category.metrics)
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

export function collectPendingManualMetrics(
  report: QualityReport,
): Array<{ categoryLabel: string; metrics: QualityMetricReport[] }> {
  return report.categories
    .map((category) => ({
      categoryLabel: category.label,
      metrics: selectPrimaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual"),
    }))
    .filter((entry) => entry.metrics.length > 0);
}

export function isManualOnlyCategory(category: QualityCategoryReport): boolean {
  return selectPrimaryMetrics(category.metrics).every((metric) => ["manual", "not_applicable"].includes(metric.verdict));
}

export function isAutomatableManualMetric(metric: QualityMetricReport): boolean {
  const text = `${metric.label} ${metric.summary} ${metric.actual} ${metric.threshold}`.toLowerCase();
  return /(axe|lighthouse|lcov|junit|playwright|storybook|openapi|trivy|audit|eslint|json|xml|coverage|ビルド時間|キャッシュ効率|通過率|翻訳キー|bundle|取込|実行結果)/u.test(text);
}

export function shouldRenderDetailedMetric(metric: QualityMetricReport): boolean {
  return metric.automation === "automatic" && ["fail", "warn", "partial"].includes(metric.verdict);
}

export function describeEvaluationType(metric: QualityMetricReport): string {
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

export function describeEvidenceType(metric: QualityMetricReport): string {
  if (metric.verdict === "not_applicable") {
    return "対象外";
  }
  if (metric.automation === "manual") {
    return metric.evidence.length > 0 ? "手動/入力済み" : "手動/未収集";
  }
  return describeEvaluationType(metric) === "静的推定" ? "自動/静的推定" : "自動/実測";
}

export function describeConfidenceLevel(metric: QualityMetricReport): string {
  if (metric.verdict === "not_applicable") {
    return "—";
  }
  if (metric.automation === "manual") {
    return "低";
  }
  return describeEvaluationType(metric) === "静的推定" ? "中" : "高";
}

export function collectCategoryOverviewMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
  return selectPrimaryMetrics(metrics).filter((metric) => metric.automation === "automatic");
}

export function collectDerivedTestPresenceMetrics(metrics: QualityMetricReport[]): QualityMetricReport[] {
  return selectDerivedMetrics(metrics)
    .filter((metric) => isDerivedTestPresenceMetric(metric))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function isDerivedTestPresenceMetric(metric: QualityMetricReport): boolean {
  return metric.aggregation === "derived" && /_test_file_presence$/u.test(metric.id);
}

export function testPresenceLayerLabel(metric: QualityMetricReport): string {
  const mapping: Record<string, string> = {
    route_test_file_presence: "Route",
    feature_test_file_presence: "Feature",
    form_test_file_presence: "Form",
    ui_test_file_presence: "UI",
  };
  return mapping[metric.id] ?? metric.label;
}

export function summarizeMetricTargets(ctx: QualityRenderContext, metric: QualityMetricReport, limit: number): string {
  const targets = sortEvidenceForDisplay(metric.evidence)
    .filter((evidence) => evidence.filePath)
    .map((evidence) => ctx.toDisplayPath(evidence.filePath!))
    .filter((filePath, index, items) => items.indexOf(filePath) === index);
  if (targets.length === 0) {
    return "—";
  }
  const visibleTargets = targets.slice(0, limit);
  const remainder = targets.length > limit ? `、他${targets.length - limit}件` : "";
  return `${visibleTargets.join("、")}${remainder}`;
}

export function shouldRenderWorkspaceSegments(segments: WorkspaceSegmentSummary[]): boolean {
  const meaningfulSegments = segments.filter((segment) => segment.fileCount > 0 && segment.id !== "other");
  return meaningfulSegments.length >= 2;
}

export function shouldRenderFeatureSummaries(features: FeatureSummary[]): boolean {
  return features.length >= 2;
}

export function describeOverallVerdictRule(): string {
  return "FAILカテゴリが1つでもあれば OVERALL=FAIL。FAILが無く WARN があれば WARN、次に PARTIAL、最後に PASS を採用します。";
}

export function calculateAutomaticCoverage(report: QualityReport): { automaticCount: number; totalCount: number; coverageRate: number } {
  const primaryMetrics = selectPrimaryMetrics(report.categories.flatMap((category) => category.metrics));
  const automaticCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
  const totalCount = primaryMetrics.length;
  return {
    automaticCount,
    totalCount,
    coverageRate: totalCount > 0 ? (automaticCount / totalCount) * 100 : 0,
  };
}

export function calculateAutomaticSignalStats(
  report: QualityReport,
  includeStaticEstimates: boolean,
): { total: number; pass: number; warn: number; fail: number; partial: number; passRate: number } {
  const metrics = selectPrimaryMetrics(report.categories.flatMap((category) => category.metrics))
    .filter((metric) => metric.automation === "automatic" && metric.verdict !== "not_applicable")
    .filter((metric) => includeStaticEstimates || describeEvaluationType(metric) !== "静的推定");
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

export function collectNotableDerivedInsights(
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
      selectDerivedMetrics(category.metrics)
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
      return metricNumericActual(left.metric) - metricNumericActual(right.metric);
    })
    .slice(0, limit);
}

export function metricNumericActual(metric: QualityMetricReport): number {
  const match = metric.actual.match(/([0-9]+(?:\.[0-9]+)?)/u);
  return match ? Number.parseFloat(match[1] ?? "0") : Number.POSITIVE_INFINITY;
}

export function recommendMetricAction(metric: QualityMetricReport): string {
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

export function metricAnchor(categoryLabel: string, metric: QualityMetricReport): string {
  return `${anchorify(categoryLabel)}-${anchorify(metric.id)}`;
}

export function anchorify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function sortEvidenceForDisplay(evidence: QualityEvidence[]): QualityEvidence[] {
  return evidence.slice().sort((left, right) => {
    const leftHasFile = left.filePath ? 0 : 1;
    const rightHasFile = right.filePath ? 0 : 1;
    if (leftHasFile !== rightHasFile) {
      return leftHasFile - rightHasFile;
    }

    const leftScore = extractEvidenceScore(left);
    const rightScore = extractEvidenceScore(right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    const leftPath = left.filePath ?? "";
    const rightPath = right.filePath ?? "";
    if (leftPath !== rightPath) {
      return leftPath.localeCompare(rightPath);
    }

    const leftLine = extractEvidenceLine(left);
    const rightLine = extractEvidenceLine(right);
    if (leftLine !== rightLine) {
      return leftLine - rightLine;
    }

    const leftLabel = `${left.label}: ${left.value}`;
    const rightLabel = `${right.label}: ${right.value}`;
    return leftLabel.localeCompare(rightLabel);
  });
}

export function extractEvidenceScore(evidence: QualityEvidence): number {
  const source = `${evidence.label} ${evidence.value}`;
  const match = source.match(/score\s+([0-9]+(?:\.[0-9]+)?)/iu);
  return match ? Number.parseFloat(match[1] ?? "0") : Number.NEGATIVE_INFINITY;
}

export function extractEvidenceLine(evidence: QualityEvidence): number {
  const source = `${evidence.label} ${evidence.value}`;
  const match = source.match(/([0-9]+)行目/u);
  return match ? Number.parseInt(match[1] ?? "0", 10) : Number.MAX_SAFE_INTEGER;
}

export function renderCsv(report: QualityReport): string {
  const rows = [
    ["Category", "Metric", "Metric ID", "Aggregation", "Automation", "Actual", "Threshold", "Verdict", "Summary"],
    ...report.categories.flatMap((category) =>
      category.metrics.map((metric) => [
        category.label,
        metric.label,
        metric.id,
        metric.aggregation,
        metric.automation,
        metric.actual,
        metric.threshold,
        metric.verdict,
        metric.summary,
      ])
    ),
  ];

  return rows.map((row) => row.map((cell) => csvCell(cell, { alwaysQuote: true })).join(",")).join("\n");
}

export function renderHtml(ctx: QualityRenderContext, report: QualityReport): string {
  const qualityProfile = report.qualityProfile ?? "application";
  const workspaceSegments = report.workspaceSegments ?? [];
  const featureSummaries = report.featureSummaries ?? [];
  const showWorkspaceSegments = shouldRenderWorkspaceSegments(workspaceSegments);
  const showFeatureSummaries = shouldRenderFeatureSummaries(featureSummaries);
  const priorityMetrics = collectPriorityMetrics(report, 8);
  const automaticCoverage = calculateAutomaticCoverage(report);
  const measuredSignalStats = calculateAutomaticSignalStats(report, false);
  const modeledSignalStats = calculateAutomaticSignalStats(report, true);
  const derivedInsights = collectNotableDerivedInsights(report, 2);
  const pendingManualMetrics = collectPendingManualMetrics(report);
  const automatablePendingMetrics = pendingManualMetrics
    .map((entry) => ({
      categoryLabel: entry.categoryLabel,
      metrics: entry.metrics.filter((metric) => isAutomatableManualMetric(metric)),
    }))
    .filter((entry) => entry.metrics.length > 0);
  const manualOnlyPendingMetrics = pendingManualMetrics
    .map((entry) => ({
      categoryLabel: entry.categoryLabel,
      metrics: entry.metrics.filter((metric) => !isAutomatableManualMetric(metric)),
    }))
    .filter((entry) => entry.metrics.length > 0);
  const manualOnlyCategories = report.categories.filter((category) => isManualOnlyCategory(category));
  const mainCategories = report.categories.filter((category) => !isManualOnlyCategory(category));
  const failCategories = report.categories.filter((category) => category.verdict === "fail").map((category) => category.label);
  const warnCategories = report.categories.filter((category) => category.verdict === "warn").map((category) => category.label);
  const partialCategories = report.categories.filter((category) => category.verdict === "partial").map((category) => category.label);
  const blockingMetrics = collectBlockingAutomaticMetrics(report, 3);
  const renderBulletList = (items: string[]): string => items.length === 0
    ? "<p>なし</p>"
    : `<ul class="bullet-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;

  const summaryRows = report.categories.map((category) => {
    const primaryMetrics = selectPrimaryMetrics(category.metrics);
    const autoCount = primaryMetrics.filter((metric) => metric.automation === "automatic").length;
    const failCount = primaryMetrics.filter((metric) => metric.verdict === "fail").length;
    const warnCount = primaryMetrics.filter((metric) => metric.verdict === "warn").length;
    const partialCount = primaryMetrics.filter((metric) => metric.verdict === "partial").length;
    const manualCount = primaryMetrics.filter((metric) => metric.verdict === "manual").length;
    return `<tr><td>${escapeHtml(category.label)}</td><td>${autoCount}</td><td>${failCount}</td><td>${warnCount}</td><td>${partialCount}</td><td>${manualCount}</td><td>${escapeHtml(verdictBadge(category.verdict))}</td></tr>`;
  }).join("\n");
  const segmentRows = workspaceSegments.map((segment) =>
    `<tr><td>${escapeHtml(segment.label)}</td><td>${segment.fileCount}</td><td>${segment.componentCount}</td><td>${segment.typeEscapeCount}</td><td>${segment.highResponsibilityComponentCount}</td><td>${segment.visualConsumerCount}</td><td>${segment.designSystemBackedCount}</td><td>${segment.weightedTestRate.toFixed(1)}%</td><td>${segment.productTextCount}</td></tr>`
  ).join("\n");
  const featureScaleRows = featureSummaries.map((feature) =>
    `<tr><td>${escapeHtml(feature.label)}</td><td>${feature.fileCount}</td><td>${feature.componentCount}</td><td>${feature.averageComplexity.toFixed(1)}</td><td>${feature.maxComplexity.toFixed(1)}</td></tr>`
  ).join("\n");
  const featureRiskRows = featureSummaries.map((feature) =>
    `<tr><td>${escapeHtml(feature.label)}</td><td>${feature.typeEscapeCount}</td><td>${feature.highResponsibilityComponentCount}</td><td>${feature.visualConsumerCount}</td><td>${feature.designSystemBackedCount}</td><td>${feature.weightedTestRate.toFixed(1)}%</td><td>${feature.productTextCount}</td></tr>`
  ).join("\n");
  const priorityRows = priorityMetrics.map((entry, index) => {
    const metricLabel = shouldRenderDetailedMetric(entry.metric)
      ? `<a href="#${escapeHtml(metricAnchor(entry.categoryLabel, entry.metric))}">${escapeHtml(entry.metric.label)}</a>`
      : escapeHtml(entry.metric.label);
    return `<tr><td>${index + 1}</td><td>${escapeHtml(entry.categoryLabel)}</td><td>${metricLabel}</td><td>${escapeHtml(verdictBadge(entry.metric.verdict))}</td><td>${escapeHtml(entry.metric.actual)}</td><td>${escapeHtml(entry.metric.threshold)}</td><td>${escapeHtml(describeEvidenceType(entry.metric))}</td><td>${escapeHtml(describeConfidenceLevel(entry.metric))}</td><td>${escapeHtml(summarizeMetricTargets(ctx, entry.metric, 2))}</td><td>${escapeHtml(recommendMetricAction(entry.metric))}</td><td>${escapeHtml(entry.metric.summary)}</td></tr>`;
  }).join("\n");

  const detailSections = mainCategories.map((category) => {
    const overviewMetrics = collectCategoryOverviewMetrics(category.metrics);
    const manualPrimaryMetrics = selectPrimaryMetrics(category.metrics).filter((metric) => metric.verdict === "manual");
    const testBucketMetrics = category.id === "test" ? collectDerivedTestPresenceMetrics(category.metrics) : [];
    const detailedMetrics = category.metrics.filter((metric) =>
      shouldRenderDetailedMetric(metric) && !isDerivedTestPresenceMetric(metric)
    );
    const hiddenManualMetrics = category.metrics.filter((metric) => metric.verdict === "manual" && !shouldRenderDetailedMetric(metric));
    const overviewTable = overviewMetrics.length === 0
      ? "<p>自動判定指標はありません。</p>"
      : `<div class="table-wrap"><table><thead><tr><th>指標</th><th>集計</th><th>実績</th><th>基準</th><th>判定</th><th>証跡種別</th><th>信頼度</th><th>主対象</th></tr></thead><tbody>${overviewMetrics.map((metric) =>
        `<tr data-verdict="${escapeHtml(metric.verdict)}"><td>${escapeHtml(metric.label)}</td><td>${escapeHtml(metric.aggregation === "derived" ? "派生" : "親")}</td><td>${escapeHtml(metric.actual)}</td><td>${escapeHtml(metric.threshold)}</td><td>${escapeHtml(verdictBadge(metric.verdict))}</td><td>${escapeHtml(describeEvidenceType(metric))}</td><td>${escapeHtml(describeConfidenceLevel(metric))}</td><td>${escapeHtml(summarizeMetricTargets(ctx, metric, 2))}</td></tr>`
      ).join("\n")}</tbody></table></div>`;
    const manualNote = manualPrimaryMetrics.length > 0
      ? `<p>手動確認待ち ${manualPrimaryMetrics.length} 件: ${escapeHtml(manualPrimaryMetrics.slice(0, 4).map((metric) => metric.label).join("、"))}${manualPrimaryMetrics.length > 4 ? `、他${manualPrimaryMetrics.length - 4}件` : ""}。詳細は「不足証跡」または付録を参照してください。</p>`
      : "";
    const testBucketTable = testBucketMetrics.length > 0
      ? `<h3>層別テスト対応率</h3><div class="table-wrap"><table><thead><tr><th>層</th><th>実績</th><th>基準</th><th>判定</th></tr></thead><tbody>${testBucketMetrics.map((metric) =>
        `<tr><td>${escapeHtml(testPresenceLayerLabel(metric))}</td><td>${escapeHtml(metric.actual)}</td><td>${escapeHtml(metric.threshold)}</td><td>${escapeHtml(verdictBadge(metric.verdict))}</td></tr>`
      ).join("\n")}</tbody></table></div>`
      : "";
    const detailCards = detailedMetrics.length === 0
      ? `<p>${hiddenManualMetrics.length > 0 ? `詳細展開は省略しています。手動確認待ち ${hiddenManualMetrics.length} 件は「不足証跡」を参照してください。` : "追加で確認すべき詳細はありません。"}</p>`
      : `<h3>要確認項目</h3><div class="metric-grid">${detailedMetrics.map((metric) => {
        const sortedEvidence = sortEvidenceForDisplay(metric.evidence);
        return `<article class="metric-card" data-verdict="${escapeHtml(metric.verdict)}" id="${escapeHtml(metricAnchor(category.label, metric))}"><h4>${escapeHtml(metric.label)}</h4><ul class="bullet-list"><li>指標ID: <code>${escapeHtml(metric.id)}</code></li><li>集計: ${escapeHtml(metric.aggregation === "derived" ? "派生" : "親")}</li><li>判定: ${escapeHtml(verdictBadge(metric.verdict))}</li><li>実績: ${escapeHtml(metric.actual)}</li><li>基準: ${escapeHtml(metric.threshold)}</li><li>証跡種別: ${escapeHtml(describeEvidenceType(metric))}</li><li>信頼度: ${escapeHtml(describeConfidenceLevel(metric))}</li><li>主対象: ${escapeHtml(summarizeMetricTargets(ctx, metric, 3))}</li><li>推奨アクション: ${escapeHtml(recommendMetricAction(metric))}</li><li>要点: ${escapeHtml(metric.summary)}</li></ul>${sortedEvidence.length > 0 ? `<div><strong>証跡</strong><ul class="bullet-list">${sortedEvidence.slice(0, 3).map((evidence) => `<li>${escapeHtml(`${evidence.label}: ${evidence.value}`)}</li>`).join("")}${sortedEvidence.length > 3 ? `<li>他${sortedEvidence.length - 3}件</li>` : ""}</ul></div>` : ""}</article>`;
      }).join("\n")}</div>`;
    return `<section class="category" data-verdict="${escapeHtml(category.verdict)}"><details open><summary>${escapeHtml(category.label)} — ${escapeHtml(verdictBadge(category.verdict))}</summary><p>${escapeHtml(category.summary)}</p>${overviewTable}${manualNote}${testBucketTable}${detailCards}</details></section>`;
  }).join("\n");
  const appendixSections = manualOnlyCategories.map((category) => {
    const primaryMetrics = selectPrimaryMetrics(category.metrics);
    return `<section><h3>${escapeHtml(category.label)}</h3><ul class="bullet-list"><li>判定: ${escapeHtml(verdictBadge(category.verdict))}</li><li>指標: ${escapeHtml(primaryMetrics.map((metric) => metric.label).join("、"))}</li><li>補足: ${escapeHtml(category.summary)}</li></ul></section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>React 出荷審査 品質レポート</title>
  <style>
${REPORT_BASE_CSS}
    section { margin-top: 28px; }
    .meta { display: flex; gap: 16px; flex-wrap: wrap; }
    .card { padding: 12px 16px; min-width: 160px; }
    .metric-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 16px; background: #ffffff; }
    .bullet-list { margin: 8px 0 0 20px; padding: 0; }
    .bullet-list li { margin: 4px 0; }
    .toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
    .category > details > summary { cursor: pointer; font-size: 1.25em; font-weight: 700; margin-bottom: 8px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <h1>React 出荷審査 品質レポート</h1>
  <div class="meta">
    <div class="card"><strong>OVERALL</strong><br />${escapeHtml(verdictBadge(report.summary.overallVerdict))}</div>
    <div class="card"><strong>自動判定カバレッジ</strong><br />${automaticCoverage.automaticCount}/${automaticCoverage.totalCount} (${automaticCoverage.coverageRate.toFixed(1)}%)</div>
    <div class="card"><strong>実測ベーススコア</strong><br />PASS率 ${measuredSignalStats.passRate.toFixed(1)}%</div>
    <div class="card"><strong>推定込みスコア</strong><br />PASS率 ${modeledSignalStats.passRate.toFixed(1)}%</div>
    <div class="card"><strong>FAIL</strong><br />${report.summary.failCount}</div>
    <div class="card"><strong>WARN</strong><br />${report.summary.warnCount}</div>
    <div class="card"><strong>MANUAL</strong><br />${report.summary.manualCount}</div>
    <div class="card"><strong>PROFILE</strong><br />${escapeHtml(qualityProfile)}</div>
  </div>
  <section>
    <h2>判定凡例</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>記号</th><th>状態</th><th>定義</th></tr>
        </thead>
        <tbody>
          <tr><td>○</td><td>PASS</td><td>自動判定指標で重大な問題が検出されていない状態</td></tr>
          <tr><td>△</td><td>WARN</td><td>FAIL ではないが、継続監視または追加対応が必要な状態</td></tr>
          <tr><td>×</td><td>FAIL</td><td>カテゴリ内に失敗指標が1件以上ある状態</td></tr>
          <tr><td>◐</td><td>PARTIAL</td><td>自動判定は通るが、手動確認待ちが残っており完了扱いできない状態</td></tr>
          <tr><td>―</td><td>MANUAL</td><td>自動判定指標がなく、手動証跡待ちの状態</td></tr>
        </tbody>
      </table>
    </div>
    <ul class="bullet-list">
      <li>総合判定ルール: ${escapeHtml(describeOverallVerdictRule())}</li>
      <li>信頼度: 高=実測/集計, 中=静的推定, 低=手動入力または未収集</li>
    </ul>
  </section>
  <section>
    <h2>要点</h2>
    <ul class="bullet-list">
      <li>総合判定: ${escapeHtml(verdictBadge(report.summary.overallVerdict))}</li>
      ${buildGateVerdictLines(ctx).map((line) => `<li>${escapeHtml(line.replace(/^[-\s]*/u, "").replace(/\*\*/gu, ""))}</li>`).join("\n      ")}
      <li>${escapeHtml(buildBaselineComparisonLine(ctx, report).replace(/^[-\s]*/u, ""))}</li>
      <li>自動阻害指標: ${escapeHtml(blockingMetrics.length > 0 ? blockingMetrics.map((entry) => `${entry.categoryLabel}/${entry.metric.label}`).join("、") : "なし")}</li>
      <li>注目下位指標: ${escapeHtml(derivedInsights.length > 0 ? derivedInsights.map((entry) => `${entry.categoryLabel}/${entry.metric.label} ${entry.metric.actual} (${verdictBadge(entry.metric.verdict)})`).join("、") : "なし")}</li>
      <li>FAILカテゴリ: ${escapeHtml(failCategories.length > 0 ? failCategories.join("、") : "なし")}</li>
      <li>WARNカテゴリ: ${escapeHtml(warnCategories.length > 0 ? warnCategories.join("、") : "なし")}</li>
      <li>PARTIALカテゴリ: ${escapeHtml(partialCategories.length > 0 ? partialCategories.join("、") : "なし")}</li>
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
      <li>OVERALL: ${escapeHtml(verdictBadge(report.summary.overallVerdict))}</li>
    </ul>
  </section>
  ${showWorkspaceSegments ? `<section><h2>ワークスペース内訳</h2><div class="table-wrap"><table><thead><tr><th>セグメント</th><th>Files</th><th>Components</th><th>Type Escapes</th><th>High Responsibility</th><th>Visual Consumers</th><th>DS Backed</th><th>Test Rate</th><th>Product Text</th></tr></thead><tbody>${segmentRows}</tbody></table></div></section>` : ""}
  ${showFeatureSummaries ? `<section><h2>フィーチャー内訳</h2><h3>規模と複雑度</h3><div class="table-wrap"><table><thead><tr><th>フィーチャー</th><th>Files</th><th>Components</th><th>Avg Complexity</th><th>Max Complexity</th></tr></thead><tbody>${featureScaleRows}</tbody></table></div><h3>品質リスク</h3><div class="table-wrap"><table><thead><tr><th>フィーチャー</th><th>Type Escapes</th><th>High Responsibility</th><th>Visual Consumers</th><th>DS Backed</th><th>Test Rate</th><th>Product Text</th></tr></thead><tbody>${featureRiskRows}</tbody></table></div></section>` : ""}
  <section>
    <h2>観点別詳細</h2>
    <div class="toolbar">
      <label><input type="checkbox" id="only-flagged" /> × FAIL / △ WARN のみ表示</label>
      <button type="button" id="collapse-all">すべて折りたたむ</button>
      <button type="button" id="expand-all">すべて展開</button>
    </div>
  </section>
  ${detailSections}
  ${manualOnlyCategories.length > 0 ? `<section><h2>付録: 手動確認カテゴリ</h2><p>自動判定が無い、または対象外のみのカテゴリを付録へ退避しています。</p>${appendixSections}</section>` : ""}
  <section>
    <h2>メタデータ</h2>
    <ul class="bullet-list">
      <li>生成時刻: ${escapeHtml(report.timestamp)}</li>
      <li>実行時間: ${report.executionTimeMs}ms</li>
      <li>プロジェクト: ${escapeHtml(report.projectRoot)}</li>
      <li>品質プロファイル: ${escapeHtml(qualityProfile)}</li>
    </ul>
  </section>
  <script>
    const flaggedOnly = document.getElementById("only-flagged");
    const flaggedVerdicts = new Set(["fail", "warn"]);
    flaggedOnly.addEventListener("change", () => {
      const active = flaggedOnly.checked;
      for (const category of document.querySelectorAll("section.category")) {
        category.hidden = active && !flaggedVerdicts.has(category.dataset.verdict);
      }
      for (const row of document.querySelectorAll("tr[data-verdict]")) {
        row.hidden = active && !flaggedVerdicts.has(row.dataset.verdict);
      }
      for (const card of document.querySelectorAll(".metric-card[data-verdict]")) {
        card.hidden = active && !flaggedVerdicts.has(card.dataset.verdict);
      }
    });
    document.getElementById("collapse-all").addEventListener("click", () => {
      for (const detail of document.querySelectorAll("section.category > details")) detail.open = false;
    });
    document.getElementById("expand-all").addEventListener("click", () => {
      for (const detail of document.querySelectorAll("section.category > details")) detail.open = true;
    });
  </script>
</body>
</html>`;
}

export function buildBaselineComparisonLine(ctx: QualityRenderContext, report: QualityReport): string {
  const context = ctx.gateContext;
  if (!context?.baselinePath) {
    return "- 前回比: N/A（ベースライン未設定）";
  }
  const baselineLabel = context.baselineOverallVerdict ? verdictBadge(context.baselineOverallVerdict) : "不明";
  const currentLabel = verdictBadge(report.summary.overallVerdict);
  return `- 前回比: ${baselineLabel} → ${currentLabel}（悪化 ${context.regressedCount ?? 0} 件 / 改善 ${context.improvedCount ?? 0} 件、ベースライン: ${ctx.toDisplayPath(context.baselinePath)}）`;
}

export function buildGateVerdictLines(ctx: QualityRenderContext): string[] {
  const context = ctx.gateContext;
  if (!context || context.mode !== "gate") {
    return [];
  }
  if (context.gateVerdict !== "fail") {
    return ["- **ゲート判定: ○ PASS**（自動FAILなし、ベースライン悪化なし）"];
  }

  const lines = [
    `- **ゲート判定: × FAIL**（自動FAIL ${context.failingAutomaticMetrics.length} 件 / ベースライン悪化 ${context.blockingRegressions.length} 件、終了コード 2）`,
  ];
  for (const offender of context.failingAutomaticMetrics.slice(0, 5)) {
    lines.push(`  - 阻害: ${offender.category} / ${offender.label} — 実績 ${offender.actual}（基準 ${offender.threshold}）`);
  }
  for (const regression of context.blockingRegressions.slice(0, 5)) {
    lines.push(`  - 悪化: ${regression.category} / ${regression.label} — ${regression.baselineVerdict} → ${regression.currentVerdict} ↘`);
  }
  const hiddenCount = Math.max(0, context.failingAutomaticMetrics.length - 5) + Math.max(0, context.blockingRegressions.length - 5);
  if (hiddenCount > 0) {
    lines.push(`  - ほか ${hiddenCount} 件は観点別詳細を参照`);
  }
  return lines;
}
