import path from "node:path";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";

import { AnalysisCache, ComplexityAnalyzer, ConfigManager, DependencyAnalyzer, DiffGenerator, FileScanner, GraphBuilder, Logger, ManualQualityInputLoader, QualityDiffGenerator, QualityReportGenerator, ReportGenerator } from "./core/index.js";
import { shouldIncludeInAnalysisScope } from "./core/FileConventions.js";
import type { AnalysisConfig, AnalysisResult, CacheStats, GraphJSON, GraphMetrics, IncrementalStats, ManualQualityMetricInput, ParseIssue, PersistedAnalysisReport, QualityDiffReport, QualityMetricDiffEntry, QualityReport } from "./types/index.js";

interface RunArtifacts {
  results: AnalysisResult[];
  allResults: AnalysisResult[];
  scanResult: Awaited<ReturnType<FileScanner["scanProject"]>>;
  fullScanResult: Awaited<ReturnType<FileScanner["scanProject"]>>;
  graphBuilder: GraphBuilder;
  graphJson: GraphJSON;
  graphMetrics: GraphMetrics;
  analysisCacheStats: CacheStats;
  incrementalStats: IncrementalStats;
  parseIssues: ParseIssue[];
}

function printHelp(): void {
  console.log(`ts-react-analyzer

Usage:
  ts-react-analyzer analyze <projectDir> [options]
  ts-react-analyzer graph <projectDir> [options]
  ts-react-analyzer diff <projectDir> [options]
  ts-react-analyzer quality <collect|report|gate|diff> <projectDir> [options]

Options:
  --output <dir>                 report output directory
  --format <formats>             csv,markdown,json,html,all
  --config <path>                custom config file path
  --prefix <name>                report file prefix
  --verbose                      enable debug logging
  --max-file-size <bytes>        skip files larger than the threshold
  --analysis-scope <scope>       all,source-only
  --quality-profile <profile>    application,library-repo
  --complexity-threshold <n>     warning threshold
  --impact-threshold <n>         diff impact score threshold
  --fail-on-impact               exit non-zero when impact threshold is exceeded
  --exclude-groups <groups>      comma-separated exclusion groups
  --exclude-patterns <patterns>  comma-separated regex patterns
  --cache-dir <dir>              cache directory
  --log-file <path>              log file path
  --manual-input <path>          manual quality input json path
  --quality-gate-blocking-metrics <ids>
                                comma-separated metric ids that must fail gate on regression
  --quality-gate-monitoring-metrics <ids>
                                comma-separated metric ids excluded from regression gate
  --max-typecheck-root-names <n> skip TS program creation above this root count
  --baseline <path>              baseline report json path for diff/gate
  --help                         show help
`);
}

async function buildArtifacts(
  projectDir: string,
  config: AnalysisConfig,
  logger: Logger,
  options: { includeUnscopedScan?: boolean } = {},
): Promise<RunArtifacts> {
  const preferUnscopedScan = options.includeUnscopedScan && config.analysisScope !== "all";
  const fullScanResult = await new FileScanner({
    ...config,
    analysisScope: preferUnscopedScan ? "all" : config.analysisScope,
  }).scanProject(projectDir);
  const scopedParsedFiles = fullScanResult.parsed.filter((parsedFile) =>
    shouldIncludeInAnalysisScope(parsedFile.filePath, config.analysisScope)
  );
  const scopedFilePaths = new Set(scopedParsedFiles.map((parsedFile) => parsedFile.filePath));
  const scanResult = {
    ...fullScanResult,
    parsed: scopedParsedFiles,
  };
  logger.info("Scan completed", {
    parsed: fullScanResult.parsed.length,
    scopedParsed: scopedParsedFiles.length,
    skipped: fullScanResult.skipped.length,
    errors: fullScanResult.errors.length,
    fileCacheHits: fullScanResult.cacheStats.hits,
    fileCacheMisses: fullScanResult.cacheStats.misses,
  });

  const analysisCache = new AnalysisCache(config.cacheDir, projectDir, config.tsCompilerOptions);
  await analysisCache.initialize();

  const dependencyAnalyzer = new DependencyAnalyzer(path.resolve(projectDir), config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graphBuilder = new GraphBuilder();
  const results: AnalysisResult[] = [];
  const allResults: AnalysisResult[] = [];
  const parseIssues: ParseIssue[] = [];

  for (const parsedFile of fullScanResult.parsed) {
    const analysisContextHash = dependencyAnalyzer.getAnalysisContextHash(parsedFile.filePath);
    const cached = analysisCache.get(parsedFile.filePath, parsedFile.metadata.sha256, analysisContextHash);
    // parseDiagnosticCount へのアクセスは遅延パースを起動するため、キャッシュヒット時は
    // キャッシュ済みの値を使い、AST を生成しない
    const parseDiagnosticCount = cached
      ? cached.parseDiagnosticCount ?? 0
      : parsedFile.metadata.parseDiagnosticCount;
    if (parseDiagnosticCount > 0 && scopedFilePaths.has(parsedFile.filePath)) {
      parseIssues.push({ filePath: parsedFile.filePath, diagnosticCount: parseDiagnosticCount });
    }
    const result = cached
      ? {
          filePath: parsedFile.filePath,
          complexity: cached.complexity,
          dependencies: cached.dependencies,
          dependencyErrors: cached.dependencyErrors,
        }
      : (() => {
          const dependencyResult = dependencyAnalyzer.extractDependencies(parsedFile.sourceFile, parsedFile.filePath);
          const complexity = complexityAnalyzer.analyzeFile(parsedFile.sourceFile, parsedFile.filePath);
          const freshResult: AnalysisResult = {
            filePath: parsedFile.filePath,
            complexity,
            dependencies: dependencyResult.dependencies,
            dependencyErrors: dependencyResult.errors,
          };
          analysisCache.set(parsedFile.filePath, parsedFile.metadata.sha256, analysisContextHash, {
            complexity,
            dependencies: dependencyResult.dependencies,
            dependencyErrors: dependencyResult.errors,
            parseDiagnosticCount: parsedFile.metadata.parseDiagnosticCount,
          });
          return freshResult;
        })();

    if (scopedFilePaths.has(parsedFile.filePath)) {
      for (const dependency of result.dependencies) {
        if (!dependency.isExternal) {
          graphBuilder.addDependency(dependency.source, dependency.target, {
            type: dependency.type,
            isExternal: dependency.isExternal,
          });
        }
      }

      logger.debug(cached ? "File analyzed from cache" : "File analyzed", {
        filePath: parsedFile.filePath,
        dependencies: result.dependencies.length,
        functions: result.complexity.functions.length,
        components: result.complexity.components.length,
      });
      results.push(result);
    }

    allResults.push(result);
  }

  await analysisCache.persist();
  const pageRanks = graphBuilder.calculatePageRank();
  const graphJson = graphBuilder.exportToJSON();
  const sccs = graphBuilder.detectStronglyConnectedComponents();
  const largestStronglyConnectedComponentSize = sccs.reduce((max, component) => Math.max(max, component.length), 0);
  const topInDegree = [...graphJson.nodes]
    .sort((left, right) => right.inDegree - left.inDegree || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((node) => ({ id: node.id, degree: node.inDegree }));
  const topOutDegree = [...graphJson.nodes]
    .sort((left, right) => right.outDegree - left.outDegree || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((node) => ({ id: node.id, degree: node.outDegree }));
  const graphWarnings = buildGraphWarnings(graphJson, {
    cycles: graphBuilder.detectCycles(),
    largestStronglyConnectedComponentSize,
    topInDegree,
    topOutDegree,
  }, projectDir);
  const graphMetrics: GraphMetrics = {
    cycles: graphBuilder.detectCycles(),
    totalDependencies: results.reduce((sum, result) => sum + result.dependencies.length, 0),
    externalDependencies: results.reduce(
      (sum, result) => sum + result.dependencies.filter((dependency) => dependency.isExternal).length,
      0,
    ),
    stronglyConnectedComponents: sccs,
    weaklyConnectedComponents: graphBuilder.detectWeaklyConnectedComponents(),
    topPageRank: Array.from(pageRanks.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([id, score]) => ({ id, score })),
    topInDegree,
    topOutDegree,
    largestStronglyConnectedComponentSize,
    warnings: graphWarnings,
  };

  return {
    results,
    allResults,
    scanResult: {
      ...scanResult,
      parsed: scopedParsedFiles,
    },
    fullScanResult,
    graphBuilder,
    graphJson,
    graphMetrics,
    analysisCacheStats: analysisCache.getStats(),
    incrementalStats: {
      reusedFiles: analysisCache.getStats().hits,
      recomputedFiles: analysisCache.getStats().misses,
    },
    parseIssues,
  };
}

async function analyzeProject(projectDir: string, config: AnalysisConfig): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Analysis started", { projectDir });
    const artifacts = await buildArtifacts(projectDir, config, logger);

    const reportGenerator = new ReportGenerator();
    await reportGenerator.generateReports(artifacts.results, artifacts.graphMetrics, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: config.outputFormats,
      complexityThreshold: config.complexityThreshold,
      executionTimeMs: Date.now() - startTime,
      projectRoot: projectDir,
      skippedFiles: artifacts.scanResult.skipped,
      scanErrors: artifacts.scanResult.errors,
      parseIssues: artifacts.parseIssues,
      cacheStats: artifacts.scanResult.cacheStats,
      analysisCacheStats: artifacts.analysisCacheStats,
      incrementalStats: artifacts.incrementalStats,
      graphJson: artifacts.graphJson,
    });

    logger.info("Reports generated", {
      outputDir: config.outputDir,
      durationMs: Date.now() - startTime,
      analysisCacheHits: artifacts.analysisCacheStats.hits,
      analysisCacheMisses: artifacts.analysisCacheStats.misses,
    });
    await logger.close();
    return 0;
  } catch (error) {
    logger.error("Analysis failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await logger.close();
    return 1;
  }
}

async function graphProject(projectDir: string, config: AnalysisConfig): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();

  try {
    logger.info("Graph export started", { projectDir });
    const artifacts = await buildArtifacts(projectDir, config, logger);
    await fs.mkdir(config.outputDir, { recursive: true });
    const graphJsonPath = path.join(config.outputDir, `${config.filePrefix}_graph.json`);
    const graphDotPath = path.join(config.outputDir, `${config.filePrefix}_graph.dot`);

    await fs.writeFile(graphJsonPath, JSON.stringify({
      graph: artifacts.graphJson,
      metrics: artifacts.graphMetrics,
    }, null, 2), "utf8");
    await fs.writeFile(graphDotPath, artifacts.graphBuilder.exportToDOT(), "utf8");

    logger.info("Graph export completed", {
      outputDir: config.outputDir,
      graphJsonPath,
      graphDotPath,
      analysisCacheHits: artifacts.analysisCacheStats.hits,
      analysisCacheMisses: artifacts.analysisCacheStats.misses,
    });
    await logger.close();
    return 0;
  } catch (error) {
    logger.error("Graph export failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await logger.close();
    return 1;
  }
}

async function diffProject(projectDir: string, config: AnalysisConfig, baselinePath: string): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Diff started", { projectDir, baselinePath });
    const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as PersistedAnalysisReport;
    const artifacts = await buildArtifacts(projectDir, config, logger);

    const reportGenerator = new ReportGenerator();
    const currentReport = await reportGenerator.generateReports(artifacts.results, artifacts.graphMetrics, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: config.outputFormats,
      complexityThreshold: config.complexityThreshold,
      executionTimeMs: Date.now() - startTime,
      projectRoot: projectDir,
      skippedFiles: artifacts.scanResult.skipped,
      scanErrors: artifacts.scanResult.errors,
      parseIssues: artifacts.parseIssues,
      cacheStats: artifacts.scanResult.cacheStats,
      analysisCacheStats: artifacts.analysisCacheStats,
      incrementalStats: artifacts.incrementalStats,
      graphJson: artifacts.graphJson,
    });

    const currentReportPath = path.join(config.outputDir, `${config.filePrefix}_report.json`);
    const diffGenerator = new DiffGenerator();
    const diff = diffGenerator.compare(currentReport, baseline, baselinePath, currentReportPath);
    await diffGenerator.writeReports(diff, config.outputDir, config.filePrefix, {
      projectRoot: projectDir,
      impactScoreThreshold: config.impactScoreThreshold,
    });

    const thresholdViolations = config.impactScoreThreshold > 0
      ? diff.impact.prioritizedFiles.filter((item) => item.score >= config.impactScoreThreshold)
      : [];

    logger.info("Diff completed", {
      outputDir: config.outputDir,
      changedFiles: diff.summary.changedFiles,
      addedFiles: diff.summary.addedFiles,
      removedFiles: diff.summary.removedFiles,
      impactThreshold: config.impactScoreThreshold,
      thresholdViolations: thresholdViolations.length,
    });

    if (config.failOnImpactThreshold && thresholdViolations.length > 0) {
      logger.error("Impact threshold exceeded", {
        threshold: config.impactScoreThreshold,
        offenders: thresholdViolations.slice(0, 10).map((item) => ({
          path: item.path,
          score: item.score,
        })),
      });
      await logger.close();
      return 2;
    }

    await logger.close();
    return 0;
  } catch (error) {
    logger.error("Diff failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await logger.close();
    return 1;
  }
}

async function qualityProject(
  projectDir: string,
  config: AnalysisConfig,
  mode: "collect" | "report" | "gate" | "diff",
  baselinePath?: string,
): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Quality analysis started", { projectDir, mode });
    const baselineReport = (mode === "diff" || mode === "gate") && baselinePath
      ? JSON.parse(await fs.readFile(baselinePath, "utf8")) as QualityReport
      : undefined;
    const artifacts = await buildArtifacts(projectDir, config, logger, { includeUnscopedScan: true });
    const manualInputPath = config.manualInputPath
      ? path.resolve(config.manualInputPath)
      : path.join(projectDir, "quality.manual.json");
    let manualInputs: ManualQualityMetricInput[] = [];

    try {
      await fs.access(manualInputPath);
      manualInputs = await new ManualQualityInputLoader().load(manualInputPath);
      logger.info("Manual quality input loaded", {
        manualInputPath,
        entries: manualInputs.length,
      });
    } catch {
      logger.debug("Manual quality input not found", { manualInputPath });
    }

    const qualityReportGenerator = new QualityReportGenerator();
    const currentReportPath = path.join(config.outputDir, `${config.filePrefix}_quality_report.json`);
    const qualityDiffGenerator = new QualityDiffGenerator();
    let failingAutomaticMetrics: Array<{ category: string; metric: QualityReport["categories"][number]["metrics"][number] }> = [];
    let diff: QualityDiffReport | undefined;
    let blockingRegressionMetrics: ReturnType<typeof selectBlockingRegressionMetrics> = [];

    const report = await qualityReportGenerator.generateReports({
      projectRoot: projectDir,
      analysisResults: artifacts.results,
      parsedFiles: artifacts.scanResult.parsed,
      testEvidenceResults: artifacts.allResults,
      testEvidenceParsedFiles: artifacts.fullScanResult.parsed,
      graphMetrics: artifacts.graphMetrics,
      executionTimeMs: Date.now() - startTime,
      tsConfigPath: config.tsConfigPath,
      qualityProfile: config.qualityProfile,
      testPresenceSettings: config.testPresenceSettings,
      maxTypeCheckRootNames: config.maxTypeCheckRootNames,
      manualInputs,
    }, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: mode === "diff" && !config.outputFormats.includes("json")
        ? [...config.outputFormats, "json"]
        : config.outputFormats,
      onProgress: (message, metadata) => logger.info(message, metadata),
      // レポート書き出し前に gate 判定とベースライン比較を確定させ、
      // 「ゲート判定」「前回比」を md / html 本文へ反映する
      gate: (builtReport) => {
        failingAutomaticMetrics = builtReport.categories
          .flatMap((category) => category.metrics.map((metric) => ({ category: category.label, metric })))
          .filter(({ metric }) => metric.aggregation === "primary" && metric.automation === "automatic" && metric.verdict === "fail");
        const shouldCompareWithBaseline = Boolean(baselineReport && baselinePath && (mode === "diff" || mode === "gate"));
        diff = shouldCompareWithBaseline
          ? qualityDiffGenerator.compare(builtReport, baselineReport!, baselinePath!, currentReportPath)
          : undefined;
        blockingRegressionMetrics = diff ? selectBlockingRegressionMetrics(diff, config) : [];

        if (mode !== "gate" && !diff) {
          return undefined;
        }
        return {
          mode,
          baselinePath: diff ? baselinePath : undefined,
          baselineOverallVerdict: baselineReport?.summary.overallVerdict,
          regressedCount: diff?.summary.regressedMetrics,
          improvedCount: diff?.summary.improvedMetrics,
          gateVerdict: failingAutomaticMetrics.length > 0 || blockingRegressionMetrics.length > 0 ? "fail" : "pass",
          failingAutomaticMetrics: failingAutomaticMetrics.map(({ category, metric }) => ({
            category,
            label: metric.label,
            actual: metric.actual,
            threshold: metric.threshold,
          })),
          blockingRegressions: blockingRegressionMetrics.map((metric) => ({
            category: metric.categoryLabel,
            label: metric.label,
            baselineVerdict: metric.baselineVerdict ?? "不明",
            currentVerdict: metric.currentVerdict ?? "不明",
          })),
        };
      },
    });

    if (diff) {
      await qualityDiffGenerator.writeReports(diff, config.outputDir, config.filePrefix, config.outputFormats);
    }

    if (mode === "diff") {
      if (!baselineReport || !baselinePath) {
        throw new Error("Quality diff requires a baseline report.");
      }
      if (!diff) {
        throw new Error("Quality diff generation failed.");
      }

      logger.info("Quality diff completed", {
        outputDir: config.outputDir,
        changedCategories: diff.summary.changedCategories,
        changedMetrics: diff.summary.changedMetrics,
        regressedMetrics: diff.summary.regressedMetrics,
        automaticRegressions: diff.summary.automaticRegressions,
        durationMs: Date.now() - startTime,
      });

      await logger.close();
      return 0;
    }

    logger.info("Quality analysis completed", {
      outputDir: config.outputDir,
      overallVerdict: report.summary.overallVerdict,
      automaticFailCount: failingAutomaticMetrics.length,
      automaticRegressionCount: blockingRegressionMetrics.length,
      durationMs: Date.now() - startTime,
    });

    if (mode === "gate" && failingAutomaticMetrics.length > 0) {
      logger.error("Quality gate failed", {
        offenders: failingAutomaticMetrics.slice(0, 10).map(({ category, metric }) => ({
          category,
          metric: metric.label,
          actual: metric.actual,
          threshold: metric.threshold,
        })),
      });
      await logger.close();
      return 2;
    }

    if (mode === "gate" && diff && blockingRegressionMetrics.length > 0) {
      logger.error("Quality gate failed due to automatic regressions", {
        baselinePath,
        blockingMetricIds: config.qualityGateBlockingMetricIds,
        monitoringMetricIds: config.qualityGateMonitoringMetricIds,
        offenders: blockingRegressionMetrics
          .slice(0, 10)
          .map((metric) => ({
            category: metric.categoryLabel,
            metric: metric.label,
            baselineVerdict: metric.baselineVerdict,
            currentVerdict: metric.currentVerdict,
            baselineActual: metric.baselineActual,
            currentActual: metric.currentActual,
          })),
      });
      await logger.close();
      return 2;
    }

    await logger.close();
    return 0;
  } catch (error) {
    logger.error("Quality analysis failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await logger.close();
    return 1;
  }
}

function buildGraphWarnings(
  graphJson: GraphJSON,
  graphStats: {
    cycles: GraphMetrics["cycles"];
    largestStronglyConnectedComponentSize: number;
    topInDegree: GraphMetrics["topInDegree"];
    topOutDegree: GraphMetrics["topOutDegree"];
  },
  projectRoot?: string,
): string[] {
  const toDisplayPath = (filePath: string): string => {
    if (!projectRoot || !path.isAbsolute(filePath)) {
      return filePath;
    }

    const relativePath = path.relative(projectRoot, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return filePath;
    }

    return relativePath.split(path.sep).join("/");
  };
  const warnings: string[] = [];
  const nodeCount = Math.max(graphJson.nodes.length, 1);
  const hubThreshold = Math.max(5, Math.ceil(nodeCount * 0.1));
  const fanOutThreshold = Math.max(5, Math.ceil(nodeCount * 0.18));

  if (graphStats.cycles.length > 0) {
    warnings.push(`循環依存を ${graphStats.cycles.length} 件検出しました。`);
  }
  if (graphStats.largestStronglyConnectedComponentSize >= 4) {
    warnings.push(`最大の強連結成分は ${graphStats.largestStronglyConnectedComponentSize} ファイルにまたがっています。`);
  }
  const topHub = graphStats.topInDegree[0];
  if (topHub && topHub.degree >= hubThreshold) {
    warnings.push(`ハブモジュール警告: ${toDisplayPath(topHub.id)} は ${topHub.degree} モジュールから参照されています。`);
  }
  const topFanOut = graphStats.topOutDegree[0];
  if (topFanOut && topFanOut.degree >= fanOutThreshold) {
    warnings.push(`fan-out 警告: ${toDisplayPath(topFanOut.id)} は ${topFanOut.degree} モジュールに依存しています。`);
  }

  return warnings;
}

function selectBlockingRegressionMetrics(
  diff: QualityDiffReport,
  config: AnalysisConfig,
): QualityMetricDiffEntry[] {
  const monitoringMetricIds = new Set(config.qualityGateMonitoringMetricIds);
  const blockingMetricIds = new Set(config.qualityGateBlockingMetricIds);

  return diff.metrics.filter((metric) => {
    if ((metric.currentAggregation ?? metric.baselineAggregation ?? "primary") !== "primary") {
      return false;
    }
    if (metric.trend !== "regressed" || metric.currentAutomation !== "automatic") {
      return false;
    }
    // 同一判定内の数値悪化 (fail のまま件数増など) は差分レポートで可視化する
    // のみとし、gate はドキュメントどおり判定の悪化 (pass->warn 等) だけで落とす
    if (metric.baselineVerdict === metric.currentVerdict) {
      return false;
    }
    if (monitoringMetricIds.has(metric.id)) {
      return false;
    }
    if (blockingMetricIds.size > 0) {
      return blockingMetricIds.has(metric.id);
    }
    return true;
  });
}

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      format: { type: "string" },
      config: { type: "string" },
      prefix: { type: "string" },
      verbose: { type: "boolean" },
      "max-file-size": { type: "string" },
      "analysis-scope": { type: "string" },
      "quality-profile": { type: "string" },
      "complexity-threshold": { type: "string" },
      "impact-threshold": { type: "string" },
      "fail-on-impact": { type: "boolean" },
      "exclude-groups": { type: "string" },
      "exclude-patterns": { type: "string" },
      "cache-dir": { type: "string" },
      "log-file": { type: "string" },
      "manual-input": { type: "string" },
      "quality-gate-blocking-metrics": { type: "string" },
      "quality-gate-monitoring-metrics": { type: "string" },
      "max-typecheck-root-names": { type: "string" },
      baseline: { type: "string" },
      help: { type: "boolean" },
    },
  });

  const [command, maybeSubcommand, maybeProjectDir] = parsed.positionals;
  const projectDir = command === "quality" ? maybeProjectDir : maybeSubcommand;
  const qualityMode = command === "quality"
    ? (
      maybeSubcommand === "gate"
        ? "gate"
        : maybeSubcommand === "report"
          ? "report"
          : maybeSubcommand === "collect"
            ? "collect"
            : maybeSubcommand === "diff"
              ? "diff"
              : undefined
    )
    : undefined;

  if (parsed.values.help || !command) {
    printHelp();
    return 0;
  }

  const validCommands = ["analyze", "graph", "diff", "quality"];
  if (!validCommands.includes(command) || !projectDir || (command === "quality" && !qualityMode)) {
    printHelp();
    return 1;
  }

  const projectRoot = path.resolve(projectDir);
  const configManager = new ConfigManager();
  const configPath = typeof parsed.values.config === "string"
    ? path.resolve(parsed.values.config)
    : path.join(projectRoot, "analyzer.config.json");
  const tsConfigPath = path.join(projectRoot, "tsconfig.json");
  const dotEnvPath = path.join(projectRoot, ".env");

  const cliConfig = configManager.loadFromCLI({
    output: typeof parsed.values.output === "string" ? parsed.values.output : undefined,
    format: typeof parsed.values.format === "string" ? parsed.values.format : undefined,
    prefix: typeof parsed.values.prefix === "string" ? parsed.values.prefix : undefined,
    verbose: parsed.values.verbose,
    maxFileSize: typeof parsed.values["max-file-size"] === "string" ? parsed.values["max-file-size"] : undefined,
    analysisScope: typeof parsed.values["analysis-scope"] === "string" ? parsed.values["analysis-scope"] : undefined,
    qualityProfile: typeof parsed.values["quality-profile"] === "string" ? parsed.values["quality-profile"] : undefined,
    complexityThreshold: typeof parsed.values["complexity-threshold"] === "string"
      ? parsed.values["complexity-threshold"]
      : undefined,
    impactScoreThreshold: typeof parsed.values["impact-threshold"] === "string"
      ? parsed.values["impact-threshold"]
      : undefined,
    failOnImpactThreshold: parsed.values["fail-on-impact"],
    excludeGroups: typeof parsed.values["exclude-groups"] === "string" ? parsed.values["exclude-groups"] : undefined,
    excludePatterns: typeof parsed.values["exclude-patterns"] === "string" ? parsed.values["exclude-patterns"] : undefined,
    cacheDir: typeof parsed.values["cache-dir"] === "string" ? parsed.values["cache-dir"] : undefined,
    logFile: typeof parsed.values["log-file"] === "string" ? parsed.values["log-file"] : undefined,
    manualInput: typeof parsed.values["manual-input"] === "string" ? parsed.values["manual-input"] : undefined,
    qualityGateBlockingMetrics: typeof parsed.values["quality-gate-blocking-metrics"] === "string"
      ? parsed.values["quality-gate-blocking-metrics"]
      : undefined,
    qualityGateMonitoringMetrics: typeof parsed.values["quality-gate-monitoring-metrics"] === "string"
      ? parsed.values["quality-gate-monitoring-metrics"]
      : undefined,
    maxTypeCheckRootNames: typeof parsed.values["max-typecheck-root-names"] === "string"
      ? parsed.values["max-typecheck-root-names"]
      : undefined,
  });

  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromFile(configPath),
    configManager.loadFromTSConfig(tsConfigPath),
    cliConfig,
    configManager.loadFromDotEnv(dotEnvPath),
    configManager.loadFromEnvironment(),
    {
      projectRoot,
      tsConfigPath,
    },
  );

  if (config.outputFormats.length === 0) {
    config.outputFormats = ["json", "markdown", "csv"];
  }

  config.outputDir = path.resolve(projectRoot, config.outputDir);
  config.cacheDir = path.resolve(projectRoot, config.cacheDir);
  config.logFile = path.resolve(projectRoot, config.logFile);
  if (config.manualInputPath) {
    config.manualInputPath = path.resolve(projectRoot, config.manualInputPath);
  }

  if (command === "graph") {
    return graphProject(projectRoot, config);
  }
  if (command === "diff") {
    const baselinePath = typeof parsed.values.baseline === "string"
      ? path.resolve(parsed.values.baseline)
      : path.join(config.outputDir, `${config.filePrefix}_report.json`);
    return diffProject(projectRoot, config, baselinePath);
  }
  if (command === "quality") {
    if (!qualityMode) {
      printHelp();
      return 1;
    }
    const baselinePath = qualityMode === "diff"
      ? typeof parsed.values.baseline === "string"
        ? path.resolve(parsed.values.baseline)
        : path.join(config.outputDir, `${config.filePrefix}_quality_report.json`)
      : qualityMode === "gate" && typeof parsed.values.baseline === "string"
        ? path.resolve(parsed.values.baseline)
      : undefined;
    return qualityProject(projectRoot, config, qualityMode, baselinePath);
  }

  return analyzeProject(projectRoot, config);
}

const exitCode = await main();
process.exit(exitCode);
