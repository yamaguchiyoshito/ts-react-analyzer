import type {
  QualityCategoryId,
  QualityGateRenderContext,
  QualityProfile,
  TestPresenceSettings,
} from "../../types/index.js";

/**
 * QualityReportGenerator とその分割モジュール (MetricBuilders / TestPresenceCollector /
 * JsxAnalysis / WorkspaceSummaries / QualityReportRenderer) が共有する内部モデル。
 * 公開 API (QualityReport など) は src/types に置き、ここは生成過程でだけ使う型と定数に限る。
 */

export interface AuditFinding {
  filePath: string;
  line: number;
  text: string;
}

export interface I18nFinding extends AuditFinding {
  scope: "product" | "library";
}

export interface CategoryDescriptor {
  id: QualityCategoryId;
  label: string;
}

export interface VisualConsumerSummary {
  total: number;
  designSystemUsers: number;
  bespokeFiles: AuditFinding[];
  entries: Array<{
    filePath: string;
    hasDesignSystemBacking: boolean;
  }>;
}

export interface TestPresenceBucketSummary {
  id: "route" | "feature" | "form" | "ui";
  label: string;
  targetFiles: number;
  matchedFiles: number;
  weightedTarget: number;
  weightedMatched: number;
  rate: number;
}

export interface TestPresenceSummary {
  targetFiles: number;
  matchedFiles: number;
  weightedTarget: number;
  weightedMatched: number;
  rate: number;
  buckets: TestPresenceBucketSummary[];
  staticMatchedFiles: number;
  runtimeMatchedFiles: number;
  runtimeExplicitUnmatchedFiles: number;
  noEvidenceUnmatchedFiles: number;
  matches: TestPresenceFileMatch[];
}

export interface TestPresenceBucketDescriptor {
  id: TestPresenceBucketSummary["id"];
  label: string;
  metricId: string;
}

export interface TestPresenceFileMatch {
  filePath: string;
  bucketId: TestPresenceBucketSummary["id"];
  weight: number;
  matched: boolean;
  matchedBy: "runtime" | "static" | "none";
  reasons: string[];
}

export interface TypeEscapeFileSummary {
  filePath: string;
  score: number;
  reasons: string[];
}

export interface TypeEscapeStats {
  totalWeightedScore: number;
  averageFileScore: number;
  highRiskFileCount: number;
  analyzedFileCount: number;
  topFiles: TypeEscapeFileSummary[];
}

/**
 * 解析系モジュールが必要とする生成器の状態。関数は純粋に保ち、状態はこの
 * オブジェクトで明示的に渡す。classifyFileType / toDisplayPath は生成器側で
 * メモ化しているため、値ではなく関数として受け取る。
 */
export interface QualityAnalysisContext {
  projectRoot?: string;
  qualityProfile: QualityProfile;
  testPresenceSettings: TestPresenceSettings;
  toDisplayPath(filePath: string): string;
  classifyFileType(filePath: string): string;
  isStrictQualityCheckTargetFile(filePath: string): boolean;
}

/** レポート描画 (markdown / csv / html) が必要とする状態 */
export interface QualityRenderContext {
  gateContext?: QualityGateRenderContext;
  toDisplayPath(filePath: string): string;
}

export const QUALITY_CATEGORIES: CategoryDescriptor[] = [
  { id: "functional", label: "機能品質" },
  { id: "uiux", label: "UI/UX品質" },
  { id: "accessibility", label: "アクセシビリティ品質" },
  { id: "performance", label: "パフォーマンス品質" },
  { id: "code", label: "コード品質" },
  { id: "test", label: "テスト品質" },
  { id: "api", label: "API連携品質" },
  { id: "security", label: "セキュリティ品質" },
  { id: "i18n", label: "国際化（i18n）品質" },
  { id: "operations", label: "運用・保守性" },
  { id: "build", label: "ビルド・デプロイ品質" },
  { id: "dependencies", label: "依存関係・ライブラリ品質" },
];

export const TEST_PRESENCE_BUCKETS: TestPresenceBucketDescriptor[] = [
  { id: "route", label: "Route", metricId: "route_test_file_presence" },
  { id: "feature", label: "Feature", metricId: "feature_test_file_presence" },
  { id: "form", label: "Form", metricId: "form_test_file_presence" },
  { id: "ui", label: "UI", metricId: "ui_test_file_presence" },
];

export const DEFAULT_TEST_PRESENCE_SETTINGS: TestPresenceSettings = {
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
