import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AnalysisDiffReport,
  GraphJSON,
  GraphNode,
  HotSpotReportItem,
  PersistedAnalysisReport,
  PersistedFileReport,
} from "../types/index.js";

export interface DiffRenderOptions {
  projectRoot?: string;
  impactScoreThreshold?: number;
}

const IMPACT_REASON_LABELS: Record<string, string> = {
  changed: "変更ファイル",
  "adjacent-to-change": "変更に隣接",
  "within-2-hops": "変更から2ホップ以内",
  "high-fan-in": "被依存が多い",
  "high-fan-out": "依存が多い",
};

export class DiffGenerator {
  compare(
    rawCurrent: PersistedAnalysisReport,
    rawBaseline: PersistedAnalysisReport,
    baselinePath: string,
    currentPath: string,
    options: { projectRoot?: string } = {},
  ): AnalysisDiffReport {
    // 旧形式 (絶対パス) の baseline は projectRoot 相対へ正規化してから比較する
    const current = this.normalizePersistedReport(rawCurrent, options.projectRoot);
    const baseline = this.normalizePersistedReport(rawBaseline, options.projectRoot);
    const currentFiles = new Map(current.files.map((file) => [file.path, file]));
    const baselineFiles = new Map(baseline.files.map((file) => [file.path, file]));
    const allPaths = Array.from(new Set([...currentFiles.keys(), ...baselineFiles.keys()])).sort();

    const files = allPaths.map((filePath) => this.compareFile(filePath, currentFiles.get(filePath), baselineFiles.get(filePath)));
    const summary = {
      addedFiles: files.filter((file) => file.status === "added").length,
      removedFiles: files.filter((file) => file.status === "removed").length,
      changedFiles: files.filter((file) => file.status === "changed").length,
      unchangedFiles: files.filter((file) => file.status === "unchanged").length,
      complexityDelta: current.statistics.averageComplexity - baseline.statistics.averageComplexity,
      dependencyDelta: current.graph.totalDependencies - baseline.graph.totalDependencies,
    };

    return {
      generatedAt: new Date().toISOString(),
      baselinePath,
      currentPath,
      summary,
      graphDelta: {
        cycleDelta: (current.graph.cycles?.length ?? 0) - (baseline.graph.cycles?.length ?? 0),
        dependencyDelta: current.graph.totalDependencies - baseline.graph.totalDependencies,
        externalDependencyDelta: (current.graph.externalDependencies ?? 0) - (baseline.graph.externalDependencies ?? 0),
        warningDelta: this.diffStrings(current.graph.warnings ?? [], baseline.graph.warnings ?? []),
      },
      hotSpotDelta: this.buildHotSpotDelta(current, baseline),
      impact: this.buildImpactSection(
        files.filter((file) => file.status !== "unchanged").map((file) => file.path),
        current.files,
        baseline.files,
        current.graphJson,
        baseline.graphJson,
      ),
      files,
    };
  }

  private normalizePersistedReport(report: PersistedAnalysisReport, fallbackRoot?: string): PersistedAnalysisReport {
    const root = report.projectRoot ?? (fallbackRoot ? path.resolve(fallbackRoot) : undefined);
    const hasAbsolutePaths = report.files.some((file) => path.isAbsolute(file.path));
    if (!root || !hasAbsolutePaths) {
      return report;
    }

    const rel = (filePath: string): string => {
      if (!path.isAbsolute(filePath)) {
        return filePath.split(path.sep).join("/");
      }
      const relative = path.relative(root, filePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return filePath.split(path.sep).join("/");
      }
      return relative.split(path.sep).join("/");
    };

    return {
      ...report,
      files: report.files.map((file) => ({ ...file, path: rel(file.path) })),
      graphJson: report.graphJson
        ? {
            nodes: report.graphJson.nodes.map((node) => ({ ...node, id: rel(node.id) })),
            edges: report.graphJson.edges.map((edge) => ({ ...edge, source: rel(edge.source), target: rel(edge.target) })),
          }
        : undefined,
      decisionSummary: report.decisionSummary
        ? {
            ...report.decisionSummary,
            topHotSpots: report.decisionSummary.topHotSpots.map((item) => ({ ...item, path: rel(item.path) })),
          }
        : undefined,
    };
  }

  async writeReports(
    diff: AnalysisDiffReport,
    outputDir: string,
    prefix: string,
    options: DiffRenderOptions = {},
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.json`), JSON.stringify(diff, null, 2), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.md`), this.toMarkdown(diff, options), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_diff.html`), this.toHtml(diff, options), "utf8");
  }

  private compareFile(pathname: string, current?: PersistedFileReport, baseline?: PersistedFileReport) {
    if (current && !baseline) {
      return {
        path: pathname,
        status: "added" as const,
        complexityDelta: current.complexity.overallComplexity,
        dependencyDelta: current.dependencies.length,
        warningDelta: current.warnings.map((warning) => `+${warning}`),
      };
    }

    if (!current && baseline) {
      return {
        path: pathname,
        status: "removed" as const,
        complexityDelta: -baseline.complexity.overallComplexity,
        dependencyDelta: -baseline.dependencies.length,
        warningDelta: baseline.warnings.map((warning) => `-${warning}`),
      };
    }

    const complexityDelta = (current?.complexity.overallComplexity ?? 0) - (baseline?.complexity.overallComplexity ?? 0);
    const dependencyDelta = (current?.dependencies.length ?? 0) - (baseline?.dependencies.length ?? 0);
    const warningDelta = this.diffStrings(current?.warnings ?? [], baseline?.warnings ?? []);
    const status = complexityDelta !== 0 || dependencyDelta !== 0 || warningDelta.length > 0
      ? "changed" as const
      : "unchanged" as const;

    return {
      path: pathname,
      status,
      complexityDelta,
      dependencyDelta,
      warningDelta,
    };
  }

  private diffStrings(current: string[], baseline: string[]): string[] {
    const currentSet = new Set(current);
    const baselineSet = new Set(baseline);
    const added = current.filter((item) => !baselineSet.has(item)).map((item) => `+${item}`);
    const removed = baseline.filter((item) => !currentSet.has(item)).map((item) => `-${item}`);
    return [...added, ...removed];
  }

  private toMarkdown(diff: AnalysisDiffReport, options: DiffRenderOptions = {}): string {
    const display = (filePath: string): string => this.toRenderDisplayPath(filePath, options.projectRoot);
    const changedFiles = diff.files.filter((file) => file.status !== "unchanged");
    const threshold = options.impactScoreThreshold ?? 0;
    const violations = threshold > 0
      ? diff.impact.prioritizedFiles.filter((item) => item.score >= threshold)
      : [];
    const maxScore = diff.impact.prioritizedFiles.reduce((max, item) => Math.max(max, item.score), 0);
    const statusLabel: Record<string, string> = { added: "追加", removed: "削除", changed: "変更" };

    let markdown = "# 差分レポート（baseline 比較）\n\n";
    markdown += `${this.buildImpactVerdictLine(diff, violations.length, threshold, maxScore)}\n`;
    markdown += `- 変更ファイル: 追加 ${diff.summary.addedFiles} / 削除 ${diff.summary.removedFiles} / 変更 ${diff.summary.changedFiles} / 変更なし ${diff.summary.unchangedFiles}\n`;
    markdown += `- 平均複雑度差分: ${this.formatSigned(diff.summary.complexityDelta, 2)}\n`;
    markdown += `- 依存総数差分: ${this.formatDependencyDelta(diff)}\n`;
    markdown += `- baseline: ${display(diff.baselinePath)}\n`;
    markdown += `- 生成時刻: ${diff.generatedAt}\n\n`;
    markdown += "score は「変更ファイルからの距離・被依存数・複雑度の変化」を合成した影響度です。`--impact-threshold`（CI 既定 60）以上を要注意とみなします。\n\n";

    markdown += "## グラフ差分\n\n";
    markdown += `- 循環依存差分: ${this.formatSigned(diff.graphDelta.cycleDelta)}\n`;
    markdown += `- 依存総数差分: ${this.formatDependencyDelta(diff)}\n`;
    if (diff.graphDelta.warningDelta.length > 0) {
      markdown += `- 警告差分:\n${diff.graphDelta.warningDelta.map((warning) => `  - ${warning}`).join("\n")}\n\n`;
    } else {
      markdown += "- 警告差分: なし\n\n";
    }

    markdown += "## Hot Spot 差分\n\n";
    markdown += `- 変動 ${diff.hotSpotDelta.changed.length} 件 / 新規 ${diff.hotSpotDelta.added.length} 件 / 解消 ${diff.hotSpotDelta.removed.length} 件\n\n`;
    if (diff.hotSpotDelta.changed.length > 0) {
      markdown += "### 変動した Hot Spot\n\n";
      markdown += "| ファイル | scoreΔ | 複雑度Δ | 依存Δ | anyΔ | クラスタ | 内訳変化 |\n";
      markdown += "|----------|--------|---------|-------|------|----------|----------|\n";
      for (const item of diff.hotSpotDelta.changed.slice(0, 10)) {
        const drivers = (item.complexityDriverDelta?.length ?? 0) > 0 ? `drivers=${item.complexityDriverDelta!.join(", ")}` : "—";
        markdown += `| ${item.currentDisplayPath} | ${this.formatSigned(item.scoreDelta)} | ${this.formatSigned(item.complexityDelta)} | ${this.formatSigned(item.dependencyDelta)} | ${this.formatSigned(item.anyDelta)} | ${item.clusterBefore}->${item.clusterAfter} | ${drivers} |\n`;
      }
      markdown += "\n";
    }
    if (diff.hotSpotDelta.added.length > 0) {
      markdown += "### 新たに Hot Spot 入り\n\n";
      for (const item of diff.hotSpotDelta.added.slice(0, 10)) {
        markdown += `- ${item.displayPath} score=${item.score} クラスタ=${item.cluster}\n`;
        if ((item.complexityDrivers?.length ?? 0) > 0) {
          markdown += `  drivers=${item.complexityDrivers!.join(", ")}\n`;
        }
      }
      markdown += "\n";
    }
    if (diff.hotSpotDelta.removed.length > 0) {
      markdown += "### Hot Spot 解消\n\n";
      for (const item of diff.hotSpotDelta.removed.slice(0, 10)) {
        markdown += `- ${item.displayPath} score=${item.score} クラスタ=${item.cluster}\n`;
      }
      markdown += "\n";
    }

    markdown += "## 影響範囲\n\n";
    markdown += `- 変更ファイル ${diff.impact.changedFiles.length} 件から、${diff.impact.impactedFiles.length} 件への波及を検出しました。\n`;
    markdown += "- 波及先の全一覧は JSON レポートの `impact.impactedFiles` を参照してください。\n\n";
    if (diff.impact.prioritizedFiles.length > 0) {
      markdown += "### 優先対応（影響度スコア順）\n\n";
      markdown += "| ファイル | score | 距離 | 被依存 | 依存 | 複雑度圧 | 理由 |\n";
      markdown += "|----------|-------|------|--------|------|----------|------|\n";
      for (const item of diff.impact.prioritizedFiles.slice(0, 10)) {
        const reasons = item.reasons.length > 0
          ? item.reasons.map((reason) => IMPACT_REASON_LABELS[reason] ?? reason).join("、")
          : "—";
        markdown += `| ${display(item.path)} | ${item.score} | ${item.distance} | ${item.inboundDegree} | ${item.outboundDegree} | ${item.complexityPressure} | ${reasons} |\n`;
      }
      markdown += "\n";
    }

    markdown += "## 変更ファイル\n\n";
    if (changedFiles.length === 0) {
      markdown += "ファイル単位の変更はありません。\n";
      return markdown;
    }

    markdown += "| ファイル | 状態 | 複雑度Δ | 依存Δ | 警告差分 |\n";
    markdown += "|----------|------|---------|-------|----------|\n";
    for (const file of changedFiles) {
      const warnings = file.warningDelta.length > 0 ? file.warningDelta.join("、") : "—";
      markdown += `| ${display(file.path)} | ${statusLabel[file.status] ?? file.status} | ${this.formatSigned(file.complexityDelta)} | ${this.formatSigned(file.dependencyDelta)} | ${warnings} |\n`;
    }

    return markdown;
  }

  private formatDependencyDelta(diff: AnalysisDiffReport): string {
    const total = this.formatSigned(diff.graphDelta.dependencyDelta);
    const external = diff.graphDelta.externalDependencyDelta;
    if (external === undefined) {
      return total;
    }
    const internal = diff.graphDelta.dependencyDelta - external;
    return `${total}（内部 ${this.formatSigned(internal)} / 外部 ${this.formatSigned(external)}）`;
  }

  private buildImpactVerdictLine(
    diff: AnalysisDiffReport,
    violationCount: number,
    threshold: number,
    maxScore: number,
  ): string {
    const changeCount = diff.summary.addedFiles + diff.summary.removedFiles + diff.summary.changedFiles;
    if (changeCount === 0) {
      return "- **影響判定: 変更なし** — baseline との差分はありません";
    }
    if (threshold > 0 && violationCount > 0) {
      return `- **影響判定: ⚠ 要注意** — 影響度スコア ${threshold} 以上のファイルが ${violationCount} 件あります（最大 score ${maxScore}）`;
    }
    if (threshold > 0) {
      return `- **影響判定: 問題なし** — 影響度スコアが閾値 ${threshold} を超えるファイルはありません（最大 score ${maxScore}）`;
    }
    return `- **影響判定**: 最大影響度スコア ${maxScore}（閾値未設定のため参考値）`;
  }

  private formatSigned(value: number, digits = 0): string {
    const formatted = digits > 0 ? value.toFixed(digits) : String(value);
    return value > 0 ? `+${formatted}` : formatted;
  }

  private toRenderDisplayPath(filePath: string, projectRoot?: string): string {
    const normalized = filePath.split(path.sep).join("/");
    if (!projectRoot || !path.isAbsolute(filePath)) {
      return normalized;
    }
    const relative = path.relative(projectRoot, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return normalized;
    }
    return relative.split(path.sep).join("/");
  }

  private toHtml(diff: AnalysisDiffReport, options: DiffRenderOptions = {}): string {
    const toAbsolute = (filePath: string): string =>
      options.projectRoot && !path.isAbsolute(filePath) ? path.join(options.projectRoot, filePath) : filePath;
    const changedSet = new Set(diff.impact.changedFiles);
    const impactedSet = new Set(diff.impact.impactedFiles);
    const threshold = options.impactScoreThreshold ?? 0;
    const violations = threshold > 0
      ? diff.impact.prioritizedFiles.filter((item) => item.score >= threshold)
      : [];
    const maxScore = diff.impact.prioritizedFiles.reduce((max, item) => Math.max(max, item.score), 0);
    const verdictText = this.buildImpactVerdictLine(diff, violations.length, threshold, maxScore)
      .replace(/^[-\s]*/u, "")
      .replace(/\*\*/gu, "");
    const rows = diff.files
      .filter((file) => file.status !== "unchanged")
      .map((file) => {
        const warningDelta = file.warningDelta.length > 0 ? file.warningDelta.join(", ") : "";
        return `<tr class="${file.status}" data-file="${this.escapeHtml(file.path)}"><td><a href="${this.toFileHref(toAbsolute(file.path))}">${this.escapeHtml(this.toRenderDisplayPath(file.path, options.projectRoot))}</a></td><td>${file.status}</td><td>${file.complexityDelta}</td><td>${file.dependencyDelta}</td><td>${this.escapeHtml(warningDelta)}</td></tr>`;
      })
      .join("\n");
    const warningDelta = diff.graphDelta.warningDelta.length > 0
      ? diff.graphDelta.warningDelta.map((warning) => `<li>${this.escapeHtml(warning)}</li>`).join("")
      : "<li>Warning Delta: none</li>";
    const hotSpotChanged = diff.hotSpotDelta.changed.length > 0
      ? `<ul>${diff.hotSpotDelta.changed.slice(0, 10).map((item) =>
        `<li><a href="${this.toFileHref(toAbsolute(item.path))}">${this.escapeHtml(item.currentDisplayPath)}</a> scoreDelta=${item.scoreDelta} complexityDelta=${item.complexityDelta} dependencyDelta=${item.dependencyDelta} anyDelta=${item.anyDelta} cluster=${this.escapeHtml(item.clusterBefore)}-&gt;${this.escapeHtml(item.clusterAfter)}${this.renderHtmlDriverMeta(item.complexityDriverDelta)}</li>`
      ).join("")}</ul>`
      : "<p>No changed hot spots.</p>";
    const hotSpotAdded = diff.hotSpotDelta.added.length > 0
      ? `<ul>${diff.hotSpotDelta.added.slice(0, 10).map((item) =>
        `<li><a href="${this.toFileHref(toAbsolute(item.path))}">${this.escapeHtml(item.displayPath)}</a> score=${item.score} cluster=${this.escapeHtml(item.cluster)}${this.renderHtmlDriverMeta(item.complexityDrivers)}</li>`
      ).join("")}</ul>`
      : "<p>No added hot spots.</p>";
    const hotSpotRemoved = diff.hotSpotDelta.removed.length > 0
      ? `<ul>${diff.hotSpotDelta.removed.slice(0, 10).map((item) =>
        `<li><a href="${this.toFileHref(toAbsolute(item.path))}">${this.escapeHtml(item.displayPath)}</a> score=${item.score} cluster=${this.escapeHtml(item.cluster)}${this.renderHtmlDriverMeta(item.complexityDrivers)}</li>`
      ).join("")}</ul>`
      : "<p>No removed hot spots.</p>";
    const impactGraph = JSON.stringify(diff.impact.graph).replace(/</gu, "\\u003c");
    const subtreeData = JSON.stringify(diff.impact.subtrees).replace(/</gu, "\\u003c");
    const subtreeMetricsData = JSON.stringify(diff.impact.subtrees).replace(/</gu, "\\u003c");
    const prioritizedData = JSON.stringify(diff.impact.prioritizedFiles).replace(/</gu, "\\u003c");
    const focusOptions = [
      `<option value="__all__">All Changed Files</option>`,
      ...diff.impact.subtrees.map((subtree) =>
        `<option value="${this.escapeHtml(subtree.root)}">${this.escapeHtml(subtree.root)}</option>`
      ),
    ].join("");
    const impactedList = diff.impact.impactedFiles.length > 0
      ? `<div id="impact-priority"></div>`
      : "<p>No impacted files.</p>";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Analysis Diff Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; background: #f8fafc; }
    h1, h2 { margin-bottom: 8px; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #e2e8f0; }
    tr.added { background: #dcfce7; }
    tr.removed { background: #fee2e2; }
    tr.changed { background: #fef3c7; }
    #impact-shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; margin: 20px 0 24px; }
    #impact-graph { min-height: 420px; border: 1px solid #cbd5e1; border-radius: 8px; background: white; overflow: hidden; }
    #impact-list { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    #impact-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    #impact-toolbar select { border: 1px solid #94a3b8; border-radius: 6px; padding: 6px 8px; background: white; }
    #subtree-metrics { margin: 0 0 24px; background: white; border-radius: 8px; overflow: hidden; }
    .impact-entry { border-top: 1px solid #e2e8f0; padding: 10px 0; }
    .impact-entry:first-child { border-top: 0; padding-top: 0; }
    .impact-score { display: inline-block; min-width: 48px; font-weight: 700; color: #0f766e; }
    .impact-meta { color: #475569; font-size: 12px; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #e2e8f0; border-radius: 4px; padding: 0 4px; }
    ul { margin: 0; padding-left: 18px; }
  </style>
</head>
<body>
  <h1>Analysis Diff Report</h1>
  <div class="card" style="margin-bottom:16px;font-weight:600">${this.escapeHtml(verdictText)}</div>
  <div class="meta">
    <div class="card"><strong>Baseline</strong><br /><code>${this.escapeHtml(diff.baselinePath)}</code></div>
    <div class="card"><strong>Current</strong><br /><a href="${this.toFileHref(toAbsolute(diff.currentPath))}"><code>${this.escapeHtml(diff.currentPath)}</code></a></div>
    <div class="card"><strong>Generated At</strong><br />${this.escapeHtml(diff.generatedAt)}</div>
    <div class="card"><strong>Changed Files</strong><br />${diff.summary.changedFiles}</div>
    <div class="card"><strong>Added / Removed</strong><br />${diff.summary.addedFiles} / ${diff.summary.removedFiles}</div>
    <div class="card"><strong>Complexity Delta</strong><br />${diff.summary.complexityDelta.toFixed(2)}</div>
    <div class="card"><strong>Changed Hot Spots</strong><br />${diff.hotSpotDelta.changed.length}</div>
  </div>
  <h2>Graph Delta</h2>
  <ul>
    <li>Cycle Delta: ${diff.graphDelta.cycleDelta}</li>
    <li>Dependency Delta: ${diff.graphDelta.dependencyDelta}</li>
    ${warningDelta}
  </ul>
  <h2>Hot Spot Delta</h2>
  <ul>
    <li>Added Hot Spots: ${diff.hotSpotDelta.added.length}</li>
    <li>Removed Hot Spots: ${diff.hotSpotDelta.removed.length}</li>
    <li>Changed Hot Spots: ${diff.hotSpotDelta.changed.length}</li>
  </ul>
  <h3>Changed Hot Spots</h3>
  ${hotSpotChanged}
  <h3>Added Hot Spots</h3>
  ${hotSpotAdded}
  <h3>Removed Hot Spots</h3>
  ${hotSpotRemoved}
  <h2>Changed Subtree</h2>
  <div id="impact-toolbar">
    <label for="impact-focus">Focus</label>
    <select id="impact-focus">${focusOptions}</select>
    <label for="subtree-sort">Sort subtree by</label>
    <select id="subtree-sort">
      <option value="maxScore">Max Score</option>
      <option value="impactedCount">Impacted Count</option>
      <option value="averageScore">Average Score</option>
      <option value="averageDistance">Average Distance</option>
      <option value="root">Root</option>
    </select>
  </div>
  <table id="subtree-metrics">
    <thead>
      <tr><th>Root</th><th>Impacted</th><th>Max Score</th><th>Average Score</th><th>Average Distance</th><th>Max In</th><th>Max Out</th></tr>
    </thead>
    <tbody id="subtree-metrics-body"></tbody>
  </table>
  <div id="impact-shell">
    <div id="impact-graph"></div>
    <aside id="impact-list">
      <strong>Impacted Files</strong>
      ${impactedList}
    </aside>
  </div>
  <h2>Changed Files</h2>
  <table>
    <thead>
      <tr><th>File</th><th>Status</th><th>Complexity Delta</th><th>Dependency Delta</th><th>Warning Delta</th></tr>
    </thead>
    <tbody>
      ${rows || "<tr><td colspan=\"5\">No changed files.</td></tr>"}
    </tbody>
  </table>
  <script>
    const graphData = ${impactGraph};
    const subtreeData = ${subtreeData};
    const subtreeMetricsData = ${subtreeMetricsData};
    const prioritizedData = ${prioritizedData};
    const changed = new Set(${JSON.stringify(Array.from(changedSet))});
    const impacted = new Set(${JSON.stringify(Array.from(impactedSet))});
    const changedTableRows = Array.from(document.querySelectorAll("tbody tr[data-file]"));
    const host = document.getElementById("impact-graph");
    const priorityHost = document.getElementById("impact-priority");
    const focusSelect = document.getElementById("impact-focus");
    const subtreeSortSelect = document.getElementById("subtree-sort");
    const subtreeMetricsBody = document.getElementById("subtree-metrics-body");
    const SVG_NS = "http://www.w3.org/2000/svg";
    const subtreeMap = new Map(subtreeData.map((item) => [item.root, item]));

    function renderList(visibleIds) {
      if (!priorityHost) return;
      const visible = prioritizedData
        .filter((item) => visibleIds.has(item.path))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
      priorityHost.innerHTML = visible.length === 0
        ? "<p>No impacted files.</p>"
        : visible.map((item) => {
            const reasons = item.reasons.join(", ");
            const complexityPressure = item.complexityPressure > 0 ? ", complexityPressure=" + item.complexityPressure : "";
            return "<div class=\\"impact-entry\\">" +
              "<div><span class=\\"impact-score\\">" + item.score + "</span><a href=\\"" + toHref(item.path) + "\\">" + item.path + "</a></div>" +
              "<div class=\\"impact-meta\\">distance=" + item.distance + ", inbound=" + item.inboundDegree + ", outbound=" + item.outboundDegree + complexityPressure + ", reasons=" + reasons + "</div>" +
            "</div>";
          }).join("");
    }

    function renderGraph(activeGraph) {
      host.innerHTML = "";
      if (!activeGraph.nodes.length) {
        host.innerHTML = "<div style=\\"padding:16px;color:#64748b\\">No impacted graph.</div>";
        return;
      }
      const width = host.clientWidth || 960;
      const height = 420;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      host.appendChild(svg);

      const centerX = width / 2;
      const centerY = height / 2;
      const radiusBase = Math.min(width, height) * 0.28;
      const nodes = activeGraph.nodes.map((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(activeGraph.nodes.length, 1);
        return {
          ...node,
          x: centerX + Math.cos(angle) * (radiusBase + node.outDegree * 8),
          y: centerY + Math.sin(angle) * (radiusBase + node.outDegree * 8),
        };
      });
      const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));
      const colorFor = (id) => changed.has(id) ? "#f59e0b" : impacted.has(id) ? "#93c5fd" : "#cbd5e1";

      for (const edge of activeGraph.edges) {
        const source = nodeById[edge.source];
        const target = nodeById[edge.target];
        if (!source || !target) continue;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
        line.setAttribute("stroke", "#94a3b8");
        line.setAttribute("stroke-opacity", "0.75");
        svg.appendChild(line);
      }

      for (const node of nodes) {
        const group = document.createElementNS(SVG_NS, "g");
        const circle = document.createElementNS(SVG_NS, "circle");
        const label = document.createElementNS(SVG_NS, "text");
        const title = document.createElementNS(SVG_NS, "title");
        circle.setAttribute("cx", String(node.x));
        circle.setAttribute("cy", String(node.y));
        circle.setAttribute("r", String(changed.has(node.id) ? 11 : 8));
        circle.setAttribute("fill", colorFor(node.id));
        circle.setAttribute("stroke", "#0f172a");
        circle.setAttribute("stroke-width", "0.8");
        label.setAttribute("x", String(node.x + 12));
        label.setAttribute("y", String(node.y + 4));
        label.setAttribute("font-size", "11");
        label.textContent = node.id.split("/").pop();
        title.textContent = node.id;
        circle.appendChild(title);
        group.appendChild(circle);
        group.appendChild(label);
        svg.appendChild(group);
      }
    }

    const projectRootForHref = ${this.serializeForHtmlScript(options.projectRoot ?? "")};
    function toHref(filePath) {
      const absolute = projectRootForHref && !filePath.startsWith("/") && !/^[A-Za-z]:/.test(filePath)
        ? projectRootForHref.replace(/[/\\]+$/, "") + "/" + filePath
        : filePath;
      return "file://" + encodeURI(absolute);
    }

    function renderSubtreeMetrics(sortKey) {
      if (!subtreeMetricsBody) return;
      const items = [...subtreeMetricsData].sort((left, right) => {
        if (sortKey === "root") {
          return left.root.localeCompare(right.root);
        }
        if (sortKey === "averageDistance") {
          return left.metrics.averageDistance - right.metrics.averageDistance || left.root.localeCompare(right.root);
        }
        return right.metrics[sortKey] - left.metrics[sortKey] || left.root.localeCompare(right.root);
      });
      subtreeMetricsBody.innerHTML = items.map((item) =>
        "<tr>" +
          "<td><button type=\\"button\\" data-focus-root=\\"" + item.root + "\\">" + item.root + "</button></td>" +
          "<td>" + item.metrics.impactedCount + "</td>" +
          "<td>" + item.metrics.maxScore + "</td>" +
          "<td>" + item.metrics.averageScore.toFixed(1) + "</td>" +
          "<td>" + item.metrics.averageDistance.toFixed(1) + "</td>" +
          "<td>" + item.metrics.maxInboundDegree + "</td>" +
          "<td>" + item.metrics.maxOutboundDegree + "</td>" +
        "</tr>"
      ).join("");
      for (const button of subtreeMetricsBody.querySelectorAll("button[data-focus-root]")) {
        button.addEventListener("click", (event) => {
          const root = event.currentTarget.getAttribute("data-focus-root");
          if (!root) return;
          if (focusSelect) focusSelect.value = root;
          applyFocus(root);
        });
      }
    }

    function filterChangedTable(visibleIds) {
      for (const row of changedTableRows) {
        // visibleIds が null のときは全件表示。行の識別は data-file 属性で行い、
        // 依存グラフにノードが無い変更ファイルも隠さない。
        const filePath = row.getAttribute("data-file") || "";
        row.style.display = visibleIds === null || visibleIds.has(filePath) ? "" : "none";
      }
    }

    function applyFocus(root) {
      if (root === "__all__") {
        renderGraph(graphData);
        renderList(new Set(graphData.nodes.map((node) => node.id)));
        filterChangedTable(null);
        return;
      }
      const subtree = subtreeMap.get(root);
      if (!subtree) {
        renderGraph(graphData);
        renderList(new Set(graphData.nodes.map((node) => node.id)));
        filterChangedTable(null);
        return;
      }
      renderGraph(subtree.graph);
      const visibleIds = new Set(subtree.impactedFiles);
      renderList(visibleIds);
      filterChangedTable(visibleIds);
    }

    if (focusSelect) {
      focusSelect.addEventListener("change", (event) => {
        applyFocus(event.target.value);
      });
    }
    if (subtreeSortSelect) {
      subtreeSortSelect.addEventListener("change", (event) => {
        renderSubtreeMetrics(event.target.value);
      });
    }
    renderSubtreeMetrics("maxScore");
    applyFocus("__all__");
  </script>
</body>
</html>`;
  }

  private buildImpactSection(
    changedFiles: string[],
    currentFiles: PersistedAnalysisReport["files"],
    baselineFiles: PersistedAnalysisReport["files"],
    currentGraph?: PersistedAnalysisReport["graphJson"],
    baselineGraph?: PersistedAnalysisReport["graphJson"],
  ) {
    const currentFilesByPath = new Map(currentFiles.map((file) => [file.path, file]));
    const baselineFilesByPath = new Map(baselineFiles.map((file) => [file.path, file]));
    const currentEdges = currentGraph?.edges ?? [];
    const baselineEdges = baselineGraph?.edges ?? [];
    const combinedNodes = this.mergeNodes(currentGraph?.nodes ?? [], baselineGraph?.nodes ?? []);
    const combinedEdges = this.mergeEdges(currentEdges, baselineEdges);
    const adjacency = this.buildUndirectedAdjacency(combinedEdges);
    const incoming = this.buildDirectedAdjacency(combinedEdges, "target");
    const outgoing = this.buildDirectedAdjacency(combinedEdges, "source");

    const subtrees = changedFiles.map((root) => {
      const impactedFiles = this.collectImpactedForRoot(root, adjacency, 2);
      const prioritizedForRoot = impactedFiles.map((filePath) => {
        const distance = this.computeDistanceToChanged(filePath, [root], adjacency);
        const inboundDegree = incoming.get(filePath)?.size ?? 0;
        const outboundDegree = outgoing.get(filePath)?.size ?? 0;
        const directlyChanged = filePath === root;
        const complexityChange = this.getComplexityChangePressure(
          filePath,
          currentFilesByPath.get(filePath),
          baselineFilesByPath.get(filePath),
        );
        const score = this.computeImpactScore({
          directlyChanged,
          distance,
          inboundDegree,
          outboundDegree,
          complexityPressure: complexityChange.score,
        });
        return {
          score,
          distance,
          inboundDegree,
          outboundDegree,
          complexityPressure: complexityChange.score,
        };
      });
      return {
        root,
        impactedFiles,
        metrics: {
          impactedCount: impactedFiles.length,
          maxScore: prioritizedForRoot.reduce((max, item) => Math.max(max, item.score), 0),
          averageScore: prioritizedForRoot.length > 0
            ? prioritizedForRoot.reduce((sum, item) => sum + item.score, 0) / prioritizedForRoot.length
            : 0,
          averageDistance: prioritizedForRoot.length > 0
            ? prioritizedForRoot.reduce((sum, item) => sum + item.distance, 0) / prioritizedForRoot.length
            : 0,
          maxInboundDegree: prioritizedForRoot.reduce((max, item) => Math.max(max, item.inboundDegree), 0),
          maxOutboundDegree: prioritizedForRoot.reduce((max, item) => Math.max(max, item.outboundDegree), 0),
        },
        graph: this.buildGraphSlice(impactedFiles, combinedNodes, combinedEdges),
      };
    });

    const impactedUnion = new Set<string>(changedFiles);
    for (const subtree of subtrees) {
      for (const file of subtree.impactedFiles) {
        impactedUnion.add(file);
      }
    }

    const prioritizedFiles = Array.from(impactedUnion).map((filePath) => {
      const distance = this.computeDistanceToChanged(filePath, changedFiles, adjacency);
      const inboundDegree = incoming.get(filePath)?.size ?? 0;
      const outboundDegree = outgoing.get(filePath)?.size ?? 0;
      const directlyChanged = changedFiles.includes(filePath);
      const complexityChange = this.getComplexityChangePressure(
        filePath,
        currentFilesByPath.get(filePath),
        baselineFilesByPath.get(filePath),
      );
      const score = this.computeImpactScore({
        directlyChanged,
        distance,
        inboundDegree,
        outboundDegree,
        complexityPressure: complexityChange.score,
      });
      const reasons = this.buildImpactReasons({
        directlyChanged,
        distance,
        inboundDegree,
        outboundDegree,
        complexitySignals: complexityChange.signals,
      });
      return {
        path: filePath,
        score,
        distance,
        inboundDegree,
        outboundDegree,
        directlyChanged,
        complexityPressure: complexityChange.score,
        complexitySignals: complexityChange.signals,
        reasons,
      };
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

    return {
      changedFiles,
      impactedFiles: Array.from(impactedUnion).sort(),
      prioritizedFiles,
      subtrees,
      graph: this.buildGraphSlice(Array.from(impactedUnion), combinedNodes, combinedEdges),
    };
  }

  private buildHotSpotDelta(current: PersistedAnalysisReport, baseline: PersistedAnalysisReport): AnalysisDiffReport["hotSpotDelta"] {
    const currentHotSpots = new Map((current.decisionSummary?.topHotSpots ?? []).map((item) => [item.path, item]));
    const baselineHotSpots = new Map((baseline.decisionSummary?.topHotSpots ?? []).map((item) => [item.path, item]));
    const allPaths = new Set([...currentHotSpots.keys(), ...baselineHotSpots.keys()]);

    const added: HotSpotReportItem[] = [];
    const removed: HotSpotReportItem[] = [];
    const changed: AnalysisDiffReport["hotSpotDelta"]["changed"] = [];

    for (const path of allPaths) {
      const currentItem = currentHotSpots.get(path);
      const baselineItem = baselineHotSpots.get(path);

      if (currentItem && !baselineItem) {
        added.push(currentItem);
        continue;
      }
      if (!currentItem && baselineItem) {
        removed.push(baselineItem);
        continue;
      }
      if (!currentItem || !baselineItem) {
        continue;
      }

      const scoreDelta = currentItem.score - baselineItem.score;
      const complexityDelta = currentItem.complexity - baselineItem.complexity;
      const dependencyDelta = currentItem.dependencies - baselineItem.dependencies;
      const anyDelta = currentItem.anyCount - baselineItem.anyCount;
      const complexityDriverDelta = this.buildComplexityDriverDelta(
        baselineItem.complexityDrivers,
        currentItem.complexityDrivers,
      );

      if (
        scoreDelta !== 0
        || complexityDelta !== 0
        || dependencyDelta !== 0
        || anyDelta !== 0
        || currentItem.cluster !== baselineItem.cluster
        || complexityDriverDelta.length > 0
      ) {
        changed.push({
          path,
          currentDisplayPath: currentItem.displayPath,
          baselineDisplayPath: baselineItem.displayPath,
          scoreDelta,
          complexityDelta,
          dependencyDelta,
          anyDelta,
          clusterBefore: baselineItem.cluster,
          clusterAfter: currentItem.cluster,
          baselineComplexityDrivers: baselineItem.complexityDrivers,
          currentComplexityDrivers: currentItem.complexityDrivers,
          complexityDriverDelta,
        });
      }
    }

    added.sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath));
    removed.sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath));
    changed.sort((left, right) => Math.abs(right.scoreDelta) - Math.abs(left.scoreDelta) || left.currentDisplayPath.localeCompare(right.currentDisplayPath));

    return { added, removed, changed };
  }

  private buildComplexityDriverDelta(baselineDrivers?: string[], currentDrivers?: string[]): string[] {
    const baseline = this.toDriverEntryMap(baselineDrivers);
    const current = this.toDriverEntryMap(currentDrivers);
    const orderedKeys = [
      ...Array.from(current.keys()),
      ...Array.from(baseline.keys()).filter((key) => !current.has(key)),
    ];
    const deltas: string[] = [];

    for (const key of orderedKeys) {
      const before = baseline.get(key);
      const after = current.get(key);
      if (before === after) {
        continue;
      }
      if (before && after) {
        deltas.push(`${key}=${before}->${after}`);
        continue;
      }
      if (!before && after) {
        deltas.push(`${key}=+${after}`);
        continue;
      }
      if (before && !after) {
        deltas.push(`${key}=-${before}`);
      }
    }

    return deltas;
  }

  private toDriverEntryMap(drivers?: string[]): Map<string, string> {
    const entries = new Map<string, string>();
    for (const driver of drivers ?? []) {
      const separator = driver.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = driver.slice(0, separator);
      const value = driver.slice(separator + 1);
      entries.set(key, value);
    }
    return entries;
  }

  private renderHtmlDriverMeta(drivers?: string[]): string {
    if (!drivers || drivers.length === 0) {
      return "";
    }
    return `<div class="impact-meta">drivers=${this.escapeHtml(drivers.join(", "))}</div>`;
  }

  private mergeNodes(currentNodes: GraphNode[], baselineNodes: GraphNode[]): GraphNode[] {
    const byId = new Map<string, GraphNode>();
    for (const node of [...baselineNodes, ...currentNodes]) {
      const existing = byId.get(node.id);
      if (!existing) {
        byId.set(node.id, { ...node });
        continue;
      }
      byId.set(node.id, {
        id: node.id,
        inDegree: Math.max(existing.inDegree, node.inDegree),
        outDegree: Math.max(existing.outDegree, node.outDegree),
        pageRank: Math.max(existing.pageRank, node.pageRank),
      });
    }
    return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  private mergeEdges(currentEdges: GraphJSON["edges"], baselineEdges: GraphJSON["edges"]): GraphJSON["edges"] {
    const merged = new Map<string, GraphJSON["edges"][number]>();
    for (const edge of [...baselineEdges, ...currentEdges]) {
      merged.set(`${edge.source}=>${edge.target}`, edge);
    }
    return Array.from(merged.values()).sort((left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
    );
  }

  private buildUndirectedAdjacency(edges: GraphJSON["edges"]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, new Set<string>());
      }
      if (!adjacency.has(edge.target)) {
        adjacency.set(edge.target, new Set<string>());
      }
      adjacency.get(edge.source)?.add(edge.target);
      adjacency.get(edge.target)?.add(edge.source);
    }
    return adjacency;
  }

  private buildDirectedAdjacency(
    edges: GraphJSON["edges"],
    direction: "source" | "target",
  ): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      const key = direction === "source" ? edge.source : edge.target;
      const value = direction === "source" ? edge.target : edge.source;
      if (!adjacency.has(key)) {
        adjacency.set(key, new Set<string>());
      }
      adjacency.get(key)?.add(value);
    }
    return adjacency;
  }

  private collectImpactedForRoot(root: string, adjacency: Map<string, Set<string>>, maxDepth: number): string[] {
    const visited = new Set<string>([root]);
    const queue: Array<{ node: string; depth: number }> = [{ node: root, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      if (current.depth >= maxDepth) {
        continue;
      }
      for (const next of adjacency.get(current.node) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        queue.push({ node: next, depth: current.depth + 1 });
      }
    }

    return Array.from(visited).sort();
  }

  private buildGraphSlice(nodeIds: string[], nodes: GraphNode[], edges: GraphJSON["edges"]): GraphJSON {
    const allowed = new Set(nodeIds);
    return {
      nodes: nodes.filter((node) => allowed.has(node.id)),
      edges: edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
    };
  }

  private computeDistanceToChanged(
    path: string,
    changedFiles: string[],
    adjacency: Map<string, Set<string>>,
  ): number {
    if (changedFiles.includes(path)) {
      return 0;
    }

    const visited = new Set<string>(changedFiles);
    const queue = changedFiles.map((file) => ({ file, distance: 0 }));
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      for (const next of adjacency.get(current.file) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        if (next === path) {
          return current.distance + 1;
        }
        visited.add(next);
        queue.push({ file: next, distance: current.distance + 1 });
      }
    }
    return 99;
  }

  private computeImpactScore(input: {
    directlyChanged: boolean;
    distance: number;
    inboundDegree: number;
    outboundDegree: number;
    complexityPressure: number;
  }): number {
    let score = 0;
    if (input.directlyChanged) {
      score += 100;
    }
    score += Math.max(0, 50 - input.distance * 12);
    score += input.inboundDegree * 5;
    score += input.outboundDegree * 4;
    score += input.complexityPressure;
    return score;
  }

  private buildImpactReasons(input: {
    directlyChanged: boolean;
    distance: number;
    inboundDegree: number;
    outboundDegree: number;
    complexitySignals: string[];
  }): string[] {
    const reasons: string[] = [];
    if (input.directlyChanged) {
      reasons.push("changed");
    }
    if (input.distance <= 1 && !input.directlyChanged) {
      reasons.push("adjacent-to-change");
    } else if (input.distance <= 2) {
      reasons.push("within-2-hops");
    }
    if (input.inboundDegree >= 2) {
      reasons.push("high-fan-in");
    }
    if (input.outboundDegree >= 2) {
      reasons.push("high-fan-out");
    }
    return [...reasons, ...input.complexitySignals];
  }

  private getComplexityChangePressure(
    filePath: string,
    current?: PersistedFileReport,
    baseline?: PersistedFileReport,
  ): { score: number; signals: string[] } {
    if (!current || !baseline) {
      return { score: 0, signals: [] };
    }

    const currentBreakdown = current.complexity.scoreBreakdown;
    const baselineBreakdown = baseline.complexity.scoreBreakdown;
    const signals: string[] = [];
    let score = 0;
    const currentOverall = current.complexity.overallComplexity;
    const baselineOverall = baseline.complexity.overallComplexity;
    const overallDelta = currentOverall - baselineOverall;

    if (overallDelta > 0) {
      const points = Math.min(24, overallDelta * 4);
      score += points;
      signals.push(`weighted=+${overallDelta}`);
    }

    const driverDeltas = [
      this.createComplexityPressureEntry("peakFn", baselineBreakdown?.peakFunctionComplexity ?? 0, currentBreakdown?.peakFunctionComplexity ?? 0, 5),
      this.createComplexityPressureEntry("top3avg", baselineBreakdown?.topFunctionAverage ?? 0, currentBreakdown?.topFunctionAverage ?? 0, 3),
      this.createComplexityPressureEntry("renderPeak", baselineBreakdown?.peakRenderComplexity ?? 0, currentBreakdown?.peakRenderComplexity ?? 0, 6),
      this.createComplexityPressureEntry("hookPressure", baselineBreakdown?.hookPressure ?? 0, currentBreakdown?.hookPressure ?? 0, 4),
      this.createComplexityPressureEntry("nesting", baselineBreakdown?.peakNestingDepth ?? 0, currentBreakdown?.peakNestingDepth ?? 0, 4),
      this.createComplexityPressureEntry("elevatedFns", baselineBreakdown?.elevatedFunctionCount ?? 0, currentBreakdown?.elevatedFunctionCount ?? 0, 5),
    ];

    for (const entry of driverDeltas) {
      if (!entry) {
        continue;
      }
      score += entry.score;
      signals.push(`${entry.label}=+${this.formatImpactMetric(entry.delta)}`);
    }

    if (filePath && score > 0 && signals.length === 0) {
      signals.push("complexity-regressed");
    }

    return {
      score: Math.min(40, score),
      signals,
    };
  }

  private createComplexityPressureEntry(
    label: string,
    baseline: number,
    current: number,
    weight: number,
  ): { label: string; delta: number; score: number } | null {
    const delta = current - baseline;
    if (delta <= 0) {
      return null;
    }

    return {
      label,
      delta,
      score: Math.min(12, Math.ceil(delta * weight)),
    };
  }

  private formatImpactMetric(value: number): string {
    const rounded = Number(value.toFixed(2));
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  private serializeForHtmlScript(value: string): string {
    return JSON.stringify(value).replace(/</gu, "\\u003c");
  }

  private toFileHref(filePath: string): string {
    return pathToFileURL(filePath).href;
  }
}
