import { classifyFileType, getFileTypePurpose } from "./FileConventions.js";
import type {
  AnalysisResult,
  Dependency,
  DirectoryPurposeAuditReport,
  PurposeAlignmentFinding,
  PurposeAlignmentSeverity,
} from "../types/index.js";

const DEFAULT_ROUTE_COMPLEXITY_LIMIT = 12;
const DEFAULT_SHARED_CODE_LINES_LIMIT = 40;
const DEFAULT_SHARED_COMPLEXITY_LIMIT = 8;
const REACT_MODULE_PATTERN = /^react(?:-dom)?(?:\/|$)/u;

const SEVERITY_ORDER: Record<PurposeAlignmentSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface DirectoryPurposeAuditOptions {
  /**
   * 解析設定の complexityThreshold。指定すると Route の複雑度上限 (routeComplexityLimit)
   * の既定値になり、Shared の複雑度上限はその 2/3 (切り上げ) になる。
   * 未指定のときは従来どおり Route 12 / Shared 8 を使う (ReportGenerator 側の配線は別途)。
   */
  complexityThreshold?: number;
  /** Route に許容する overallComplexity の上限 (既定: complexityThreshold ?? 12) */
  routeComplexityLimit?: number;
  /** Shared に許容する overallComplexity の上限 (既定: ceil(complexityThreshold * 2 / 3) ?? 8) */
  sharedComplexityLimit?: number;
  /** Shared に許容するコード行数の上限 (既定: 40) */
  sharedCodeLinesLimit?: number;
}

interface ResolvedThresholds {
  routeComplexityLimit: number;
  sharedComplexityLimit: number;
  sharedCodeLinesLimit: number;
}

function resolveThresholds(options: DirectoryPurposeAuditOptions): ResolvedThresholds {
  const configured = typeof options.complexityThreshold === "number" && options.complexityThreshold > 0
    ? options.complexityThreshold
    : undefined;
  return {
    routeComplexityLimit: options.routeComplexityLimit ?? configured ?? DEFAULT_ROUTE_COMPLEXITY_LIMIT,
    sharedComplexityLimit: options.sharedComplexityLimit
      ?? (configured !== undefined ? Math.max(1, Math.ceil(configured * 2 / 3)) : DEFAULT_SHARED_COMPLEXITY_LIMIT),
    sharedCodeLinesLimit: options.sharedCodeLinesLimit ?? DEFAULT_SHARED_CODE_LINES_LIMIT,
  };
}

// 型のみの import (`import type { ReactNode } from "react"`) は実行時依存を生まないため、
// レイヤ違反の判定からは除外する
function isRuntimeDependency(dependency: Dependency): boolean {
  return !dependency.isTypeOnly;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/u.test(name);
}

// `components/Button/index.tsx` のように、PascalCase のフォルダ名と同名のコンポーネントを
// index に直接定義するのは一般的なフォルダ型コンポーネントの構成なので Barrel 違反にしない
function isComponentFolderIndex(displayPath: string, componentNames: string[]): boolean {
  const segments = displayPath.split("/");
  const folderName = segments.length >= 2 ? segments[segments.length - 2] ?? "" : "";
  if (!folderName || !isPascalCase(folderName)) {
    return false;
  }
  return componentNames.includes(folderName);
}

export function auditDirectoryPurposes(
  results: AnalysisResult[],
  toDisplayPath: (filePath: string) => string = (filePath) => filePath,
  options: DirectoryPurposeAuditOptions = {},
): DirectoryPurposeAuditReport {
  const findings: PurposeAlignmentFinding[] = [];
  const thresholds = resolveThresholds(options);

  const normalize = (filePath: string): string => toDisplayPath(filePath).replace(/\\/gu, "/");

  for (const result of results) {
    const displayPath = normalize(result.filePath);
    const fileType = classifyFileType(displayPath);
    const purpose = getFileTypePurpose(fileType)?.purpose ?? "";
    const complexity = result.complexity;
    const hasComponents = complexity.components.length > 0;
    const hasFunctions = complexity.functions.length > 0;
    const runtimeDependencies = result.dependencies.filter(isRuntimeDependency);
    const usesReact = complexity.hooks.length > 0
      || runtimeDependencies.some((dependency) =>
        dependency.isExternal && REACT_MODULE_PATTERN.test(dependency.modulePath));

    const report = (rule: string, severity: PurposeAlignmentSeverity, issue: string, suggestion: string): void => {
      findings.push({ filePath: displayPath, fileType, purpose, rule, severity, issue, suggestion });
    };

    if ((fileType === "Utils" || fileType === "API/Infrastructure") && hasComponents) {
      report(
        "component-in-non-ui-layer",
        "high",
        `${fileType} に React コンポーネントが定義されています`,
        "コンポーネントを components/ または features/ へ移し、この層は表示を持たない処理に限定してください",
      );
    }

    if ((fileType === "Schema" || fileType === "Validation") && (hasComponents || usesReact)) {
      report(
        "react-in-data-layer",
        "high",
        `${fileType} が React に依存しています`,
        "React 依存を取り除き、画面都合の処理は Hook / Form 側へ移してください",
      );
    }

    if (
      fileType === "Barrel"
      && (hasFunctions || hasComponents)
      && !isComponentFolderIndex(displayPath, complexity.components.map((component) => component.name))
    ) {
      report(
        "implementation-in-barrel",
        "medium",
        "Barrel (index) に再エクスポート以外の実装があります",
        "実装を個別ファイルへ移し、index は再エクスポート専用に保ってください",
      );
    }

    if (fileType === "Type Support" && (hasFunctions || hasComponents)) {
      report(
        "runtime-code-in-type-support",
        "medium",
        "型定義ファイルに実行時コードがあります",
        "実行時コードを通常のモジュールへ移し、型定義は型だけに保ってください",
      );
    }

    if ((fileType === "UI component" || fileType === "Layout") && hasComponents) {
      const infrastructureTargets = runtimeDependencies
        .filter((dependency) => !dependency.isExternal)
        .map((dependency) => normalize(dependency.target))
        .filter((target) => classifyFileType(target) === "API/Infrastructure");
      if (infrastructureTargets.length > 0) {
        report(
          "ui-depends-on-infrastructure",
          "medium",
          `${fileType} が API/Infrastructure を直接参照しています (${infrastructureTargets.length} 件)`,
          "データ取得は Hook / Feature 側へ寄せ、UI 部品は props で値を受け取ってください",
        );
      }
    }

    if (fileType === "Route" && complexity.overallComplexity >= thresholds.routeComplexityLimit) {
      report(
        "heavy-logic-in-route",
        "medium",
        `Route の複雑度が ${complexity.overallComplexity} に達しています (上限 ${thresholds.routeComplexityLimit})`,
        "画面の組み立て以外のロジックを Feature / Hook へ抽出し、Route を薄く保ってください",
      );
    }

    if (fileType === "Hook" && hasComponents) {
      report(
        "jsx-in-hook",
        "medium",
        "Hook ファイルに React コンポーネントが定義されています",
        "表示はコンポーネントへ分離し、Hook はロジック専用に保ってください",
      );
    }

    if (
      fileType === "Shared"
      && (complexity.codeLines >= thresholds.sharedCodeLinesLimit
        || complexity.overallComplexity >= thresholds.sharedComplexityLimit)
    ) {
      report(
        "unclassified-shared-growth",
        "low",
        `責務未分類 (Shared) のままコードが成長しています (コード行数 ${complexity.codeLines} / 複雑度 ${complexity.overallComplexity})`,
        "features/ や lib/ など目的の明確なディレクトリへ移し、責務を確定してください",
      );
    }
  }

  findings.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.filePath.localeCompare(right.filePath)
    || left.rule.localeCompare(right.rule));

  return {
    findings,
    summary: {
      high: findings.filter((finding) => finding.severity === "high").length,
      medium: findings.filter((finding) => finding.severity === "medium").length,
      low: findings.filter((finding) => finding.severity === "low").length,
    },
  };
}
