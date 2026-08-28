// 3x3 マトリクス (行数帯 × 複雑度帯) のクラスタコード。
// 旧表記 "S-L" 等は、行数の L (Large) と複雑度の L (Low) が同じ文字で衝突し
// 誤読を招いたため、複雑度側を数字 (1=低, 2=中, 3=高) にした "S1"〜"L3" へ
// 再符号化した。旧コードを含む baseline とも比較できるよう変換表を持つ。

const LEGACY_CLUSTER_CODES: Record<string, string> = {
  "S-L": "S1",
  "S-M": "S2",
  "S-H": "S3",
  "M-L": "M1",
  "M-M": "M2",
  "M-H": "M3",
  "L-L": "L1",
  "L-M": "L2",
  "L-H": "L3",
};

const CLUSTER_AXIS_LABELS: Record<string, string> = {
  S1: "小規模・低複雑度",
  S2: "小規模・中複雑度",
  S3: "小規模・高複雑度",
  M1: "中規模・低複雑度",
  M2: "中規模・中複雑度",
  M3: "中規模・高複雑度",
  L1: "大規模・低複雑度",
  L2: "大規模・中複雑度",
  L3: "大規模・高複雑度",
};

const CLUSTER_MEANINGS: Record<string, string> = {
  S1: "小規模で安定",
  S2: "小規模だが分岐あり",
  S3: "小規模だが高リスク",
  M1: "中規模で管理可能",
  M2: "中規模で中リスク",
  M3: "中規模で高リスク",
  L1: "大規模だが安定",
  L2: "大規模で要注意",
  L3: "大規模で高リスク",
};

const CLUSTER_WEIGHTS: Record<string, number> = {
  L3: 18,
  M3: 12,
  L2: 10,
  S3: 8,
  M2: 6,
  L1: 4,
  S2: 3,
};

export const CLUSTER_CODES = ["S1", "S2", "S3", "M1", "M2", "M3", "L1", "L2", "L3"] as const;

export function normalizeClusterCode(code: string): string {
  return LEGACY_CLUSTER_CODES[code] ?? code;
}

export function describeClusterAxes(code: string): string {
  return CLUSTER_AXIS_LABELS[normalizeClusterCode(code)] ?? "未分類";
}

export function describeClusterMeaning(code: string): string {
  return CLUSTER_MEANINGS[normalizeClusterCode(code)] ?? "未分類";
}

export function formatClusterWithLabel(code: string): string {
  const normalized = normalizeClusterCode(code);
  const label = CLUSTER_AXIS_LABELS[normalized];
  return label ? `${normalized} (${label})` : normalized;
}

export function getClusterWeight(code: string): number {
  return CLUSTER_WEIGHTS[normalizeClusterCode(code)] ?? 1;
}

export function isHighComplexityCluster(code: string): boolean {
  return normalizeClusterCode(code).endsWith("3");
}
