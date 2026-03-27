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
      trend: this.calculateTrend(current?.verdict, baseline?.verdict),
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

  private calculateTrend(current?: QualityVerdict, baseline?: QualityVerdict): QualityDiffTrend {
    if (!current || !baseline) {
      return "neutral";
    }

    const currentScore = this.verdictScore(current);
    const baselineScore = this.verdictScore(baseline);

    if (currentScore < baselineScore) {
      return "improved";
    }
    if (currentScore > baselineScore) {
      return "regressed";
    }
    return "neutral";
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
    return evidence.map((item) => `${item.type}:${item.label}:${item.value}:${item.filePath ?? ""}`);
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

    markdown += "## サマリー\n\n";
    markdown += "| baseline判定 | current判定 | 変更カテゴリ | 変更指標 | 改善 | 悪化 | 自動悪化 | 手動悪化 |\n";
    markdown += "|---|---:|---:|---:|---:|---:|---:|---:|\n";
    markdown += `| ${diff.summary.baselineOverallVerdict} | ${diff.summary.currentOverallVerdict} | ${diff.summary.changedCategories} | ${diff.summary.changedMetrics} | ${diff.summary.improvedMetrics} | ${diff.summary.regressedMetrics} | ${diff.summary.automaticRegressions} | ${diff.summary.manualRegressions} |\n\n`;

    markdown += "## 観点差分\n\n";
    markdown += "| 観点 | baseline | current | status | changed | improved | regressed |\n";
    markdown += "|---|---|---|---|---:|---:|---:|\n";
    for (const category of diff.categories) {
      markdown += `| ${category.label} | ${category.baselineVerdict ?? "none"} | ${category.currentVerdict ?? "none"} | ${category.status} | ${category.changedMetrics} | ${category.improvedMetrics} | ${category.regressedMetrics} |\n`;
    }
    markdown += "\n";

    markdown += "## 悪化指標\n\n";
    if (regressions.length === 0) {
      markdown += "悪化した指標はありません。\n\n";
    } else {
      markdown += "| 観点 | 指標 | baseline | current | automation | 変更 |\n";
      markdown += "|---|---|---|---|---|---|\n";
      for (const metric of regressions) {
        markdown += `| ${metric.categoryLabel} | ${metric.label} | ${metric.baselineVerdict ?? "none"} | ${metric.currentVerdict ?? "none"} | ${metric.currentAutomation ?? "none"} | ${metric.changes.join("<br />")} |\n`;
      }
      markdown += "\n";
    }

    markdown += "## 変更指標\n\n";
    if (changedMetrics.length === 0) {
      markdown += "差分はありません。\n";
      return markdown;
    }

    for (const metric of changedMetrics) {
      markdown += `- [${metric.status}/${metric.trend}] ${metric.categoryLabel} / ${metric.label}: ${metric.changes.join("; ") || "value changed"}\n`;
    }

    return markdown;
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
    <div class="card"><strong>Overall Verdict</strong><br />${this.escapeHtml(diff.summary.baselineOverallVerdict)} -> ${this.escapeHtml(diff.summary.currentOverallVerdict)}</div>
    <div class="card"><strong>Changed / Regressed</strong><br />${diff.summary.changedMetrics} / ${diff.summary.regressedMetrics}</div>
  </div>

  <h2>観点差分</h2>
  <table>
    <thead>
      <tr><th>観点</th><th>baseline</th><th>current</th><th>status</th><th>changed</th><th>improved</th><th>regressed</th></tr>
    </thead>
    <tbody>
      ${diff.categories.map((category) =>
        `<tr><td>${this.escapeHtml(category.label)}</td><td>${this.escapeHtml(category.baselineVerdict ?? "none")}</td><td>${this.escapeHtml(category.currentVerdict ?? "none")}</td><td>${this.escapeHtml(category.status)}</td><td>${category.changedMetrics}</td><td>${category.improvedMetrics}</td><td>${category.regressedMetrics}</td></tr>`
      ).join("")}
    </tbody>
  </table>

  <h2>悪化指標</h2>
  ${regressions.length === 0
    ? "<p>悪化した指標はありません。</p>"
    : `<table><thead><tr><th>観点</th><th>指標</th><th>baseline</th><th>current</th><th>automation</th><th>変更</th></tr></thead><tbody>${
      regressions.map((metric) =>
        `<tr class="regressed"><td>${this.escapeHtml(metric.categoryLabel)}</td><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(metric.baselineVerdict ?? "none")}</td><td>${this.escapeHtml(metric.currentVerdict ?? "none")}</td><td>${this.escapeHtml(metric.currentAutomation ?? "none")}</td><td>${this.escapeHtml(metric.changes.join("; "))}</td></tr>`
      ).join("")
    }</tbody></table>`}

  <h2>変更指標</h2>
  ${changedMetrics.length === 0
    ? "<p>差分はありません。</p>"
    : `<table><thead><tr><th>観点</th><th>指標</th><th>status</th><th>trend</th><th>変更</th></tr></thead><tbody>${
      changedMetrics.map((metric) =>
        `<tr class="${this.escapeHtml(metric.trend)}"><td>${this.escapeHtml(metric.categoryLabel)}</td><td>${this.escapeHtml(metric.label)}</td><td>${this.escapeHtml(metric.status)}</td><td>${this.escapeHtml(metric.trend)}</td><td>${this.escapeHtml(metric.changes.join("; "))}</td></tr>`
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
