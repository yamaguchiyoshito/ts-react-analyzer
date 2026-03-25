import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type { AnalysisConfig, OutputFormat } from "../types/index.js";

export class ConfigManager {
  private readonly defaults: AnalysisConfig;

  constructor() {
    this.defaults = this.loadDefaults();
  }

  getDefaults(): AnalysisConfig {
    return this.cloneConfig(this.defaults);
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

        if (key === "excludePatterns" && Array.isArray(value)) {
          merged.excludePatterns = [...value];
          continue;
        }

        if (key === "outputFormats" && Array.isArray(value)) {
          merged.outputFormats = [...value] as OutputFormat[];
          continue;
        }

        if (key === "pathMappings") {
          merged.pathMappings = { ...merged.pathMappings, ...(value as Record<string, string[]>) };
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

    return merged;
  }

  private loadDefaults(): AnalysisConfig {
    return {
      excludePatterns: [
        "(?:^|[/\\\\])node_modules(?:$|[/\\\\])",
        "(?:^|[/\\\\])dist(?:$|[/\\\\])",
        "(?:^|[/\\\\])build(?:$|[/\\\\])",
        "(?:^|[/\\\\])\\.next(?:$|[/\\\\])",
        "(?:^|[/\\\\])coverage(?:$|[/\\\\])",
        "(?:^|[/\\\\])\\.git(?:$|[/\\\\])",
      ],
      outputFormats: ["json", "markdown", "csv"],
      outputDir: "./analysis-reports",
      filePrefix: "analysis",
      complexityThreshold: 10,
      impactScoreThreshold: 0,
      failOnImpactThreshold: false,
      maxFileSizeBytes: 10 * 1024 * 1024,
      verbose: false,
      enableCache: true,
      cacheDir: "./.ts-analyzer-cache",
      logFile: "./analysis.log",
      tsCompilerOptions: {},
      pathMappings: {},
    };
  }

  private cloneConfig(config: AnalysisConfig): AnalysisConfig {
    return {
      ...config,
      excludePatterns: [...config.excludePatterns],
      outputFormats: [...config.outputFormats],
      tsCompilerOptions: { ...config.tsCompilerOptions },
      pathMappings: { ...config.pathMappings },
    };
  }

  private mergeExcludePatterns(defaults: string[], custom: unknown): string[] {
    if (!Array.isArray(custom)) {
      return [...defaults];
    }

    return [...new Set([...defaults, ...custom.filter((value): value is string => typeof value === "string")])];
  }
}
