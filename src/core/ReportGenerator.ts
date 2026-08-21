import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { auditDirectoryPurposes } from "./DirectoryPurposeAuditor.js";
import { classifyFileType, getFileTypePurpose, KNOWN_FILE_TYPES } from "./FileConventions.js";
import type {
  AnalysisResult,
  CacheStats,
  DecisionSummaryReport,
  Dependency,
  FunctionMetrics,
  GenerationOptions,
  GraphJSON,
  GraphMetrics,
  HookInfo,
  HotSpotReportItem,
  IncrementalStats,
  ParseIssue,
  PersistedAnalysisReport,
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

const LOW_COMPLEXITY_MAX = 6;
const MEDIUM_COMPLEXITY_MAX = 12;
const PURPOSE_FINDINGS_MARKDOWN_LIMIT = 20;

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
  private readonly displayPathCache = new Map<string, string>();

  async generateReports(
    analysisResults: AnalysisResult[],
    graphMetrics: GraphMetrics,
    options: GenerationOptions,
  ): Promise<PersistedAnalysisReport> {
    this.analysisResults = analysisResults;
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    this.displayPathCache.clear();
    this.graphMetrics = graphMetrics;
    this.executionTime = Math.max(1, options.executionTimeMs ?? (Date.now() - this.startTime));

    await fs.mkdir(options.outputDir, { recursive: true });
    const formats = options.formats.includes("all")
      ? ["json", "markdown", "csv", "html"]
      : options.formats;
    const persistedReport = this.buildPersistedReport(options);

    if (formats.includes("csv")) {
      await this.generateCSVReports(options.outputDir, options.prefix);
    }
    if (formats.includes("markdown")) {
      await this.generateMarkdownReport(options.outputDir, options.prefix, options);
    }
    if (formats.includes("json")) {
      // 大規模プロジェクトでは数十 MB になるため、インデントなしで書き出す
      await fs.writeFile(
        path.join(options.outputDir, `${options.prefix}_report.json`),
        JSON.stringify(persistedReport),
        "utf8",
      );
    }
    if (formats.includes("html")) {
      await this.generateHTMLReport(options.outputDir, options.prefix, options);
    }

    return persistedReport;
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
    const bodySections = [
      this.generateDecisionSummarySection(options.complexityThreshold),
      this.generateStatisticsSection(),
      this.generateTypeSafetySection(),
      this.generateDependencyAnalysisSection(),
      this.generateFileTypeDistributionSection(),
      this.generateDirectoryPurposeSection(),
      this.generateMatrixClusterSection(),
      this.generateComponentsSection(),
      this.generateScanSection(options.skippedFiles ?? [], options.scanErrors ?? [], options.parseIssues ?? []),
      this.generateRiskAnalysisSection(options.complexityThreshold),
      this.generateSummarySection(options.cacheStats, options.analysisCacheStats, options.incrementalStats),
      this.generateMetadataSection(),
    ];
    const body = bodySections.map((section) => this.withSectionBreak(section)).join("");
    // 目次は実際に出力したセクション見出しから生成し、リンク切れ・番号ずれを防ぐ
    const markdown = [
      "# TypeScript/React 静的解析レポート",
      this.buildTableOfContents(body),
    ].map((section) => this.withSectionBreak(section)).join("") + body;

    await fs.writeFile(path.join(outputDir, `${prefix}_report.md`), markdown, "utf8");
  }

  private buildTableOfContents(body: string): string {
    const headings = Array.from(body.matchAll(/^## (.+)$/gmu)).map((match) => match[1]!);
    return [
      "## 目次",
      "",
      ...headings.map((heading, index) => `${index + 1}. [${heading}](#${this.toMarkdownAnchor(heading)})`),
      "",
    ].join("\n");
  }

  private toMarkdownAnchor(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
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
      "## 実行サマリー",
      "",
      "レポートの規模と実行条件だけを最後に確認するための要約です。",
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
    const primary = hotSpots[0];

    let markdown = "## 要点\n\n";
    markdown += "ここだけ読めば、いま対応すべきものが分かります。\n\n";
    if (this.analysisResults.length === 0) {
      markdown += "> ⚠ 解析対象が 0 件でした。projectDir の指定、tsconfig の include、除外設定 (exclude) を確認してください。\n\n";
    }
    markdown += `- **最優先ファイル**: ${primary ? primary.displayPath : "なし"}\n`;
    markdown += `- **優先改修候補数**: ${hotSpots.length}\n`;
    markdown += `- **循環依存の状態**: ${decisionSummary.cycleStatus}\n`;
    markdown += `- **複雑度リスク**: 高=${decisionSummary.riskSummary.complexity.high}, 中=${decisionSummary.riskSummary.complexity.medium}\n`;
    markdown += `- **構造リスク**: 高=${decisionSummary.riskSummary.structure.high}, 中=${decisionSummary.riskSummary.structure.medium}\n`;
    markdown += `- **型安全性の警戒信号**: 高=${decisionSummary.riskSummary.typeSafety.high}, 中=${decisionSummary.riskSummary.typeSafety.medium}, any=${decisionSummary.typeSafetyAlerts.anyCount}, ts-ignore=${decisionSummary.typeSafetyAlerts.tsIgnoreCount}\n\n`;

    markdown += "## 優先対応 Top 5\n\n";
    markdown += "この表の上から順に着手すると効率的です。score は複雑度・依存・型安全性・Hooks の合算 (severity: Critical>=120 / High>=80 / Medium>=40 / Low<40)、依存は 内部+外部 の内訳付きです。\n\n";
    if (hotSpots.length === 0) {
      markdown += "優先度の高い改修候補はありません。\n\n";
      return markdown;
    }

    markdown += "| 順位 | ファイル | severity | 主因 | score | 複雑度 | 依存 | any | Hooks | クラスタ | 推奨対応 |\n";
    markdown += "|------|----------|----------|------|-------|----------|------|-----|-------|----------|----------|\n";
    hotSpots.forEach((item, index) => {
      markdown += `| ${index + 1} | ${item.displayPath} | ${this.getHotSpotSeverity(item.score)} | ${this.getPrimaryRiskAxisLabel(item.path)} | ${item.score} | ${item.complexity} | ${this.formatDependencyBreakdown(item.path, item.dependencies)} | ${item.anyCount} | ${item.hooks} | ${item.cluster} | ${item.action} |\n`;
    });
    markdown += "\n";

    if (primary && (primary.complexityDrivers?.length ?? 0) > 0) {
      markdown += "### 最優先ファイルの補足\n\n";
      markdown += `- **対象**: ${primary.displayPath}\n`;
      markdown += `- **score帯**: ${this.getHotSpotSeverity(primary.score)}\n`;
      markdown += `- **クラスタ**: ${primary.cluster}\n`;
      markdown += `- **複雑度内訳**: ${primary.complexityDrivers!.join(", ")}\n`;
      markdown += `- **推奨対応**: ${primary.action}\n`;
      markdown += "- **内訳の見方**: weighted=ファイル代表値 / peakFn=最も複雑な関数 / top3avg=上位3関数の平均 / nesting=最大ネスト深度 / hookPressure=コンポーネントあたりHooks数 / elevatedFns=複雑度5以上または深いネストの関数数\n";
      markdown += "\n";
    }
    return markdown;
  }

  private generateStatisticsSection(): string {
    if (this.analysisResults.length === 0) {
      return "## リスク概況\n\n複雑度・構造・型安全性の偏りだけを短く確認するセクションです。\n\n解析対象ファイルはありません。";
    }

    const complexity = this.buildRiskBreakdown((result) => this.getRiskLevel(result.complexity.overallComplexity));
    const structure = this.buildRiskBreakdown((result) => this.getStructureRiskLevel(result));
    const typeSafety = this.buildTypeSafetyRiskBreakdown();

    return [
      "## リスク概況",
      "",
      "どの軸 (複雑度・構造・型安全性) に問題が偏っているかが分かります。",
      "",
      "| 軸 | 低 | 中 | 高 |",
      "|----|----|----|----|",
      `| 複雑度 | ${complexity.low} | ${complexity.medium} | ${complexity.high} |`,
      `| 構造 | ${structure.low} | ${structure.medium} | ${structure.high} |`,
      `| 型安全性 | ${typeSafety.low} | ${typeSafety.medium} | ${typeSafety.high} |`,
      "",
      "### 判定基準",
      "",
      `- **複雑度**: 平均 / 最大 / 上位3関数平均 / ネスト深度 / render分岐 / hook圧の重み付きスコア（低<=${LOW_COMPLEXITY_MAX}, 中<=${MEDIUM_COMPLEXITY_MAX}）。関数単体の複雑度は分岐数ベースの循環的複雑度で、10 を超えたら分割を検討してください`,
      "- **構造**: 依存数・Hooks 数・コード行数ベース",
      "- **型安全性**: any / assertion / non-null / ts-ignore の重み付きスコアベース",
    ].join("\n");
  }

  private generateRiskAnalysisSection(threshold: number): string {
    const topHotSpotPaths = new Set(this.getHotSpots(threshold, 5).map((item) => item.path));
    const highRiskFiles = this.analysisResults
      .filter((result) => this.isHotSpotTargetFile(result.filePath))
      .filter((result) => result.complexity.overallComplexity >= threshold)
      .filter((result) => !topHotSpotPaths.has(result.filePath))
      .sort((left, right) => right.complexity.overallComplexity - left.complexity.overallComplexity)
      .slice(0, 10);

    if (highRiskFiles.length === 0) {
      return "## 閾値超過ファイル（補足）\n\n優先対応 Top 5 に入らなかった閾値超過ファイルだけを補足表示します。\n\n追加の閾値超過ファイルはありません。\n\n";
    }

    let markdown = "## 閾値超過ファイル（補足）\n\n";
    markdown += "優先対応 Top 5 に入らなかった閾値超過ファイルだけを補足表示します。\n\n";
    for (const file of highRiskFiles) {
      const displayPath = this.toDisplayPath(file.filePath);
      const cluster = this.classifySizeComplexityCluster(file.complexity.codeLines, file.complexity.overallComplexity);
      const complexityDrivers = this.buildComplexityDrivers(file);
      markdown += `- **${displayPath}**\n`;
      markdown += `  理由: matrix=${cluster}, complexity=${file.complexity.overallComplexity}, codeLines=${file.complexity.codeLines}, functions=${file.complexity.functions.length}, hooks=${file.complexity.hooks.length}, any=${file.complexity.typeMetrics.anyTypeCount}, dependencyCount=${file.dependencies.length}\n`;
      markdown += `  複雑度内訳: ${complexityDrivers.join(", ")}\n`;
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
    markdown += `| 行数帯 \\\\ 複雑度 | 低 (<=${LOW_COMPLEXITY_MAX}) | 中 (<=${MEDIUM_COMPLEXITY_MAX}) | 高 (>${MEDIUM_COMPLEXITY_MAX}) |\n`;
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
    markdown += "どの責務にコードが偏っているかが分かります。0 件の種別は省略しています。\n\n";
    markdown += "| ファイル種別 | 件数 | 比率 | 平均複雑度 | 平均コード行数 |\n";
    markdown += "|--------------|------|------|------------|----------------|\n";

    const visibleEntries = Array.from(stats.entries())
      .filter(([, entry]) => entry.count > 0)
      .sort((left, right) => {
        const countDiff = right[1].count - left[1].count;
        if (countDiff !== 0) {
          return countDiff;
        }
        const complexityDiff = right[1].totalComplexity / right[1].count - (left[1].totalComplexity / left[1].count);
        if (complexityDiff !== 0) {
          return complexityDiff;
        }
        return left[0].localeCompare(right[0]);
      });

    for (const [fileType, entry] of visibleEntries) {
      const averageComplexity = entry.count > 0 ? (entry.totalComplexity / entry.count).toFixed(1) : "0.0";
      const averageCodeLines = entry.count > 0 ? (entry.totalCodeLines / entry.count).toFixed(1) : "0.0";
      markdown += `| ${fileType} | ${entry.count} | ${((entry.count / this.analysisResults.length) * 100).toFixed(1)}% | ${averageComplexity} | ${averageCodeLines} |\n`;
    }

    markdown += "\n";
    const riskFocusedEntries = visibleEntries
      .slice()
      .sort((left, right) => {
        const leftAverage = left[1].totalComplexity / left[1].count;
        const rightAverage = right[1].totalComplexity / right[1].count;
        const complexityDiff = rightAverage - leftAverage;
        if (complexityDiff !== 0) {
          return complexityDiff;
        }
        const countDiff = right[1].count - left[1].count;
        if (countDiff !== 0) {
          return countDiff;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, 3);

    if (riskFocusedEntries.length > 0) {
      markdown += "### 要注意種別\n\n";
      markdown += "| ファイル種別 | 件数 | 平均複雑度 | 所見 |\n";
      markdown += "|--------------|------|------------|------|\n";
      for (const [fileType, entry] of riskFocusedEntries) {
        const averageComplexity = entry.totalComplexity / entry.count;
        markdown += `| ${fileType} | ${entry.count} | ${averageComplexity.toFixed(1)} | ${this.describeFileTypeRisk(fileType, averageComplexity, entry.count)} |\n`;
      }
      markdown += "\n";
    }

    const hiddenTypes = KNOWN_FILE_TYPES.length - visibleEntries.length;
    if (hiddenTypes > 0) {
      markdown += `- 0 件の種別 ${hiddenTypes} 件は省略しています。\n\n`;
    }
    return markdown;
  }

  private generateDirectoryPurposeSection(): string {
    if (this.analysisResults.length === 0) {
      return "## ディレクトリ目的と改善提案\n\nディレクトリごとの目的定義と、目的と実装内容のずれを確認します。\n\n解析対象ファイルはありません。\n\n";
    }

    const typeCounts = new Map<string, number>();
    for (const result of this.analysisResults) {
      const fileType = this.classifyFileType(result.filePath);
      typeCounts.set(fileType, (typeCounts.get(fileType) ?? 0) + 1);
    }

    let markdown = "## ディレクトリ目的と改善提案\n\n";
    markdown += "配置ディレクトリから推定した各種別の目的定義と、目的と実装内容が食い違うファイルへの改善提案です。\n\n";
    markdown += "### 種別ごとの目的定義\n\n";
    markdown += "| ファイル種別 | 目的 | 主な配置 | 目的から導かれる期待 |\n";
    markdown += "|--------------|------|----------|----------------------|\n";

    const presentTypes = Array.from(typeCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    for (const [fileType] of presentTypes) {
      const definition = getFileTypePurpose(fileType);
      if (!definition) {
        continue;
      }
      markdown += `| ${fileType} | ${definition.purpose} | ${definition.directoryHints.join(", ")} | ${definition.expectation} |\n`;
    }
    markdown += "\n";

    const audit = auditDirectoryPurposes(this.analysisResults, (filePath) => this.toDisplayPath(filePath));
    markdown += "### 目的に沿った改善提案\n\n";
    if (audit.findings.length === 0) {
      markdown += "目的と実装内容の不整合は検出されませんでした。\n\n";
      return markdown;
    }

    const sharedCount = typeCounts.get("Shared") ?? 0;
    const sharedRatio = this.analysisResults.length > 0 ? sharedCount / this.analysisResults.length : 0;
    if (sharedRatio > 0.5) {
      markdown += `> このプロジェクトは解析対象の ${(sharedRatio * 100).toFixed(0)}% が責務未分類 (Shared) です。React アプリのディレクトリ規約 (features/ や components/ など) に沿っていない可能性が高く、個別ファイルの指摘より先に配置規約の整備を検討してください。\n\n`;
    }

    markdown += `不整合 ${audit.findings.length} 件（high=${audit.summary.high}, medium=${audit.summary.medium}, low=${audit.summary.low}）を検出しました。severity 順に対応してください。\n\n`;
    markdown += "| 対象 | 種別 | severity | 指摘 | 改善提案 |\n";
    markdown += "|------|------|----------|------|----------|\n";

    // 同一ルールの指摘が多発する場合は 1 行に集約し、上位の指摘が埋もれないようにする
    const AGGREGATE_THRESHOLD = 5;
    const countsByRule = new Map<string, number>();
    for (const finding of audit.findings) {
      countsByRule.set(finding.rule, (countsByRule.get(finding.rule) ?? 0) + 1);
    }
    const renderedAggregates = new Set<string>();
    let renderedRows = 0;
    for (const finding of audit.findings) {
      if (renderedRows >= PURPOSE_FINDINGS_MARKDOWN_LIMIT) {
        break;
      }
      const ruleCount = countsByRule.get(finding.rule) ?? 0;
      if (ruleCount >= AGGREGATE_THRESHOLD) {
        if (renderedAggregates.has(finding.rule)) {
          continue;
        }
        renderedAggregates.add(finding.rule);
        markdown += `| ${ruleCount} ファイル（例: ${finding.filePath}） | ${finding.fileType} | ${finding.severity} | ${finding.issue} ほか同種 ${ruleCount - 1} 件 | ${finding.suggestion} 全対象は JSON の \`directoryPurposeAudit\` を参照してください |\n`;
        renderedRows += 1;
        continue;
      }
      markdown += `| ${finding.filePath} | ${finding.fileType} | ${finding.severity} | ${finding.issue} | ${finding.suggestion} |\n`;
      renderedRows += 1;
    }
    markdown += "\n";

    const aggregatedCount = Array.from(renderedAggregates).reduce((sum, rule) => sum + (countsByRule.get(rule) ?? 0), 0);
    const remaining = audit.findings.length - aggregatedCount - (renderedRows - renderedAggregates.size);
    if (remaining > 0) {
      markdown += `- 残り ${remaining} 件は JSON レポートの \`directoryPurposeAudit\` を参照してください。\n\n`;
    }
    return markdown;
  }

  private generateTypeSafetySection(): string {
    const totals = this.getTypeSafetyTotals();
    const allScoredFiles = this.analysisResults
      .filter((result) => this.isTypeSafetyTargetFile(result.filePath))
      .map((result) => ({
        path: this.toDisplayPath(result.filePath),
        score: this.getTypeSafetyScore(result),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const worstFiles = this.analysisResults
      .filter((result) => this.isTypeSafetyTargetFile(result.filePath))
      .map((result) => {
        const metrics = result.complexity.typeMetrics;
        const score = this.getTypeSafetyScore(result);
        return {
          path: this.toDisplayPath(result.filePath),
          anyCount: metrics.anyTypeCount,
          assertionCount: metrics.assertionCount,
          unsafeAssertionCount: metrics.unsafeAssertionCount ?? 0,
          doubleAssertionCount: metrics.doubleAssertionCount ?? 0,
          nonNullAssertionCount: metrics.nonNullAssertionCount,
          tsIgnoreCount: metrics.tsIgnoreCount,
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 10);

    let markdown = "## 型安全性\n\n";
    markdown += "型の逃げ道を件数表にまとめ、問題ファイルだけを下段に残します。\n\n";
    markdown += "| 指標 | 件数 |\n";
    markdown += "|------|------|\n";
    markdown += `| explicit any | ${totals.anyCount} |\n`;
    markdown += `| 型アサーション | ${totals.assertionCount} |\n`;
    markdown += `| unsafe assertion | ${totals.unsafeAssertionCount} |\n`;
    markdown += `| double assertion | ${totals.doubleAssertionCount} |\n`;
    markdown += `| non-null アサーション | ${totals.nonNullAssertionCount} |\n`;
    markdown += `| ts-ignore | ${totals.tsIgnoreCount} |\n`;
    markdown += `| ts-expect-error | ${totals.tsExpectErrorCount} |\n`;
    markdown += `| ts-nocheck | ${totals.tsNoCheckCount} |\n\n`;

    if (worstFiles.length === 0) {
      markdown += "型安全性の警告はありません。\n\n";
      return markdown;
    }

    markdown += "### スコア上位ファイル\n\n";
    markdown += "| ファイル | any | assertions | unsafe | double | non-null | ts-ignore | score |\n";
    markdown += "|----------|-----|------------|--------|--------|----------|-----------|-------|\n";
    for (const item of worstFiles) {
      markdown += `| ${item.path} | ${item.anyCount} | ${item.assertionCount} | ${item.unsafeAssertionCount} | ${item.doubleAssertionCount} | ${item.nonNullAssertionCount} | ${item.tsIgnoreCount} | ${item.score} |\n`;
    }
    markdown += "\n";

    const totalScore = allScoredFiles.reduce((sum, item) => sum + item.score, 0);
    const dominant = allScoredFiles[0];
    if (dominant && totalScore > 0) {
      const topHotSpotPaths = new Set(this.getHotSpots(10, 5).map((item) => item.displayPath));
      const outsideTop = topHotSpotPaths.size > 0 && !topHotSpotPaths.has(dominant.path)
        ? "総合の優先対応 Top 5 には入っていないため、型安全性の観点で個別に対応してください。"
        : "";
      markdown += `- **支配要因**: ${dominant.path} が型逃げスコア全体の ${((dominant.score / totalScore) * 100).toFixed(1)}% を占めます。${outsideTop}\n\n`;
    }
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
      markdown += "循環の経路 (末尾は先頭に戻ります) と、どの import を外せば循環を断てるかを示します。\n\n";
      for (const cycle of cycleInsights) {
        const displayNodes = cycle.nodes.map((node) => this.toDisplayPath(node));
        const loop = [...displayNodes, displayNodes[0]].join(" -> ");
        markdown += `- ${loop}（${cycle.nodes.length} ファイル循環）\n`;
        if (cycle.cutCandidate) {
          markdown += `  切断候補: ${this.toDisplayPath(cycle.cutCandidate.source)} から ${this.toDisplayPath(cycle.cutCandidate.target)} への ${cycle.cutCandidate.type} を外すと循環が解消します\n`;
        } else {
          markdown += "  切断候補: なし\n";
        }
        if (cycle.barrelInvolved) {
          markdown += "  補足: barrel (index) 経由の循環です。index からの再エクスポートを直接 import に変えると切断しやすくなります\n";
        }
        if (cycle.sharedCandidate) {
          markdown += `  補足: 双方が使う部分を ${this.toDisplayPath(cycle.sharedCandidate)} から共通モジュールへ抽出する方法もあります\n`;
        }
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

    // 閾値未満の行を機械的に埋めると「outDegree=0 なのに依存先が多い」のような
    // 虚偽の含意が出るため、意味のある値だけを表示する
    const hubEntries = this.graphMetrics.topInDegree.filter((entry) => entry.degree >= 2).slice(0, 3);
    const fanOutEntries = this.graphMetrics.topOutDegree.filter((entry) => entry.degree >= 3).slice(0, 3);
    const pageRankScores = this.graphMetrics.topPageRank.map((entry) => entry.score);
    const minTopPageRank = pageRankScores.length > 0 ? Math.min(...pageRankScores) : 0;
    const centralEntries = this.graphMetrics.topPageRank
      .filter((entry) => pageRankScores.length > 1 && entry.score > minTopPageRank)
      .slice(0, 3);

    const structureRows = [
      ...hubEntries.map((entry) => ({
        aspect: "ハブ",
        file: this.toDisplayPath(entry.id),
        metric: `inDegree=${entry.degree}`,
        implication: `${entry.degree} モジュールから参照されており、変更の波及が大きい`,
      })),
      ...fanOutEntries.map((entry) => ({
        aspect: "fan-out",
        file: this.toDisplayPath(entry.id),
        metric: `outDegree=${entry.degree}`,
        implication: `${entry.degree} モジュールに依存しており、責務分割の候補`,
      })),
      ...centralEntries.map((entry) => ({
        aspect: "影響中心",
        file: this.toDisplayPath(entry.id),
        metric: `pageRank=${entry.score.toFixed(4)}`,
        implication: "依存グラフの中心に近く、変更が広く波及しやすい",
      })),
    ];

    markdown += "### 構造上位\n\n";
    markdown += "ハブ・fan-out・中心性のうち、注意が必要な水準のものだけを表示します。\n\n";
    if (structureRows.length > 0) {
      markdown += "| 観点 | ファイル | 指標 | 含意 |\n";
      markdown += "|------|----------|------|------|\n";
      for (const row of structureRows) {
        markdown += `| ${row.aspect} | ${row.file} | ${row.metric} | ${row.implication} |\n`;
      }
      markdown += "\n";
    } else {
      markdown += "注意水準 (inDegree>=2, outDegree>=3) に達するハブ・fan-out はありません。\n\n";
    }

    const topInDegree = hubEntries[0];
    const topOutDegree = fanOutEntries[0];
    const topPageRank = centralEntries[0];
    if (topInDegree || topOutDegree || topPageRank) {
      markdown += "### 構造解釈\n\n";
      if (topInDegree) {
        markdown += `- ハブ化: ${this.toDisplayPath(topInDegree.id)} が最も参照される共通依存です (${topInDegree.degree} モジュールから参照)。\n`;
      }
      if (topOutDegree) {
        markdown += `- fan-out過多: ${this.toDisplayPath(topOutDegree.id)} が最も多くの依存先を持つ起点です (${topOutDegree.degree} モジュールに依存)。\n`;
      }
      if (topPageRank) {
        markdown += `- 影響中心: ${this.toDisplayPath(topPageRank.id)} を変更すると波及しやすい構造です。\n`;
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
    markdown += "JSX を返す宣言単位で数えているため、1 ファイル内の複数コンポーネントも含みます。\n\n";

    if (hookHeavy.length > 0) {
      markdown += "### Hooks 多用コンポーネント\n\n";
      markdown += "Hooks の利用が集中しているコンポーネントです。件数の多い Hook から表示します。\n\n";
      markdown += "| コンポーネント | ファイル | Hooks数 | 主な Hooks |\n";
      markdown += "|----------------|----------|---------|------------|\n";
      for (const component of hookHeavy) {
        markdown += `| ${component.name} | ${component.file} | ${component.hookCount} | ${this.summarizeHookUsage(component.hooksUsed)} |\n`;
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
    const generatedSkips = skippedFiles.filter((skipped) => !this.isExpectedSkip(skipped) && this.isGeneratedArtifactSkip(skipped));
    const configuredSkips = skippedFiles.filter((skipped) => !this.isExpectedSkip(skipped) && !this.isGeneratedArtifactSkip(skipped) && this.isConfiguredSkip(skipped));
    const unexpectedSkips = skippedFiles.filter((skipped) => !this.isExpectedSkip(skipped) && !this.isGeneratedArtifactSkip(skipped) && !this.isConfiguredSkip(skipped));

    let markdown = "## スキャン結果\n\n";
    markdown += "外部依存、生成物、設定除外、要調査項目を分離して、調べるべきものだけが残るようにしています。\n\n";
    markdown += `- **設定どおりの除外**: ${expectedSkips.length}\n`;
    markdown += `- **生成物の除外**: ${generatedSkips.length}\n`;
    markdown += `- **設定起因の除外**: ${configuredSkips.length}\n`;
    markdown += `- **要調査の除外**: ${unexpectedSkips.length}\n`;
    markdown += `- **スキャンエラー**: ${scanErrors.length}\n`;
    markdown += `- **パースエラー**: ${parseIssues.length}\n\n`;

    if (expectedSkips.length > 0) {
      markdown += "### 設定どおりの除外\n\n";
      markdown += "設定済みの除外対象に一致したため、解析対象から外した項目です。\n\n";
      for (const skipped of expectedSkips.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(skipped.filePath)} (${skipped.reason})\n`;
      }
      markdown += "\n";
    }

    if (generatedSkips.length > 0) {
      markdown += "### 生成物の除外\n\n";
      markdown += "ビルド成果物や出力ディレクトリであり、解析対象に含めるべきではない項目です。\n\n";
      for (const skipped of generatedSkips.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(skipped.filePath)} (${skipped.reason})\n`;
      }
      markdown += "\n";
    }

    if (configuredSkips.length > 0) {
      markdown += "### 設定起因の除外\n\n";
      markdown += "analysis scope や明示設定により、意図的に解析対象外にした項目です。生列挙ではなくカテゴリ別に集約しています。\n\n";
      for (const group of this.groupConfiguredSkips(configuredSkips)) {
        const examples = group.examples.join(", ");
        const remainder = group.count > group.examples.length ? `、他${group.count - group.examples.length}件` : "";
        markdown += `- ${group.label}: ${group.count}件（例: ${examples}${remainder}）\n`;
      }
      markdown += "\n";
    }

    if (unexpectedSkips.length > 0) {
      markdown += "### 要調査の除外\n\n";
      markdown += "サイズ超過や権限問題など、後で確認すべき除外項目です。\n\n";
      for (const skipped of unexpectedSkips.slice(0, 10)) {
        markdown += `- ${this.toDisplayPath(skipped.filePath)} (${skipped.reason})\n`;
      }
      markdown += "\n";
    }

    if (scanErrors.length > 0) {
      markdown += "### スキャンエラー\n\n";
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

  private groupConfiguredSkips(skippedFiles: SkippedFile[]): Array<{ label: string; count: number; examples: string[] }> {
    const groups = new Map<string, { count: number; examples: string[] }>();

    for (const skipped of skippedFiles) {
      const label = this.classifyConfiguredSkipGroup(skipped.filePath);
      if (!groups.has(label)) {
        groups.set(label, { count: 0, examples: [] });
      }

      const group = groups.get(label)!;
      group.count += 1;
      if (group.examples.length < 3) {
        group.examples.push(this.toDisplayPath(skipped.filePath));
      }
    }

    return Array.from(groups.entries())
      .map(([label, entry]) => ({ label, count: entry.count, examples: entry.examples }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }

  private classifyConfiguredSkipGroup(filePath: string): string {
    const displayPath = this.toDisplayPath(filePath).replace(/\\/gu, "/");
    if (/(^|\/)\.storybook(\/|$)/u.test(displayPath)) {
      return "Storybook設定";
    }
    if (/(^|\/)__tests__(\/|$)|(?:^|\/)tests?(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/u.test(displayPath)) {
      return "テストコード";
    }
    if (/\.stories\.[cm]?[jt]sx?$/u.test(displayPath) || /(^|\/)(stories|storybook)(\/|$)/u.test(displayPath)) {
      return "Story";
    }
    if (/(^|\/)(next|vite|vitest|jest)\.config\./u.test(displayPath) || /(^|\/)tsconfig\.json$/u.test(displayPath)) {
      return "設定ファイル";
    }
    return "その他の設定除外";
  }

  private getHotSpotSeverity(score: number): string {
    if (score >= 120) {
      return "Critical";
    }
    if (score >= 80) {
      return "High";
    }
    if (score >= 40) {
      return "Medium";
    }
    return "Low";
  }

  private describeFileTypeRisk(fileType: string, averageComplexity: number, count: number): string {
    if (averageComplexity >= 10) {
      return count >= 5
        ? `${fileType} が高複雑度です。${count} 件に広がっているため横断的な設計見直しが必要です。`
        : `${fileType} が高複雑度です。件数 ${count} 件なので該当ファイルの分割で収束します。`;
    }
    if (count >= 10) {
      return `${fileType} が多数派です。小さな設計崩れでも波及しやすい状態です。`;
    }
    return `${fileType} は局所対応で収まりやすい規模です。`;
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

  private buildPersistedReport(options: GenerationOptions): PersistedAnalysisReport {
    const decisionSummary = this.buildDecisionSummary(options.complexityThreshold);
    // パスは projectDir 相対で永続化する。絶対パスのままだと、別マシンや
    // CI の別ワークスペースで作った baseline と diff したとき全ファイルが
    // added/removed 判定になり比較が成立しない。
    const rel = (filePath: string): string => this.toDisplayPath(filePath);
    const report: PersistedAnalysisReport = {
      timestamp: new Date().toISOString(),
      executionTimeMs: this.executionTime,
      projectRoot: this.projectRoot,
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
        path: rel(result.filePath),
        complexity: result.complexity,
        dependencies: result.dependencies.map((dependency) => ({
          ...dependency,
          source: rel(dependency.source),
          target: dependency.isExternal ? dependency.target : rel(dependency.target),
        })),
        dependencyErrors: result.dependencyErrors,
        warnings: this.generateWarnings(result, options.complexityThreshold),
      })),
      graph: {
        ...this.graphMetrics,
        cycles: this.graphMetrics.cycles.map((cycle) => ({ ...cycle, nodes: cycle.nodes.map(rel) })),
        stronglyConnectedComponents: this.graphMetrics.stronglyConnectedComponents.map((component) => component.map(rel)),
        weaklyConnectedComponents: this.graphMetrics.weaklyConnectedComponents.map((component) => component.map(rel)),
        topPageRank: this.graphMetrics.topPageRank.map((entry) => ({ ...entry, id: rel(entry.id) })),
        topInDegree: this.graphMetrics.topInDegree.map((entry) => ({ ...entry, id: rel(entry.id) })),
        topOutDegree: this.graphMetrics.topOutDegree.map((entry) => ({ ...entry, id: rel(entry.id) })),
      },
      skippedFiles: options.skippedFiles ?? [],
      scanErrors: options.scanErrors ?? [],
      cacheStats: options.cacheStats,
      analysisCacheStats: options.analysisCacheStats,
      incrementalStats: options.incrementalStats,
      graphJson: options.graphJson
        ? {
            nodes: options.graphJson.nodes.map((node) => ({ ...node, id: rel(node.id) })),
            edges: options.graphJson.edges.map((edge) => ({ ...edge, source: rel(edge.source), target: rel(edge.target) })),
          }
        : undefined,
      decisionSummary: {
        ...decisionSummary,
        topHotSpots: decisionSummary.topHotSpots.map((item) => ({ ...item, path: rel(item.path) })),
      },
      directoryPurposeAudit: auditDirectoryPurposes(this.analysisResults, (filePath) => this.toDisplayPath(filePath)),
    };

    return report;
  }

  private async generateHTMLReport(outputDir: string, prefix: string, options: GenerationOptions): Promise<void> {
    const riskLabels: Record<string, string> = { low: "低", medium: "中", high: "高" };
    const rows = this.analysisResults
      .map((result) => {
        const risk = this.getRiskLevel(result.complexity.overallComplexity);
        return `<tr class="${risk}" data-file="${this.escapeHtml(result.filePath)}"><td><a href="${this.toFileHref(result.filePath)}">${this.escapeHtml(this.toDisplayPath(result.filePath))}</a></td><td>${result.complexity.totalLines}</td><td>${result.complexity.overallComplexity}</td><td>${result.complexity.components.length}</td><td>${riskLabels[risk] ?? risk}</td></tr>`;
      })
      .join("\n");
    // md 版の中核である優先対応 Top 5 を HTML でも先頭に出し、両者の結論を揃える
    const decisionSummary = this.buildDecisionSummary(options.complexityThreshold);
    const hotSpotRows = decisionSummary.topHotSpots
      .map((item, index) =>
        `<tr><td>${index + 1}</td><td><a href="${this.toFileHref(item.path)}">${this.escapeHtml(item.displayPath)}</a></td><td>${this.escapeHtml(this.getHotSpotSeverity(item.score))}</td><td>${this.escapeHtml(this.getPrimaryRiskAxisLabel(item.path))}</td><td>${item.score}</td><td>${this.escapeHtml(item.action)}</td></tr>`)
      .join("\n");
    const hotSpotSection = decisionSummary.topHotSpots.length > 0
      ? `<h2>優先対応 Top 5</h2>
  <table>
    <thead><tr><th>順位</th><th>ファイル</th><th>severity</th><th>主因</th><th>score</th><th>推奨対応</th></tr></thead>
    <tbody>${hotSpotRows}</tbody>
  </table>`
      : "<h2>優先対応 Top 5</h2><p>優先度の高い改修候補はありません。</p>";
    // 数千ノードを埋め込むと HTML が肥大しブラウザ描画も破綻するため、
    // 次数上位のノードに絞って可視化する (全量は JSON レポートに保持)
    const HTML_GRAPH_NODE_LIMIT = 300;
    const fullGraph = options.graphJson ?? { nodes: [], edges: [] };
    let graphData = fullGraph;
    let graphTruncatedNote = "";
    if (fullGraph.nodes.length > HTML_GRAPH_NODE_LIMIT) {
      const keptNodes = [...fullGraph.nodes]
        .sort((left, right) => (right.inDegree + right.outDegree) - (left.inDegree + left.outDegree) || left.id.localeCompare(right.id))
        .slice(0, HTML_GRAPH_NODE_LIMIT);
      const keptIds = new Set(keptNodes.map((node) => node.id));
      graphData = {
        nodes: keptNodes,
        edges: fullGraph.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)),
      };
      graphTruncatedNote = `<p>次数上位 ${HTML_GRAPH_NODE_LIMIT} / 全 ${fullGraph.nodes.length} ノードを表示しています。全量は JSON レポートを参照してください。</p>`;
    }

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>TypeScript/React 静的解析レポート</title>
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
  <h1>TypeScript/React 静的解析レポート</h1>
  <div class="meta">
    <div class="card"><strong>対象ファイル</strong><br />${this.analysisResults.length}</div>
    <div class="card"><strong>依存総数</strong><br />${this.graphMetrics.totalDependencies}</div>
    <div class="card"><strong>循環依存</strong><br />${this.graphMetrics.cycles.length}</div>
    <div class="card"><strong>グラフ警告</strong><br />${this.graphMetrics.warnings.length}</div>
    <div class="card"><strong>複雑度閾値</strong><br />${options.complexityThreshold}</div>
    <div class="card"><strong>ファイルキャッシュ</strong><br />${options.cacheStats?.hits ?? 0} hit / ${options.cacheStats?.misses ?? 0} miss</div>
    <div class="card"><strong>解析キャッシュ</strong><br />${options.analysisCacheStats?.hits ?? 0} hit / ${options.analysisCacheStats?.misses ?? 0} miss</div>
    <div class="card"><strong>差分再利用 (Incremental)</strong><br />${options.incrementalStats?.reusedFiles ?? 0} reused / ${options.incrementalStats?.recomputedFiles ?? 0} recomputed</div>
    <div class="card"><strong>生成時刻</strong><br />${new Date().toISOString()}</div>
  </div>
  ${hotSpotSection}
  <h2>依存グラフ (Dependency Graph)</h2>
  <div class="toolbar">
    <button id="reset-filter">フィルタ解除</button>
    <div class="legend">
      <span class="low">被参照 少</span>
      <span class="medium">被参照 中</span>
      <span class="high">被参照 多</span>
      <span>円の大きさ = 依存グラフ上の中心性</span>
    </div>
  </div>
  ${graphTruncatedNote}
  <div id="graph-shell">
    <div id="graph">
      <div id="graph-empty">グラフデータがありません。</div>
    </div>
    <aside id="inspector">
      <strong>選択中</strong>
      <p id="selection-name">なし</p>
      <p id="selection-meta">ノードをクリックするとファイル表を絞り込めます。</p>
    </aside>
  </div>
  <h2>ファイル一覧</h2>
  <table>
    <thead>
      <tr><th>ファイル</th><th>行数</th><th>複雑度</th><th>コンポーネント</th><th>複雑度リスク</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <script>
    const graphData = ${this.serializeForScript(graphData)};
    const tableRows = Array.from(document.querySelectorAll("tbody tr[data-file]"));
    const selectionName = document.getElementById("selection-name");
    const selectionMeta = document.getElementById("selection-meta");
    const graphHost = document.getElementById("graph");
    const emptyState = document.getElementById("graph-empty");
    const SVG_NS = "http://www.w3.org/2000/svg";
    document.getElementById("reset-filter").addEventListener("click", () => {
      for (const row of tableRows) row.style.display = "";
      selectionName.textContent = "なし";
      selectionMeta.textContent = "ノードをクリックするとファイル表を絞り込めます。";
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
    if (complexity <= LOW_COMPLEXITY_MAX) {
      return "low";
    }
    if (complexity <= MEDIUM_COMPLEXITY_MAX) {
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
    // 各セクション・CSV から同じパスに対して繰り返し呼ばれるためメモ化する
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

  private classifyFileType(filePath: string, componentName?: string, hasChildren = false): string {
    return classifyFileType(this.toDisplayPath(filePath), { componentName, hasChildren });
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
      .filter((segment) => segment !== "__tests__" && segment !== "tests" && segment !== "test")
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
    if (complexity <= LOW_COMPLEXITY_MAX) {
      return "L";
    }
    if (complexity <= MEDIUM_COMPLEXITY_MAX) {
      return "M";
    }
    return "H";
  }

  private getHotSpots(threshold: number, limit: number): HotSpotItem[] {
    return this.analysisResults
      .filter((result) => this.isHotSpotTargetFile(result.filePath))
      .map((result) => {
        const pathLabel = this.toDisplayPath(result.filePath);
        const cluster = this.classifySizeComplexityCluster(result.complexity.codeLines, result.complexity.overallComplexity);
        const dependencies = result.dependencies.length;
        const hooks = result.complexity.hooks.length;
        const anyCount = this.isTypeSafetyTargetFile(result.filePath) ? result.complexity.typeMetrics.anyTypeCount : 0;
        const complexityDrivers = this.buildComplexityDrivers(result);
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
          complexityDrivers,
          action: this.buildHotSpotAction(result, dependencies, anyCount, hooks),
        };
      })
      .sort((left, right) => right.score - left.score || left.displayPath.localeCompare(right.displayPath))
      .slice(0, limit);
  }

  private buildHotSpotAction(result: AnalysisResult, dependencies: number, anyCount: number, hooks: number): string {
    // 推奨対応は「主因」列と同じ軸判定から導く。any があるだけで any 除去を
    // 最優先にすると、主因が複雑度のファイルへ的外れな処方が出る。
    const axis = this.getPrimaryRiskAxisLabel(result.filePath);
    const peakFunction = result.complexity.functions.reduce<FunctionMetrics | null>(
      (max, metric) => (!max || metric.cyclomaticComplexity > max.cyclomaticComplexity ? metric : max),
      null,
    );

    if (axis === "型安全性") {
      return anyCount > 0
        ? "explicit anyの除去 + unsafe castの局所化"
        : "型アサーション / non-null assertion の除去";
    }
    if (axis === "複雑度") {
      if (peakFunction && peakFunction.cyclomaticComplexity >= 8) {
        return `最複雑関数 ${peakFunction.name} (複雑度${peakFunction.cyclomaticComplexity}, ${peakFunction.startLine}行目) の分割`;
      }
      if (hooks >= 2 && result.complexity.components.length > 0) {
        return "hook分割 + render分岐の分離";
      }
      if (result.complexity.functions.length > 0) {
        return "大関数の分割 + 補助関数の抽出";
      }
      return "render分岐の分離 + サブコンポーネント化";
    }
    if (dependencies >= 5) {
      return "依存境界の分割 + fan-out削減";
    }
    if (result.complexity.components.length > 0) {
      return "サブコンポーネント化 + shared helper抽出";
    }
    return "依存の整理と責務の明確化";
  }

  private buildComplexityDrivers(result: AnalysisResult): string[] {
    const breakdown = result.complexity.scoreBreakdown;
    const functionComplexities = result.complexity.functions
      .map((metric) => metric.cyclomaticComplexity)
      .sort((left, right) => right - left);
    const peakFunction = result.complexity.functions.reduce<FunctionMetrics | null>(
      (max, metric) => (!max || metric.cyclomaticComplexity > max.cyclomaticComplexity ? metric : max),
      null,
    );
    const peakFunctionComplexity = functionComplexities[0] ?? breakdown?.peakFunctionComplexity ?? 0;
    const topFunctionAverage = functionComplexities.length > 0
      ? functionComplexities.slice(0, 3).reduce((sum, value) => sum + value, 0) / Math.min(functionComplexities.length, 3)
      : (breakdown?.topFunctionAverage ?? 0);
    const peakNestingDepth = Math.max(
      result.complexity.functions.reduce((max, metric) => Math.max(max, metric.maxNestingDepth), 0),
      breakdown?.peakNestingDepth ?? 0,
    );
    const peakRenderComplexity = Math.max(
      ...result.complexity.components.map((component) => component.renderComplexity.complexity),
      breakdown?.peakRenderComplexity ?? 0,
      0,
    );
    const derivedHookPressure = result.complexity.components.length > 0
      ? result.complexity.hooks.length / result.complexity.components.length
      : result.complexity.hooks.length;
    const hookPressure = Math.max(derivedHookPressure, breakdown?.hookPressure ?? 0);
    const elevatedFunctionCount = Math.max(
      result.complexity.functions.filter((metric) => metric.cyclomaticComplexity >= 5 || metric.maxNestingDepth >= 4).length,
      breakdown?.elevatedFunctionCount ?? 0,
    );
    const weightedScore = breakdown && Math.abs(breakdown.weightedScore - result.complexity.overallComplexity) <= 1
      ? breakdown.weightedScore
      : result.complexity.overallComplexity;

    const drivers = [`weighted=${this.formatMetric(weightedScore)}`];
    if (peakFunction && peakFunction.cyclomaticComplexity > 0) {
      drivers.push(`peakFn=${peakFunction.cyclomaticComplexity} (${peakFunction.name}, ${peakFunction.startLine}行目)`);
    } else if (peakFunctionComplexity > 0) {
      drivers.push(`peakFn=${peakFunctionComplexity}`);
    }
    if (functionComplexities.length >= 2) {
      drivers.push(`top3avg=${this.formatMetric(topFunctionAverage)}`);
    }
    if (peakNestingDepth > 0) {
      drivers.push(`nesting=${peakNestingDepth}`);
    }
    if (peakRenderComplexity > 0) {
      drivers.push(`renderPeak=${peakRenderComplexity}`);
    }
    if (hookPressure > 0) {
      drivers.push(`hookPressure=${this.formatMetric(hookPressure)}`);
    }
    if (elevatedFunctionCount > 0) {
      drivers.push(`elevatedFns=${elevatedFunctionCount}`);
    }
    return drivers;
  }

  private summarizeHookUsage(hooks: HookInfo[]): string {
    const counts = new Map<string, number>();
    for (const hook of hooks) {
      counts.set(hook.name, (counts.get(hook.name) ?? 0) + 1);
    }
    const parts = Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const visible = parts.slice(0, 5).map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
    const remainder = parts.length - visible.length;
    return visible.join(", ") + (remainder > 0 ? `, ほか${remainder}種` : "");
  }

  private formatDependencyBreakdown(filePath: string, fallbackTotal: number): string {
    const result = this.analysisResults.find((entry) => entry.filePath === filePath);
    if (!result) {
      return String(fallbackTotal);
    }
    const external = result.dependencies.filter((dependency) => dependency.isExternal).length;
    const internal = result.dependencies.length - external;
    return `${result.dependencies.length} (内${internal}+外${external})`;
  }

  private formatMetric(value: number): string {
    return Number(value.toFixed(2)).toString();
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
    unsafeAssertionCount: number;
    doubleAssertionCount: number;
    nonNullAssertionCount: number;
    tsIgnoreCount: number;
    tsExpectErrorCount: number;
    tsNoCheckCount: number;
  } {
    return this.analysisResults
      .filter((result) => this.isTypeSafetyTargetFile(result.filePath))
      .reduce((totals, result) => ({
        anyCount: totals.anyCount + result.complexity.typeMetrics.anyTypeCount,
        assertionCount: totals.assertionCount + result.complexity.typeMetrics.assertionCount,
        unsafeAssertionCount: totals.unsafeAssertionCount + (result.complexity.typeMetrics.unsafeAssertionCount ?? 0),
        doubleAssertionCount: totals.doubleAssertionCount + (result.complexity.typeMetrics.doubleAssertionCount ?? 0),
        nonNullAssertionCount: totals.nonNullAssertionCount + result.complexity.typeMetrics.nonNullAssertionCount,
        tsIgnoreCount: totals.tsIgnoreCount + result.complexity.typeMetrics.tsIgnoreCount,
        tsExpectErrorCount: totals.tsExpectErrorCount + (result.complexity.typeMetrics.tsExpectErrorCount ?? 0),
        tsNoCheckCount: totals.tsNoCheckCount + (result.complexity.typeMetrics.tsNoCheckCount ?? 0),
      }), {
        anyCount: 0,
        assertionCount: 0,
        unsafeAssertionCount: 0,
        doubleAssertionCount: 0,
        nonNullAssertionCount: 0,
        tsIgnoreCount: 0,
        tsExpectErrorCount: 0,
        tsNoCheckCount: 0,
      });
  }

  private getTypeSafetyScore(result: AnalysisResult): number {
    if (!this.isTypeSafetyTargetFile(result.filePath)) {
      return 0;
    }

    const metrics = result.complexity.typeMetrics;
    return (metrics.anyTypeCount * 4)
      + ((metrics.unsafeAssertionCount ?? 0) * 4)
      + ((metrics.doubleAssertionCount ?? 0) * 5)
      + (Math.max(0, metrics.assertionCount - (metrics.unsafeAssertionCount ?? 0) - (metrics.doubleAssertionCount ?? 0) - (metrics.constAssertionCount ?? 0)) * 1)
      + (metrics.nonNullAssertionCount * 2)
      + (metrics.tsIgnoreCount * 5)
      + ((metrics.tsExpectErrorCount ?? 0) * 4)
      + ((metrics.tsNoCheckCount ?? 0) * 20);
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

  private isHotSpotTargetFile(filePath: string): boolean {
    const fileType = this.classifyFileType(filePath);
    return fileType !== "Test" && fileType !== "Story";
  }

  private isExpectedSkip(skipped: SkippedFile): boolean {
    return skipped.reason === "Excluded pattern match" && this.isExpectedExcludedPath(skipped.filePath);
  }

  private isConfiguredSkip(skipped: SkippedFile): boolean {
    return /^Excluded by analysis scope\b/u.test(skipped.reason);
  }

  private isGeneratedArtifactSkip(skipped: SkippedFile): boolean {
    const normalized = skipped.filePath.replace(/\\/gu, "/");
    if (skipped.reason !== "Excluded pattern match") {
      return false;
    }
    return /(^|\/)(out|storybook-static|coverage|dist|build)(\/|$)/u.test(normalized);
  }

  private isExpectedExcludedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/gu, "/");
    return /(^|\/)(node_modules|\.next|\.git|\.venv)(\/|$)/u.test(normalized)
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
        criticalSignals: typeTotals.anyCount + typeTotals.tsIgnoreCount + typeTotals.tsNoCheckCount,
        anyCount: typeTotals.anyCount,
        assertionCount: typeTotals.assertionCount,
        nonNullAssertionCount: typeTotals.nonNullAssertionCount,
        tsIgnoreCount: typeTotals.tsIgnoreCount,
        tsExpectErrorCount: typeTotals.tsExpectErrorCount,
        tsNoCheckCount: typeTotals.tsNoCheckCount,
        unsafeAssertionCount: typeTotals.unsafeAssertionCount,
        doubleAssertionCount: typeTotals.doubleAssertionCount,
      },
    };
  }
}
