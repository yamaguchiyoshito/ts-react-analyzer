import type { QualityDiffReport, QualityMetricDiffEntry, QualityReport } from "../types/index.js";

export interface QualityGateMetricSelection {
  qualityGateBlockingMetricIds: string[];
  qualityGateMonitoringMetricIds: string[];
}

export interface QualityGateMetricIdValidation {
  knownMetricIds: string[];
  unknownBlockingMetricIds: string[];
  unknownMonitoringMetricIds: string[];
  /** blocking に指定された ID がすべて未知 (= gate 対象が 1 件も残らない) */
  blockingAllUnknown: boolean;
}

/**
 * 実測できていた指標 (automatic) が今回 manual (証跡待ち) に落ちた「証跡の喪失」か。
 * 例: 前回は lcov.info があったが今回は生成されなかった。
 * verdictScore 上は良化に見えるため、明示的に検出しないと gate をすり抜ける。
 */
export function isEvidenceLossRegression(metric: QualityMetricDiffEntry): boolean {
  return metric.trend === "regressed"
    && metric.baselineAutomation === "automatic"
    && metric.currentAutomation === "manual";
}

/**
 * baseline 比較で gate を落とす対象となる悪化指標を選ぶ。
 *
 * - 親指標のみ (派生指標は診断情報)
 * - 自動判定の悪化 (pass -> warn 等)、または自動 -> manual の証跡喪失
 * - 同一判定内の数値悪化は差分レポートで可視化するだけで gate は落とさない
 * - monitoring に入れた指標は除外、blocking 指定があればその指標だけに絞る
 */
export function selectBlockingRegressionMetrics(
  diff: QualityDiffReport,
  selection: QualityGateMetricSelection,
): QualityMetricDiffEntry[] {
  const monitoringMetricIds = new Set(selection.qualityGateMonitoringMetricIds);
  const blockingMetricIds = new Set(selection.qualityGateBlockingMetricIds);

  return diff.metrics.filter((metric) => {
    if ((metric.currentAggregation ?? metric.baselineAggregation ?? "primary") !== "primary") {
      return false;
    }
    if (metric.trend !== "regressed") {
      return false;
    }
    if (metric.currentAutomation !== "automatic" && !isEvidenceLossRegression(metric)) {
      return false;
    }
    // 同一判定内の数値悪化 (fail のまま件数増など) は差分レポートで可視化する
    // のみとし、gate はドキュメントどおり判定の悪化 (pass->warn 等) だけで落とす
    if (metric.baselineVerdict === metric.currentVerdict) {
      return false;
    }
    if (monitoringMetricIds.has(metric.id)) {
      return false;
    }
    if (blockingMetricIds.size > 0) {
      return blockingMetricIds.has(metric.id);
    }
    return true;
  });
}

/**
 * 設定された gate 指標 ID がレポートに存在するかを照合する。
 * typo で blocking 指標が 1 件も一致しないと「gate 対象なし」として素通りするため、
 * 呼び出し側で利用者エラーとして扱えるように blockingAllUnknown を返す。
 */
export function validateQualityGateMetricIds(
  report: Pick<QualityReport, "categories">,
  selection: QualityGateMetricSelection,
): QualityGateMetricIdValidation {
  const knownMetricIds = new Set<string>();
  for (const category of report.categories) {
    for (const metric of category.metrics) {
      knownMetricIds.add(metric.id);
    }
  }

  const unknownBlockingMetricIds = uniqueUnknown(selection.qualityGateBlockingMetricIds, knownMetricIds);
  const unknownMonitoringMetricIds = uniqueUnknown(selection.qualityGateMonitoringMetricIds, knownMetricIds);
  const blockingConfigured = selection.qualityGateBlockingMetricIds.filter((id) => id.trim().length > 0);

  return {
    knownMetricIds: Array.from(knownMetricIds).sort(),
    unknownBlockingMetricIds,
    unknownMonitoringMetricIds,
    blockingAllUnknown: blockingConfigured.length > 0
      && blockingConfigured.every((id) => !knownMetricIds.has(id)),
  };
}

function uniqueUnknown(ids: string[], known: Set<string>): string[] {
  return Array.from(new Set(ids.filter((id) => id.trim().length > 0 && !known.has(id))));
}
