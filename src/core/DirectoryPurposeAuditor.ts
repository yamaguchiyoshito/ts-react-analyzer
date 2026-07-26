import { classifyFileType, getFileTypePurpose } from "./FileConventions.js";
import type {
  AnalysisResult,
  DirectoryPurposeAuditReport,
  PurposeAlignmentFinding,
  PurposeAlignmentSeverity,
} from "../types/index.js";

const ROUTE_COMPLEXITY_LIMIT = 12;
const SHARED_CODE_LINES_LIMIT = 40;
const SHARED_COMPLEXITY_LIMIT = 8;
const REACT_MODULE_PATTERN = /^react(?:-dom)?(?:\/|$)/u;

const SEVERITY_ORDER: Record<PurposeAlignmentSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function auditDirectoryPurposes(
  results: AnalysisResult[],
  toDisplayPath: (filePath: string) => string = (filePath) => filePath,
): DirectoryPurposeAuditReport {
  const findings: PurposeAlignmentFinding[] = [];

  const normalize = (filePath: string): string => toDisplayPath(filePath).replace(/\\/gu, "/");

  for (const result of results) {
    const displayPath = normalize(result.filePath);
    const fileType = classifyFileType(displayPath);
    const purpose = getFileTypePurpose(fileType)?.purpose ?? "";
    const complexity = result.complexity;
    const hasComponents = complexity.components.length > 0;
    const hasFunctions = complexity.functions.length > 0;
    const usesReact = complexity.hooks.length > 0
      || result.dependencies.some((dependency) =>
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

    if (fileType === "Barrel" && (hasFunctions || hasComponents)) {
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
      const infrastructureTargets = result.dependencies
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

    if (fileType === "Route" && complexity.overallComplexity >= ROUTE_COMPLEXITY_LIMIT) {
      report(
        "heavy-logic-in-route",
        "medium",
        `Route の複雑度が ${complexity.overallComplexity} に達しています`,
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
      && (complexity.codeLines >= SHARED_CODE_LINES_LIMIT || complexity.overallComplexity >= SHARED_COMPLEXITY_LIMIT)
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
