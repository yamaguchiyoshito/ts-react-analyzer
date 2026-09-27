import path from "node:path";

import type { QualityVerdict } from "../types/index.js";

/**
 * レポート生成器 (ReportGenerator / QualityReportGenerator / DiffGenerator /
 * QualityDiffGenerator) で共有する表示・エスケープ・パス整形のユーティリティ。
 * 各生成器が同じ処理を個別に持つと、エスケープ漏れや表記ゆれ (例: `'` を
 * エスケープするかどうか) が生成器ごとに分かれてしまうため、ここに集約する。
 */

/**
 * レポート JSON (`*_report.json` / `*_quality_report.json`) のスキーマ版。
 * 互換性のない構造変更を入れたら上げる。cli の baseline 読込はこの版より新しい
 * ファイルを拒否し、版が無い (旧バージョンの) ファイルは受け入れる。
 */
export const REPORT_SCHEMA_VERSION = 1;

/** HTML のテキスト・属性値へ埋め込む前に & < > " ' をエスケープする */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * Markdown の表セルへ埋め込む値を整形する。`|` は列区切りと衝突するため
 * エスケープし、改行は行 (= 表の 1 レコード) を壊すので空白に潰す。
 * 特殊文字を含まない値はそのまま返るため、既存の表記は変わらない。
 */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/gu, " ")
    .replace(/\|/gu, "\\|");
}

/** `<script>` 内へ JSON を埋め込む。`</script>` や `<!--` で閉じられないよう `<` をエスケープする */
export function serializeForHtmlScript(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

/**
 * 表示用のパスへ変換する。projectRoot 配下の絶対パスは posix 区切りの相対パス、
 * それ以外 (相対パス・ルート外・projectRoot 未指定) は区切りだけ揃えて返す。
 */
export function toDisplayPath(filePath: string, projectRoot?: string): string {
  const normalized = filePath.split(path.sep).join("/");
  if (!projectRoot || !path.isAbsolute(filePath)) {
    return normalized;
  }
  const relativePath = path.relative(projectRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return normalized;
  }
  return relativePath.split(path.sep).join("/");
}

export interface CsvCellOptions {
  /** true のとき値に関わらず常に引用符で囲む (RFC 4180 上はどちらも妥当) */
  alwaysQuote?: boolean;
}

/** RFC 4180 に沿って CSV セルを整形する。区切り・引用符・改行を含むときは引用符で囲み、`"` は `""` にする */
export function csvCell(value: string, options: CsvCellOptions = {}): string {
  const needsQuote = options.alwaysQuote
    || value.includes(",")
    || value.includes("\"")
    || value.includes("\n")
    || value.includes("\r");
  return needsQuote ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}

export function toCsvRow(cells: string[], options: CsvCellOptions = {}): string {
  return cells.map((cell) => csvCell(cell, options)).join(",");
}

export function verdictMark(verdict?: QualityVerdict): string {
  switch (verdict) {
    case "pass":
      return "○";
    case "partial":
      return "◐";
    case "warn":
      return "△";
    case "fail":
      return "×";
    case "manual":
      return "―";
    default:
      return "";
  }
}

export function verdictLabel(verdict?: QualityVerdict): string {
  switch (verdict) {
    case "pass":
      return "PASS";
    case "partial":
      return "PARTIAL";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
    case "manual":
      return "MANUAL";
    case "not_applicable":
      return "N/A";
    case undefined:
      return "なし";
    default:
      // 旧バージョンの JSON に未知の判定値があっても落とさず、そのまま表示する
      return String(verdict);
  }
}

// 判定は「記号 + 英字」の二重表記にする。色に依存せず、一覧表を斜め読み
// したときに ○△× で状態が拾えるようにするための表示規則
export function verdictBadge(verdict?: QualityVerdict): string {
  const mark = verdictMark(verdict);
  const label = verdictLabel(verdict);
  return mark ? `${mark} ${label}` : label;
}

/** 文字列集合の差分を `+追加` / `-削除` の形で返す (順序は current, baseline の出現順) */
export function diffStrings(current: string[], baseline: string[]): string[] {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  const added = current.filter((item) => !baselineSet.has(item)).map((item) => `+${item}`);
  const removed = baseline.filter((item) => !currentSet.has(item)).map((item) => `-${item}`);
  return [...added, ...removed];
}

/** 4 種の HTML レポートで共通の基本スタイル。各レポートはこの後ろに固有のルールを足す */
export const REPORT_BASE_CSS = `    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111827; line-height: 1.5; }
    h1, h2 { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; background: #ffffff; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #e2e8f0; }
    .card { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
    .table-wrap { overflow-x: auto; }
    code { background: #e2e8f0; border-radius: 4px; padding: 0 4px; }
    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button { border: 1px solid #94a3b8; background: #ffffff; border-radius: 6px; padding: 6px 10px; cursor: pointer; }`;

// ---------------------------------------------------------------------------
// テストファイル対応の照合
// ---------------------------------------------------------------------------

const SOURCE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/iu;
const TEST_DIRECTORY_SEGMENTS = new Set(["__tests__", "tests", "test", "e2e", "playwright", "cypress", ".storybook"]);
const TEST_SUFFIX_PATTERN = /\.(test|spec|e2e|cy|ct|stories|story|fixture)$/iu;

/** 照合キーの基礎形: projectRoot 相対・posix 区切り・拡張子なし・小文字 */
export function normalizeMatchPath(filePath: string, projectRoot?: string): string {
  return toDisplayPath(filePath.replace(/\\/gu, "/"), projectRoot)
    .replace(SOURCE_EXTENSION_PATTERN, "")
    .toLowerCase();
}

function expandSrcVariants(normalizedPath: string): string[] {
  const keys = new Set<string>([normalizedPath]);
  if (normalizedPath.startsWith("src/")) {
    keys.add(normalizedPath.slice(4));
  } else if (!normalizedPath.startsWith("/") && normalizedPath.length > 0) {
    keys.add(`src/${normalizedPath}`);
  }
  return Array.from(keys).filter(Boolean);
}

/** ソースファイル側の照合キー (`src/` の有無を吸収する) */
export function buildSourceMatchKeys(filePath: string, projectRoot?: string): string[] {
  return expandSrcVariants(normalizeMatchPath(filePath, projectRoot));
}

/**
 * テストファイルのパスから、命名規約上それが対応するソースの照合キーを作る。
 * `__tests__/` や `tests/` などのディレクトリと `.test` / `.spec` などの接尾辞を外す。
 */
export function buildTestPathConventionKeys(filePath: string, projectRoot?: string): string[] {
  const normalizedPath = normalizeMatchPath(filePath, projectRoot)
    .split("/")
    .filter((segment) => !TEST_DIRECTORY_SEGMENTS.has(segment))
    .join("/")
    .replace(TEST_SUFFIX_PATTERN, "");
  return expandSrcVariants(normalizedPath);
}

/** テストファイル群から、対応ソースの照合キー集合を作る */
export function collectTestTargetKeys(testFilePaths: Iterable<string>, projectRoot?: string): Set<string> {
  const targets = new Set<string>();
  for (const filePath of testFilePaths) {
    for (const key of buildTestPathConventionKeys(filePath, projectRoot)) {
      targets.add(key);
    }
  }
  return targets;
}

/** ソースファイルに命名規約上対応するテストが `testTargetKeys` に含まれるか */
export function hasMatchingTestFile(filePath: string, testTargetKeys: Set<string>, projectRoot?: string): boolean {
  return buildSourceMatchKeys(filePath, projectRoot).some((key) => testTargetKeys.has(key));
}
