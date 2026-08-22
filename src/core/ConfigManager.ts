import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { AnalysisConfig, AnalysisScope, OutputFormat, QualityProfile, TestPresenceSettings } from "../types/index.js";

const EXCLUDE_GROUP_PATTERNS: Record<string, string[]> = {
  dependencies: [
    "(?:^|[/\\\\])node_modules(?:$|[/\\\\])",
  ],
  "build-output": [
    "(?:^|[/\\\\])dist(?:$|[/\\\\])",
    "(?:^|[/\\\\])build(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.next(?:$|[/\\\\])",
    "(?:^|[/\\\\])out(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.output(?:$|[/\\\\])",
  ],
  coverage: [
    "(?:^|[/\\\\])coverage(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.nyc_output(?:$|[/\\\\])",
  ],
  vcs: [
    "(?:^|[/\\\\])\\.git(?:$|[/\\\\])",
  ],
  "storybook-assets": [
    "(?:^|[/\\\\])storybook-static[/\\\\]assets(?:$|[/\\\\])",
  ],
  "deployment-artifacts": [
    "(?:^|[/\\\\])\\.firebase(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.vercel(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.netlify(?:$|[/\\\\])",
  ],
  "tool-cache": [
    "(?:^|[/\\\\])\\.turbo(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.cache(?:$|[/\\\\])",
    "(?:^|[/\\\\])\\.parcel-cache(?:$|[/\\\\])",
  ],
  "package-distribution": [
    "(?:^|[/\\\\])lib[/\\\\](?:esm|cjs|modern)(?:$|[/\\\\])",
    "(?:^|[/\\\\])(?:esm|cjs|umd)(?:$|[/\\\\])",
  ],
};

export class ConfigManager {
  private readonly defaults: AnalysisConfig;

  constructor() {
    this.defaults = this.loadDefaults();
  }

  getDefaults(): AnalysisConfig {
    return this.withResolvedExcludePatterns(this.cloneConfig(this.defaults));
  }

  getAvailableExcludeGroups(): string[] {
    return Object.keys(EXCLUDE_GROUP_PATTERNS).sort();
  }

  loadFromFile(configPath: string): Partial<AnalysisConfig> {
    if (!configPath || !fs.existsSync(configPath)) {
      return {};
    }

    const content = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content) as Partial<AnalysisConfig>;
    return parsed;
  }

  loadFromTSConfig(tsConfigPath: string): Partial<AnalysisConfig> {
    if (!tsConfigPath || !fs.existsSync(tsConfigPath)) {
      return {};
    }

    const readResult = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
    if (readResult.error) {
      throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"));
    }

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      path.dirname(tsConfigPath),
      undefined,
      tsConfigPath,
    );

    return {
      tsConfigPath,
      tsCompilerOptions: parsed.options,
      pathMappings: parsed.options.paths ?? {},
      excludePatterns: this.mergeExcludePatterns(
        this.defaults.excludePatterns,
        parsed.raw?.exclude,
      ),
    };
  }

  loadFromCLI(args: Record<string, string | boolean | undefined>): Partial<AnalysisConfig> {
    const cliConfig: Partial<AnalysisConfig> = {};

    if (typeof args.analysisScope === "string") {
      cliConfig.analysisScope = this.normalizeAnalysisScope(args.analysisScope);
    }
    if (typeof args.qualityProfile === "string") {
      cliConfig.qualityProfile = this.normalizeQualityProfile(args.qualityProfile);
    }
    if (typeof args.excludeGroups === "string") {
      cliConfig.excludeGroups = args.excludeGroups.split(",").map((value) => value.trim()).filter(Boolean);
    }
    if (typeof args.output === "string") {
      cliConfig.outputDir = args.output;
    }
    if (typeof args.format === "string") {
      cliConfig.outputFormats = args.format.split(",").map((value) => value.trim()) as OutputFormat[];
    }
    if (typeof args.prefix === "string") {
      cliConfig.filePrefix = args.prefix;
    }
    if (typeof args.excludePatterns === "string") {
      cliConfig.excludePatterns = args.excludePatterns.split(",").map((value) => value.trim());
    }
    if (typeof args.complexityThreshold === "string") {
      cliConfig.complexityThreshold = Number.parseInt(args.complexityThreshold, 10);
    }
    if (typeof args.impactScoreThreshold === "string") {
      cliConfig.impactScoreThreshold = Number.parseInt(args.impactScoreThreshold, 10);
    }
    if (typeof args.maxFileSize === "string") {
      cliConfig.maxFileSizeBytes = Number.parseInt(args.maxFileSize, 10);
    }
    if (typeof args.cacheDir === "string") {
      cliConfig.cacheDir = args.cacheDir;
    }
    if (typeof args.verbose === "boolean") {
      cliConfig.verbose = args.verbose;
    }
    if (typeof args.failOnImpactThreshold === "boolean") {
      cliConfig.failOnImpactThreshold = args.failOnImpactThreshold;
    }
    if (typeof args.logFile === "string") {
      cliConfig.logFile = args.logFile;
    }
    if (typeof args.manualInput === "string") {
      cliConfig.manualInputPath = args.manualInput;
    }
    if (typeof args.qualityGateBlockingMetrics === "string") {
      cliConfig.qualityGateBlockingMetricIds = args.qualityGateBlockingMetrics
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (typeof args.qualityGateMonitoringMetrics === "string") {
      cliConfig.qualityGateMonitoringMetricIds = args.qualityGateMonitoringMetrics
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (typeof args.maxTypeCheckRootNames === "string") {
      cliConfig.maxTypeCheckRootNames = Number.parseInt(args.maxTypeCheckRootNames, 10);
    }

    return cliConfig;
  }

  loadFromDotEnv(dotEnvPath: string): Partial<AnalysisConfig> {
    if (!dotEnvPath || !fs.existsSync(dotEnvPath)) {
      return {};
    }

    const envVars: Record<string, string> = {};
    const content = fs.readFileSync(dotEnvPath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
      envVars[key] = value;
    }

    return this.loadFromEnvironment(envVars);
  }

  loadFromEnvironment(env: NodeJS.ProcessEnv = process.env): Partial<AnalysisConfig> {
    const envConfig: Partial<AnalysisConfig> = {};

    if (env.ANALYZER_ANALYSIS_SCOPE) {
      envConfig.analysisScope = this.normalizeAnalysisScope(env.ANALYZER_ANALYSIS_SCOPE);
    }
    if (env.ANALYZER_QUALITY_PROFILE) {
      envConfig.qualityProfile = this.normalizeQualityProfile(env.ANALYZER_QUALITY_PROFILE);
    }
    if (env.ANALYZER_EXCLUDE_GROUPS) {
      envConfig.excludeGroups = env.ANALYZER_EXCLUDE_GROUPS.split(",").map((value) => value.trim()).filter(Boolean);
    }
    if (env.ANALYZER_OUTPUT_DIR) {
      envConfig.outputDir = env.ANALYZER_OUTPUT_DIR;
    }
    if (env.ANALYZER_FORMATS) {
      envConfig.outputFormats = env.ANALYZER_FORMATS.split(",").map((value) => value.trim()) as OutputFormat[];
    }
    if (env.ANALYZER_PREFIX) {
      envConfig.filePrefix = env.ANALYZER_PREFIX;
    }
    if (env.ANALYZER_VERBOSE) {
      envConfig.verbose = env.ANALYZER_VERBOSE === "true";
    }
    if (env.ANALYZER_CACHE_DIR) {
      envConfig.cacheDir = env.ANALYZER_CACHE_DIR;
    }
    if (env.ANALYZER_MAX_FILE_SIZE) {
      envConfig.maxFileSizeBytes = Number.parseInt(env.ANALYZER_MAX_FILE_SIZE, 10);
    }
    if (env.ANALYZER_COMPLEXITY_THRESHOLD) {
      envConfig.complexityThreshold = Number.parseInt(env.ANALYZER_COMPLEXITY_THRESHOLD, 10);
    }
    if (env.ANALYZER_IMPACT_SCORE_THRESHOLD) {
      envConfig.impactScoreThreshold = Number.parseInt(env.ANALYZER_IMPACT_SCORE_THRESHOLD, 10);
    }
    if (env.ANALYZER_FAIL_ON_IMPACT_THRESHOLD) {
      envConfig.failOnImpactThreshold = env.ANALYZER_FAIL_ON_IMPACT_THRESHOLD === "true";
    }
    if (env.ANALYZER_LOG_FILE) {
      envConfig.logFile = env.ANALYZER_LOG_FILE;
    }
    if (env.ANALYZER_MANUAL_INPUT) {
      envConfig.manualInputPath = env.ANALYZER_MANUAL_INPUT;
    }
    if (env.ANALYZER_QUALITY_GATE_BLOCKING_METRICS) {
      envConfig.qualityGateBlockingMetricIds = env.ANALYZER_QUALITY_GATE_BLOCKING_METRICS
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (env.ANALYZER_QUALITY_GATE_MONITORING_METRICS) {
      envConfig.qualityGateMonitoringMetricIds = env.ANALYZER_QUALITY_GATE_MONITORING_METRICS
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (env.ANALYZER_MAX_TYPECHECK_ROOT_NAMES) {
      envConfig.maxTypeCheckRootNames = Number.parseInt(env.ANALYZER_MAX_TYPECHECK_ROOT_NAMES, 10);
    }

    return envConfig;
  }

  mergeConfigs(...configs: Array<Partial<AnalysisConfig>>): AnalysisConfig {
    const merged = this.cloneConfig(this.defaults);

    for (const config of configs) {
      if (!config) {
        continue;
      }

      for (const [key, value] of Object.entries(config)) {
        if (value === undefined) {
          continue;
        }

        if (key === "analysisScope" && typeof value === "string") {
          const normalizedScope = this.normalizeAnalysisScope(value);
          if (normalizedScope) {
            merged.analysisScope = normalizedScope;
          }
          continue;
        }

        if (key === "qualityProfile" && typeof value === "string") {
          const normalizedProfile = this.normalizeQualityProfile(value);
          if (normalizedProfile) {
            merged.qualityProfile = normalizedProfile;
          }
          continue;
        }

        if (key === "excludeGroups" && Array.isArray(value)) {
          merged.excludeGroups = [...new Set([
            ...merged.excludeGroups,
            ...value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
          ])];
          continue;
        }

        if (key === "excludePatterns" && Array.isArray(value)) {
          merged.excludePatterns = [...new Set([
            ...merged.excludePatterns,
            ...value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
          ])];
          continue;
        }

        if (key === "outputFormats" && Array.isArray(value)) {
          merged.outputFormats = [...value] as OutputFormat[];
          continue;
        }

        if ((key === "qualityGateBlockingMetricIds" || key === "qualityGateMonitoringMetricIds") && Array.isArray(value)) {
          (merged as unknown as Record<string, unknown>)[key] = [...value];
          continue;
        }

        if (key === "pathMappings") {
          merged.pathMappings = { ...merged.pathMappings, ...(value as Record<string, string[]>) };
          continue;
        }

        if (key === "testPresenceSettings") {
          merged.testPresenceSettings = this.mergeTestPresenceSettings(merged.testPresenceSettings, value);
          continue;
        }

        if (key === "tsCompilerOptions") {
          merged.tsCompilerOptions = {
            ...merged.tsCompilerOptions,
            ...(value as ts.CompilerOptions),
          };
          continue;
        }

        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }

    return this.withResolvedExcludePatterns(merged);
  }

  private loadDefaults(): AnalysisConfig {
    return {
      analysisScope: "all",
      qualityProfile: "application",
      testPresenceSettings: this.defaultTestPresenceSettings(),
      excludeGroups: [
        "dependencies",
        "build-output",
        "coverage",
        "vcs",
        "storybook-assets",
        "deployment-artifacts",
        "tool-cache",
      ],
      excludePatterns: [],
      outputFormats: ["json", "markdown", "csv"],
      outputDir: "./analysis-reports",
      filePrefix: "analysis",
      complexityThreshold: 12,
      impactScoreThreshold: 0,
      failOnImpactThreshold: false,
      maxFileSizeBytes: 10 * 1024 * 1024,
      verbose: false,
      enableCache: true,
      cacheDir: "./.ts-analyzer-cache",
      logFile: "./analysis.log",
      manualInputPath: undefined,
      qualityGateBlockingMetricIds: [],
      qualityGateMonitoringMetricIds: [],
      maxTypeCheckRootNames: 5000,
      tsCompilerOptions: {},
      pathMappings: {},
    };
  }

  private cloneConfig(config: AnalysisConfig): AnalysisConfig {
    return {
      ...config,
      analysisScope: config.analysisScope,
      qualityProfile: config.qualityProfile,
      testPresenceSettings: this.cloneTestPresenceSettings(config.testPresenceSettings),
      excludeGroups: [...config.excludeGroups],
      excludePatterns: [...config.excludePatterns],
      outputFormats: [...config.outputFormats],
      qualityGateBlockingMetricIds: [...config.qualityGateBlockingMetricIds],
      qualityGateMonitoringMetricIds: [...config.qualityGateMonitoringMetricIds],
      maxTypeCheckRootNames: config.maxTypeCheckRootNames,
      tsCompilerOptions: { ...config.tsCompilerOptions },
      pathMappings: { ...config.pathMappings },
    };
  }

  private mergeExcludePatterns(defaults: string[], custom: unknown): string[] {
    if (!Array.isArray(custom)) {
      return [...defaults];
    }

    // tsconfig の exclude は glob なので、正規表現へ変換してから合流する。
    // 素通しすると "out" が "checkout.ts" に部分一致するなど無関係なファイルを除外してしまう。
    const converted = custom
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => this.tsconfigGlobToRegexPattern(value));
    return [...new Set([...defaults, ...converted])];
  }

  private tsconfigGlobToRegexPattern(glob: string): string {
    const anyDeep = "\u0000";
    const anySegmentChars = "\u0001";
    const anySegmentChar = "\u0002";
    const separator = "[/\\\\]";
    const segmentChar = "[^/\\\\]";

    const normalized = glob.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    const body = normalized
      .replace(/[.+^${}()|[\]]/gu, "\\$&")
      .replace(/\*\*/gu, anyDeep)
      .replace(/\*/gu, anySegmentChars)
      .replace(/\?/gu, anySegmentChar)
      .replace(/\//gu, separator)
      .replaceAll(anyDeep, ".*")
      .replaceAll(anySegmentChars, `${segmentChar}*`)
      .replaceAll(anySegmentChar, segmentChar);
    return `(?:^|${separator})${body}(?:$|${separator})`;
  }

  private withResolvedExcludePatterns(config: AnalysisConfig): AnalysisConfig {
    const groupPatterns = config.excludeGroups.flatMap((group) => EXCLUDE_GROUP_PATTERNS[group] ?? []);
    return {
      ...config,
      excludePatterns: [...new Set([...groupPatterns, ...config.excludePatterns])],
    };
  }

  private normalizeAnalysisScope(value: string | undefined): AnalysisScope | undefined {
    if (value === "all" || value === "source-only") {
      return value;
    }
    return undefined;
  }

  private normalizeQualityProfile(value: string | undefined): QualityProfile | undefined {
    if (value === "application" || value === "library-repo") {
      return value;
    }
    return undefined;
  }

  private defaultTestPresenceSettings(): TestPresenceSettings {
    return {
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

  private mergeTestPresenceSettings(current: TestPresenceSettings, value: unknown): TestPresenceSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.cloneTestPresenceSettings(current);
    }

    const next = this.cloneTestPresenceSettings(current);
    const record = value as Record<string, unknown>;
    const thresholds = record.thresholds;
    if (thresholds && typeof thresholds === "object" && !Array.isArray(thresholds)) {
      for (const profile of ["application", "library-repo"] as const) {
        const rawThreshold = (thresholds as Record<string, unknown>)[profile];
        if (!rawThreshold || typeof rawThreshold !== "object" || Array.isArray(rawThreshold)) {
          continue;
        }
        const pass = this.readFiniteNumber((rawThreshold as Record<string, unknown>).pass);
        const warn = this.readFiniteNumber((rawThreshold as Record<string, unknown>).warn);
        if (pass !== null) {
          next.thresholds[profile].pass = pass;
        }
        if (warn !== null) {
          next.thresholds[profile].warn = warn;
        }
      }
    }

    const bucketWeights = record.bucketWeights;
    if (bucketWeights && typeof bucketWeights === "object" && !Array.isArray(bucketWeights)) {
      for (const key of Object.keys(next.bucketWeights) as Array<keyof TestPresenceSettings["bucketWeights"]>) {
        const value = this.readFiniteNumber((bucketWeights as Record<string, unknown>)[key]);
        if (value !== null) {
          next.bucketWeights[key] = value;
        }
      }
    }

    const staticDepth = this.readFiniteNumber(record.staticImportTraversalMaxDepth);
    if (staticDepth !== null) {
      next.staticImportTraversalMaxDepth = Math.max(0, Math.trunc(staticDepth));
    }

    const minCoverage = this.readFiniteNumber(record.runtimeLineCoverageMinPercent);
    if (minCoverage !== null) {
      next.runtimeLineCoverageMinPercent = Math.max(0, minCoverage);
    }

    const knownCallNames = this.readStringArray(record.knownCallNames);
    if (knownCallNames) {
      next.knownCallNames = knownCallNames;
    }

    const knownFrameworkModules = this.readStringArray(record.knownFrameworkModules);
    if (knownFrameworkModules) {
      next.knownFrameworkModules = knownFrameworkModules;
    }

    return next;
  }

  private readFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private readStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
      return null;
    }
    const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return entries.length > 0 ? entries : [];
  }
}
