import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type {
  BarrelInfo,
  Dependency,
  ExportedItem,
  ExtractionError,
  ExtractionResult,
  ImportedItem,
} from "../types/index.js";

interface ResolveResult {
  target: string;
  isExternal: boolean;
}

interface ResolutionContext {
  compilerOptions: ts.CompilerOptions;
  configDir: string;
  hash: string;
}

export class DependencyAnalyzer {
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly compilerOptionsHash: string;
  private readonly projectRoot: string;
  private readonly host: ts.ModuleResolutionHost;
  // node_modules 探索を全ファイルで共有する TypeScript 標準の解決キャッシュ。
  // これが無いと N ファイルが import する同じパッケージを N 回探索する。
  private readonly moduleResolutionCache: ts.ModuleResolutionCache;
  private readonly externalLibraries = new Set<string>();
  private readonly reExportChains = new Map<string, Set<string>>();
  private readonly resolutionCache = new Map<string, ResolveResult>();
  private readonly nearestTsConfigCache = new Map<string, string | null>();
  private readonly resolutionContextCache = new Map<string, ResolutionContext>();

  constructor(projectRoot: string, compilerOptions: ts.CompilerOptions) {
    this.projectRoot = path.resolve(projectRoot);
    this.compilerOptions = compilerOptions;
    this.compilerOptionsHash = this.hash(this.stableStringify(compilerOptions));
    this.host = ts.sys;
    this.moduleResolutionCache = ts.createModuleResolutionCache(
      this.projectRoot,
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
    );
  }

  extractDependencies(sourceFile: ts.SourceFile, filePath: string): ExtractionResult {
    const dependencies: Dependency[] = [];
    const barrels: BarrelInfo[] = [];
    const errors: ExtractionError[] = [];
    let sideEffectImports = 0;

    const visit = (node: ts.Node): void => {
      try {
        if (ts.isImportDeclaration(node)) {
          const importResult = this.handleImportDeclaration(node, filePath);
          dependencies.push(...importResult.dependencies);
          sideEffectImports += importResult.sideEffectImports;
          if (importResult.barrel) {
            barrels.push(importResult.barrel);
          }
        } else if (ts.isExportDeclaration(node)) {
          const exportResult = this.handleExportDeclaration(node, filePath);
          dependencies.push(...exportResult.dependencies);
        } else if (ts.isCallExpression(node)) {
          const dependency = this.extractDynamicImport(node, filePath);
          if (dependency) {
            dependencies.push(dependency);
          }
        }
      } catch (error) {
        errors.push({
          node: ts.getLineAndCharacterOfPosition(sourceFile, node.getStart()),
          message: error instanceof Error ? error.message : String(error),
        });
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return {
      dependencies,
      barrels,
      errors,
      externalCount: dependencies.filter((dependency) => dependency.isExternal).length,
      internalCount: dependencies.filter((dependency) => !dependency.isExternal).length,
      sideEffectImports,
    };
  }

  getExternalLibraries(): string[] {
    return Array.from(this.externalLibraries).sort();
  }

  getReExportChains(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.reExportChains.entries()).map(([source, targets]) => [source, Array.from(targets).sort()]),
    );
  }

  getAnalysisContextHash(filePath: string): string {
    const context = this.getResolutionContextForFile(filePath);
    return context.hash;
  }

  private handleImportDeclaration(
    node: ts.ImportDeclaration,
    fromFile: string,
  ): { dependencies: Dependency[]; barrel?: BarrelInfo; sideEffectImports: number } {
    const modulePath = this.readModulePath(node.moduleSpecifier);
    if (!modulePath) {
      return { dependencies: [], sideEffectImports: 0 };
    }

    if (!node.importClause) {
      const resolved = this.resolveModuleTarget(modulePath, fromFile);
      return {
        dependencies: [{
          source: fromFile,
          target: resolved.target,
          type: "side-effect-import",
          isExternal: resolved.isExternal,
          modulePath,
          range: this.createRange(node, node.getSourceFile()),
        }],
        sideEffectImports: 1,
      };
    }

    const imported: ImportedItem[] = [];
    if (node.importClause.name) {
      imported.push({
        name: "default",
        alias: node.importClause.name.text,
        kind: "default",
        isNamed: false,
      });
    }

    const namedBindings = node.importClause.namedBindings;
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) {
        imported.push({
          name: "*",
          alias: namedBindings.name.text,
          kind: "namespace",
          isNamed: false,
        });
      } else {
        for (const element of namedBindings.elements) {
          imported.push({
            name: element.propertyName?.text ?? element.name.text,
            alias: element.name.text,
            kind: "named",
            isNamed: true,
          });
        }
      }
    }

    const resolved = this.resolveModuleTarget(modulePath, fromFile);
    const dependency: Dependency = {
      source: fromFile,
      target: resolved.target,
      type: "import",
      isExternal: resolved.isExternal,
      imported,
      modulePath,
      range: this.createRange(node, node.getSourceFile()),
    };

    const barrel = !resolved.isExternal && this.isBarrelFile(resolved.target)
      ? {
          source: fromFile,
          barrel: resolved.target,
          items: imported,
        }
      : undefined;

    return { dependencies: [dependency], barrel, sideEffectImports: 0 };
  }

  private handleExportDeclaration(
    node: ts.ExportDeclaration,
    fromFile: string,
  ): { dependencies: Dependency[] } {
    if (!node.moduleSpecifier) {
      return { dependencies: [] };
    }

    const modulePath = this.readModulePath(node.moduleSpecifier);
    if (!modulePath) {
      return { dependencies: [] };
    }

    const exported: ExportedItem[] = [];
    if (!node.exportClause) {
      exported.push({
        name: "*",
        kind: "all",
      });
    } else if (ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        exported.push({
          name: element.propertyName?.text ?? element.name.text,
          alias: element.name.text,
          kind: "named",
        });
      }
    }

    const resolved = this.resolveModuleTarget(modulePath, fromFile);
    if (!resolved.isExternal) {
      this.trackReExport(fromFile, resolved.target);
    }

    return {
      dependencies: [{
        source: fromFile,
        target: resolved.target,
        type: "export",
        isExternal: resolved.isExternal,
        exported,
        modulePath,
        range: this.createRange(node, node.getSourceFile()),
      }],
    };
  }

  private extractDynamicImport(node: ts.CallExpression, fromFile: string): Dependency | null {
    if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      return null;
    }

    const firstArgument = node.arguments[0];
    if (!firstArgument) {
      return null;
    }

    const modulePath = this.extractStringLiteral(firstArgument);
    if (!modulePath) {
      return null;
    }

    const resolved = this.resolveModuleTarget(modulePath, fromFile);
    return {
      source: fromFile,
      target: resolved.target,
      type: "dynamic-import",
      isExternal: resolved.isExternal,
      modulePath,
      range: this.createRange(node, node.getSourceFile()),
    };
  }

  private resolveModuleTarget(modulePath: string, fromFile: string): ResolveResult {
    const cacheKey = `${fromFile}::${modulePath}`;
    const cached = this.resolutionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const context = this.getResolutionContextForFile(fromFile);
    const resolution = ts.resolveModuleName(
      modulePath,
      fromFile,
      context.compilerOptions,
      this.host,
      this.moduleResolutionCache,
    );
    const resolvedFileName = resolution.resolvedModule?.resolvedFileName
      ? path.resolve(resolution.resolvedModule.resolvedFileName)
      : undefined;

    if (resolvedFileName) {
      const resolvedResult = this.isExternalResolvedModule(resolution.resolvedModule, resolvedFileName)
        ? this.createExternalResolution(modulePath)
        : {
            target: resolvedFileName,
            isExternal: false,
          };
      this.resolutionCache.set(cacheKey, resolvedResult);
      return resolvedResult;
    }

    if (modulePath.startsWith(".")) {
      const relativeResult = {
        target: this.resolveExistingInternalTarget(path.resolve(path.dirname(fromFile), modulePath)),
        isExternal: false,
      } satisfies ResolveResult;
      this.resolutionCache.set(cacheKey, relativeResult);
      return relativeResult;
    }

    if (this.matchesConfiguredPathAlias(modulePath, context.compilerOptions.paths ?? {})) {
      const aliasResult = {
        target: this.resolveAliasFallback(modulePath, context),
        isExternal: false,
      } satisfies ResolveResult;
      this.resolutionCache.set(cacheKey, aliasResult);
      return aliasResult;
    }

    const externalResult = this.createExternalResolution(modulePath);
    this.resolutionCache.set(cacheKey, externalResult);
    return externalResult;
  }

  private createRange(node: ts.Node, sourceFile: ts.SourceFile) {
    const location = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
    return {
      start: node.getStart(),
      end: node.getEnd(),
      line: location.line + 1,
      character: location.character + 1,
    };
  }

  private isExternalSpecifier(modulePath: string): boolean {
    return !modulePath.startsWith(".") && !path.isAbsolute(modulePath);
  }

  private isBarrelFile(filePath: string): boolean {
    return /^index\.(tsx?|jsx?)$/u.test(path.basename(filePath));
  }

  private readModulePath(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return null;
  }

  private extractStringLiteral(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return null;
  }

  private trackReExport(source: string, target: string): void {
    if (!this.reExportChains.has(source)) {
      this.reExportChains.set(source, new Set<string>());
    }
    this.reExportChains.get(source)?.add(target);
  }

  private getResolutionContextForFile(filePath: string): ResolutionContext {
    const tsConfigPath = this.findNearestTsConfig(filePath);
    if (!tsConfigPath) {
      return {
        compilerOptions: this.compilerOptions,
        configDir: this.projectRoot,
        hash: `fallback:${this.compilerOptionsHash}`,
      };
    }

    const cached = this.resolutionContextCache.get(tsConfigPath);
    if (cached) {
      return cached;
    }

    const loaded = this.loadResolutionContext(tsConfigPath);
    this.resolutionContextCache.set(tsConfigPath, loaded);
    return loaded;
  }

  private findNearestTsConfig(filePath: string): string | undefined {
    const startDir = path.dirname(path.resolve(filePath));
    const visited: string[] = [];
    let currentDir = startDir;

    while (this.isWithinProjectRoot(currentDir)) {
      const cached = this.nearestTsConfigCache.get(currentDir);
      if (cached !== undefined) {
        for (const visitedDir of visited) {
          this.nearestTsConfigCache.set(visitedDir, cached);
        }
        return cached ?? undefined;
      }

      visited.push(currentDir);
      const candidate = this.findNearestConfigInDirectory(currentDir);
      if (candidate) {
        for (const visitedDir of visited) {
          this.nearestTsConfigCache.set(visitedDir, candidate);
        }
        return candidate;
      }

      if (currentDir === this.projectRoot) {
        break;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    for (const visitedDir of visited) {
      this.nearestTsConfigCache.set(visitedDir, null);
    }
    return undefined;
  }

  private loadResolutionContext(tsConfigPath: string): ResolutionContext {
    const configDir = path.dirname(tsConfigPath);
    try {
      const readResult = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
      if (readResult.error) {
        return {
          compilerOptions: this.compilerOptions,
          configDir,
          hash: `invalid:${tsConfigPath}:${this.compilerOptionsHash}`,
        };
      }

      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        configDir,
        undefined,
        tsConfigPath,
      );

      return {
        compilerOptions: {
          ...this.compilerOptions,
          ...parsed.options,
        },
        configDir,
        hash: this.hash(`${tsConfigPath}:${this.stableStringify(parsed.options)}`),
      };
    } catch {
      return {
        compilerOptions: this.compilerOptions,
        configDir,
        hash: `fallback:${this.compilerOptionsHash}`,
      };
    }
  }

  private findNearestConfigInDirectory(dirPath: string): string | undefined {
    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      return undefined;
    }

    const candidates = entries
      .filter((entry) => this.isTypeCheckConfigFile(entry))
      .sort((left, right) => this.compareConfigPriority(left, right))
      .map((entry) => path.join(dirPath, entry));

    return candidates[0];
  }

  private isTypeCheckConfigFile(fileName: string): boolean {
    return fileName === "jsconfig.json" || /^tsconfig(?:\.[^.]+)*\.json$/u.test(fileName);
  }

  private compareConfigPriority(left: string, right: string): number {
    const leftRank = this.configPriority(left);
    const rightRank = this.configPriority(right);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  }

  private configPriority(fileName: string): number {
    if (fileName === "tsconfig.json") {
      return 0;
    }
    if (fileName === "jsconfig.json") {
      return 1;
    }
    if (/^tsconfig\.(app|lib|src)\.json$/u.test(fileName)) {
      return 2;
    }
    if (/^tsconfig\.(base|shared|options)\.json$/u.test(fileName)) {
      return 4;
    }
    return 3;
  }

  private isExternalResolvedModule(
    resolvedModule: ts.ResolvedModule | undefined,
    resolvedFileName: string,
  ): boolean {
    return resolvedModule?.isExternalLibraryImport === true
      || /(^|[/\\])node_modules(?:$|[/\\])/u.test(resolvedFileName);
  }

  private createExternalResolution(modulePath: string): ResolveResult {
    const packageName = modulePath.startsWith("@")
      ? modulePath.split("/").slice(0, 2).join("/")
      : modulePath.split("/")[0];
    if (packageName) {
      this.externalLibraries.add(packageName);
    }
    return { target: packageName || modulePath, isExternal: true };
  }

  private matchesConfiguredPathAlias(modulePath: string, paths: Record<string, string[]>): boolean {
    if (!this.isExternalSpecifier(modulePath)) {
      return false;
    }

    return Object.keys(paths).some((pattern) => this.matchPathAliasPattern(modulePath, pattern) !== null);
  }

  private resolveAliasFallback(modulePath: string, context: ResolutionContext): string {
    const baseDir = this.resolveBaseDir(context);
    let fallbackTarget: string | null = null;
    for (const [pattern, replacements] of Object.entries(context.compilerOptions.paths ?? {})) {
      const wildcardValue = this.matchPathAliasPattern(modulePath, pattern);
      if (wildcardValue === null) {
        continue;
      }

      for (const replacement of replacements) {
        const substituted = replacement.includes("*")
          ? replacement.replace(/\*/gu, wildcardValue)
          : replacement;
        const candidate = path.isAbsolute(substituted)
          ? substituted
          : path.resolve(baseDir, substituted);
        const resolvedCandidate = this.findExistingInternalTarget(candidate);
        if (resolvedCandidate) {
          return resolvedCandidate;
        }
        fallbackTarget ??= path.resolve(candidate);
      }
    }

    return fallbackTarget ?? this.resolveExistingInternalTarget(path.resolve(baseDir, modulePath));
  }

  private resolveBaseDir(context: ResolutionContext): string {
    const { baseUrl } = context.compilerOptions;
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return context.configDir;
    }

    return path.isAbsolute(baseUrl)
      ? baseUrl
      : path.resolve(context.configDir, baseUrl);
  }

  private resolveExistingInternalTarget(basePath: string): string {
    return this.findExistingInternalTarget(basePath) ?? path.resolve(basePath);
  }

  private findExistingInternalTarget(basePath: string): string | undefined {
    const resolvedBase = path.resolve(basePath);
    const candidates = new Set<string>([
      resolvedBase,
      `${resolvedBase}.ts`,
      `${resolvedBase}.tsx`,
      `${resolvedBase}.js`,
      `${resolvedBase}.jsx`,
      `${resolvedBase}.d.ts`,
      path.join(resolvedBase, "index.ts"),
      path.join(resolvedBase, "index.tsx"),
      path.join(resolvedBase, "index.js"),
      path.join(resolvedBase, "index.jsx"),
      path.join(resolvedBase, "index.d.ts"),
    ]);

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return path.resolve(candidate);
        }
      } catch {
        // Ignore missing candidates.
      }
    }

    return undefined;
  }

  private matchPathAliasPattern(modulePath: string, pattern: string): string | null {
    if (!pattern.includes("*")) {
      return pattern === modulePath ? "" : null;
    }

    const [rawPrefix, rawSuffix] = pattern.split("*");
    const prefix = rawPrefix ?? "";
    const suffix = rawSuffix ?? "";
    if (!modulePath.startsWith(prefix) || !modulePath.endsWith(suffix)) {
      return null;
    }

    return modulePath.slice(prefix.length, modulePath.length - suffix.length);
  }

  private isWithinProjectRoot(candidatePath: string): boolean {
    const relative = path.relative(this.projectRoot, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(",")}}`;
    }

    return JSON.stringify(value);
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}
