import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AnalysisResult,
  CacheStats,
  DecisionSummaryReport,
  Dependency,
  GenerationOptions,
  GraphJSON,
  GraphMetrics,
  HookInfo,
  HotSpotReportItem,
  IncrementalStats,
  ParseIssue,
  RiskAxisBreakdown,
  SkippedFile,
} from "../types/index.js";

interface HookStats {
  name: string;
  count: number;
  files: Set<string>;
  totalArgs: number;
  withDependencies: number;
}

type HotSpotItem = HotSpotReportItem;

interface ExternalLibraryStat {
  name: string;
  count: number;
}

interface ExternalDependencyGroup {
  label: string;
  totalCount: number;
  items: ExternalLibraryStat[];
}

interface CycleInsight {
  nodes: string[];
  cutCandidate: Dependency | null;
  barrelInvolved: boolean;
  sharedCandidate: string | null;
}

export class ReportGenerator {
  private analysisResults: AnalysisResult[] = [];
  private projectRoot?: string;
  private graphMetrics: GraphMetrics = {
    cycles: [],
    totalDependencies: 0,
    externalDependencies: 0,
    stronglyConnectedComponents: [],
    weaklyConnectedComponents: [],
    topPageRank: [],
    topInDegree: [],
    topOutDegree: [],
    largestStronglyConnectedComponentSize: 0,
    warnings: [],
  };
  private executionTime = 0;
  private readonly startTime = Date.now();

  async generateReports(
    analysisResults: AnalysisResult[],
    graphMetrics: GraphMetrics,
    options: GenerationOptions,
  ): Promise<void> {
    this.analysisResults = analysisResults;
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    this.graphMetrics = graphMetrics;
    this.executionTime = Math.max(1, options.executionTimeMs ?? (Date.now() - this.startTime));

    await fs.mkdir(options.outputDir, { recursive: true });
    const formats = options.formats.includes("all")
      ? ["json", "markdown", "csv", "html"]
      : options.formats;

    if (formats.includes("csv")) {
      await this.generateCSVReports(options.outputDir, options.prefix);
    }
    if (formats.includes("markdown")) {
      await this.generateMarkdownReport(options.outputDir, options.prefix, options);
    }
    if (formats.includes("json")) {
      await this.generateJSONReport(options.outputDir, options.prefix, options);
    }
    if (formats.includes("html")) {
      await this.generateHTMLReport(options.outputDir, options.prefix, options);
    }
  }

  private async generateCSVReports(outputDir: string, prefix: string): Promise<void> {
    await fs.writeFile(path.join(outputDir, `${prefix}_files.csv`), this.generateFilesCSV(), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_dependencies.csv`), this.generateDependenciesCSV(), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_components.csv`), this.generateComponentsCSV(), "utf8");
    await fs.writeFile(path.join(outputDir, `${prefix}_hooks.csv`), this.generateHooksCSV(), "utf8");
  }

  private generateFilesCSV(): string {
    const testTargets = this.collectTestTargetKeys();
    const headers = [
      "File",
      "File Type",
      "Has Test File",
      "Matrix Cluster",
      "Lines",
      "Code Lines",
      "Comment Lines",
      "Functions",
      "Complexity",
      "Components",
      "Hooks",
      "Dependencies",
      "Risk Level",
      "Type Safety",
    ];

    const rows = this.analysisResults.map((result) => [
      this.toDisplayPath(result.filePath),
      this.classifyFileType(result.filePath),
      this.hasCorrespondingTestFile(result.filePath, testTargets) ? "Yes" : "No",
      this.classifySizeComplexityCluster(result.complexity.codeLines, result.complexity.overallComplexity),
      String(result.complexity.totalLines),
      String(result.complexity.codeLines),
      String(result.complexity.commentLines),
      String(result.complexity.functions.length),
      String(result.complexity.overallComplexity),
      String(result.complexity.components.length),
      String(result.complexity.hooks.length),
      String(result.dependencies.length),
      this.getRiskLevel(result.complexity.overallComplexity),
      `${result.complexity.typeMetrics.anyTypeCount} any / ${result.complexity.typeMetrics.assertionCount} assertions`,
    ]);

    return this.toCsvString([headers, ...rows]);
  }

  private generateDependenciesCSV(): string {
    const headers = ["Source", "Target", "Type", "External", "Imported Items"];
    const rows = this.analysisResults.flatMap((result) =>
      result.dependencies.map((dependency) => [
        this.toDisplayPath(dependency.source),
        this.toDisplayPath(dependency.target),
        dependency.type,
        dependency.isExternal ? "Yes" : "No",
        dependency.imported?.map((item) => item.alias ?? item.name).join("; ") ?? "",
      ])
    );

    return this.toCsvString([headers, ...rows]);
  }

  private generateComponentsCSV(): string {
    const headers = [
      "Component",
      "File",
      "File Type",
      "JSX Elements",
      "Hooks",
      "Props Count",
      "Has Children",
      "Uses Ref",
      "Is ForwardRef",
      "Render Complexity",
    ];

    const rows = this.analysisResults.flatMap((result) =>
      result.complexity.components.map((component) => [
        component.name,
        this.toDisplayPath(result.filePath),
        this.classifyFileType(result.filePath, component.name, component.hasChildren),
        String(component.jsxElements),
        component.hooksUsed.map((hook) => hook.name).join(", "),
        String(component.propsInterface?.properties.length ?? 0),
        component.hasChildren ? "Yes" : "No",
        component.usesRef ? "Yes" : "No",
        component.isForwardRef ? "Yes" : "No",
        String(component.renderComplexity.complexity),
      ])
    );

    return this.toCsvString([headers, ...rows]);
  }

  private generateHooksCSV(): string {
    const headers = ["Hook", "Count", "Files", "Average Args", "With Dependencies"];
    const map = new Map<string, HookStats>();

    for (const result of this.analysisResults) {
      for (const hook of result.complexity.hooks) {
        if (!map.has(hook.name)) {
          map.set(hook.name, {
            name: hook.name,
            count: 0,
            files: new Set<string>(),
            totalArgs: 0,
            withDependencies: 0,
          });
        }

        const stats = map.get(hook.name)!;
        stats.count += 1;
        stats.files.add(result.filePath);
        stats.totalArgs += hook.args;
        if (hook.hasDependencies) {
          stats.withDependencies += 1;
        }
      }
    }

    const rows = Array.from(map.values())
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .map((stats) => [
        stats.name,
        String(stats.count),
        String(stats.files.size),
        (stats.totalArgs / stats.count).toFixed(2),
        `${stats.withDependencies}/${stats.count}`,
      ]);

    return this.toCsvString([headers, ...rows]);
  }

  private async generateMarkdownReport(outputDir: string, prefix: string, options: GenerationOptions): Promise<void> {
    const sections = [
      "# TypeScript/React 静的解析レポート",
      this.generateDecisionSummarySection(options.complexityThreshold),
      this.generateSummarySection(options.cacheStats, options.analysisCacheStats, options.incrementalStats),
      this.generateMatrixClusterSection(),
      this.generateFileTypeDistributionSection(),
      this.generateStatisticsSection(),
      this.generateRiskAnalysisSection(options.complexityThreshold),
      this.generateTypeSafetySection(),
      this.generateDependencyAnalysisSection(),
      this.generateComponentsSection(),
      this.generateScanSection(options.skippedFiles ?? [], options.scanErrors ?? [], options.parseIssues ?? []),
      this.generateRecommendationsSection(options.complexityThreshold),
      this.generateMetadataSection(),
    ];
    const markdown = sections.map((section) => this.withSectionBreak(section)).join("");

    await fs.writeFile(path.join(outputDir, `${prefix}_report.md`), markdown, "utf8");
  }

  private generateSummarySection(
    cacheStats?: CacheStats,
    analysisCacheStats?: CacheStats,
    incrementalStats?: IncrementalStats,
  ): string {
    const fileCount = this.analysisResults.length;
    const totalLines = this.analysisResults.reduce((sum, result) => sum + result.complexity.totalLines, 0);
    const totalFunctions = this.analysisResults.reduce((sum, result) => sum + result.complexity.functions.length, 0);
    const totalComponents = this.analysisResults.reduce((sum, result) => sum + result.complexity.components.length, 0);
    const averageComplexity = fileCount > 0
      ? (this.analysisResults.reduce((sum, result) => sum + result.complexity.overallComplexity, 0) / fileCount).toFixed(2)
      : "0.00";
    const cacheLine = cacheStats
      ? `- **ファイルキャッシュ**: ${cacheStats.hits} hit / ${cacheStats.misses} miss\n`
      : "";
    const analysisCacheLine = analysisCacheStats
      ? `- **解析キャッシュ**: ${analysisCacheStats.hits} hit / ${analysisCacheStats.misses} miss\n`
      : "";
    const incrementalLine = incrementalStats
      ? `- **差分再利用**: ${incrementalStats.reusedFiles} reused / ${incrementalStats.recomputedFiles} recomputed\n`
      : "";

    return [
      "## 概要",
      "",
      "レポート全体の規模感と実行条件を短く把握するための要約です。",
      "",
      `- **対象ファイル数**: ${fileCount}`,
      `- **総行数**: ${totalLines}`,
      `- **関数数**: ${totalFunctions}`,
      `- **コンポーネント数**: ${totalComponents}`,
      `- **平均複雑度**: ${averageComplexity}`,
      `- **実行時間**: ${this.executionTime}ms`,
      cacheLine.trimEnd(),
      analysisCacheLine.trimEnd(),
      incrementalLine.trimEnd(),
      "",
    ].filter(Boolean).join("\n");
  }

  private generateDecisionSummarySection(threshold: number): string {
    const decisionSummary = this.buildDecisionSummary(threshold);
    const hotSpots = decisionSummary.topHotSpots;

    let markdown = "## 意思決定サマリー\n\n";
    markdown += "優先順位の高い論点を先頭で整理し、着手判断を早くするためのセクションです。\n\n";
    markdown += `- **重点改修候補**: ${hotSpots.length > 0 ? hotSpots.map((item) => item.displayPath).join(", ") : "なし"}\n`;
    markdown += `- **循環依存の状態**: ${decisionSummary.cycleStatus}\n`;
    markdown += `- **複雑度リスク**: 高=${decisionSummary.riskSummary.complexity.high}, 中=${decisionSummary.riskSummary.complexity.medium}\n`;
    markdown += `- **構造リスク**: 高=${decisionSummary.riskSummary.structure.high}, 中=${decisionSummary.riskSummary.structure.medium}\n`;
    markdown += `- **型安全性リスク**: 高=${decisionSummary.riskSummary.typeSafety.high}, 中=${decisionSummary.riskSummary.typeSafety.medium}, any=${decisionSummary.typeSafetyAlerts.anyCount}, ts-ignore=${decisionSummary.typeSafetyAlerts.tsIgnoreCount}\n\n`;

    markdown += "## 重点改修候補 Top 5\n\n";
    markdown += "複雑度だけでなく、構造負債と型安全性を含めた総合危険度で上位ファイルを示します。\n\n";
    if (hotSpots.length === 0) {
      markdown += "優先度の高い改修候補はありません。\n\n";
      return markdown;
    }

    for (const item of hotSpots) {
      markdown += `- **${item.displayPath}** 主因=${this.getPrimaryRiskAxisLabel(item.path)} score=${item.score} cluster=${item.cluster} complexity=${item.complexity} codeLines=${item.codeLines} dependencies=${item.dependencies} any=${item.anyCount} hooks=${item.hooks}\n`;
      markdown += `  理由=${item.reasons.join(", ")}\n`;
      markdown += `  対応=${item.action}\n`;
    }
    markdown += "\n";
    return markdown;
  }

  private generateStatisticsSection(): string {
    if (this.analysisResults.length === 0) {
      return "## リスク分布\n\n複雑度・構造・型安全性を別軸で集計し、どこに負債が偏っているかを示します。\n\n解析対象ファイルはありません。";
    }

    const complexity = this.buildRiskBreakdown((result) => this.getRiskLevel(result.complexity.overallComplexity));
    const structure = this.buildRiskBreakdown((result) => this.getStructureRiskLevel(result));
    const typeSafety = this.buildTypeSafetyRiskBreakdown();

    return [
      "## リスク分布",
      "",
      "複雑度・構造・型安全性を別軸で集計し、どこに負債が偏っているかを示します。",
      "",
      "| 軸 | 低 | 中 | 高 |",
      "|----|----|----|----|",
      `| 複雑度 | ${complexity.low} | ${complexity.medium} | ${complexity.high} |`,
      `| 構造 | ${structure.low} | ${structure.medium} | ${structure.high} |`,
      `| 型安全性 | ${typeSafety.low} | ${typeSafety.medium} | ${typeSafety.high} |`,
      "",
      "### 判定基準",
      "",
      "- **複雑度**: サイクロマティック複雑度ベース",
      "- **構造**: 依存数・Hooks 数・コード行数ベース",
      "- **型安全性**: any / assertion / non-null / ts-ignore の重み付きスコアベース",
    ].join("\n");
  }

  private generateRiskAnalysisSection(threshold: number): string {
    const highRiskFiles = this.analysisResults
      .filter((result) => result.complexity.overallComplexity >= threshold)
      .sort((left, right) => right.complexity.overallComplexity - left.complexity.overallComplexity)
      .slice(0, 10);

    if (highRiskFiles.length === 0) {
      return "## 高複雑度ファイル\n\n複雑度しきい値を超えたファイルについて、危険な理由と対応方針を示します。\n\n閾値超過ファイルはありません。\n\n";
    }

    let markdown = "## 高複雑度ファイル\n\n";
    markdown += "複雑度しきい値を超えたファイルについて、危険な理由と対応方針を示します。\n\n";
    for (const file of highRiskFiles) {
      const displayPath = this.toDisplayPath(file.filePath);
      const cluster = this.classifySizeComplexityCluster(file.complexity.codeLines, file.complexity.overallComplexity);
      markdown += `- **${displayPath}**\n`;
      markdown += `  理由: matrix=${cluster}, complexity=${file.complexity.overallComplexity}, codeLines=${file.complexity.codeLines}, functions=${file.complexity.functions.length}, hooks=${file.complexity.hooks.length}, any=${file.complexity.typeMetrics.anyTypeCount}, dependencyCount=${file.dependencies.length}\n`;
      markdown += `  対応: ${this.buildHotSpotAction(file, file.dependencies.length, file.complexity.typeMetrics.anyTypeCount, file.complexity.hooks.length)}\n`;
    }
    markdown += "\n";
    return markdown;
  }

  private generateMatrixClusterSection(): string {
    if (this.analysisResults.length === 0) {
      return "## 3x3 マトリクス要約\n\nコード行数と複雑度の 3x3 マトリクスで、設計負債の位置を俯瞰します。\n\n解析対象ファイルはありません。\n\n";
    }

    const sizeBands: Array<"S" | "M" | "L"> = ["S", "M", "L"];
    const complexityBands: Array<"L" | "M" | "H"> = ["L", "M", "H"];
    const counts = new Map<string, number>();

    for (const result of this.analysisResults) {
      const cluster = this.classifySizeComplexityCluster(result.complexity.codeLines, result.complexity.overallComplexity);
      counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
    }

    let markdown = "## 3x3 マトリクス要約\n\n";
    markdown += "コード行数と複雑度の 3x3 マトリクスで、設計負債の位置を俯瞰します。\n\n";
    markdown += "| 行数帯 \\\\ 複雑度 | 低 (<=5) | 中 (<=10) | 高 (>10) |\n";
    markdown += "|-------------------|----------|-----------|----------|\n";
    markdown += `| 小 (<=100) | ${counts.get("S-L") ?? 0} | ${counts.get("S-M") ?? 0} | ${counts.get("S-H") ?? 0} |\n`;
    markdown += `| 中 (<=300) | ${counts.get("M-L") ?? 0} | ${counts.get("M-M") ?? 0} | ${counts.get("M-H") ?? 0} |\n`;
    markdown += `| 大 (>300) | ${counts.get("L-L") ?? 0} | ${counts.get("L-M") ?? 0} | ${counts.get("L-H") ?? 0} |\n\n`;

    markdown += "| クラスタ | 件数 | 意味 |\n";
    markdown += "|----------|------|------|\n";
    for (const sizeBand of sizeBands) {
      for (const complexityBand of complexityBands) {
        const cluster = `${sizeBand}-${complexityBand}`;
        markdown += `| ${cluster} | ${counts.get(cluster) ?? 0} | ${this.describeCluster(cluster)} |\n`;
      }
    }
    markdown += "\n";
    return markdown;
  }

  private generateFileTypeDistributionSection(): string {
    if (this.analysisResults.length === 0) {
      return "## ファイル種別分布\n\nRoute や Feature などの種別ごとの偏りを見て、責務の寄り方を判断します。\n\n解析対象ファイルはありません。\n\n";
    }

    const order = [
      "Route",
      "Schema",
      "Feature",
      "Validation",
      "Layout",
      "Form",
      "UI component",
      "Storybook Support",
      "Context/State",
      "Hook",
      "API/Infrastructure",
      "Utils",
      "Type Support",
      "Barrel",
      "Shared",
      "Test",
      "Story",
      "Fixture",
      "Config",
    ];
    const stats = new Map<string, { count: number; totalComplexity: number; totalCodeLines: number }>();

    for (const result of this.analysisResults) {
      const fileType = this.classifyFileType(result.filePath);
      if (!stats.has(fileType)) {
        stats.set(fileType, { count: 0, totalComplexity: 0, totalCodeLines: 0 });
      }

      const entry = stats.get(fileType)!;
      entry.count += 1;
      entry.totalComplexity += result.complexity.overallComplexity;
      entry.totalCodeLines += result.complexity.codeLines;
    }

    let markdown = "## ファイル種別分布\n\n";
    markdown += "Route や Feature などの種別ごとの偏りを見て、責務の寄り方を判断します。\n\n";
    markdown += "| ファイル種別 | 件数 | 比率 | 平均複雑度 | 平均コード行数 |\n";
    markdown += "|--------------|------|------|------------|----------------|\n";

    for (const fileType of order) {
      const entry = stats.get(fileType) ?? { count: 0, totalComplexity: 0, totalCodeLines: 0 };
      const averageComplexity = entry.count > 0 ? (entry.totalComplexity / entry.count).toFixed(1) : "0.0";
      const averageCodeLines = entry.count > 0 ? (entry.totalCodeLines / entry.count).toFixed(1) : "0.0";
      markdown += `| ${fileType} | ${entry.count} | ${((entry.count / this.analysisResults.length) * 100).toFixed(1)}% | ${averageComplexity} | ${averageCodeLines} |\n`;
    }

    markdown += "\n";
    return markdown;
  }

  private generateTypeSafetySection(): string {
    const totals = this.getTypeSafetyTotals();
    const worstFiles = this.analysisResults
      .filter((result) => this.isTypeSafetyTargetFile(result.filePath))
      .map((result) => {
        const metrics = result.complexity.typeMetrics;
        const score = this.getTypeSafetyScore(result);
        return {
          path: this.toDisplayPath(result.filePath),
          anyCount: metrics.anyTypeCount,
          assertionCount: metrics.assertionCount,
          nonNullAssertionCount: metrics.nonNullAssertionCount,
          tsIgnoreCount: metrics.tsIgnoreCount,
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 10);

    let markdown = "## 型安全性\n\n";
    markdown += "型の逃げ道になっている記述を集計し、どこで安全性が落ちているかを示します。\n\n";
    markdown += `- **explicit any**: ${totals.anyCount}\n`;
    markdown += `- **型アサーション**: ${totals.assertionCount}\n`;
    markdown += `- **non-null アサーション**: ${totals.nonNullAssertionCount}\n`;
    markdown += `- **ts-ignore**: ${totals.tsIgnoreCount}\n\n`;

    if (worstFiles.length === 0) {
      markdown += "型安全性の警告はありません。\n\n";
      return markdown;
    }

    markdown += "| ファイル | any | assertions | non-null | ts-ignore | score |\n";
    markdown += "|----------|-----|------------|----------|-----------|-------|\n";
    for (const item of worstFiles) {
      markdown += `| ${item.path} | ${item.anyCount} | ${item.assertionCount} | ${item.nonNullAssertionCount} | ${item.tsIgnoreCount} | ${item.score} |\n`;
    }
    markdown += "\n";
    return markdown;
  }

  private generateDependencyAnalysisSection(): string {
    const externalLibraryGroups = this.getExternalLibraryStatsByContext(10);
    const cycleInsights = this.getCycleInsights(10);
    let markdown = "## 依存関係分析\n\n";
    markdown += "内部依存と外部依存の偏り、循環依存の有無、中心モジュールを整理します。\n\n";
    markdown += `- **総依存数**: ${this.graphMetrics.totalDependencies}\n`;
    markdown += `- **外部依存数**: ${this.graphMetrics.externalDependencies}\n`;
    markdown += `- **循環依存数**: ${this.graphMetrics.cycles.length}\n`;
    markdown += `- **SCC 数**: ${this.graphMetrics.stronglyConnectedComponents.length}\n`;
    markdown += `- **最大 SCC サイズ**: ${this.graphMetrics.largestStronglyConnectedComponentSize}\n`;
    markdown += `- **弱連結クラスタ数**: ${this.graphMetrics.weaklyConnectedComponents.length}\n\n`;

    if (this.graphMetrics.warnings.length > 0) {
      markdown += "### グラフ警告\n\n";
      markdown += "依存グラフ全体で目立つ構造上の警告を列挙します。\n\n";
      for (const warning of this.graphMetrics.warnings) {
        markdown += `- ${warning}\n`;
      }
      markdown += "\n";
    }

    if (this.graphMetrics.cycles.length > 0) {
      markdown += "### 循環依存\n\n";
      markdown += "循環依存の経路と、切断候補となる依存辺を示します。\n\n";
      for (const cycle of cycleInsights) {
        markdown += `- ${cycle.nodes.map((node) => this.toDisplayPath(node)).join(" -> ")}\n`;
        markdown += `  切断候補: ${cycle.cutCandidate
          ? `${this.toDisplayPath(cycle.cutCandidate.source)} -> ${this.toDisplayPath(cycle.cutCandidate.target)} (${cycle.cutCandidate.type})`
          : "なし"}\n`;
        markdown += `  barrel経由: ${cycle.barrelInvolved ? "あり" : "なし"}\n`;
        markdown += `  shared化候補: ${cycle.sharedCandidate ? this.toDisplayPath(cycle.sharedCandidate) : "なし"}\n`;
      }
      markdown += "\n";
    }

    markdown += "### 外部ライブラリ内訳\n\n";
    markdown += "runtime / storybook / test / dev の文脈ごとに package 利用回数を分けて表示します。\n\n";
    if (externalLibraryGroups.every((group) => group.items.length === 0)) {
      markdown += "外部ライブラリ依存は検出されませんでした。\n\n";
    } else {
      for (const group of externalLibraryGroups) {
        if (group.items.length === 0) {
          continue;
        }
        markdown += `#### ${group.label} (${group.totalCount})\n\n`;
        for (const item of group.items) {
          markdown += `- ${item.name}: ${item.count}\n`;
        }
        markdown += "\n";
      }
    }

    if (this.graphMetrics.topPageRank.length > 0) {
      markdown += "### 中心性が高いモジュール\n\n";
      markdown += "依存グラフ全体で影響範囲が大きいモジュールを示します。\n\n";
      for (const entry of this.graphMetrics.topPageRank.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(entry.id)} (${entry.score.toFixed(4)})\n`;
      }
      markdown += "\n";
    }

    if (this.graphMetrics.topInDegree.length > 0) {
      markdown += "### 被依存が多いモジュール\n\n";
      markdown += "多くのファイルから参照されるハブモジュールを示します。\n\n";
      for (const entry of this.graphMetrics.topInDegree.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(entry.id)} (inDegree=${entry.degree})\n`;
      }
      markdown += "\n";
    }

    if (this.graphMetrics.topOutDegree.length > 0) {
      markdown += "### 依存先が多いモジュール\n\n";
      markdown += "依存の広がりが大きいモジュールを示します。\n\n";
      for (const entry of this.graphMetrics.topOutDegree.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(entry.id)} (outDegree=${entry.degree})\n`;
      }
      markdown += "\n";
    }

    return markdown;
  }

  private generateComponentsSection(): string {
    const components = this.analysisResults.flatMap((result) =>
      result.complexity.components.map((component) => ({ ...component, file: this.toDisplayPath(result.filePath) }))
    );

    if (components.length === 0) {
      return "## コンポーネント分析\n\nReact コンポーネントの構造と Hooks 利用の偏りを確認します。\n\nReact コンポーネントは検出されませんでした。\n\n";
    }

    const averageJsx = components.reduce((sum, component) => sum + component.jsxElements, 0) / components.length;
    const hookHeavy = components
      .filter((component) => component.hookCount >= 2)
      .sort((left, right) => right.hookCount - left.hookCount)
      .slice(0, 10);

    let markdown = "## コンポーネント分析\n\n";
    markdown += "React コンポーネントの構造と Hooks 利用の偏りを確認します。\n\n";
    markdown += `- **総コンポーネント数**: ${components.length}\n`;
    markdown += `- **平均 JSX ノード数**: ${averageJsx.toFixed(1)}\n\n`;

    if (hookHeavy.length > 0) {
      markdown += "### Hooks 多用コンポーネント\n\n";
      markdown += "Hooks が集中しているコンポーネントを確認し、分割候補を洗い出します。\n\n";
      for (const component of hookHeavy) {
        markdown += `- **${component.name}** (${component.file}) hooks=${component.hooksUsed.map((hook) => hook.name).join(", ")}\n`;
      }
      markdown += "\n";
    }

    return markdown;
  }

  private generateScanSection(
    skippedFiles: SkippedFile[],
    scanErrors: Array<{ filePath: string; reason: string }>,
    parseIssues: ParseIssue[],
  ): string {
    const expectedSkips = skippedFiles.filter((skipped) => this.isExpectedSkip(skipped));
    const unexpectedSkips = skippedFiles.filter((skipped) => !this.isExpectedSkip(skipped));

    let markdown = "## スキャン結果\n\n";
    markdown += "スキャン段階で想定どおり除外されたものと、異常として扱うべき事象を分離して示します。\n\n";
    markdown += `- **想定どおりの除外**: ${expectedSkips.length}\n`;
    markdown += `- **想定外の除外**: ${unexpectedSkips.length}\n`;
    markdown += `- **想定外のエラー**: ${scanErrors.length}\n`;
    markdown += `- **パースエラー**: ${parseIssues.length}\n\n`;

    if (expectedSkips.length > 0) {
      markdown += "### 想定どおりの除外\n\n";
      markdown += "設定済みの除外対象に一致したため、解析対象から外した項目です。\n\n";
      for (const skipped of expectedSkips.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(skipped.filePath)} (${skipped.reason})\n`;
      }
      markdown += "\n";
    }

    if (unexpectedSkips.length > 0) {
      markdown += "### 想定外の除外\n\n";
      markdown += "サイズ超過や循環検出など、後で確認すべき除外項目です。\n\n";
      for (const skipped of unexpectedSkips.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(skipped.filePath)} (${skipped.reason})\n`;
      }
      markdown += "\n";
    }

    if (scanErrors.length > 0) {
      markdown += "### 想定外のエラー\n\n";
      markdown += "読み取り失敗など、スキャン処理が継続できなかった事象です。\n\n";
      for (const error of scanErrors.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(error.filePath)} (${error.reason})\n`;
      }
      markdown += "\n";
    }

    if (parseIssues.length > 0) {
      markdown += "### パースエラー\n\n";
      markdown += "AST 生成時に診断が発生したファイルを示します。\n\n";
      for (const issue of parseIssues.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(issue.filePath)} (diagnostics=${issue.diagnosticCount})\n`;
      }
      markdown += "\n";
    }

    return markdown;
  }

  private generateRecommendationsSection(threshold: number): string {
    const tasks = this.getHotSpots(threshold, 5);

    if (tasks.length === 0) {
      return "## 優先対応タスク\n\n読み終わった直後に着手順を決められるよう、優先順位付きで対応を並べます。\n\n直ちに着手すべき対応はありません。\n\n";
    }

    let markdown = "## 優先対応タスク\n\n";
    markdown += "読み終わった直後に着手順を決められるよう、優先順位付きで対応を並べます。\n\n";
    tasks.forEach((item, index) => {
      markdown += `${index + 1}. ${item.displayPath}\n`;
      markdown += `理由: クラスタ=${item.cluster}, complexity=${item.complexity}, any=${item.anyCount}, fan-out=${item.dependencies}, codeLines=${item.codeLines}\n`;
      markdown += `対応: ${item.action}\n\n`;
    });
    return markdown;
  }

  private generateMetadataSection(): string {
    return [
      "## メタデータ",
      "",
      "レポート生成時刻とツール実行情報を記録します。",
      "",
      `- **生成時刻**: ${new Date().toISOString()}`,
      `- **実行時間**: ${this.executionTime}ms`,
      "- **ツールバージョン**: 0.1.0",
      "",
    ].join("\n");
  }

  private withSectionBreak(section: string): string {
    const trimmed = section.trimEnd();
    return `${trimmed}\n\n`;
  }

  private async generateJSONReport(outputDir: string, prefix: string, options: GenerationOptions): Promise<void> {
    const decisionSummary = this.buildDecisionSummary(options.complexityThreshold);
    const report = {
      timestamp: new Date().toISOString(),
      executionTimeMs: this.executionTime,
      statistics: {
        fileCount: this.analysisResults.length,
        totalLines: this.analysisResults.reduce((sum, result) => sum + result.complexity.totalLines, 0),
        functionCount: this.analysisResults.reduce((sum, result) => sum + result.complexity.functions.length, 0),
        componentCount: this.analysisResults.reduce((sum, result) => sum + result.complexity.components.length, 0),
        averageComplexity: this.analysisResults.length > 0
          ? this.analysisResults.reduce((sum, result) => sum + result.complexity.overallComplexity, 0) / this.analysisResults.length
          : 0,
      },
      files: this.analysisResults.map((result) => ({
        path: result.filePath,
        complexity: result.complexity,
        dependencies: result.dependencies,
        dependencyErrors: result.dependencyErrors,
        warnings: this.generateWarnings(result, options.complexityThreshold),
      })),
      graph: this.graphMetrics,
      skippedFiles: options.skippedFiles ?? [],
      scanErrors: options.scanErrors ?? [],
      cacheStats: options.cacheStats,
      analysisCacheStats: options.analysisCacheStats,
      incrementalStats: options.incrementalStats,
      graphJson: options.graphJson,
      decisionSummary,
    };

    await fs.writeFile(path.join(outputDir, `${prefix}_report.json`), JSON.stringify(report, null, 2), "utf8");
  }

  private async generateHTMLReport(outputDir: string, prefix: string, options: GenerationOptions): Promise<void> {
    const rows = this.analysisResults
      .map((result) => {
        const risk = this.getRiskLevel(result.complexity.overallComplexity);
        return `<tr class="${risk}" data-file="${this.escapeHtml(result.filePath)}"><td><a href="${this.toFileHref(result.filePath)}">${this.escapeHtml(this.toDisplayPath(result.filePath))}</a></td><td>${result.complexity.totalLines}</td><td>${result.complexity.overallComplexity}</td><td>${result.complexity.components.length}</td><td>${risk}</td></tr>`;
      })
      .join("\n");
    const graphData = options.graphJson ?? { nodes: [], edges: [] };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>TypeScript/React Static Analysis Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #1f2937; }
    h1, h2 { margin-bottom: 8px; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    #graph-shell { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; margin: 20px 0 32px; }
    #graph { min-height: 520px; border: 1px solid #cbd5e1; border-radius: 8px; background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); position: relative; overflow: hidden; }
    #graph-empty { display: none; padding: 16px; color: #64748b; }
    #inspector { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
    th { background: #e2e8f0; }
    tr.high { background: #fee2e2; }
    tr.medium { background: #fef3c7; }
    tr.low { background: #dcfce7; }
    code { background: #e5e7eb; padding: 0 4px; border-radius: 4px; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
    button { border: 1px solid #94a3b8; background: white; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    .legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #475569; }
    .legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 999px; vertical-align: middle; }
    .legend .low::before { background: #8ce99a; }
    .legend .medium::before { background: #ffe066; }
    .legend .high::before { background: #ff6b6b; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>TypeScript/React Static Analysis Report</h1>
  <div class="meta">
    <div class="card"><strong>Files</strong><br />${this.analysisResults.length}</div>
    <div class="card"><strong>Dependencies</strong><br />${this.graphMetrics.totalDependencies}</div>
    <div class="card"><strong>Cycles</strong><br />${this.graphMetrics.cycles.length}</div>
    <div class="card"><strong>Graph Warnings</strong><br />${this.graphMetrics.warnings.length}</div>
    <div class="card"><strong>Complexity Threshold</strong><br />${options.complexityThreshold}</div>
    <div class="card"><strong>File Cache</strong><br />${options.cacheStats?.hits ?? 0} hit / ${options.cacheStats?.misses ?? 0} miss</div>
    <div class="card"><strong>Analysis Cache</strong><br />${options.analysisCacheStats?.hits ?? 0} hit / ${options.analysisCacheStats?.misses ?? 0} miss</div>
    <div class="card"><strong>Incremental</strong><br />${options.incrementalStats?.reusedFiles ?? 0} reused / ${options.incrementalStats?.recomputedFiles ?? 0} recomputed</div>
    <div class="card"><strong>Generated At</strong><br />${new Date().toISOString()}</div>
  </div>
  <h2>Dependency Graph</h2>
  <div class="toolbar">
    <button id="reset-filter">Reset Filter</button>
    <div class="legend">
      <span class="low">Low in-degree</span>
      <span class="medium">Medium in-degree</span>
      <span class="high">High in-degree</span>
    </div>
  </div>
  <div id="graph-shell">
    <div id="graph">
      <div id="graph-empty">Graph data is not available.</div>
    </div>
    <aside id="inspector">
      <strong>Selection</strong>
      <p id="selection-name">None</p>
      <p id="selection-meta">Click a node to filter the file table.</p>
    </aside>
  </div>
  <h2>Files</h2>
  <table>
    <thead>
      <tr><th>File</th><th>Lines</th><th>Complexity</th><th>Components</th><th>Risk</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <script>
    const graphData = ${this.serializeForScript(graphData)};
    const tableRows = Array.from(document.querySelectorAll("tbody tr"));
    const selectionName = document.getElementById("selection-name");
    const selectionMeta = document.getElementById("selection-meta");
    const graphHost = document.getElementById("graph");
    const emptyState = document.getElementById("graph-empty");
    const SVG_NS = "http://www.w3.org/2000/svg";
    document.getElementById("reset-filter").addEventListener("click", () => {
      for (const row of tableRows) row.style.display = "";
      selectionName.textContent = "None";
      selectionMeta.textContent = "Click a node to filter the file table.";
    });

    if (!graphData.nodes.length) {
      emptyState.style.display = "block";
    } else {
      const width = graphHost.clientWidth || 960;
      const height = 520;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      graphHost.appendChild(svg);

      const links = graphData.edges.map((edge) => ({ ...edge }));
      const nodes = graphData.nodes.map((node) => ({ ...node }));
      const colorFor = (node) => node.inDegree > 5 ? "#ff6b6b" : node.inDegree > 2 ? "#ffe066" : "#8ce99a";
      const centerX = width / 2;
      const centerY = height / 2;
      const radiusBase = Math.min(width, height) * 0.3;

      nodes.forEach((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1);
        const ring = radiusBase + (node.outDegree * 8) - (node.inDegree * 3);
        node.x = centerX + Math.cos(angle) * Math.max(80, ring);
        node.y = centerY + Math.sin(angle) * Math.max(80, ring);
      });

      const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));

      for (const edge of links) {
        const source = nodeById[edge.source];
        const target = nodeById[edge.target];
        if (!source || !target) continue;
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(source.x));
        line.setAttribute("y1", String(source.y));
        line.setAttribute("x2", String(target.x));
        line.setAttribute("y2", String(target.y));
        line.setAttribute("stroke", "#94a3b8");
        line.setAttribute("stroke-opacity", "0.7");
        line.setAttribute("stroke-width", "1.4");
        svg.appendChild(line);
      }

      for (const item of nodes) {
        const group = document.createElementNS(SVG_NS, "g");
        const circle = document.createElementNS(SVG_NS, "circle");
        const label = document.createElementNS(SVG_NS, "text");
        const title = document.createElementNS(SVG_NS, "title");
        const radius = 7 + Math.max(item.pageRank || 0, 0.02) * 60;

        circle.setAttribute("cx", String(item.x));
        circle.setAttribute("cy", String(item.y));
        circle.setAttribute("r", String(radius));
        circle.setAttribute("fill", colorFor(item));
        circle.setAttribute("stroke", "#0f172a");
        circle.setAttribute("stroke-width", "0.8");
        circle.style.cursor = "pointer";

        label.setAttribute("x", String(item.x + radius + 4));
        label.setAttribute("y", String(item.y + 4));
        label.setAttribute("font-size", "11");
        label.setAttribute("fill", "#334155");
        label.textContent = item.id.split("/").pop();

        title.textContent = item.id;
        circle.appendChild(title);
        circle.addEventListener("click", () => {
          for (const row of tableRows) {
            row.style.display = row.dataset.file === item.id ? "" : "none";
          }
          selectionName.textContent = item.id;
          selectionMeta.textContent = "inDegree=" + item.inDegree + ", outDegree=" + item.outDegree + ", pageRank=" + (item.pageRank || 0).toFixed(4);
        });

        group.appendChild(circle);
        group.appendChild(label);
        svg.appendChild(group);
      }
    }
  </script>
</body>
</html>`;

    await fs.writeFile(path.join(outputDir, `${prefix}_report.html`), html, "utf8");
  }

  private toCsvString(rows: string[][]): string {
    return rows.map((row) =>
      row.map((cell) => {
        if (cell.includes(",") || cell.includes("\"") || cell.includes("\n")) {
          return `"${cell.replace(/"/gu, "\"\"")}"`;
        }
        return cell;
      }).join(",")
    ).join("\n");
  }

  private getRiskLevel(complexity: number): "low" | "medium" | "high" {
    if (complexity <= 5) {
      return "low";
    }
    if (complexity <= 10) {
      return "medium";
    }
    return "high";
  }

  private generateWarnings(result: AnalysisResult, threshold: number): string[] {
    const warnings: string[] = [];
    if (result.complexity.overallComplexity >= threshold) {
      warnings.push("complexity-threshold-exceeded");
    }
    if (result.complexity.typeMetrics.anyTypeCount > 0) {
      warnings.push("explicit-any-usage");
    }
    if (result.dependencies.length > 20) {
      warnings.push("high-dependency-count");
    }
    return warnings;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  private serializeForScript(value: GraphJSON): string {
    return JSON.stringify(value).replace(/</gu, "\\u003c");
  }

  private toFileHref(filePath: string): string {
    return pathToFileURL(filePath).href;
  }

  private toDisplayPath(filePath: string): string {
    const normalized = filePath.split(path.sep).join("/");
    if (!this.projectRoot || !path.isAbsolute(filePath)) {
      return normalized;
    }

    const relativePath = path.relative(this.projectRoot, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return normalized;
    }

    return relativePath.split(path.sep).join("/");
  }

  private classifyFileType(filePath: string, componentName?: string, hasChildren = false): string {
    const displayPath = this.toDisplayPath(filePath).split(path.sep).join("/");
    const normalized = displayPath.toLowerCase();
    const baseName = path.basename(displayPath);
    const normalizedBaseName = baseName.toLowerCase();
    const baseStem = baseName.replace(/\.[cm]?[jt]sx?$/u, "");
    const normalizedBaseStem = baseStem.toLowerCase();
    const normalizedComponentName = componentName?.toLowerCase() ?? "";
    const isTestFile = /(?:^|\.)(test|spec)\.[cm]?[jt]sx?$/.test(normalizedBaseName)
      || /(^|\/)(__tests__|tests)\//.test(normalized);
    const isStoryFile = /\.stories\.[cm]?[jt]sx?$/.test(normalizedBaseName)
      || /(^|\/)(stories|storybook)\//.test(normalized);
    const isFixtureFile = /(^|\/)(__fixtures__|fixtures)\//.test(normalized)
      || /\.fixture\.[cm]?[jt]sx?$/.test(normalizedBaseName);
    const isStorybookSupportFile = (normalized.startsWith(".storybook/") || normalized.includes("/.storybook/"))
      && /\.(?:[cm]?[jt]sx?)$/u.test(normalizedBaseName)
      && !/^(main|preview|manager|vitest\.setup)\.[cm]?[jt]sx?$/u.test(normalizedBaseName);
    const isConfigFile = normalizedBaseName === "tsconfig.json"
      || normalizedBaseName === "jsconfig.json"
      || normalizedBaseName.startsWith("eslint.config.")
      || normalizedBaseName.startsWith(".eslintrc")
      || normalizedBaseName.startsWith(".prettierrc")
      || normalizedBaseName.startsWith("vite.config.")
      || normalizedBaseName.startsWith("vitest.config.")
      || normalizedBaseName.startsWith("jest.config.")
      || normalizedBaseName.startsWith("storybook.")
      || normalized.includes("/.storybook/")
      || normalized.startsWith(".storybook/")
      || normalizedBaseName.includes(".config.");
    const isBarrel = this.isBarrelFile(displayPath);
    const isRouteFile = /(^|\/)(app|pages)\//.test(normalized)
      || /^(app|root|page|loading|error|template|route)\.[cm]?[jt]sx?$/.test(normalizedBaseName);
    const isSchemaFile = /(^|\/)schemas?(\/|$)/.test(normalized)
      || /\.schema\.[cm]?[jt]sx?$/u.test(normalizedBaseName);
    const isValidationFile = /(^|\/)(validations?|validators?)(\/|$)/.test(normalized)
      || /\.(validation|validator)\.[cm]?[jt]sx?$/u.test(normalizedBaseName);
    const isUiLibraryFile = /(^|\/)components\/ui(\/|$)/.test(normalized)
      || /(^|\/)components\/commons(\/|$)/.test(normalized);
    const isLayoutFile = /(^|\/)(layouts?|layout)(\/|$)/.test(normalized)
      || /(^|\/)(header|sidebar|footer|navbar)\.[cm]?[jt]sx?$/.test(normalized)
      || /(^|\/).*(layout|container|shell)\.[cm]?[jt]sx?$/.test(normalized)
      || (hasChildren && /(layout|container|shell)$/u.test(normalizedComponentName));
    const isFeatureFile = /(^|\/)(features?|modules?|domains?|scenes?|containers?)(\/|$)/.test(normalized);
    const isHookFile = /^use[A-Z0-9]/u.test(baseStem)
      || /(^|\/)hooks?(\/|$)/.test(normalized);
    const isContextStateFile = /(^|\/)contexts?(\/|$)/.test(normalized)
      || /(provider|context|store)\.[cm]?[jt]sx?$/.test(normalizedBaseName)
      || /(provider|context|store)$/u.test(normalizedBaseStem);
    const isApiInfrastructureFile = /(^|\/)(bases\/api|api|services?|repositories?|clients?)(\/|$)/.test(normalized);
    const isUtilsFile = /(^|\/)(lib|utils?|helpers?)(\/|$)/.test(normalized);
    const isTypeSupportFile = /\.d\.[cm]?ts$/u.test(normalizedBaseName)
      || normalizedBaseName.includes("shims")
      || normalizedBaseName.includes("global.d.ts");
    const isUiComponentFile = /(^|\/)components(\/|$)/.test(normalized);
    const isFormFile = /(^|\/)(components\/forms?|forms?|form-components)(\/|$)/.test(normalized)
      || normalizedBaseStem === "form"
      || normalizedBaseStem.endsWith("form")
      || normalizedComponentName.endsWith("form");

    if (isTestFile) {
      return "Test";
    }
    if (isStoryFile) {
      return "Story";
    }
    if (isFixtureFile) {
      return "Fixture";
    }
    if (isStorybookSupportFile) {
      return "Storybook Support";
    }
    if (isConfigFile) {
      return "Config";
    }
    if (isBarrel) {
      return "Barrel";
    }
    if (isRouteFile) {
      return "Route";
    }
    if (isSchemaFile) {
      return "Schema";
    }
    if (isValidationFile) {
      return "Validation";
    }
    if (isLayoutFile) {
      if (isUiLibraryFile) {
        return "UI component";
      }
      return "Layout";
    }
    if (isFeatureFile) {
      return "Feature";
    }
    if (isHookFile) {
      return "Hook";
    }
    if (isContextStateFile) {
      return "Context/State";
    }
    if (isApiInfrastructureFile) {
      return "API/Infrastructure";
    }
    if (isUtilsFile) {
      return "Utils";
    }
    if (isTypeSupportFile) {
      return "Type Support";
    }
    if (isUiComponentFile && !isFormFile) {
      return "UI component";
    }
    if (isFormFile) {
      return "Form";
    }
    return "Shared";
  }

  private hasCorrespondingTestFile(filePath: string, testTargets: Set<string>): boolean {
    if (this.classifyFileType(filePath) === "Test") {
      return true;
    }

    const sourceKeys = this.buildSourceMatchKeys(filePath);
    return sourceKeys.some((key) => testTargets.has(key));
  }

  private collectTestTargetKeys(): Set<string> {
    const targets = new Set<string>();

    for (const result of this.analysisResults) {
      if (this.classifyFileType(result.filePath) !== "Test") {
        continue;
      }

      for (const key of this.buildTestTargetKeys(result.filePath)) {
        targets.add(key);
      }
    }

    return targets;
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

  private buildTestTargetKeys(filePath: string): string[] {
    const withoutExt = this.toDisplayPath(filePath)
      .split(path.sep)
      .join("/")
      .replace(/\.[cm]?[jt]sx?$/iu, "");
    const normalizedPath = withoutExt
      .split("/")
      .filter((segment) => segment !== "__tests__" && segment !== "tests")
      .join("/")
      .replace(/\.(test|spec)$/iu, "")
      .toLowerCase();
    const keys = new Set<string>([normalizedPath]);

    if (normalizedPath.startsWith("src/")) {
      keys.add(normalizedPath.slice(4));
    } else if (!normalizedPath.startsWith("/") && normalizedPath.length > 0) {
      keys.add(`src/${normalizedPath}`);
    }

    return Array.from(keys).filter(Boolean);
  }

  private normalizeMatchPath(filePath: string): string {
    return this.toDisplayPath(filePath)
      .split(path.sep)
      .join("/")
      .replace(/\.[cm]?[jt]sx?$/iu, "")
      .toLowerCase();
  }

  private classifySizeComplexityCluster(codeLines: number, complexity: number): string {
    const sizeBand = this.classifyCodeLineBand(codeLines);
    const complexityBand = this.classifyComplexityBand(complexity);
    return `${sizeBand}-${complexityBand}`;
  }

  private classifyCodeLineBand(codeLines: number): "S" | "M" | "L" {
    if (codeLines <= 100) {
      return "S";
    }
    if (codeLines <= 300) {
      return "M";
    }
    return "L";
  }

  private classifyComplexityBand(complexity: number): "L" | "M" | "H" {
    if (complexity <= 5) {
      return "L";
    }
    if (complexity <= 10) {
      return "M";
    }
    return "H";
  }

  private getHotSpots(threshold: number, limit: number): HotSpotItem[] {
    return this.analysisResults
      .map((result) => {
        const pathLabel = this.toDisplayPath(result.filePath);
        const cluster = this.classifySizeComplexityCluster(result.complexity.codeLines, result.complexity.overallComplexity);
        const dependencies = result.dependencies.length;
        const hooks = result.complexity.hooks.length;
        const anyCount = this.isTypeSafetyTargetFile(result.filePath) ? result.complexity.typeMetrics.anyTypeCount : 0;
        const score = (result.complexity.overallComplexity * 5)
          + (dependencies * 2)
          + (anyCount * 4)
          + hooks
          + this.getClusterWeight(cluster);
        const reasons: string[] = [];

        if (result.complexity.overallComplexity >= threshold) {
          reasons.push(`complexity>=${threshold}`);
        }
        if (cluster.endsWith("-H")) {
          reasons.push(`cluster=${cluster}`);
        }
        if (dependencies >= 5) {
          reasons.push(`dependencies=${dependencies}`);
        }
        if (anyCount > 0) {
          reasons.push(`any=${anyCount}`);
        }
        if (hooks >= 2) {
          reasons.push(`hooks=${hooks}`);
        }
        if (reasons.length === 0) {
          reasons.push(`cluster=${cluster}`);
        }

        return {
          path: result.filePath,
          displayPath: pathLabel,
          score,
          cluster,
          complexity: result.complexity.overallComplexity,
          codeLines: result.complexity.codeLines,
          dependencies,
          hooks,
          anyCount,
          reasons,
          action: this.buildHotSpotAction(result, dependencies, anyCount, hooks),
        };
      })
      .sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath))
      .slice(0, limit);
  }

  private buildHotSpotAction(result: AnalysisResult, dependencies: number, anyCount: number, hooks: number): string {
    if (anyCount > 0) {
      return "explicit anyの除去 + unsafe castの局所化";
    }
    if (dependencies >= 5) {
      return "依存境界の分割 + fan-out削減";
    }
    if (hooks >= 2 && result.complexity.components.length > 0) {
      return "hook分割 + render分岐の分離";
    }
    if (result.complexity.functions.length >= 3) {
      return "大関数の分割 + 補助関数の抽出";
    }
    return "サブコンポーネント化 + shared helper抽出";
  }

  private getClusterWeight(cluster: string): number {
    switch (cluster) {
      case "L-H":
        return 18;
      case "M-H":
        return 12;
      case "L-M":
        return 10;
      case "S-H":
        return 8;
      case "M-M":
        return 6;
      case "L-L":
        return 4;
      case "S-M":
        return 3;
      default:
        return 1;
    }
  }

  private describeCluster(cluster: string): string {
    switch (cluster) {
      case "S-L":
        return "小規模で安定";
      case "S-M":
        return "小規模だが分岐あり";
      case "S-H":
        return "小規模だが高リスク";
      case "M-L":
        return "中規模で管理可能";
      case "M-M":
        return "中規模で中リスク";
      case "M-H":
        return "中規模で高リスク";
      case "L-L":
        return "大規模だが安定";
      case "L-M":
        return "大規模で要注意";
      case "L-H":
        return "大規模で高リスク";
      default:
        return "未分類";
    }
  }

  private getTypeSafetyTotals(): {
    anyCount: number;
    assertionCount: number;
    nonNullAssertionCount: number;
    tsIgnoreCount: number;
  } {
    return this.analysisResults
      .filter((result) => this.isTypeSafetyTargetFile(result.filePath))
      .reduce((totals, result) => ({
        anyCount: totals.anyCount + result.complexity.typeMetrics.anyTypeCount,
        assertionCount: totals.assertionCount + result.complexity.typeMetrics.assertionCount,
        nonNullAssertionCount: totals.nonNullAssertionCount + result.complexity.typeMetrics.nonNullAssertionCount,
        tsIgnoreCount: totals.tsIgnoreCount + result.complexity.typeMetrics.tsIgnoreCount,
      }), {
        anyCount: 0,
        assertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 0,
      });
  }

  private getTypeSafetyScore(result: AnalysisResult): number {
    if (!this.isTypeSafetyTargetFile(result.filePath)) {
      return 0;
    }

    const metrics = result.complexity.typeMetrics;
    return (metrics.anyTypeCount * 4)
      + (metrics.assertionCount * 2)
      + (metrics.nonNullAssertionCount * 2)
      + (metrics.tsIgnoreCount * 5);
  }

  private getStructureRiskScore(result: AnalysisResult): number {
    const dependencyCount = result.dependencies.length;
    const hookCount = result.complexity.hooks.length;
    const codeLines = result.complexity.codeLines;
    const codeLineWeight = codeLines > 300 ? 4 : codeLines > 100 ? 2 : 0;

    return (dependencyCount * 2) + hookCount + codeLineWeight;
  }

  private getStructureRiskLevel(result: AnalysisResult): "low" | "medium" | "high" {
    const score = this.getStructureRiskScore(result);
    if (score <= 8) {
      return "low";
    }
    if (score <= 18) {
      return "medium";
    }
    return "high";
  }

  private getTypeSafetyRiskLevel(result: AnalysisResult): "low" | "medium" | "high" {
    const score = this.getTypeSafetyScore(result);
    if (score === 0) {
      return "low";
    }
    if (score <= 4) {
      return "medium";
    }
    return "high";
  }

  private buildRiskBreakdown(selector: (result: AnalysisResult) => "low" | "medium" | "high"): RiskAxisBreakdown {
    return this.analysisResults.reduce<RiskAxisBreakdown>((totals, result) => {
      totals[selector(result)] += 1;
      return totals;
    }, { low: 0, medium: 0, high: 0 });
  }

  private buildTypeSafetyRiskBreakdown(): RiskAxisBreakdown {
    return this.analysisResults.reduce<RiskAxisBreakdown>((totals, result) => {
      if (!this.isTypeSafetyTargetFile(result.filePath)) {
        return totals;
      }
      totals[this.getTypeSafetyRiskLevel(result)] += 1;
      return totals;
    }, { low: 0, medium: 0, high: 0 });
  }

  private getPrimaryRiskAxisLabel(filePath: string): string {
    const result = this.analysisResults.find((entry) => entry.filePath === filePath);
    if (!result) {
      return "構造";
    }

    const complexityScore = result.complexity.overallComplexity;
    const structureScore = this.getStructureRiskScore(result);
    const typeSafetyScore = this.getTypeSafetyScore(result);
    const maxScore = Math.max(complexityScore, structureScore, typeSafetyScore);

    if (maxScore === typeSafetyScore && typeSafetyScore > 0) {
      return "型安全性";
    }
    if (maxScore === complexityScore && complexityScore >= structureScore) {
      return "複雑度";
    }
    return "構造";
  }

  private getExternalLibraryStatsByContext(limit: number): ExternalDependencyGroup[] {
    const buckets = new Map<string, Map<string, number>>([
      ["runtime", new Map<string, number>()],
      ["storybook", new Map<string, number>()],
      ["test", new Map<string, number>()],
      ["dev", new Map<string, number>()],
    ]);

    for (const result of this.analysisResults) {
      for (const dependency of result.dependencies) {
        if (!dependency.isExternal) {
          continue;
        }
        const packageName = dependency.target || dependency.modulePath;
        const context = this.classifyExternalDependencyContext(result.filePath, packageName);
        const bucket = buckets.get(context)!;
        bucket.set(packageName, (bucket.get(packageName) ?? 0) + 1);
      }
    }

    return [
      { key: "runtime", label: "Runtime 外部ライブラリ Top 10" },
      { key: "storybook", label: "Storybook 外部ライブラリ Top 10" },
      { key: "test", label: "Test 外部ライブラリ Top 10" },
      { key: "dev", label: "Dev 外部ライブラリ Top 10" },
    ].map(({ key, label }) => {
      const items = Array.from(buckets.get(key)!.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, limit);
      const totalCount = Array.from(buckets.get(key)!.values()).reduce((sum, count) => sum + count, 0);

      return { label, totalCount, items };
    });
  }

  private classifyExternalDependencyContext(filePath: string, packageName: string): "runtime" | "storybook" | "test" | "dev" {
    const normalizedPath = this.toDisplayPath(filePath).toLowerCase();
    const normalizedPackage = packageName.toLowerCase();
    const fileType = this.classifyFileType(filePath);

    if (normalizedPackage.startsWith("@storybook/") || normalizedPackage === "storybook") {
      return "storybook";
    }
    if (/^(vitest|jest|@testing-library\/|jsdom|happy-dom)\b/u.test(normalizedPackage)) {
      return "test";
    }
    if (fileType === "Story" || fileType === "Storybook Support" || normalizedPath.startsWith(".storybook/")) {
      return "storybook";
    }
    if (fileType === "Test" || fileType === "Type Support" || /(?:^|\/)(test|tests|__tests__)(\/|$)/u.test(normalizedPath)) {
      return "test";
    }
    if (fileType === "Config") {
      return "dev";
    }
    return "runtime";
  }

  private getCycleInsights(limit: number): CycleInsight[] {
    const internalDependencies = this.getInternalDependencies();
    const outDegree = new Map<string, number>();
    for (const dependency of internalDependencies) {
      outDegree.set(dependency.source, (outDegree.get(dependency.source) ?? 0) + 1);
    }

    return this.graphMetrics.cycles.slice(0, limit).map((cycle) => {
      const cycleNodes = new Set(cycle.nodes);
      const cycleDependencies = internalDependencies.filter((dependency) =>
        cycleNodes.has(dependency.source) && cycleNodes.has(dependency.target)
      );
      const cutCandidate = cycleDependencies
        .slice()
        .sort((left, right) => {
          const leftBarrel = this.isBarrelFile(left.source) || this.isBarrelFile(left.target) ? 0 : 1;
          const rightBarrel = this.isBarrelFile(right.source) || this.isBarrelFile(right.target) ? 0 : 1;
          if (leftBarrel !== rightBarrel) {
            return leftBarrel - rightBarrel;
          }
          const leftType = left.type === "export" ? 0 : 1;
          const rightType = right.type === "export" ? 0 : 1;
          if (leftType !== rightType) {
            return leftType - rightType;
          }
          const leftOut = outDegree.get(left.source) ?? 0;
          const rightOut = outDegree.get(right.source) ?? 0;
          if (leftOut !== rightOut) {
            return leftOut - rightOut;
          }
          return `${left.source}->${left.target}`.localeCompare(`${right.source}->${right.target}`);
        })[0] ?? null;

      const barrelInvolved = cycle.nodes.some((node) => this.isBarrelFile(node))
        || cycleDependencies.some((dependency) => this.isBarrelFile(dependency.source) || this.isBarrelFile(dependency.target));
      const sharedCandidate = this.selectSharedCandidate(cycle.nodes, cycleDependencies);

      return {
        nodes: cycle.nodes,
        cutCandidate,
        barrelInvolved,
        sharedCandidate,
      };
    });
  }

  private selectSharedCandidate(cycleNodes: string[], cycleDependencies: Dependency[]): string | null {
    const participation = new Map<string, number>();
    for (const node of cycleNodes) {
      participation.set(node, 0);
    }
    for (const dependency of cycleDependencies) {
      participation.set(dependency.source, (participation.get(dependency.source) ?? 0) + 1);
      participation.set(dependency.target, (participation.get(dependency.target) ?? 0) + 1);
    }

    const preferred = cycleNodes.filter((node) =>
      !["Shared", "UI component", "Storybook Support", "Context/State", "Hook", "API/Infrastructure", "Utils", "Type Support", "Barrel", "Schema", "Validation", "Test", "Story", "Fixture", "Config"]
        .includes(this.classifyFileType(node))
    );
    const candidates = preferred.length > 0 ? preferred : cycleNodes;

    return candidates
      .slice()
      .sort((left, right) => {
        const leftParticipation = participation.get(left) ?? 0;
        const rightParticipation = participation.get(right) ?? 0;
        if (leftParticipation !== rightParticipation) {
          return rightParticipation - leftParticipation;
        }
        const leftResult = this.analysisResults.find((result) => result.filePath === left);
        const rightResult = this.analysisResults.find((result) => result.filePath === right);
        const leftCodeLines = leftResult?.complexity.codeLines ?? Number.MAX_SAFE_INTEGER;
        const rightCodeLines = rightResult?.complexity.codeLines ?? Number.MAX_SAFE_INTEGER;
        if (leftCodeLines !== rightCodeLines) {
          return leftCodeLines - rightCodeLines;
        }
        return left.localeCompare(right);
      })[0] ?? null;
  }

  private getInternalDependencies(): Dependency[] {
    return this.analysisResults.flatMap((result) => result.dependencies.filter((dependency) => !dependency.isExternal));
  }

  private isBarrelFile(filePath: string): boolean {
    return /^index\.(tsx?|jsx?)$/u.test(path.basename(filePath));
  }

  private isTypeSafetyTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return fileType !== "Test" && fileType !== "Story";
  }

  private isExpectedSkip(skipped: SkippedFile): boolean {
    return skipped.reason === "Excluded pattern match" && this.isExpectedExcludedPath(skipped.filePath);
  }

  private isExpectedExcludedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/gu, "/");
    return /(^|\/)(node_modules|dist|build|\.next|coverage|\.git|\.venv)(\/|$)/u.test(normalized)
      || /(^|\/)storybook-static\/assets(\/|$)/u.test(normalized);
  }

  private buildDecisionSummary(threshold: number): DecisionSummaryReport {
    const typeTotals = this.getTypeSafetyTotals();
    return {
      topHotSpots: this.getHotSpots(threshold, 5),
      cycleCount: this.graphMetrics.cycles.length,
      cycleStatus: this.graphMetrics.cycles.length > 0
        ? `${this.graphMetrics.cycles.length} 件の循環依存を検出`
        : "循環依存はありません",
      riskSummary: {
        complexity: this.buildRiskBreakdown((result) => this.getRiskLevel(result.complexity.overallComplexity)),
        structure: this.buildRiskBreakdown((result) => this.getStructureRiskLevel(result)),
        typeSafety: this.buildTypeSafetyRiskBreakdown(),
      },
      typeSafetyAlerts: {
        criticalSignals: typeTotals.anyCount + typeTotals.tsIgnoreCount,
        anyCount: typeTotals.anyCount,
        assertionCount: typeTotals.assertionCount,
        nonNullAssertionCount: typeTotals.nonNullAssertionCount,
        tsIgnoreCount: typeTotals.tsIgnoreCount,
      },
    };
  }
}
