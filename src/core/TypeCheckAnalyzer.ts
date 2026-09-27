import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { isSolutionStyleConfig, resolveTsConfigLeaves, type ResolvedTsConfig } from "./TsConfigResolver.js";

export interface TypeCheckIssue {
  filePath: string;
  line: number;
  character: number;
  code: number;
  message: string;
}

export interface TypeCheckStrictnessConfig {
  tsConfigPath: string;
  strict: boolean;
  noImplicitAny: boolean;
  strictNullChecks: boolean;
  noUncheckedIndexedAccess: boolean;
  exactOptionalPropertyTypes: boolean;
  useUnknownInCatchVariables: boolean;
  enabledOptionCount: number;
}

export interface TypeCheckStrictnessSummary {
  configCount: number;
  strictConfigCount: number;
  fullyStrictConfigCount: number;
  optionCoverage: {
    strict: number;
    noImplicitAny: number;
    strictNullChecks: number;
    noUncheckedIndexedAccess: number;
    exactOptionalPropertyTypes: number;
    useUnknownInCatchVariables: number;
  };
  configs: TypeCheckStrictnessConfig[];
}

export interface TypeCheckSummary {
  totalErrors: number;
  checkedFiles: number;
  issues: TypeCheckIssue[];
  tsConfigPath?: string;
  skippedReason?: string;
  /**
   * 検査対象として見つかったが実際には型検査されなかったファイル数 (上限超過・実行時エラー時)。
   * 0 のスキップ (対象ファイルなし) と区別し、複数 tsconfig を合算した際に
   * 「一部だけ検査済み」を pass と誤認しないために使う。
   */
  skippedFiles?: number;
  strictnessSummary?: TypeCheckStrictnessSummary;
}

export interface TypeCheckAnalyzerOptions {
  includedFilePaths?: string[];
  maxRootNames?: number;
  // 指定時は .tsbuildinfo をこの配下に保存し、2 回目以降を増分型検査にする
  cacheDir?: string;
  onProgress?: (message: string, metadata?: Record<string, unknown>) => void;
}

interface DiscoveredTsConfigCandidate {
  path: string;
  supportsTypeCheckDiscovery: boolean;
}

export class TypeCheckAnalyzer {
  analyzeProject(projectRoot: string, tsConfigPath?: string, options: TypeCheckAnalyzerOptions = {}): TypeCheckSummary {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const tsConfigPaths = this.resolveTsConfigPaths(resolvedProjectRoot, tsConfigPath, options);

    if (tsConfigPaths.length === 0) {
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        skippedReason: "tsconfig / jsconfig が見つからないため型検査をスキップしました。",
      };
    }

    if (tsConfigPaths.length === 1) {
      return this.analyzeTsConfig(resolvedProjectRoot, tsConfigPaths[0]!, options);
    }

    const summaries = tsConfigPaths.map((candidatePath) =>
      this.analyzeTsConfig(resolvedProjectRoot, candidatePath, options)
    );

    return this.mergeSummaries(summaries, tsConfigPaths);
  }

  private analyzeTsConfig(
    projectRoot: string,
    tsConfigPath: string,
    options: TypeCheckAnalyzerOptions,
  ): TypeCheckSummary {
    const resolvedTsConfigPath = path.resolve(tsConfigPath);
    const readResult = ts.readConfigFile(resolvedTsConfigPath, ts.sys.readFile);
    if (readResult.error) {
      return {
        totalErrors: 1,
        checkedFiles: 0,
        issues: [{
          filePath: resolvedTsConfigPath,
          line: 1,
          character: 1,
          code: readResult.error.code,
          message: ts.flattenDiagnosticMessageText(readResult.error.messageText, "\n"),
        }],
        tsConfigPath: resolvedTsConfigPath,
      };
    }

    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      path.dirname(resolvedTsConfigPath),
      { noEmit: true },
      resolvedTsConfigPath,
    );

    // Vite / Next テンプレートの solution 型 tsconfig (files: [] + references) は自身に
    // 検査対象を持たないため、references 先の末端設定をそれぞれ型検査して合算する
    if (parsed.errors.length === 0 && isSolutionStyleConfig(parsed)) {
      return this.analyzeSolutionTsConfig(projectRoot, resolvedTsConfigPath, parsed, options);
    }

    return this.analyzeParsedTsConfig(projectRoot, resolvedTsConfigPath, parsed, options, new Set<string>());
  }

  private analyzeSolutionTsConfig(
    projectRoot: string,
    resolvedTsConfigPath: string,
    parsed: ts.ParsedCommandLine,
    options: TypeCheckAnalyzerOptions,
  ): TypeCheckSummary {
    let leaves: ResolvedTsConfig[];
    try {
      leaves = resolveTsConfigLeaves(resolvedTsConfigPath, { noEmit: true }).leaves;
    } catch (error) {
      leaves = [];
      options.onProgress?.("TypeScript project references resolution failed", {
        tsConfigPath: resolvedTsConfigPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (leaves.length === 0) {
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        tsConfigPath: resolvedTsConfigPath,
        skippedReason: "references 先に型検査対象の tsconfig が見つからないため型検査をスキップしました。",
        strictnessSummary: this.collectStrictnessSummary(parsed.options, resolvedTsConfigPath),
      };
    }

    options.onProgress?.("TypeScript project references resolved", {
      tsConfigPath: resolvedTsConfigPath,
      leafTsConfigPaths: leaves.map((leaf) => leaf.tsConfigPath),
    });

    // 複数の末端設定に同じファイルが含まれる場合は最初の設定でだけ検査し、重複計上を避ける
    const claimedFiles = new Set<string>();
    const summaries = leaves.map((leaf) =>
      this.analyzeParsedTsConfig(projectRoot, leaf.tsConfigPath, leaf.parsed, options, claimedFiles)
    );
    const merged = this.mergeSummaries(summaries, leaves.map((leaf) => leaf.tsConfigPath));
    return { ...merged, tsConfigPath: resolvedTsConfigPath };
  }

  private analyzeParsedTsConfig(
    projectRoot: string,
    resolvedTsConfigPath: string,
    parsed: ts.ParsedCommandLine,
    options: TypeCheckAnalyzerOptions,
    claimedFiles: Set<string>,
  ): TypeCheckSummary {
    const strictnessSummary = this.collectStrictnessSummary(parsed.options, resolvedTsConfigPath);

    if (parsed.errors.length > 0) {
      return {
        totalErrors: parsed.errors.length,
        checkedFiles: parsed.fileNames.length,
        issues: parsed.errors.map((diagnostic) => this.toIssue(diagnostic, resolvedTsConfigPath)),
        tsConfigPath: resolvedTsConfigPath,
        strictnessSummary,
      };
    }

    const includedFilePathSet = this.createIncludedFilePathSet(options.includedFilePaths);
    const ownProjectFilePathSet = new Set(parsed.fileNames.map((fileName) => path.resolve(fileName)));
    const rootNames = parsed.fileNames.filter((fileName) => {
      const resolvedFileName = path.resolve(fileName);
      if (includedFilePathSet && !includedFilePathSet.has(resolvedFileName)) {
        return false;
      }
      if (claimedFiles.has(resolvedFileName)) {
        return false;
      }
      claimedFiles.add(resolvedFileName);
      return true;
    });

    if (rootNames.length === 0) {
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        tsConfigPath: resolvedTsConfigPath,
        skippedReason: "解析スコープに含まれる TypeScript 対象がないため型検査をスキップしました。",
        strictnessSummary,
      };
    }

    if (typeof options.maxRootNames === "number" && rootNames.length > options.maxRootNames) {
      options.onProgress?.("TypeScript type check skipped", {
        rootNames: rootNames.length,
        maxRootNames: options.maxRootNames,
        tsConfigPath: resolvedTsConfigPath,
      });
      // 何も検査していないので checkedFiles は 0。対象数は skippedFiles で別途伝える
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        tsConfigPath: resolvedTsConfigPath,
        skippedReason: `TypeScript 対象が ${rootNames.length} ファイルで上限 ${options.maxRootNames} を超えるため、型検査をスキップしました。`,
        skippedFiles: rootNames.length,
        strictnessSummary,
      };
    }

    options.onProgress?.("TypeScript program creation started", {
      rootNames: rootNames.length,
      originalRootNames: parsed.fileNames.length,
      scoped: Boolean(includedFilePathSet),
      incremental: Boolean(options.cacheDir),
      tsConfigPath: resolvedTsConfigPath,
    });
    // TypeScript 自体が非常に深い import 連鎖で RangeError (スタック溢れ) を投げることがある。
    // その場合は quality 実行全体を落とさず、型検査だけをスキップ扱い (verdict manual) に落とす。
    let rawDiagnostics: readonly ts.Diagnostic[];
    try {
      rawDiagnostics = this.collectDiagnostics(rootNames, parsed, resolvedTsConfigPath, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onProgress?.("TypeScript type check failed", {
        tsConfigPath: resolvedTsConfigPath,
        error: message,
      });
      return {
        totalErrors: 0,
        checkedFiles: 0,
        issues: [],
        tsConfigPath: resolvedTsConfigPath,
        skippedReason: `型検査の実行中にエラーが発生したため型検査をスキップしました (${message})。`,
        skippedFiles: rootNames.length,
        strictnessSummary,
      };
    }
    const diagnostics = this.filterDiagnosticsForScope(
      rawDiagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
      ownProjectFilePathSet,
      Boolean(includedFilePathSet),
    );

    return {
      totalErrors: diagnostics.length,
      checkedFiles: rootNames.filter((fileName) => this.isWithinDirectory(fileName, projectRoot)).length,
      issues: diagnostics.map((diagnostic) => this.toIssue(diagnostic, resolvedTsConfigPath)),
      tsConfigPath: resolvedTsConfigPath,
      strictnessSummary,
    };
  }

  private isWithinDirectory(fileName: string, directory: string): boolean {
    const relative = path.relative(directory, fileName);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private collectDiagnostics(
    rootNames: string[],
    parsed: ts.ParsedCommandLine,
    resolvedTsConfigPath: string,
    options: TypeCheckAnalyzerOptions,
  ): readonly ts.Diagnostic[] {
    if (!options.cacheDir) {
      const program = ts.createProgram({
        rootNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
      });
      return ts.getPreEmitDiagnostics(program);
    }

    // .tsbuildinfo を使った増分型検査。2 回目以降は変更の影響を受けたファイル
    // だけを再検査し、残りは前回の診断結果を再利用する (tsc --incremental --noEmit 相当)。
    const buildInfoDir = path.join(options.cacheDir, "typecheck");
    fs.mkdirSync(buildInfoDir, { recursive: true });
    const configKey = crypto.createHash("sha256").update(resolvedTsConfigPath).digest("hex").slice(0, 16);
    const incrementalOptions: ts.CompilerOptions = {
      ...parsed.options,
      incremental: true,
      noEmit: true,
      tsBuildInfoFile: path.join(buildInfoDir, `${configKey}.tsbuildinfo`),
    };
    const host = ts.createIncrementalCompilerHost(incrementalOptions);
    const builder = ts.createIncrementalProgram({
      rootNames,
      options: incrementalOptions,
      projectReferences: parsed.projectReferences,
      host,
    });
    const diagnostics = [
      ...builder.getConfigFileParsingDiagnostics(),
      ...builder.getOptionsDiagnostics(),
      ...builder.getGlobalDiagnostics(),
      ...builder.getSyntacticDiagnostics(),
      ...builder.getSemanticDiagnostics(),
    ];
    // noEmit のため emit は .tsbuildinfo の書き出しのみを行う
    builder.emit();
    return diagnostics;
  }

  private filterDiagnosticsForScope(
    diagnostics: readonly ts.Diagnostic[],
    ownProjectFilePathSet: Set<string>,
    isScoped: boolean,
  ): ts.Diagnostic[] {
    if (!isScoped) {
      return [...diagnostics];
    }

    return diagnostics.filter((diagnostic) =>
      !diagnostic.file || ownProjectFilePathSet.has(path.resolve(diagnostic.file.fileName))
    );
  }

  private mergeSummaries(summaries: TypeCheckSummary[], tsConfigPaths: string[]): TypeCheckSummary {
    const issueMap = new Map<string, TypeCheckIssue>();
    const skippedReasons: string[] = [];
    let checkedFiles = 0;
    let skippedFiles = 0;

    for (const summary of summaries) {
      checkedFiles += summary.checkedFiles;
      skippedFiles += summary.skippedFiles ?? 0;
      for (const issue of summary.issues) {
        const key = `${issue.filePath}:${issue.line}:${issue.character}:${issue.code}:${issue.message}`;
        issueMap.set(key, issue);
      }
      if (summary.skippedReason) {
        const label = summary.tsConfigPath ? path.relative(process.cwd(), summary.tsConfigPath) : "tsconfig";
        skippedReasons.push(`${label}: ${summary.skippedReason}`);
      }
    }

    // 対象ファイルを持つ tsconfig が 1 つでも未検査 (上限超過・実行時エラー) なら、他の tsconfig が
    // 検査できていても skippedReason を残す。6000 ファイルの app が飛ばされ 50 ファイルの
    // tsconfig.node.json だけ通った結果を「型エラー 0 の pass」と読ませないため。
    // 対象ファイルが元々無い (checkedFiles も skippedFiles も 0 の) スキップは、
    // 他で検査できていれば従来どおり黙殺する。
    const shouldSurfaceSkip = skippedReasons.length > 0 && (checkedFiles === 0 || skippedFiles > 0);

    return {
      totalErrors: issueMap.size,
      checkedFiles,
      issues: Array.from(issueMap.values()),
      tsConfigPath: tsConfigPaths.length === 1 ? tsConfigPaths[0] : undefined,
      skippedReason: shouldSurfaceSkip ? skippedReasons.join(" / ") : undefined,
      ...(skippedFiles > 0 ? { skippedFiles } : {}),
      strictnessSummary: this.mergeStrictnessSummaries(summaries),
    };
  }

  private collectStrictnessSummary(
    compilerOptions: ts.CompilerOptions,
    tsConfigPath: string,
  ): TypeCheckStrictnessSummary {
    const strict = compilerOptions.strict === true;
    const config: TypeCheckStrictnessConfig = {
      tsConfigPath,
      strict,
      noImplicitAny: compilerOptions.noImplicitAny ?? strict,
      strictNullChecks: compilerOptions.strictNullChecks ?? strict,
      noUncheckedIndexedAccess: compilerOptions.noUncheckedIndexedAccess === true,
      exactOptionalPropertyTypes: compilerOptions.exactOptionalPropertyTypes === true,
      useUnknownInCatchVariables: compilerOptions.useUnknownInCatchVariables ?? strict,
      enabledOptionCount: 0,
    };
    config.enabledOptionCount = [
      config.strict,
      config.noImplicitAny,
      config.strictNullChecks,
      config.noUncheckedIndexedAccess,
      config.exactOptionalPropertyTypes,
      config.useUnknownInCatchVariables,
    ].filter(Boolean).length;

    return {
      configCount: 1,
      strictConfigCount: config.strict ? 1 : 0,
      fullyStrictConfigCount: config.enabledOptionCount === 6 ? 1 : 0,
      optionCoverage: {
        strict: config.strict ? 1 : 0,
        noImplicitAny: config.noImplicitAny ? 1 : 0,
        strictNullChecks: config.strictNullChecks ? 1 : 0,
        noUncheckedIndexedAccess: config.noUncheckedIndexedAccess ? 1 : 0,
        exactOptionalPropertyTypes: config.exactOptionalPropertyTypes ? 1 : 0,
        useUnknownInCatchVariables: config.useUnknownInCatchVariables ? 1 : 0,
      },
      configs: [config],
    };
  }

  private mergeStrictnessSummaries(summaries: TypeCheckSummary[]): TypeCheckStrictnessSummary | undefined {
    const strictnessSummaries = summaries
      .map((summary) => summary.strictnessSummary)
      .filter((summary): summary is TypeCheckStrictnessSummary => Boolean(summary));
    if (strictnessSummaries.length === 0) {
      return undefined;
    }

    return strictnessSummaries.reduce<TypeCheckStrictnessSummary>((merged, summary) => ({
      configCount: merged.configCount + summary.configCount,
      strictConfigCount: merged.strictConfigCount + summary.strictConfigCount,
      fullyStrictConfigCount: merged.fullyStrictConfigCount + summary.fullyStrictConfigCount,
      optionCoverage: {
        strict: merged.optionCoverage.strict + summary.optionCoverage.strict,
        noImplicitAny: merged.optionCoverage.noImplicitAny + summary.optionCoverage.noImplicitAny,
        strictNullChecks: merged.optionCoverage.strictNullChecks + summary.optionCoverage.strictNullChecks,
        noUncheckedIndexedAccess: merged.optionCoverage.noUncheckedIndexedAccess + summary.optionCoverage.noUncheckedIndexedAccess,
        exactOptionalPropertyTypes: merged.optionCoverage.exactOptionalPropertyTypes + summary.optionCoverage.exactOptionalPropertyTypes,
        useUnknownInCatchVariables: merged.optionCoverage.useUnknownInCatchVariables + summary.optionCoverage.useUnknownInCatchVariables,
      },
      configs: [...merged.configs, ...summary.configs],
    }), {
      configCount: 0,
      strictConfigCount: 0,
      fullyStrictConfigCount: 0,
      optionCoverage: {
        strict: 0,
        noImplicitAny: 0,
        strictNullChecks: 0,
        noUncheckedIndexedAccess: 0,
        exactOptionalPropertyTypes: 0,
        useUnknownInCatchVariables: 0,
      },
      configs: [],
    });
  }

  private resolveTsConfigPaths(
    projectRoot: string,
    tsConfigPath: string | undefined,
    options: TypeCheckAnalyzerOptions,
  ): string[] {
    if (tsConfigPath) {
      const resolvedTsConfigPath = path.resolve(tsConfigPath);
      if (fs.existsSync(resolvedTsConfigPath)) {
        return [resolvedTsConfigPath];
      }
    }

    return this.discoverWorkspaceTsConfigs(projectRoot, options.includedFilePaths);
  }

  private discoverWorkspaceTsConfigs(projectRoot: string, includedFilePaths?: string[]): string[] {
    const results: string[] = [];
    const excludedDirectories = new Set([
      ".cache",
      ".git",
      ".next",
      ".turbo",
      "build",
      "coverage",
      "dist",
      "node_modules",
      "out",
      "storybook-static",
    ]);
    const queue = [projectRoot];
    const includedFilePathSet = this.createIncludedFilePathSet(includedFilePaths);

    while (queue.length > 0) {
      const currentDir = queue.shift();
      if (!currentDir) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isFile() && this.isTypeCheckConfigFile(entry.name)) {
          const candidatePath = path.join(currentDir, entry.name);
          const candidate = this.inspectDiscoveredTsConfig(candidatePath, includedFilePathSet);
          if (candidate.supportsTypeCheckDiscovery) {
            results.push(candidate.path);
          }
        }
        if (!entry.isDirectory() || excludedDirectories.has(entry.name)) {
          continue;
        }
        queue.push(path.join(currentDir, entry.name));
      }
    }

    return Array.from(new Set(results)).sort();
  }

  private inspectDiscoveredTsConfig(
    tsConfigPath: string,
    includedFilePathSet?: Set<string>,
  ): DiscoveredTsConfigCandidate {
    const resolvedTsConfigPath = path.resolve(tsConfigPath);
    const readResult = ts.readConfigFile(resolvedTsConfigPath, ts.sys.readFile);
    if (readResult.error) {
      return {
        path: resolvedTsConfigPath,
        supportsTypeCheckDiscovery: true,
      };
    }

    const rawConfig = readResult.config as {
      files?: unknown;
      include?: unknown;
      references?: unknown;
    };
    const hasOwnFileScope = Array.isArray(rawConfig.files) || Array.isArray(rawConfig.include);
    const hasProjectReferences = Array.isArray(rawConfig.references) && rawConfig.references.length > 0;
    const hasImplicitPrimaryScope = this.isPrimaryTsConfigName(resolvedTsConfigPath) && !hasOwnFileScope && !hasProjectReferences;
    const parsed = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      path.dirname(resolvedTsConfigPath),
      { noEmit: true },
      resolvedTsConfigPath,
    );
    const resolvedFileNames = parsed.fileNames.map((fileName) => path.resolve(fileName));
    const matchesIncludedFiles = includedFilePathSet
      ? resolvedFileNames.some((fileName) => includedFilePathSet.has(fileName))
      : resolvedFileNames.length > 0;
    const isExecutableConfig = hasOwnFileScope || hasImplicitPrimaryScope;
    const supportsTypeCheckDiscovery = parsed.errors.length > 0
      ? isExecutableConfig
      : isExecutableConfig && matchesIncludedFiles;

    return {
      path: resolvedTsConfigPath,
      supportsTypeCheckDiscovery,
    };
  }

  private isTypeCheckConfigFile(fileName: string): boolean {
    return fileName === "jsconfig.json" || /^tsconfig(?:\.[^.]+)*\.json$/u.test(fileName);
  }

  private isPrimaryTsConfigName(tsConfigPath: string): boolean {
    const baseName = path.basename(tsConfigPath);
    return baseName === "tsconfig.json" || baseName === "jsconfig.json";
  }

  private createIncludedFilePathSet(filePaths?: string[]): Set<string> | undefined {
    if (!filePaths || filePaths.length === 0) {
      return undefined;
    }

    return new Set(filePaths.map((filePath) => path.resolve(filePath)));
  }

  private toIssue(diagnostic: ts.Diagnostic, fallbackFilePath: string): TypeCheckIssue {
    const filePath = diagnostic.file?.fileName ? path.resolve(diagnostic.file.fileName) : fallbackFilePath;
    const location = diagnostic.file && typeof diagnostic.start === "number"
      ? ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
      : { line: 0, character: 0 };

    return {
      filePath,
      line: location.line + 1,
      character: location.character + 1,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
  }
}
