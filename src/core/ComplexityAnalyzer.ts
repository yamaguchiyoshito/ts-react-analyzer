import ts from "typescript";

import type {
  ComponentMetrics,
  FileComplexityAnalysis,
  FunctionMetrics,
  HookInfo,
  ParameterMetric,
  PropProperty,
  PropType,
  RenderComplexity,
  RiskLevel,
  TypeSafetyMetrics,
} from "../types/index.js";

type AnalyzableFunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

export class ComplexityAnalyzer {
  private readonly hooksRegistry = new Set([
    "useState",
    "useEffect",
    "useContext",
    "useReducer",
    "useCallback",
    "useMemo",
    "useRef",
    "useLayoutEffect",
    "useImperativeHandle",
    "useDebugValue",
    "useDeferredValue",
    "useTransition",
    "useId",
  ]);

  analyzeFile(sourceFile: ts.SourceFile, filePath: string): FileComplexityAnalysis {
    const functions: FunctionMetrics[] = [];
    const components: ComponentMetrics[] = [];
    const hooks: HookInfo[] = [];
    const typeMetrics: TypeSafetyMetrics = {
      anyTypeCount: 0,
      unknownTypeCount: 0,
      assertionCount: 0,
      nonNullAssertionCount: 0,
      tsIgnoreCount: 0,
      uncheckedPatterns: [],
    };

    const lines = sourceFile.text.split(/\r?\n/u);
    let codeLines = 0;
    let commentLines = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        commentLines += 1;
      } else {
        codeLines += 1;
      }
      if (trimmed.includes("@ts-ignore")) {
        typeMetrics.tsIgnoreCount += 1;
        typeMetrics.uncheckedPatterns.push("@ts-ignore");
      }
    }

    const visit = (node: ts.Node): void => {
      if (this.isAnalyzableFunction(node)) {
        functions.push(this.analyzeFunctionComplexity(node));
      }

      if (this.isReactComponent(node)) {
        components.push(this.analyzeComponent(node));
      }

      if (ts.isCallExpression(node)) {
        const hookInfo = this.extractHookUsage(node);
        if (hookInfo) {
          hooks.push(hookInfo);
        }
      }

      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        typeMetrics.anyTypeCount += 1;
      }
      if (node.kind === ts.SyntaxKind.UnknownKeyword) {
        typeMetrics.unknownTypeCount += 1;
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        typeMetrics.assertionCount += 1;
        if (node.getText().includes(" as any") || node.getText().startsWith("<any>")) {
          typeMetrics.uncheckedPatterns.push("type-assertion:any");
        }
      }
      if (ts.isNonNullExpression(node)) {
        typeMetrics.nonNullAssertionCount += 1;
        typeMetrics.uncheckedPatterns.push("non-null-assertion");
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    return {
      filePath,
      totalLines: lines.length,
      codeLines,
      commentLines,
      functions,
      components,
      hooks,
      typeMetrics,
      overallComplexity: this.calculateOverallComplexity(functions, components),
    };
  }

  private analyzeFunctionComplexity(node: AnalyzableFunctionNode): FunctionMetrics {
    let cyclomaticComplexity = 1;
    let branchCount = 0;
    let loopCount = 0;
    let ternaryCount = 0;
    let logicalOpCount = 0;
    let maxNestingDepth = 0;

    const visit = (child: ts.Node, depth: number): void => {
      maxNestingDepth = Math.max(maxNestingDepth, depth);

      if (ts.isIfStatement(child) || ts.isCaseClause(child) || ts.isConditionalExpression(child) || ts.isSwitchStatement(child)) {
        branchCount += 1;
        cyclomaticComplexity += 1;
      }

      if (ts.isTryStatement(child) && child.catchClause) {
        branchCount += 1;
        cyclomaticComplexity += 1;
      }

      if (
        ts.isForStatement(child) ||
        ts.isForInStatement(child) ||
        ts.isForOfStatement(child) ||
        ts.isWhileStatement(child) ||
        ts.isDoStatement(child)
      ) {
        loopCount += 1;
        cyclomaticComplexity += 1;
      }

      if (ts.isConditionalExpression(child)) {
        ternaryCount += 1;
      }

      if (ts.isBinaryExpression(child)) {
        const operator = child.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
          logicalOpCount += 1;
          cyclomaticComplexity += 1;
        }
      }

      ts.forEachChild(child, (grandChild) => visit(grandChild, depth + 1));
    };

    if (node.body) {
      ts.forEachChild(node.body, (child) => visit(child, 1));
    }

    const startLine = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart()).line + 1;
    const endLine = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getEnd()).line + 1;

    return {
      name: this.getFunctionName(node),
      cyclomaticComplexity,
      startLine,
      endLine,
      lineCount: endLine - startLine + 1,
      branchCount,
      loopCount,
      ternaryCount,
      logicalOpCount,
      maxNestingDepth,
      isAsync: !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
      params: this.extractParameters(node),
      riskLevel: this.assessRiskLevel(cyclomaticComplexity),
    };
  }

  private analyzeComponent(node: ts.Node): ComponentMetrics {
    const hooksUsed = this.extractHooksFromComponent(node);
    return {
      name: this.extractComponentName(node),
      jsxElements: this.countJsxElements(node),
      hooksUsed,
      hookCount: hooksUsed.length,
      propsInterface: this.extractPropsType(node),
      hasChildren: this.checksForChildren(node),
      usesRef: this.checksForRef(node),
      isForwardRef: this.isForwardRefComponent(node),
      startLine: ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart()).line + 1,
      endLine: ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getEnd()).line + 1,
      renderComplexity: this.analyzeRenderLogic(node),
    };
  }

  private countJsxElements(node: ts.Node): number {
    let count = 0;
    const visit = (child: ts.Node): void => {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        count += 1;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return count;
  }

  private extractHooksFromComponent(node: ts.Node): HookInfo[] {
    const hooks: HookInfo[] = [];
    const seen = new Set<string>();

    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const hookInfo = this.extractHookUsage(child);
        if (hookInfo && !seen.has(`${hookInfo.name}:${hookInfo.startLine}`)) {
          hooks.push(hookInfo);
          seen.add(`${hookInfo.name}:${hookInfo.startLine}`);
        }
      }
      ts.forEachChild(child, visit);
    };

    ts.forEachChild(node, visit);
    return hooks;
  }

  private extractHookUsage(node: ts.CallExpression): HookInfo | null {
    const expression = node.expression;
    let hookName: string | null = null;

    if (ts.isIdentifier(expression)) {
      hookName = expression.text;
    } else if (ts.isPropertyAccessExpression(expression)) {
      hookName = expression.name.text;
    }

    if (hookName && (this.hooksRegistry.has(hookName) || /^use[A-Z0-9]/u.test(hookName))) {
      return {
        name: hookName,
        startLine: ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart()).line + 1,
        args: node.arguments.length,
        hasDependencies: this.hasDependencyArray(node),
      };
    }

    return null;
  }

  private hasDependencyArray(node: ts.CallExpression): boolean {
    if (node.arguments.length < 2) {
      return false;
    }
    const lastArg = node.arguments[node.arguments.length - 1];
    return !!lastArg && ts.isArrayLiteralExpression(lastArg);
  }

  private extractPropsType(node: ts.Node): PropType | null {
    const functionNode = this.resolveComponentFunctionNode(node);
    if (!functionNode || functionNode.parameters.length === 0) {
      return null;
    }

    const propsParam = functionNode.parameters[0];
    if (!propsParam?.type) {
      return null;
    }

    return {
      name: propsParam.name.getText(),
      typeDeclaration: propsParam.type.getText(),
      properties: this.extractProperties(propsParam.type),
    };
  }

  private extractProperties(typeNode: ts.TypeNode): PropProperty[] {
    if (!ts.isTypeLiteralNode(typeNode)) {
      return [];
    }

    const properties: PropProperty[] = [];
    for (const member of typeNode.members) {
      if (ts.isPropertySignature(member)) {
        properties.push({
          name: member.name.getText(),
          required: !member.questionToken,
          type: member.type?.getText() ?? "unknown",
        });
      }
    }
    return properties;
  }

  private isReactComponent(node: ts.Node): boolean {
    if (ts.isFunctionDeclaration(node)) {
      return this.isPascalCase(node.name?.text) && this.containsJsx(node);
    }

    if (ts.isVariableDeclaration(node)) {
      return this.isPascalCase(node.name.getText()) && this.containsJsx(node);
    }

    return false;
  }

  private containsJsx(node: ts.Node): boolean {
    let found = false;

    const visit = (child: ts.Node): void => {
      if (found) {
        return;
      }
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };

    ts.forEachChild(node, visit);
    return found;
  }

  private extractComponentName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node)) {
      return node.name?.text ?? "anonymous";
    }
    if (ts.isVariableDeclaration(node)) {
      return node.name.getText();
    }
    return "anonymous";
  }

  private checksForChildren(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) {
        return;
      }

      if (ts.isIdentifier(child) && child.text === "children") {
        found = true;
        return;
      }

      if (ts.isPropertyAccessExpression(child) && child.name.text === "children") {
        found = true;
        return;
      }

      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  }

  private checksForRef(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) {
        return;
      }

      if (ts.isIdentifier(child) && (child.text === "ref" || child.text === "useRef")) {
        found = true;
        return;
      }

      if (ts.isPropertyAccessExpression(child) && (child.name.text === "ref" || child.name.text === "current")) {
        found = true;
        return;
      }

      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  }

  private isForwardRefComponent(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) {
        return;
      }
      if (ts.isIdentifier(child) && child.text === "forwardRef") {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(child) && child.name.text === "forwardRef") {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
  }

  private analyzeRenderLogic(node: ts.Node): RenderComplexity {
    let hasConditionalRender = false;
    let hasListRender = false;
    let fragmentCount = 0;

    const visit = (child: ts.Node): void => {
      if (ts.isConditionalExpression(child) || ts.isIfStatement(child)) {
        hasConditionalRender = true;
      }
      if (ts.isBinaryExpression(child)) {
        const operator = child.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
          hasConditionalRender = true;
        }
      }
      if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
        if (["map", "filter", "reduce", "forEach"].includes(child.expression.name.text)) {
          hasListRender = true;
        }
      }
      if (ts.isJsxFragment(child)) {
        fragmentCount += 1;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);

    return {
      hasConditionalRender,
      hasListRender,
      fragmentCount,
      complexity: (hasConditionalRender ? 1 : 0) + (hasListRender ? 1 : 0) + fragmentCount,
    };
  }

  private extractParameters(node: AnalyzableFunctionNode): ParameterMetric[] {
    return node.parameters.map((parameter) => ({
      name: parameter.name.getText(),
      type: parameter.type?.getText() ?? "unknown",
      optional: !!parameter.questionToken,
      hasDefault: !!parameter.initializer,
    }));
  }

  private assessRiskLevel(complexity: number): RiskLevel {
    if (complexity <= 5) {
      return "low";
    }
    if (complexity <= 10) {
      return "medium";
    }
    return "high";
  }

  private calculateOverallComplexity(functions: FunctionMetrics[], components: ComponentMetrics[]): number {
    const averageFunctionComplexity = functions.length > 0
      ? functions.reduce((sum, metric) => sum + metric.cyclomaticComplexity, 0) / functions.length
      : 0;
    const averageComponentComplexity = components.length > 0
      ? components.reduce((sum, metric) => sum + metric.renderComplexity.complexity, 0) / components.length
      : 0;

    return Math.round((averageFunctionComplexity + averageComponentComplexity) / 2);
  }

  private isAnalyzableFunction(node: ts.Node): node is AnalyzableFunctionNode {
    return ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
  }

  private getFunctionName(node: AnalyzableFunctionNode): string {
    if (ts.isConstructorDeclaration(node)) {
      return "constructor";
    }
    if (node.name) {
      return node.name.getText();
    }
    if (ts.isArrowFunction(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent)) {
        return parent.name.getText();
      }
    }
    return "anonymous";
  }

  private isPascalCase(name: string | undefined): boolean {
    return !!name && /^[A-Z][A-Za-z0-9]*$/u.test(name);
  }

  private resolveComponentFunctionNode(node: ts.Node): ts.SignatureDeclarationBase | null {
    if (ts.isFunctionDeclaration(node)) {
      return node;
    }
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer;
      if (!initializer) {
        return null;
      }
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return initializer;
      }
      if (ts.isCallExpression(initializer)) {
        for (const arg of initializer.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            return arg;
          }
        }
      }
    }
    return null;
  }
}
