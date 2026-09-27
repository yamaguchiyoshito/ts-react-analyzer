import ts from "typescript";

import type { AnalysisResult, Dependency, ParsedFile } from "../../types/index.js";
import type { AuditFinding, I18nFinding, QualityAnalysisContext, VisualConsumerSummary } from "./QualityReportModel.js";

/**
 * JSX / TypeScript AST を直接走査する静的監査。dangerouslySetInnerHTML、
 * ハードコード文言、機密情報パターン、design-system backing の有無、高責務
 * コンポーネントの検出をまとめる。
 */

export function collectDangerousHtml(parsedFiles: ParsedFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const parsedFile of parsedFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && getJsxAttributeName(node.name) === "dangerouslySetInnerHTML") {
        findings.push({
          filePath: parsedFile.filePath,
          line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
          text: "dangerouslySetInnerHTML",
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsedFile.sourceFile, visit);
  }

  return findings;
}

export function collectHardcodedJsxText(ctx: QualityAnalysisContext, parsedFiles: ParsedFile[]): I18nFinding[] {
  const findings: I18nFinding[] = [];
  const userFacingAttributeNames = new Set([
    "placeholder",
    "title",
    "alt",
    "aria-label",
    "aria-description",
    "aria-placeholder",
    "label",
    "description",
    "helpertext",
    "emptytext",
  ]);

  for (const parsedFile of parsedFiles.filter((item) => isI18nTargetFile(ctx, item.filePath))) {
    const scope = classifyI18nFindingScope(ctx, parsedFile.filePath);
    const staticTextBindings = collectStaticTextBindings(parsedFile.sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node)) {
        const text = node.getText().replace(/\s+/gu, " ").trim();
        if (text && isLikelyUserFacingText(text)) {
          findings.push({
            filePath: parsedFile.filePath,
            line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
            text,
            scope,
          });
        }
      }

      if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
        const resolvedText = resolveStaticText(node.expression, staticTextBindings);
        const text = resolvedText?.replace(/\s+/gu, " ").trim();
        if (text && isLikelyUserFacingText(text)) {
          findings.push({
            filePath: parsedFile.filePath,
            line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
            text: `{${text}}`,
            scope,
          });
        }
      }

      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const attributeName = getJsxAttributeName(node.name);
        if (userFacingAttributeNames.has(attributeName) && isLikelyUserFacingText(node.initializer.text)) {
          findings.push({
            filePath: parsedFile.filePath,
            line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
            text: `${attributeName}="${node.initializer.text}"`,
            scope,
          });
        }
      }

      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
        const attributeName = getJsxAttributeName(node.name);
        const resolvedText = resolveStaticText(node.initializer.expression, staticTextBindings);
        const text = resolvedText?.replace(/\s+/gu, " ").trim();
        if (userFacingAttributeNames.has(attributeName) && text && isLikelyUserFacingText(text)) {
          findings.push({
            filePath: parsedFile.filePath,
            line: ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, node.getStart()).line + 1,
            text: `${attributeName}={${text}}`,
            scope,
          });
        }
      }

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parsedFile.sourceFile, visit);
  }

  return findings;
}

export function collectSecretIndicators(parsedFiles: ParsedFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const patterns = [
    /api[_-]?key\s*[:=]\s*['"][^'"\n]+/giu,
    /secret\s*[:=]\s*['"][^'"\n]+/giu,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/gu,
    /AKIA[0-9A-Z]{16}/gu,
  ];

  for (const parsedFile of parsedFiles) {
    for (const pattern of patterns) {
      for (const match of parsedFile.sourceCode.matchAll(pattern)) {
        const index = match.index ?? 0;
        const location = ts.getLineAndCharacterOfPosition(parsedFile.sourceFile, index);
        findings.push({
          filePath: parsedFile.filePath,
          line: location.line + 1,
          text: match[0].slice(0, 80),
        });
      }
    }
  }

  return findings;
}

export function collectVisualConsumers(ctx: QualityAnalysisContext, analysisResults: AnalysisResult[], parsedFiles: ParsedFile[]): VisualConsumerSummary {
  let total = 0;
  let designSystemUsers = 0;
  const bespokeFiles: AuditFinding[] = [];
  const entries: VisualConsumerSummary["entries"] = [];
  const analysisByFile = new Map(analysisResults.map((result) => [result.filePath, result]));
  const parsedByFile = new Map(parsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));
  const designSystemMemo = new Map<string, boolean>();

  for (const result of analysisResults) {
    if (result.complexity.components.length === 0) {
      continue;
    }

    const fileType = ctx.classifyFileType(result.filePath);
    if (!isVisualConsumerTargetFile(ctx, result.filePath)) {
      continue;
    }

    total += 1;
    const hasDesignSystemImport = hasDesignSystemBacking(result.filePath, analysisByFile, parsedByFile, designSystemMemo, new Set());
    entries.push({
      filePath: result.filePath,
      hasDesignSystemBacking: hasDesignSystemImport,
    });

    if (hasDesignSystemImport) {
      designSystemUsers += 1;
      continue;
    }

    bespokeFiles.push({
      filePath: result.filePath,
      line: result.complexity.components[0]?.startLine ?? 1,
      text: `${fileType} で JSX 使用経路上の共通UI backing が見つかりません`,
    });
  }

  return {
    total,
    designSystemUsers,
    bespokeFiles,
    entries,
  };
}

export function collectHighResponsibilityComponents(ctx: QualityAnalysisContext, analysisResults: AnalysisResult[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const result of analysisResults) {
    if (!isResponsibilityTargetFile(ctx, result.filePath)) {
      continue;
    }
    for (const component of result.complexity.components) {
      if (component.hookCount >= 4 || component.jsxElements >= 12 || component.renderComplexity.complexity >= 5) {
        findings.push({
          filePath: result.filePath,
          line: component.startLine,
          text: `${component.name}: hooks=${component.hookCount}, jsx=${component.jsxElements}, render=${component.renderComplexity.complexity}`,
        });
      }
    }
  }

  return findings;
}

export function isVisualConsumerTargetFile(ctx: QualityAnalysisContext, filePath: string): boolean {
  const fileType = ctx.classifyFileType(filePath);
  return ["Route", "Feature", "Form"].includes(fileType);
}

export function isResponsibilityTargetFile(ctx: QualityAnalysisContext, filePath: string): boolean {
  const fileType = ctx.classifyFileType(filePath);
  return ["Route", "Feature", "Form", "UI component", "Layout"].includes(fileType);
}

export function isI18nTargetFile(ctx: QualityAnalysisContext, filePath: string): boolean {
  const fileType = ctx.classifyFileType(filePath);
  return ["Route", "Feature", "Form", "UI component", "Layout", "Shared"].includes(fileType);
}

export function classifyI18nFindingScope(ctx: QualityAnalysisContext, filePath: string): "product" | "library" {
  const fileType = ctx.classifyFileType(filePath);
  if (fileType === "UI component") {
    return "library";
  }

  const normalized = ctx.toDisplayPath(filePath).replace(/\\/gu, "/").toLowerCase();
  if (normalized.includes("/components/ui/")
    || normalized.includes("/shared/ui/")
    || normalized.includes("/components/commons/")) {
    return "library";
  }
  return "product";
}

export function hasDesignSystemBacking(
  filePath: string,
  analysisByFile: Map<string, AnalysisResult>,
  parsedByFile: Map<string, ParsedFile>,
  memo: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  if (memo.has(filePath)) {
    return memo.get(filePath) ?? false;
  }
  if (visiting.has(filePath)) {
    return false;
  }

  const result = analysisByFile.get(filePath);
  const parsedFile = parsedByFile.get(filePath);
  if (!result) {
    memo.set(filePath, false);
    return false;
  }

  visiting.add(filePath);
  const hasBacking = parsedFile
    ? fileUsesDesignSystemBacking(parsedFile, result, analysisByFile, parsedByFile, memo, visiting)
    : false;
  visiting.delete(filePath);
  memo.set(filePath, hasBacking);
  return hasBacking;
}

export function fileUsesDesignSystemBacking(
  parsedFile: ParsedFile,
  result: AnalysisResult,
  analysisByFile: Map<string, AnalysisResult>,
  parsedByFile: Map<string, ParsedFile>,
  memo: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  const usedJsxReferences = collectUsedJsxReferences(parsedFile.sourceFile);
  if (usedJsxReferences.size === 0) {
    return false;
  }

  const dependencyByStart = new Map(
    result.dependencies
      .filter((dependency) => dependency.type === "import")
      .map((dependency) => [dependency.range.start, dependency] as const),
  );

  for (const statement of parsedFile.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const dependency = dependencyByStart.get(statement.getStart());
    if (!dependency) {
      continue;
    }

    const importedNames = collectImportedBindings(statement.importClause);
    if (!importedNames.some((name) => usedJsxReferences.has(name))) {
      continue;
    }

    if (isDesignSystemDependency(dependency)) {
      return true;
    }

    if (!dependency.isExternal && hasDesignSystemBacking(dependency.target, analysisByFile, parsedByFile, memo, visiting)) {
      return true;
    }
  }

  return false;
}

export function collectUsedJsxReferences(sourceFile: ts.SourceFile): Set<string> {
  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const reference = jsxTagReference(node.tagName);
      if (reference) {
        references.add(reference);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

export function jsxTagReference(tagName: ts.JsxTagNameExpression): string | null {
  if (ts.isIdentifier(tagName)) {
    return tagName.text;
  }
  if (ts.isPropertyAccessExpression(tagName)) {
    return flattenPropertyAccessRoot(tagName);
  }
  return null;
}

export function flattenPropertyAccessRoot(expression: ts.PropertyAccessExpression): string | null {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

export function collectImportedBindings(importClause: ts.ImportClause): string[] {
  const bindings: string[] = [];
  if (importClause.name) {
    bindings.push(importClause.name.text);
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return bindings;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    bindings.push(namedBindings.name.text);
    return bindings;
  }

  for (const element of namedBindings.elements) {
    bindings.push(element.name.text);
  }

  return bindings;
}

export function isDesignSystemDependency(dependency: Dependency): boolean {
  const normalizedModule = dependency.modulePath.replace(/\\/gu, "/").toLowerCase();
  const normalizedTarget = dependency.target.replace(/\\/gu, "/").toLowerCase();
  return normalizedModule.includes("components/ui")
    || normalizedModule.includes("shared/ui")
    || normalizedModule.includes("components/commons")
    || normalizedModule.includes("design-system")
    || normalizedTarget.includes("/components/ui/")
    || normalizedTarget.includes("/shared/ui/")
    || normalizedTarget.includes("/components/commons/");
}

export function isLikelyUserFacingText(text: string): boolean {
  return /\p{Letter}/u.test(text);
}

export function collectStaticTextBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const resolved = resolveStaticText(node.initializer, bindings);
      if (resolved) {
        bindings.set(node.name.text, resolved);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

export function resolveStaticText(
  expression: ts.Expression | undefined,
  bindings: Map<string, string>,
): string | null {
  if (!expression) {
    return null;
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return resolveStaticText(expression.expression, bindings);
  }
  if (ts.isIdentifier(expression)) {
    return bindings.get(expression.text) ?? null;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticText(expression.left, bindings);
    const right = resolveStaticText(expression.right, bindings);
    if (left === null || right === null) {
      return null;
    }
    return `${left}${right}`;
  }
  if (ts.isTemplateExpression(expression)) {
    let resolved = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = resolveStaticText(span.expression, bindings);
      if (value === null) {
        return null;
      }
      resolved += value + span.literal.text;
    }
    return resolved;
  }
  return null;
}

export function getJsxAttributeName(name: ts.JsxAttributeName): string {
  return ts.isIdentifier(name) ? name.text : name.name.text;
}
