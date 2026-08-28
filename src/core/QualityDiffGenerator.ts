import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  QualityCategoryDiffReport,
  QualityCategoryId,
  QualityDiffReport,
  QualityDiffStatus,
  QualityDiffTrend,
  QualityMetricDiffEntry,
  QualityMetricReport,
  QualityReport,
  QualityVerdict,
} from "../types/index.js";

type QualityDiffOutputFormat = "json" | "markdown" | "csv" | "html" | "all";

export class QualityDiffGenerator {
  compare(
    current: QualityReport,
    baseline: QualityReport,
    baselinePath: string,
    currentPath: string,
  ): QualityDiffReport {
    const currentMetrics = this.buildMetricMap(current);
    const baselineMetrics = this.buildMetricMap(baseline);
    const metricKeys = Array.from(new Set([...currentMetrics.keys(), ...baselineMetrics.keys()])).sort();
    const metrics = metricKeys.map((key) => this.compareMetric(currentMetrics.get(key), baselineMetrics.get(key)));

    const currentCategories = new Map(current.categories.map((category) => [category.id, category]));
    const baselineCategories = new Map(baseline.categories.map((category) => [category.id, category]));
    const categoryOrder = Array.from(new Set<QualityCategoryId>([
      ...baseline.categories.map((category) => category.id),
      ...current.categories.map((category) => category.id),
    ]));
    const categories = categoryOrder.map((categoryId) =>
      this.compareCategory(
        categoryId,
        currentCategories.get(categoryId),
        baselineCategories.get(categoryId),
        metrics.filter((metric) => metric.category === categoryId),
      )
    );
    const primaryMetrics = metrics.filter((metric) => this.isPrimaryDiffMetric(metric));

    return {
      generatedAt: new Date().toISOString(),
      baselinePath,
      currentPath,
      baselineTimestamp: baseline.timestamp,
      currentTimestamp: current.timestamp,
      summary: {
        baselineOverallVerdict: baseline.summary.overallVerdict,
        currentOverallVerdict: current.summary.overallVerdict,
        changedCategories: categories.filter((category) => category.status !== "unchanged").length,
        changedMetrics: primaryMetrics.filter((metric) => metric.status !== "unchanged").length,
        improvedMetrics: primaryMetrics.filter((metric) => metric.trend === "improved").length,
        regressedMetrics: primaryMetrics.filter((metric) => metric.trend === "regressed").length,
        automaticRegressions: primaryMetrics.filter((metric) =>
          metric.trend === "regressed" && metric.currentAutomation === "automatic"
        ).length,
        manualRegressions: primaryMetrics.filter((metric) =>
          metric.trend === "regressed" && metric.currentAutomation === "manual"
        ).length,
        addedMetrics: primaryMetrics.filter((metric) => metric.status === "added").length,
        removedMetrics: primaryMetrics.filter((metric) => metric.status === "removed").length,
        unchangedMetrics: primaryMetrics.filter((metric) => metric.status === "unchanged").length,
      },
      categories,
      metrics,
    };
  }

  async writeReports(
    diff: QualityDiffReport,
    outputDir: string,
    prefix: string,
    formats: QualityDiffOutputFormat[],
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });
    const effectiveFormats = this.resolveFormats(formats);

    if (effectiveFormats.includes("json")) {
      await fs.writeFile(path.join(outputDir, `${prefix}_quality_diff.json`), JSON.stringify(diff, null, 2), "utf8");
    }
    if (effectiveFormats.includes("markdown")) {
      await fs.writeFile(path.join(outputDir, `${prefix}_quality_diff.md`), this.toMarkdown(diff), "utf8");
    }
    if (effectiveFormats.includes("html")) {
      await fs.writeFile(path.join(outputDir, `${prefix}_quality_diff.html`), this.toHtml(diff), "utf8");
    }
  }

  private resolveFormats(formats: QualityDiffOutputFormat[]): Array<"json" | "markdown" | "html"> {
    if (formats.includes("all")) {
      return ["json", "markdown", "html"];
    }

    const filtered = formats.filter((format): format is "json" | "markdown" | "html" => format !== "all" && format !== "csv");
    return filtered.length > 0 ? filtered : ["json", "markdown", "html"];
  }

  private buildMetricMap(report: QualityReport): Map<string, QualityMetricReport> {
    return new Map(report.categories.flatMap((category) =>
      category.metrics.map((metric) => [`${category.id}:${metric.id}`, metric] as const)
    ));
  }

  private compareMetric(current?: QualityMetricReport, baseline?: QualityMetricReport): QualityMetricDiffEntry {
    const metric = current ?? baseline;
    if (!metric) {
      throw new Error("Quality diff comparison encountered an empty metric pair.");
    }

    const changes: string[] = [];
    if ((baseline?.verdict ?? undefined) !== (current?.verdict ?? undefined)) {
      changes.push(`verdict: ${baseline?.verdict ?? "none"} -> ${current?.verdict ?? "none"}`);
    }
    if ((baseline?.actual ?? undefined) !== (current?.actual ?? undefined)) {
      changes.push(`actual: ${baseline?.actual ?? "none"} -> ${current?.actual ?? "none"}`);
    }
    if ((baseline?.threshold ?? undefined) !== (current?.threshold ?? undefined)) {
      changes.push(`threshold: ${baseline?.threshold ?? "none"} -> ${current?.threshold ?? "none"}`);
    }
    if ((baseline?.automation ?? undefined) !== (current?.automation ?? undefined)) {
      changes.push(`automation: ${baseline?.automation ?? "none"} -> ${current?.automation ?? "none"}`);
    }
    if ((baseline?.aggregation ?? undefined) !== (current?.aggregation ?? undefined)) {
      changes.push(`aggregation: ${baseline?.aggregation ?? "none"} -> ${current?.aggregation ?? "none"}`);
    }
    if ((baseline?.summary ?? undefined) !== (current?.summary ?? undefined)) {
      changes.push("summary updated");
    }

    for (const evidenceChange of this.diffStrings(
      this.serializeEvidence(current?.evidence ?? []),
      this.serializeEvidence(baseline?.evidence ?? []),
    )) {
      changes.push(`evidence ${evidenceChange}`);
    }

    const status = current && !baseline
      ? "added"
      : !current && baseline
        ? "removed"
        : changes.length > 0
          ? "changed"
          : "unchanged";

    const categoryId = current?.category ?? baseline?.category;
    if (!categoryId) {
      throw new Error(`Quality diff metric ${metric.id} has no category.`);
    }

    return {
      id: metric.id,
      category: categoryId,
      categoryLabel: this.resolveCategoryLabel(current, baseline),
      label: current?.label ?? baseline?.label ?? metric.id,
      baselineAggregation: baseline?.aggregation,
      currentAggregation: current?.aggregation,
      status,
      trend: this.calculateTrend(current, baseline),
      baselineActual: baseline?.actual,
      currentActual: current?.actual,
      baselineThreshold: baseline?.threshold,
      currentThreshold: current?.threshold,
      baselineVerdict: baseline?.verdict,
      currentVerdict: current?.verdict,
      baselineAutomation: baseline?.automation,
      currentAutomation: current?.automation,
      baselineSummary: baseline?.summary,
      currentSummary: current?.summary,
      changes,
    };
  }

  private compareCategory(
    categoryId: QualityCategoryId,
    current: QualityReport["categories"][number] | undefined,
    baseline: QualityReport["categories"][number] | undefined,
    metrics: QualityMetricDiffEntry[],
  ): QualityCategoryDiffReport {
    const changedMetrics = metrics.filter((metric) => metric.status !== "unchanged").length;
    const status: QualityDiffStatus = current && !baseline
      ? "added"
      : !current && baseline
        ? "removed"
        : changedMetrics > 0 || current?.verdict !== baseline?.verdict
          ? "changed"
          : "unchanged";

    return {
      id: categoryId,
      label: current?.label ?? baseline?.label ?? categoryId,
      status,
      baselineVerdict: baseline?.verdict,
      currentVerdict: current?.verdict,
      changedMetrics,
      improvedMetrics: metrics.filter((metric) => metric.trend === "improved").length,
      regressedMetrics: metrics.filter((metric) => metric.trend === "regressed").length,
      addedMetrics: metrics.filter((metric) => metric.status === "added").length,
      removedMetrics: metrics.filter((metric) => metric.status === "removed").length,
      unchangedMetrics: metrics.filter((metric) => metric.status === "unchanged").length,
    };
  }

  private calculateTrend(current?: QualityMetricReport, baseline?: QualityMetricReport): QualityDiffTrend {
    if (!current || !baseline) {
      return "neutral";
    }

    // 実測できていた指標が manual (証跡待ち) に落ちるのは証跡の喪失であり、
    // verdictScore 上は良化に見えても悪化として扱う
    if (baseline.verdict !== "manual" && current.verdict === "manual") {
      return "regressed";
    }

    const currentScore = this.verdictScore(current.verdict);
    const baselineScore = this.verdictScore(baseline.verdict);

    if (currentScore < baselineScore) {
      return "improved";
    }
    if (currentScore > baselineScore) {
      return "regressed";
    }

    // 判定が同じでも warn / fail に留まったままの数値変化は方向で判定する。
    // 「FAIL のまま少しずつ腐る」リグレッションを neutral にしない。
    if (current.verdict === "warn" || current.verdict === "fail") {
      const direction = this.compareActualDirection(current, baseline);
      if (direction === "worse") {
        return "regressed";
      }
      if (direction === "better") {
        return "improved";
      }
    }
    return "neutral";
  }

  private compareActualDirection(
    current: QualityMetricReport,
    baseline: QualityMetricReport,
  ): "worse" | "better" | "same" | "unknown" {
    const currentValue = this.parseLeadingNumber(current.actual);
    const baselineValue = this.parseLeadingNumber(baseline.actual);
    if (currentValue === null || baselineValue === null) {
      return "unknown";
    }
    if (currentValue === baselineValue) {
      return "same";
    }

    const higherIsBetter = this.isHigherBetterThreshold(current.threshold || baseline.threshold || "");
    if (higherIsBetter === null) {
      return "unknown";
    }
    const improved = higherIsBetter ? currentValue > baselineValue : currentValue < baselineValue;
    return improved ? "better" : "worse";
  }

  private parseLeadingNumber(value: string | undefined): number | null {
    if (!value) {
      return null;
    }
    const match = /^\s*(-?\d+(?:\.\d+)?)/u.exec(value);
    return match?.[1] !== undefined ? Number.parseFloat(match[1]) : null;
  }

  private isHigherBetterThreshold(threshold: string): boolean | null {
    if (/>=?/u.test(threshold)) {
      return true;
    }
    if (/<=?/u.test(threshold)) {
      return false;
    }
    if (/^\s*100%/u.test(threshold)) {
      return true;
    }
    if (/^\s*\d+(?:\.\d+)?\s*$/u.test(threshold)) {
      return false;
    }
    return null;
  }

  private verdictScore(verdict: QualityVerdict): number {
    switch (verdict) {
      case "pass":
      case "not_applicable":
        return 0;
      case "partial":
        return 1;
      case "manual":
        return 2;
      case "warn":
        return 3;
      case "fail":
        return 4;
    }
  }

  private resolveCategoryLabel(
    current: QualityMetricReport | undefined,
    baseline: QualityMetricReport | undefined,
  ): string {
    return this.categoryLabel(current?.category ?? baseline?.category);
  }

  private isPrimaryDiffMetric(metric: QualityMetricDiffEntry): boolean {
    return (metric.currentAggregation ?? metric.baselineAggregation ?? "primary") === "primary";
  }

  private categoryLabel(categoryId?: QualityCategoryId): string {
    switch (categoryId) {
      case "functional":
        return "機能品質";
      case "uiux":
        return "UI/UX品質";
      case "accessibility":
        return "アクセシビリティ品質";
      case "performance":
        return "パフォーマンス品質";
      case "code":
        return "コード品質";
      case "test":
        return "テスト品質";
      case "api":
        return "API連携品質";
      case "security":
        return "セキュリティ品質";
      case "i18n":
        return "国際化（i18n）品質";
      case "operations":
        return "運用・保守性";
      case "build":
        return "ビルド・デプロイ品質";
      case "dependencies":
        return "依存関係・ライブラリ品質";
      default:
        return "不明";
    }
  }

  private serializeEvidence(evidence: QualityMetricReport["evidence"]): string[] {
    // この文字列は差分検出のキーであると同時にレポートへそのまま表示されるため、
    // 内部形式の連結ではなく人が読める形にする
    return evidence.map((item) => {
      const location = item.filePath && item.filePath !== item.value ? ` (${item.filePath})` : "";
      return `${item.label}: ${item.value}${location}`;
    });
  }

  private diffStrings(current: string[], baseline: string[]): string[] {
    const currentSet = new Set(current);
    const baselineSet = new Set(baseline);
    const added = current.filter((item) => !baselineSet.has(item)).map((item) => `+${item}`);
    const removed = baseline.filter((item) => !currentSet.has(item)).map((item) => `-${item}`);
    return [...added, ...removed];
  }

  private toMarkdown(diff: QualityDiffReport): string {
    const regressions = diff.metrics.filter((metric) => metric.trend === "regressed");
    const changedMetrics = diff.metrics.filter((metric) => metric.status !== "unchanged");

    let markdown = "# React 出荷審査 品質差分レポート\n\n";
    markdown += `- Baseline: ${diff.baselinePath}\n`;
    markdown += `- Current: ${diff.currentPath}\n`;
    markdown += `- Baseline Timestamp: ${diff.baselineTimestamp}\n`;
    markdown += `- Current Timestamp: ${diff.currentTimestamp}\n`;
    markdown += `- Generated At: ${diff.generatedAt}\n\n`;

    markdown += "凡例: 判定 = ○ PASS / △ WARN / × FAIL / ◐ PARTIAL / ― MANUAL、増減 = ↗ 改善 / ↘ 悪化 / → 変化なし\n\n";

    markdown += "## サマリー\n\n";
    markdown += "| baseline判定 | current判定 | 変更カテゴリ | 変更指標 | 改善 ↗ | 悪化 ↘ | 自動悪化 | 手動悪化 |\n";
    markdown += "|---|---|---:|---:|---:|---:|---:|---:|\n";
    markdown += `| ${this.verdictBadge(diff.summary.baselineOverallVerdict)} | ${this.verdictBadge(diff.summary.currentOverallVerdict)} | ${diff.summary.changedCategories} | ${diff.summary.changedMetrics} | ${diff.summary.improvedMetrics} | ${diff.summary.regressedMetrics} | ${diff.summary.automaticRegressions} | ${diff.summary.manualRegressions} |\n\n`;

    markdown += "## 観点差分\n\n";
    markdown += "| 観点 | baseline判定 | current判定 | 状態 | 変更 | 改善 ↗ | 悪化 ↘ |\n";
    markdown += "|---|---|---|---|---:|---:|---:|\n";
    for (const category of diff.categories) {
      markdown += `| ${category.label} | ${this.verdictBadge(category.baselineVerdict)} | ${this.verdictBadge(category.currentVerdict)} | ${this.statusLabel(category.status)} | ${category.changedMetrics} | ${category.improvedMetrics} | ${category.regressedMetrics} |\n`;
    }
    markdown += "\n";

    markdown += "## 悪化指標\n\n";
    if (regressions.length === 0) {
      markdown += "悪化した指標はありません。\n\n";
    } else {
      markdown += "| 観点 | 指標 | baseline判定 | current判定 | 自動/手動 | 変更内容 |\n";
      markdown += "|---|---|---|---|---|---|\n";
      for (const metric of regressions) {
        markdown += `| ${metric.categoryLabel} | ${metric.label} | ${this.verdictBadge(metric.baselineVerdict)} | ${this.verdictBadge(metric.currentVerdict)} | ${this.automationLabel(metric.currentAutomation)} | ${this.formatChanges(metric.changes).join("<br />")} |\n`;
      }
      markdown += "\n";
    }

    markdown += "## 変更指標\n\n";
    if (changedMetrics.length === 0) {
      markdown += "差分はありません。\n";
      return markdown;
    }

    for (const metric of changedMetrics) {
      const visibleChanges = this.formatChanges(metric.changes.slice(0, 5));
      const remainder = metric.changes.length - visibleChanges.length;
      markdown += `- [${this.statusLabel(metric.status)} / ${this.trendBadge(metric.trend)}] ${metric.categoryLabel} / ${metric.label}: ${visibleChanges.join("; ") || "値の変更"}${remainder > 0 ? `; ほか${remainder}件 (JSON 参照)` : ""}\n`;
    }

    return markdown;
  }

  // 判定・増減の表示規則は品質レポート本体と揃える (記号 + 英字、色に依存しない)
  private verdictBadge(verdict?: string): string {
    switch (verdict) {
      case "pass":
        return "○ PASS";
      case "warn":
        return "△ WARN";
      case "fail":
        return "× FAIL";
      case "partial":
        return "◐ PARTIAL";
      case "manual":
        return "― MANUAL";
      case undefined:
        return "なし";
      default:
        return verdict;
    }
  }

  private trendBadge(trend: string): string {
    switch (trend) {
      case "improved":
        return "↗ 改善";
      case "regressed":
        return "↘ 悪化";
      default:
        return "→ 変化なし";
    }
  }

  private statusLabel(status: string): string {
    switch (status) {
      case "added":
        return "追加";
      case "removed":
        return "削除";
      case "changed":
        return "変更";
      default:
        return "変更なし";
    }
  }

  private automationLabel(automation?: string): string {
    switch (automation) {
      case "automatic":
        return "自動";
      case "manual":
        return "手動";
      case undefined:
        return "なし";
      default:
        return automation;
    }
  }

  // JSON に永続化した changes ("verdict: pass -> warn" 等) は互換のため
  // そのまま保持し、表示時のみ矢印を読みやすい表記へ変換する
  private formatChanges(changes: string[]): string[] {
    return changes.map((change) => change.replace(/ -> /gu, " → "));
  }

  private toHtml(diff: QualityDiffReport): string {
    const regressions = diff.metrics.filter((metric) => metric.trend === "regressed");
    const changedMetrics = diff.metrics.filter((metric) => metric.status !== "unchanged");

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>React 出荷審査 品質差分レポート</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
    h1, h2 { margin-bottom: 8px; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; background: white; margin-bottom: 20px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #e2e8f0; }
    .regressed { background: #fee2e2; }
    .improved { background: #dcfce7; }
    .neutral { background: #f8fafc; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #e2e8f0; border-radius: 4px; padding: 0 4px; }
    ul { margin: 0; padding-left: 18px; }
  </style>
</head>
<body>
  <h1>React 出荷審査 品質差分レポート</h1>
  <div class="cards">
    <div class="card"><strong>Baseline</strong><br /><a href="${this.toFileHref(diff.baselinePath)}"><code>${this.escapeHtml(diff.baselinePath)}</code></a></div>
    <div class="card"><strong>Current</strong><br /><a href="${this.toFileHref(diff.currentPath)}"><code>${this.escapeHtml(diff.currentPath)}</code></a></div>
    <div class="card"><strong>総合判定</strong><br />${this.escapeHtml(this.verdictBadge(diff.summary.baselineOverallVerdict))} → ${this.escapeHtml(this.verdictBadge(diff.summary.currentOverallVerdict))}</div>
    <div class="card"><strong>変更 / 悪化 ↘</strong><br />${diff.summary.changedMetrics} / ${diff.summary.regressedMetrics}</div>
  </div>

  <h2>観点差分</h2>
  <table>
    <thead>
      <tr><th>観点</th><th>baseline判定</th><th>current判定</th><th>状態</th><th>変更</th><th>改善 ↗</th><th>悪化 ↘</th></tr>
    </thead>
    <tbody>
      ${diff.categories.map((category) =>
        `<tr><td>${this.escapeHtml(category.label)}</td><td>${this.escapeHtml(this.verdictBadge(category.baselineVerdict))}</td><td>${this.escapeHtml(this.verdictBadge(category.currentVerdict))}</td><td>${this.escapeHtml(this.statusLabel(category.status))}</td><td>${category.changedMetrics}</td><td>${category.improvedMetrics}</td><td>${category.regressedMetrics}</td></tr>`
      ).join("")}
    </tbody>
  </table>

  <h2>悪化指標</h2>
  ${regressions.length === 0
    ? "<p>悪化した指標はありません。</p>"
    : `<table><thead><tr><th>観点</th><th>指標</th><th>baseline判定</th><th>current判定</th><th>自動/手動</th><th>変更内容</th></tr></thead><tbody>${
      regressions.map((metric) =>
        `<tr class="regressed"><td>${this.escapeHtml(metric.categoryLabel)}</td><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(this.verdictBadge(metric.baselineVerdict))}</td><td>${this.escapeHtml(this.verdictBadge(metric.currentVerdict))}</td><td>${this.escapeHtml(this.automationLabel(metric.currentAutomation))}</td><td>${this.escapeHtml(this.formatChanges(metric.changes).join("; "))}</td></tr>`
      ).join("")
    }</tbody></table>`}

  <h2>変更指標</h2>
  ${changedMetrics.length === 0
    ? "<p>差分はありません。</p>"
    : `<table><thead><tr><th>観点</th><th>指標</th><th>状態</th><th>増減</th><th>変更内容</th></tr></thead><tbody>${
      changedMetrics.map((metric) =>
        `<tr class="${this.escapeHtml(metric.trend)}"><td>${this.escapeHtml(metric.categoryLabel)}</td><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(this.statusLabel(metric.status))}</td><td>${this.escapeHtml(this.trendBadge(metric.trend))}</td><td>${this.escapeHtml(this.formatChanges(metric.changes).join("; "))}</td></tr>`
      ).join("")
    }</tbody></table>`}
</body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private toFileHref(filePath: string): string {
    return pathToFileURL(path.resolve(filePath)).href;
  }
}
