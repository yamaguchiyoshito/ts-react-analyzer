import ts from "typescript";

export type OutputFormat = "json" | "markdown" | "csv" | "html" | "all";
export type DependencyType = "import" | "export" | "dynamic-import" | "side-effect-import";
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type RiskLevel = "low" | "medium" | "high";
export type AnalysisScope = "all" | "source-only";
export type QualityProfile = "application" | "library-repo";
export type TestPresenceBucketId = "route" | "feature" | "form" | "ui";

export interface TestPresenceThresholdConfig {
  pass: number;
  warn: number;
}

export interface TestPresenceBucketWeightConfig {
  route: number;
  feature: number;
  form: number;
  layout: number;
  api: number;
  schema: number;
  validation: number;
  hook: number;
  context: number;
  ui: number;
  shared: number;
}

export interface TestPresenceSettings {
  thresholds: Record<QualityProfile, TestPresenceThresholdConfig>;
  bucketWeights: TestPresenceBucketWeightConfig;
  staticImportTraversalMaxDepth: number;
  runtimeLineCoverageMinPercent: number;
  knownCallNames: string[];
  knownFrameworkModules: string[];
}

export interface AnalysisConfig {
  analysisScope: AnalysisScope;
  qualityProfile: QualityProfile;
  testPresenceSettings: TestPresenceSettings;
  excludeGroups: string[];
  excludePatterns: string[];
  outputFormats: OutputFormat[];
  outputDir: string;
  filePrefix: string;
  complexityThreshold: number;
  impactScoreThreshold: number;
  failOnImpactThreshold: boolean;
  maxFileSizeBytes: number;
  verbose: boolean;
  enableCache: boolean;
  cacheDir: string;
  logFile: string;
  manualInputPath?: string;
  qualityGateBlockingMetricIds: string[];
  qualityGateMonitoringMetricIds: string[];
  maxTypeCheckRootNames: number;
  tsConfigPath?: string;
  projectRoot?: string;
  tsCompilerOptions: ts.CompilerOptions;
  pathMappings: Record<string, string[]>;
}

export interface ScanError {
  filePath: string;
  reason: string;
  timestamp: number;
}

export interface SkippedFile {
  filePath: string;
  reason: string;
  isDirectory: boolean;
}

export interface ParseIssue {
  filePath: string;
  diagnosticCount: number;
}

export interface FileMetadata {
  lineCount: number;
  byteSize: number;
  hasTrailingNewline: boolean;
  lastModifiedMs: number;
  lastNewlineOffset: number;
  encoding: "utf-8" | "utf-8-bom" | "unknown";
  scriptKind: ts.ScriptKind;
  sha256: string;
  parseDiagnosticCount: number;
}

export interface ParsedFile {
  filePath: string;
  sourceFile: ts.SourceFile;
  sourceCode: string;
  metadata: FileMetadata;
}

export interface CacheRecord {
  filePath: string;
  mtimeMs: number;
  sha256: string;
  byteSize: number;
  timestamp: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface IncrementalStats {
  reusedFiles: number;
  recomputedFiles: number;
}

export interface CachedAnalysisPayload {
  dependencies: Dependency[];
  dependencyErrors: ExtractionError[];
  complexity: FileComplexityAnalysis;
  parseDiagnosticCount?: number;
}

export interface CachedAnalysisRecord {
  filePath: string;
  sourceSha256: string;
  configHash: string;
  analysisContextHash: string;
  payload: CachedAnalysisPayload;
  timestamp: number;
}

export interface ScanResult {
  parsed: ParsedFile[];
  skipped: SkippedFile[];
  errors: ScanError[];
  cacheStats: CacheStats;
}

export interface ImportedItem {
  name: string;
  alias?: string;
  kind: "default" | "named" | "namespace";
  isNamed: boolean;
}

export interface ExportedItem {
  name: string;
  alias?: string;
  kind: "named" | "namespace" | "default" | "all";
}

export interface DependencyRange {
  start: number;
  end: number;
  line: number;
  character: number;
}

export interface Dependency {
  source: string;
  target: string;
  type: DependencyType;
  isExternal: boolean;
  modulePath: string;
  imported?: ImportedItem[];
  exported?: ExportedItem[];
  range: DependencyRange;
}

export interface BarrelInfo {
  source: string;
  barrel: string;
  items: ImportedItem[];
}

export interface ExtractionError {
  node: ts.LineAndCharacter;
  message: string;
}

export interface ExtractionResult {
  dependencies: Dependency[];
  barrels: BarrelInfo[];
  errors: ExtractionError[];
  externalCount: number;
  internalCount: number;
  sideEffectImports: number;
}

export interface CircularDep {
  nodes: string[];
  length: number;
  severity: "critical" | "high" | "medium";
  affectedFiles: number;
}

export interface ParameterMetric {
  name: string;
  type: string;
  optional: boolean;
  hasDefault: boolean;
}

export interface FunctionMetrics {
  name: string;
  cyclomaticComplexity: number;
  startLine: number;
  endLine: number;
  lineCount: number;
  branchCount: number;
  loopCount: number;
  ternaryCount: number;
  logicalOpCount: number;
  maxNestingDepth: number;
  isAsync: boolean;
  params: ParameterMetric[];
  riskLevel: RiskLevel;
}

export interface HookInfo {
  name: string;
  startLine: number;
  args: number;
  hasDependencies: boolean;
}

export interface PropProperty {
  name: string;
  required: boolean;
  type: string;
}

export interface PropType {
  name: string;
  typeDeclaration: string;
  properties: PropProperty[];
}

export interface RenderComplexity {
  hasConditionalRender: boolean;
  hasListRender: boolean;
  fragmentCount: number;
  complexity: number;
}

export interface ComponentMetrics {
  name: string;
  jsxElements: number;
  hooksUsed: HookInfo[];
  hookCount: number;
  propsInterface: PropType | null;
  hasChildren: boolean;
  usesRef: boolean;
  isForwardRef: boolean;
  startLine: number;
  endLine: number;
  renderComplexity: RenderComplexity;
}

export interface TypeSafetyMetrics {
  anyTypeCount: number;
  unknownTypeCount: number;
  assertionCount: number;
  nonNullAssertionCount: number;
  tsIgnoreCount: number;
  tsExpectErrorCount?: number;
  tsNoCheckCount?: number;
  unsafeAssertionCount?: number;
  doubleAssertionCount?: number;
  constAssertionCount?: number;
  uncheckedPatterns: string[];
}

export interface ComplexityScoreBreakdown {
  averageFunctionComplexity: number;
  peakFunctionComplexity: number;
  topFunctionAverage: number;
  averageRenderComplexity: number;
  peakRenderComplexity: number;
  hookPressure: number;
  peakNestingDepth: number;
  elevatedFunctionCount: number;
  weightedScore: number;
}

export interface FileComplexityAnalysis {
  filePath: string;
  totalLines: number;
  codeLines: number;
  commentLines: number;
  functions: FunctionMetrics[];
  components: ComponentMetrics[];
  hooks: HookInfo[];
  typeMetrics: TypeSafetyMetrics;
  scoreBreakdown: ComplexityScoreBreakdown;
  overallComplexity: number;
}

export interface AnalysisResult {
  filePath: string;
  complexity: FileComplexityAnalysis;
  dependencies: Dependency[];
  dependencyErrors: ExtractionError[];
}

export interface GraphNode {
  id: string;
  inDegree: number;
  outDegree: number;
  pageRank: number;
}

export interface EdgeMetadata {
  type?: DependencyType;
  isExternal?: boolean;
}

export interface GraphMetrics {
  cycles: CircularDep[];
  totalDependencies: number;
  externalDependencies: number;
  stronglyConnectedComponents: string[][];
  weaklyConnectedComponents: string[][];
  topPageRank: Array<{ id: string; score: number }>;
  topInDegree: Array<{ id: string; degree: number }>;
  topOutDegree: Array<{ id: string; degree: number }>;
  largestStronglyConnectedComponentSize: number;
  warnings: string[];
}

export interface GraphJSON {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string; weight: number }>;
}

export interface GenerationOptions {
  outputDir: string;
  prefix: string;
  formats: OutputFormat[];
  complexityThreshold: number;
  executionTimeMs?: number;
  projectRoot?: string;
  skippedFiles?: SkippedFile[];
  scanErrors?: ScanError[];
  parseIssues?: ParseIssue[];
  cacheStats?: CacheStats;
  analysisCacheStats?: CacheStats;
  incrementalStats?: IncrementalStats;
  graphJson?: GraphJSON;
}

export interface PersistedFileReport {
  path: string;
  complexity: FileComplexityAnalysis;
  dependencies: Dependency[];
  dependencyErrors: ExtractionError[];
  warnings: string[];
}

export interface HotSpotReportItem {
  path: string;
  displayPath: string;
  score: number;
  cluster: string;
  complexity: number;
  codeLines: number;
  dependencies: number;
  hooks: number;
  anyCount: number;
  reasons: string[];
  complexityDrivers?: string[];
  action: string;
}

export interface RiskAxisBreakdown {
  low: number;
  medium: number;
  high: number;
}

export interface DecisionSummaryReport {
  topHotSpots: HotSpotReportItem[];
  cycleCount: number;
  cycleStatus: string;
  riskSummary: {
    complexity: RiskAxisBreakdown;
    structure: RiskAxisBreakdown;
    typeSafety: RiskAxisBreakdown;
  };
  typeSafetyAlerts: {
    criticalSignals: number;
    anyCount: number;
    assertionCount: number;
    nonNullAssertionCount: number;
    tsIgnoreCount: number;
    tsExpectErrorCount?: number;
    tsNoCheckCount?: number;
    unsafeAssertionCount?: number;
    doubleAssertionCount?: number;
  };
}

export type PurposeAlignmentSeverity = "high" | "medium" | "low";

export interface PurposeAlignmentFinding {
  filePath: string;
  fileType: string;
  purpose: string;
  rule: string;
  severity: PurposeAlignmentSeverity;
  issue: string;
  suggestion: string;
}

export interface DirectoryPurposeAuditReport {
  findings: PurposeAlignmentFinding[];
  summary: {
    high: number;
    medium: number;
    low: number;
  };
}

export interface PersistedAnalysisReport {
  timestamp: string;
  executionTimeMs: number;
  statistics: {
    fileCount: number;
    totalLines: number;
    functionCount: number;
    componentCount: number;
    averageComplexity: number;
  };
  files: PersistedFileReport[];
  graph: GraphMetrics;
  skippedFiles?: SkippedFile[];
  scanErrors?: ScanError[];
  cacheStats?: CacheStats;
  analysisCacheStats?: CacheStats;
  incrementalStats?: IncrementalStats;
  graphJson?: GraphJSON;
  decisionSummary?: DecisionSummaryReport;
  directoryPurposeAudit?: DirectoryPurposeAuditReport;
}

export interface FileDiffEntry {
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  complexityDelta: number;
  dependencyDelta: number;
  warningDelta: string[];
}

export interface AnalysisDiffReport {
  generatedAt: string;
  baselinePath: string;
  currentPath: string;
  summary: {
    addedFiles: number;
    removedFiles: number;
    changedFiles: number;
    unchangedFiles: number;
    complexityDelta: number;
    dependencyDelta: number;
  };
  graphDelta: {
    cycleDelta: number;
    dependencyDelta: number;
    externalDependencyDelta?: number;
    warningDelta: string[];
  };
  hotSpotDelta: {
    added: HotSpotReportItem[];
    removed: HotSpotReportItem[];
    changed: Array<{
      path: string;
      currentDisplayPath: string;
      baselineDisplayPath: string;
      scoreDelta: number;
      complexityDelta: number;
      dependencyDelta: number;
      anyDelta: number;
      clusterBefore: string;
      clusterAfter: string;
      baselineComplexityDrivers?: string[];
      currentComplexityDrivers?: string[];
      complexityDriverDelta?: string[];
    }>;
  };
  impact: {
    changedFiles: string[];
    impactedFiles: string[];
    prioritizedFiles: Array<{
      path: string;
      score: number;
      distance: number;
      inboundDegree: number;
      outboundDegree: number;
      directlyChanged: boolean;
      complexityPressure: number;
      complexitySignals: string[];
      reasons: string[];
    }>;
    subtrees: Array<{
      root: string;
      impactedFiles: string[];
      metrics: {
        impactedCount: number;
        maxScore: number;
        averageScore: number;
        averageDistance: number;
        maxInboundDegree: number;
        maxOutboundDegree: number;
      };
      graph: GraphJSON;
    }>;
    graph: GraphJSON;
  };
  files: FileDiffEntry[];
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export type QualityCategoryId =
  | "functional"
  | "uiux"
  | "accessibility"
  | "performance"
  | "code"
  | "test"
  | "api"
  | "security"
  | "i18n"
  | "operations"
  | "build"
  | "dependencies";

export type QualityVerdict = "pass" | "partial" | "warn" | "fail" | "manual" | "not_applicable";
export type QualityAutomationLevel = "automatic" | "manual";
export type QualityMetricAggregation = "primary" | "derived";
export type QualityDiffStatus = "added" | "removed" | "changed" | "unchanged";
export type QualityDiffTrend = "improved" | "regressed" | "neutral";

export interface QualityEvidence {
  type: "file" | "metric" | "note";
  label: string;
  value: string;
  filePath?: string;
}

export interface QualityMetricReport {
  id: string;
  category: QualityCategoryId;
  label: string;
  aggregation: QualityMetricAggregation;
  actual: string;
  threshold: string;
  verdict: QualityVerdict;
  automation: QualityAutomationLevel;
  summary: string;
  evidence: QualityEvidence[];
}

export interface QualityCategoryReport {
  id: QualityCategoryId;
  label: string;
  verdict: QualityVerdict;
  summary: string;
  metrics: QualityMetricReport[];
}

export interface QualitySummary {
  totalMetrics: number;
  derivedMetricCount: number;
  passCount: number;
  partialCount: number;
  partialCategoryCount: number;
  warnCount: number;
  failCount: number;
  manualCount: number;
  notApplicableCount: number;
  overallVerdict: QualityVerdict;
}

export interface WorkspaceSegmentSummary {
  id: "apps" | "packages" | "src" | "other";
  label: string;
  fileCount: number;
  componentCount: number;
  typeEscapeCount: number;
  highResponsibilityComponentCount: number;
  visualConsumerCount: number;
  designSystemBackedCount: number;
  testTargetFiles: number;
  matchedTestFiles: number;
  weightedTestRate: number;
  productTextCount: number;
}

export interface FeatureSummary {
  id: string;
  label: string;
  fileCount: number;
  componentCount: number;
  averageComplexity: number;
  maxComplexity: number;
  typeEscapeCount: number;
  highResponsibilityComponentCount: number;
  visualConsumerCount: number;
  designSystemBackedCount: number;
  testTargetFiles: number;
  matchedTestFiles: number;
  weightedTestRate: number;
  productTextCount: number;
}

export interface QualityGateOffender {
  category: string;
  label: string;
  actual: string;
  threshold: string;
}

export interface QualityGateRegression {
  category: string;
  label: string;
  baselineVerdict: string;
  currentVerdict: string;
}

export interface QualityGateRenderContext {
  mode: "collect" | "report" | "gate" | "diff";
  baselinePath?: string;
  baselineOverallVerdict?: QualityVerdict;
  regressedCount?: number;
  improvedCount?: number;
  gateVerdict?: "pass" | "fail";
  failingAutomaticMetrics: QualityGateOffender[];
  blockingRegressions: QualityGateRegression[];
}

export interface QualityReport {
  timestamp: string;
  executionTimeMs: number;
  projectRoot: string;
  qualityProfile?: QualityProfile;
  summary: QualitySummary;
  workspaceSegments?: WorkspaceSegmentSummary[];
  featureSummaries?: FeatureSummary[];
  categories: QualityCategoryReport[];
}

export interface ManualQualityMetricInput {
  id: string;
  actual?: string;
  threshold?: string;
  verdict?: QualityVerdict;
  summary?: string;
  evidence?: QualityEvidence[];
}

export interface QualityMetricDiffEntry {
  id: string;
  category: QualityCategoryId;
  categoryLabel: string;
  label: string;
  baselineAggregation?: QualityMetricAggregation;
  currentAggregation?: QualityMetricAggregation;
  status: QualityDiffStatus;
  trend: QualityDiffTrend;
  baselineActual?: string;
  currentActual?: string;
  baselineThreshold?: string;
  currentThreshold?: string;
  baselineVerdict?: QualityVerdict;
  currentVerdict?: QualityVerdict;
  baselineAutomation?: QualityAutomationLevel;
  currentAutomation?: QualityAutomationLevel;
  baselineSummary?: string;
  currentSummary?: string;
  changes: string[];
}

export interface QualityCategoryDiffReport {
  id: QualityCategoryId;
  label: string;
  status: QualityDiffStatus;
  baselineVerdict?: QualityVerdict;
  currentVerdict?: QualityVerdict;
  changedMetrics: number;
  improvedMetrics: number;
  regressedMetrics: number;
  addedMetrics: number;
  removedMetrics: number;
  unchangedMetrics: number;
}

export interface QualityDiffReport {
  generatedAt: string;
  baselinePath: string;
  currentPath: string;
  baselineTimestamp: string;
  currentTimestamp: string;
  summary: {
    baselineOverallVerdict: QualityVerdict;
    currentOverallVerdict: QualityVerdict;
    changedCategories: number;
    changedMetrics: number;
    improvedMetrics: number;
    regressedMetrics: number;
    automaticRegressions: number;
    manualRegressions: number;
    addedMetrics: number;
    removedMetrics: number;
    unchangedMetrics: number;
  };
  categories: QualityCategoryDiffReport[];
  metrics: QualityMetricDiffEntry[];
}
