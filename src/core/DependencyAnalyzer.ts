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

export class DependencyAnalyzer {
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly projectRoot: string;
  private readonly host: ts.ModuleResolutionHost;
  private readonly externalLibraries = new Set<string>();
  private readonly reExportChains = new Map<string, Set<string>>();

  constructor(projectRoot: string, compilerOptions: ts.CompilerOptions) {
    this.projectRoot = projectRoot;
    this.compilerOptions = compilerOptions;
    this.host = ts.sys;
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

  private handleImportDeclaration(
    node: ts.ImportDeclaration,
    fromFile: string,
  ): { dependencies: Dependency[]; barrel?: BarrelInfo; sideEffectImports: number } {
    const modulePath = this.readModulePath(node.moduleSpecifier);
    if (!modulePath) {
      return { dependencies: [], sideEffectImports: 0 };
    }

    if (!node.importClause) {
      return { dependencies: [], sideEffectImports: 1 };
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
    const resolution = ts.resolveModuleName(
      modulePath,
      fromFile,
      this.compilerOptions,
      this.host,
    );
    const resolvedFileName = resolution.resolvedModule?.resolvedFileName;
    const isExternal = resolution.resolvedModule?.isExternalLibraryImport ?? this.isExternalSpecifier(modulePath);

    if (isExternal) {
      const packageName = modulePath.startsWith("@")
        ? modulePath.split("/").slice(0, 2).join("/")
        : modulePath.split("/")[0];
      if (packageName) {
        this.externalLibraries.add(packageName);
      }
      return { target: packageName || modulePath, isExternal: true };
    }

    if (resolvedFileName) {
      return { target: path.resolve(resolvedFileName), isExternal: false };
    }

    if (modulePath.startsWith(".")) {
      return { target: path.resolve(path.dirname(fromFile), modulePath), isExternal: false };
    }

    return { target: path.resolve(this.projectRoot, modulePath), isExternal: false };
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
}
