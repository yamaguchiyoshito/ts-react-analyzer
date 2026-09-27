import path from "node:path";
import ts from "typescript";

import type {
  ComponentMetrics,
  ComplexityScoreBreakdown,
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

type FunctionLikeInitializer = ts.ArrowFunction | ts.FunctionExpression;

type ComponentNode =
  | ts.FunctionDeclaration
  | ts.VariableDeclaration
  | ts.ClassDeclaration
  | ts.ExportAssignment;

type AssertionNode = ts.AsExpression | ts.TypeAssertion;

// React 本体の型名。`React.FC<Props>` / `FC<Props>` など、変数の型注釈から props 型を取り出す
const FUNCTION_COMPONENT_TYPE_NAMES = new Set([
  "FC",
  "FunctionComponent",
  "VFC",
  "VoidFunctionComponent",
  "ComponentType",
]);

// クラスコンポーネントの基底クラス名 (`React.Component` / `Component` / `PureComponent`)
const CLASS_COMPONENT_BASE_NAMES = new Set(["Component", "PureComponent"]);

// 依存配列を受け取る組み込み hook と、依存配列の位置 (引数 index)
const DEPENDENCY_HOOK_ARGUMENT_INDEX: Record<string, number> = {
  useEffect: 1,
  useLayoutEffect: 1,
  useInsertionEffect: 1,
  useMemo: 1,
  useCallback: 1,
  useImperativeHandle: 2,
};

// 依存配列を持たない組み込み hook (第 2 引数があっても依存配列ではない)
const NO_DEPENDENCY_HOOKS = new Set([
  "use",
  "useState",
  "useRef",
  "useContext",
  "useReducer",
  "useId",
  "useTransition",
  "useDeferredValue",
  "useDebugValue",
  "useSyncExternalStore",
  "useOptimistic",
  "useActionState",
  "useFormStatus",
]);

const MAX_TYPE_RESOLUTION_DEPTH = 4;

export class ComplexityAnalyzer {
  private readonly hooksRegistry = new Set([
    "use",
    "useState",
    "useEffect",
    "useContext",
    "useReducer",
    "useCallback",
    "useMemo",
    "useRef",
    "useLayoutEffect",
    "useInsertionEffect",
    "useImperativeHandle",
    "useDebugValue",
    "useDeferredValue",
    "useTransition",
    "useId",
    "useSyncExternalStore",
    "useOptimistic",
    "useActionState",
    "useFormStatus",
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
      tsExpectErrorCount: 0,
      tsNoCheckCount: 0,
      unsafeAssertionCount: 0,
      doubleAssertionCount: 0,
      constAssertionCount: 0,
      uncheckedPatterns: [],
    };

    const lines = sourceFile.text.split(/\r?\n/u);
    let codeLines = 0;
    let commentLines = 0;
    let inBlockComment = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      // ブロックコメントの開閉を追跡し、banner なしの複数行コメント内部も
      // コメント行として数える (行内にコードが混在するケースは近似)
      if (inBlockComment) {
        commentLines += 1;
        if (trimmed.includes("*/")) {
          inBlockComment = false;
        }
        continue;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
        commentLines += 1;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        commentLines += 1;
        if (!trimmed.includes("*/", 2)) {
          inBlockComment = true;
        }
        continue;
      }
      codeLines += 1;
    }

    this.collectTypeScriptDirectives(sourceFile.text, typeMetrics);

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
        this.collectAssertionMetrics(node, typeMetrics);
      }
      if (ts.isNonNullExpression(node)) {
        typeMetrics.nonNullAssertionCount += 1;
        typeMetrics.uncheckedPatterns.push("non-null-assertion");
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);

    const scoreBreakdown = this.buildComplexityScoreBreakdown(functions, components, hooks);

    return {
      filePath,
      totalLines: lines.length,
      codeLines,
      commentLines,
      functions,
      components,
      hooks,
      typeMetrics,
      scoreBreakdown,
      overallComplexity: this.calculateOverallComplexity(scoreBreakdown, functions, components, hooks),
    };
  }

  private collectTypeScriptDirectives(sourceText: string, metrics: TypeSafetyMetrics): void {
    const commentPattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
    for (const comment of sourceText.match(commentPattern) ?? []) {
      this.collectDirective(comment, /@ts-ignore\b/gu, () => {
        metrics.tsIgnoreCount += 1;
        metrics.uncheckedPatterns.push("@ts-ignore");
      });
      this.collectDirective(comment, /@ts-expect-error\b/gu, () => {
        metrics.tsExpectErrorCount = (metrics.tsExpectErrorCount ?? 0) + 1;
        metrics.uncheckedPatterns.push("@ts-expect-error");
      });
      this.collectDirective(comment, /@ts-nocheck\b/gu, () => {
        metrics.tsNoCheckCount = (metrics.tsNoCheckCount ?? 0) + 1;
        metrics.uncheckedPatterns.push("@ts-nocheck");
      });
    }
  }

  private collectDirective(source: string, pattern: RegExp, onMatch: () => void): void {
    for (const _match of source.matchAll(pattern)) {
      onMatch();
    }
  }

  // 型アサーションの計数。`as const` は型を狭めるだけで型安全性を損なわないため、
  // constAssertionCount だけに数え、assertionCount / unsafe / unchecked には含めない。
  // 判定はすべて AST で行い、`as (any)` や `as any /* comment */` も取り違えない。
  private collectAssertionMetrics(node: AssertionNode, typeMetrics: TypeSafetyMetrics): void {
    if (this.isConstAssertion(node)) {
      typeMetrics.constAssertionCount = (typeMetrics.constAssertionCount ?? 0) + 1;
      return;
    }

    typeMetrics.assertionCount += 1;
    if (this.isDoubleAssertion(node)) {
      typeMetrics.doubleAssertionCount = (typeMetrics.doubleAssertionCount ?? 0) + 1;
      typeMetrics.uncheckedPatterns.push("double-assertion");
    }
    if (this.isUnsafeAssertion(node)) {
      typeMetrics.unsafeAssertionCount = (typeMetrics.unsafeAssertionCount ?? 0) + 1;
      typeMetrics.uncheckedPatterns.push("unsafe-assertion");
    }
    // ネストした `(x as any) as Foo` の内側は独立したノードとして訪問されるため、
    // 対象型が any のノードだけで 1 回数える (テキスト包含判定による二重計上を防ぐ)
    if (this.isAnyTypeNode(node.type)) {
      typeMetrics.uncheckedPatterns.push("type-assertion:any");
    }
  }

  private analyzeFunctionComplexity(node: AnalyzableFunctionNode): FunctionMetrics {
    let cyclomaticComplexity = 1;
    let branchCount = 0;
    let loopCount = 0;
    let ternaryCount = 0;
    let logicalOpCount = 0;
    let maxNestingDepth = 0;

    const visit = (child: ts.Node, depth: number): void => {
      // ネストした関数は独立に解析されるため、その内部の分岐を親へ二重計上しない
      if (this.isAnalyzableFunction(child)) {
        return;
      }

      maxNestingDepth = Math.max(maxNestingDepth, depth);
      const nestedDepth = this.isControlFlowNestingNode(child) ? depth + 1 : depth;

      // switch 自体は数えず case 節のみ数える (標準的な cyclomatic complexity)
      if (ts.isIfStatement(child) || ts.isCaseClause(child) || ts.isConditionalExpression(child)) {
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
        if (
          operator === ts.SyntaxKind.AmpersandAmpersandToken
          || operator === ts.SyntaxKind.BarBarToken
          || operator === ts.SyntaxKind.QuestionQuestionToken
        ) {
          logicalOpCount += 1;
          cyclomaticComplexity += 1;
        }
      }

      // `a?.b?.c` のようなオプショナルチェーンは 1 連鎖につき 1 つの短絡分岐として数える
      if (this.isOptionalChainEnd(child)) {
        branchCount += 1;
        cyclomaticComplexity += 1;
      }

      ts.forEachChild(child, (grandChild) => visit(grandChild, nestedDepth));
    };

    if (node.body) {
      if (ts.isBlock(node.body)) {
        ts.forEachChild(node.body, (child) => visit(child, 0));
      } else {
        // 式本体のアロー関数 (`(a) => a > 1 ? 1 : 2`) は body 自体が条件式や論理式なので、
        // 子ではなく body ノードそのものから訪問する。ネストした関数は visit 側で除外される
        visit(node.body, 0);
      }
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

  // オプショナルチェーンの最外ノード (親がチェーンを継続していないノード) だけを 1 回数える
  private isOptionalChainEnd(node: ts.Node): boolean {
    if (!ts.isOptionalChain(node)) {
      return false;
    }
    const parent = node.parent;
    return !(parent && ts.isOptionalChain(parent) && parent.expression === node);
  }

  private analyzeComponent(node: ComponentNode): ComponentMetrics {
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
    const hookName = this.resolveHookName(node.expression);
    if (!hookName) {
      return null;
    }

    return {
      name: hookName,
      startLine: ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart()).line + 1,
      args: node.arguments.length,
      hasDependencies: this.hasDependencyArray(node, hookName),
    };
  }

  private resolveHookName(expression: ts.Expression): string | null {
    let hookName: string | null = null;
    let isMemberCall = false;
    let receiver: ts.Expression | null = null;

    if (ts.isIdentifier(expression)) {
      hookName = expression.text;
    } else if (ts.isPropertyAccessExpression(expression)) {
      hookName = expression.name.text;
      isMemberCall = true;
      receiver = expression.expression;
    }

    if (!hookName) {
      return null;
    }

    // React 19 の `use(promise)`。`app.use(middleware)` (Express 等) を hook と誤認しないよう、
    // メンバー呼び出しは `React.use(...)` だけを認める
    if (hookName === "use") {
      if (!isMemberCall) {
        return hookName;
      }
      return receiver && ts.isIdentifier(receiver) && receiver.text === "React" ? hookName : null;
    }

    if (this.hooksRegistry.has(hookName) || /^use[A-Z0-9]/u.test(hookName)) {
      return hookName;
    }
    return null;
  }

  private hasDependencyArray(node: ts.CallExpression, hookName: string): boolean {
    if (NO_DEPENDENCY_HOOKS.has(hookName)) {
      return false;
    }

    const dependencyIndex = DEPENDENCY_HOOK_ARGUMENT_INDEX[hookName];
    if (typeof dependencyIndex === "number") {
      // `useEffect(fn, [a, b])` も `useEffect(fn, deps)` も依存配列付きとして扱う
      const dependencyArg = node.arguments[dependencyIndex];
      if (!dependencyArg) {
        return false;
      }
      const unwrapped = this.unwrapExpression(dependencyArg);
      return ts.isArrayLiteralExpression(unwrapped) || ts.isIdentifier(unwrapped);
    }

    // カスタム hook は末尾引数が配列リテラルのときだけ依存配列付きとみなす
    if (node.arguments.length < 2) {
      return false;
    }
    const lastArg = node.arguments[node.arguments.length - 1];
    return !!lastArg && ts.isArrayLiteralExpression(this.unwrapExpression(lastArg));
  }

  private extractPropsType(node: ComponentNode): PropType | null {
    if (ts.isClassDeclaration(node)) {
      const propsTypeNode = this.getClassComponentPropsTypeNode(node);
      return propsTypeNode ? this.buildPropTypeFromTypeNode(propsTypeNode) : null;
    }

    const functionNode = this.resolveComponentFunctionNode(node);
    const propsParam = functionNode?.parameters[0];
    if (propsParam?.type) {
      return {
        name: propsParam.name.getText(),
        typeDeclaration: propsParam.type.getText(),
        properties: this.extractProperties(propsParam.type),
      };
    }

    // 引数に型が無い場合は `const X: React.FC<Props> = ...` の型注釈や
    // `forwardRef<Element, Props>(...)` / `memo<Props>(...)` の型引数から props 型を得る
    const annotatedTypeNode = this.resolveAnnotatedPropsTypeNode(node);
    return annotatedTypeNode ? this.buildPropTypeFromTypeNode(annotatedTypeNode) : null;
  }

  private buildPropTypeFromTypeNode(typeNode: ts.TypeNode): PropType {
    const typeText = typeNode.getText();
    return {
      name: ts.isTypeReferenceNode(typeNode) ? typeText : "props",
      typeDeclaration: typeText,
      properties: this.extractProperties(typeNode),
    };
  }

  private resolveAnnotatedPropsTypeNode(node: ComponentNode): ts.TypeNode | null {
    if (ts.isVariableDeclaration(node)) {
      if (node.type) {
        const fromAnnotation = this.extractFunctionComponentTypeArgument(node.type);
        if (fromAnnotation) {
          return fromAnnotation;
        }
      }
      const initializer = node.initializer ? this.unwrapExpression(node.initializer) : null;
      if (initializer && ts.isCallExpression(initializer)) {
        return this.resolvePropsTypeFromWrapperCall(initializer, 0);
      }
      return null;
    }

    if (ts.isExportAssignment(node)) {
      const expression = this.unwrapExpression(node.expression);
      if (ts.isCallExpression(expression)) {
        return this.resolvePropsTypeFromWrapperCall(expression, 0);
      }
    }

    return null;
  }

  private extractFunctionComponentTypeArgument(typeNode: ts.TypeNode): ts.TypeNode | null {
    if (!ts.isTypeReferenceNode(typeNode)) {
      return null;
    }
    const typeName = this.getEntityNameLastIdentifier(typeNode.typeName);
    if (!FUNCTION_COMPONENT_TYPE_NAMES.has(typeName)) {
      return null;
    }
    return typeNode.typeArguments?.[0] ?? null;
  }

  private resolvePropsTypeFromWrapperCall(call: ts.CallExpression, depth: number): ts.TypeNode | null {
    if (depth > MAX_TYPE_RESOLUTION_DEPTH) {
      return null;
    }

    const calleeName = this.getCalleeName(call.expression);
    if (calleeName === "forwardRef") {
      const propsArgument = call.typeArguments?.[1];
      if (propsArgument) {
        return propsArgument;
      }
    } else if (calleeName === "memo") {
      const propsArgument = call.typeArguments?.[0];
      if (propsArgument) {
        return propsArgument;
      }
    }

    // `memo(forwardRef<E, P>(...))` のような入れ子のラッパーを辿る
    for (const arg of call.arguments) {
      const unwrapped = this.unwrapExpression(arg);
      if (ts.isCallExpression(unwrapped)) {
        const nested = this.resolvePropsTypeFromWrapperCall(unwrapped, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  }

  private getCalleeName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return expression.name.text;
    }
    return null;
  }

  private getEntityNameLastIdentifier(name: ts.EntityName): string {
    return ts.isIdentifier(name) ? name.text : name.right.text;
  }

  private extractProperties(typeNode: ts.TypeNode): PropProperty[] {
    const properties = this.collectProperties(typeNode, new Set<string>(), 0);
    // 交差型や継承で同名プロパティが重複した場合は最初の定義だけ残す
    const seen = new Set<string>();
    return properties.filter((property) => {
      if (seen.has(property.name)) {
        return false;
      }
      seen.add(property.name);
      return true;
    });
  }

  private collectProperties(typeNode: ts.TypeNode, seenTypeNames: Set<string>, depth: number): PropProperty[] {
    if (depth > MAX_TYPE_RESOLUTION_DEPTH) {
      return [];
    }

    if (ts.isTypeLiteralNode(typeNode)) {
      return this.collectMemberProperties(typeNode.members);
    }

    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.collectProperties(typeNode.type, seenTypeNames, depth + 1);
    }

    if (ts.isIntersectionTypeNode(typeNode)) {
      return typeNode.types.flatMap((member) => this.collectProperties(member, seenTypeNames, depth + 1));
    }

    // 同一ファイル内で宣言された interface / type alias なら、その定義を辿ってプロパティを得る
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) && !typeNode.typeArguments) {
      return this.collectPropertiesFromLocalDeclaration(typeNode.typeName.text, typeNode.getSourceFile(), seenTypeNames, depth);
    }
    if (ts.isExpressionWithTypeArguments(typeNode) && ts.isIdentifier(typeNode.expression) && !typeNode.typeArguments) {
      return this.collectPropertiesFromLocalDeclaration(typeNode.expression.text, typeNode.getSourceFile(), seenTypeNames, depth);
    }

    return [];
  }

  private collectPropertiesFromLocalDeclaration(
    typeName: string,
    sourceFile: ts.SourceFile,
    seenTypeNames: Set<string>,
    depth: number,
  ): PropProperty[] {
    if (seenTypeNames.has(typeName)) {
      return [];
    }
    seenTypeNames.add(typeName);

    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement) && statement.name.text === typeName) {
        const inherited = (statement.heritageClauses ?? [])
          .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((clause) => clause.types)
          .flatMap((base) => this.collectProperties(base, seenTypeNames, depth + 1));
        return [...this.collectMemberProperties(statement.members), ...inherited];
      }
      if (ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName) {
        return this.collectProperties(statement.type, seenTypeNames, depth + 1);
      }
    }
    return [];
  }

  private collectMemberProperties(members: ts.NodeArray<ts.TypeElement>): PropProperty[] {
    const properties: PropProperty[] = [];
    for (const member of members) {
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

  private isReactComponent(node: ts.Node): node is ComponentNode {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) {
        return this.isPascalCase(node.name.text) && this.containsJsx(node);
      }
      // `export default function () { return <div /> }`
      return this.hasExportDefaultModifier(node) && this.containsJsx(node);
    }

    if (ts.isVariableDeclaration(node)) {
      if (!this.isPascalCase(node.name.getText()) || !node.initializer) {
        return false;
      }
      // `const Template = <Card />` や `const Routes = [<A />, <B />]` は JSX を含むが
      // コンポーネント定義ではないため、初期化子が関数 (またはラッパー呼び出し) のものだけ認める
      return this.isComponentInitializer(node.initializer, node.type);
    }

    if (ts.isClassDeclaration(node)) {
      return this.isClassComponent(node);
    }

    if (ts.isExportAssignment(node)) {
      // `export default () => <div />` / `export default memo(function () { ... })`
      return !node.isExportEquals && this.isComponentInitializer(node.expression, undefined);
    }

    return false;
  }

  private isComponentInitializer(initializer: ts.Expression, typeAnnotation: ts.TypeNode | undefined): boolean {
    const unwrapped = this.unwrapExpression(initializer);
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
      if (this.containsJsx(unwrapped)) {
        return true;
      }
      // JSX を返さず null や文字列を返すコンポーネントでも、React.FC 型注釈があれば認める
      return this.isFunctionComponentTypeAnnotation(typeAnnotation);
    }

    if (ts.isCallExpression(unwrapped)) {
      // memo / forwardRef / observer / styled 系など、関数を引数に取るラッパー呼び出し
      const wrappedFunction = this.findFunctionArgument(unwrapped, 0);
      return wrappedFunction !== null && this.containsJsx(wrappedFunction);
    }

    return false;
  }

  private isFunctionComponentTypeAnnotation(typeAnnotation: ts.TypeNode | undefined): boolean {
    if (!typeAnnotation || !ts.isTypeReferenceNode(typeAnnotation)) {
      return false;
    }
    return FUNCTION_COMPONENT_TYPE_NAMES.has(this.getEntityNameLastIdentifier(typeAnnotation.typeName));
  }

  private findFunctionArgument(call: ts.CallExpression, depth: number): FunctionLikeInitializer | null {
    if (depth > MAX_TYPE_RESOLUTION_DEPTH) {
      return null;
    }
    for (const arg of call.arguments) {
      const unwrapped = this.unwrapExpression(arg);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
        return unwrapped;
      }
      if (ts.isCallExpression(unwrapped)) {
        const nested = this.findFunctionArgument(unwrapped, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  }

  private isClassComponent(node: ts.ClassDeclaration): boolean {
    const baseType = this.getClassHeritageType(node);
    if (!baseType) {
      return false;
    }
    const baseName = this.getCalleeName(baseType.expression);
    if (!baseName || !CLASS_COMPONENT_BASE_NAMES.has(baseName)) {
      return false;
    }
    return node.members.some((member) =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "render");
  }

  private getClassHeritageType(node: ts.ClassDeclaration): ts.ExpressionWithTypeArguments | null {
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
        return clause.types[0] ?? null;
      }
    }
    return null;
  }

  private getClassComponentPropsTypeNode(node: ts.ClassDeclaration): ts.TypeNode | null {
    const baseType = this.getClassHeritageType(node);
    const propsTypeNode = baseType?.typeArguments?.[0];
    if (!propsTypeNode) {
      return null;
    }
    return ts.isTypeReferenceNode(propsTypeNode) || ts.isTypeLiteralNode(propsTypeNode) || ts.isIntersectionTypeNode(propsTypeNode)
      ? propsTypeNode
      : null;
  }

  private hasExportDefaultModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  }

  private unwrapExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return current;
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

  private extractComponentName(node: ComponentNode): string {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      return node.name?.text ?? this.defaultExportComponentName(node.getSourceFile());
    }
    if (ts.isVariableDeclaration(node)) {
      return node.name.getText();
    }
    // export default: ラップされた名前付き関数式 (`memo(function Card() {...})`) があればその名前
    const expression = this.unwrapExpression(node.expression);
    const wrapped = ts.isCallExpression(expression) ? this.findFunctionArgument(expression, 0) : expression;
    if (wrapped && ts.isFunctionExpression(wrapped) && wrapped.name && this.isPascalCase(wrapped.name.text)) {
      return wrapped.name.text;
    }
    return this.defaultExportComponentName(node.getSourceFile());
  }

  // 無名の default export はファイル名 (拡張子と .stories 等の接尾辞を除いた先頭部分) で呼ぶ。
  // index や識別子にならない名前のときは "default"
  private defaultExportComponentName(sourceFile: ts.SourceFile): string {
    const stem = path.basename(sourceFile.fileName).split(".")[0] ?? "";
    if (stem && stem !== "index" && /^[A-Za-z_$][\w$]*$/u.test(stem)) {
      return stem;
    }
    return "default";
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

  private isControlFlowNestingNode(node: ts.Node): boolean {
    return ts.isIfStatement(node)
      || ts.isSwitchStatement(node)
      || ts.isCaseClause(node)
      || ts.isConditionalExpression(node)
      || ts.isForStatement(node)
      || ts.isForInStatement(node)
      || ts.isForOfStatement(node)
      || ts.isWhileStatement(node)
      || ts.isDoStatement(node)
      || ts.isTryStatement(node)
      || ts.isCatchClause(node);
  }

  private unwrapTypeNode(typeNode: ts.TypeNode): ts.TypeNode {
    let current = typeNode;
    while (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
    }
    return current;
  }

  private isAnyTypeNode(typeNode: ts.TypeNode): boolean {
    return this.unwrapTypeNode(typeNode).kind === ts.SyntaxKind.AnyKeyword;
  }

  private isUnknownTypeNode(typeNode: ts.TypeNode): boolean {
    return this.unwrapTypeNode(typeNode).kind === ts.SyntaxKind.UnknownKeyword;
  }

  // `as const` は TypeReference(typeName = const) として構文木に現れる
  private isConstAssertion(node: AssertionNode): boolean {
    const typeNode = this.unwrapTypeNode(node.type);
    return ts.isTypeReferenceNode(typeNode)
      && ts.isIdentifier(typeNode.typeName)
      && typeNode.typeName.text === "const"
      && !typeNode.typeArguments;
  }

  private getInnerAssertion(node: AssertionNode): AssertionNode | null {
    // `(x as any) as Foo` のように括弧で包まれた内側のアサーションも辿る
    let inner: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) {
      inner = inner.expression;
    }
    if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) && !this.isConstAssertion(inner)) {
      return inner;
    }
    return null;
  }

  private isDoubleAssertion(node: AssertionNode): boolean {
    return this.getInnerAssertion(node) !== null;
  }

  private isUnsafeAssertion(node: AssertionNode): boolean {
    if (this.isAnyTypeNode(node.type)) {
      return true;
    }

    const inner = this.getInnerAssertion(node);
    if (!inner) {
      return false;
    }
    return this.isAnyTypeNode(inner.type) || this.isUnknownTypeNode(inner.type);
  }

  private buildComplexityScoreBreakdown(
    functions: FunctionMetrics[],
    components: ComponentMetrics[],
    hooks: HookInfo[],
  ): ComplexityScoreBreakdown {
    const functionComplexities = functions
      .map((metric) => metric.cyclomaticComplexity)
      .sort((left, right) => right - left);
    const renderComplexities = components
      .map((component) => component.renderComplexity.complexity)
      .sort((left, right) => right - left);
    const averageFunctionComplexity = this.average(functionComplexities);
    const peakFunctionComplexity = functionComplexities[0] ?? 0;
    const topFunctionAverage = this.average(functionComplexities.slice(0, 3));
    const averageRenderComplexity = this.average(renderComplexities);
    const peakRenderComplexity = renderComplexities[0] ?? 0;
    const peakNestingDepth = functions.reduce((max, metric) => Math.max(max, metric.maxNestingDepth), 0);
    const elevatedFunctionCount = functions.filter((metric) =>
      metric.cyclomaticComplexity >= 5 || metric.maxNestingDepth >= 4
    ).length;
    const hookPressure = components.length > 0 ? hooks.length / components.length : hooks.length;
    const nestingPressure = Math.min(6, Math.max(0, peakNestingDepth - 2));
    const weightedScore = (
      (averageFunctionComplexity * 0.3)
      + (peakFunctionComplexity * 0.4)
      + (topFunctionAverage * 0.2)
      + (averageRenderComplexity * 1.2)
      + (peakRenderComplexity * 0.8)
      + (nestingPressure * 0.7)
      + (Math.min(4, hookPressure) * 0.4)
      + (Math.min(3, elevatedFunctionCount) * 1.1)
    );

    return {
      averageFunctionComplexity: this.roundMetric(averageFunctionComplexity),
      peakFunctionComplexity,
      topFunctionAverage: this.roundMetric(topFunctionAverage),
      averageRenderComplexity: this.roundMetric(averageRenderComplexity),
      peakRenderComplexity,
      hookPressure: this.roundMetric(hookPressure),
      peakNestingDepth,
      elevatedFunctionCount,
      weightedScore: this.roundMetric(weightedScore),
    };
  }

  private calculateOverallComplexity(
    scoreBreakdown: ComplexityScoreBreakdown,
    functions: FunctionMetrics[],
    components: ComponentMetrics[],
    hooks: HookInfo[],
  ): number {
    if (functions.length === 0 && components.length === 0 && hooks.length === 0) {
      return 0;
    }

    return Math.max(1, Math.round(scoreBreakdown.weightedScore));
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private roundMetric(value: number): number {
    return Number(value.toFixed(2));
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
    if (ts.isFunctionDeclaration(node)) {
      return this.hasExportDefaultModifier(node) ? "default" : "anonymous";
    }

    // 無名のアロー関数 / 関数式は代入先の名前で呼ぶ:
    // `const x = function () {}` → x、`{ onClick: () => {} }` → onClick、クラスフィールドも同様
    let parent: ts.Node | undefined = node.parent;
    while (
      parent
      && (ts.isParenthesizedExpression(parent)
        || ts.isAsExpression(parent)
        || ts.isSatisfiesExpression(parent)
        || ts.isTypeAssertionExpression(parent)
        || ts.isNonNullExpression(parent))
    ) {
      parent = parent.parent;
    }
    if (!parent) {
      return "anonymous";
    }
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return parent.name.getText();
    }
    if (ts.isExportAssignment(parent)) {
      return "default";
    }
    return "anonymous";
  }

  private isPascalCase(name: string | undefined): boolean {
    return !!name && /^[A-Z][A-Za-z0-9]*$/u.test(name);
  }

  private resolveComponentFunctionNode(node: ComponentNode): ts.SignatureDeclarationBase | null {
    if (ts.isFunctionDeclaration(node)) {
      return node;
    }
    if (ts.isClassDeclaration(node)) {
      return null;
    }

    const initializer = ts.isVariableDeclaration(node) ? node.initializer : node.expression;
    if (!initializer) {
      return null;
    }
    const unwrapped = this.unwrapExpression(initializer);
    if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
      return unwrapped;
    }
    if (ts.isCallExpression(unwrapped)) {
      return this.findFunctionArgument(unwrapped, 0);
    }
    return null;
  }
}
