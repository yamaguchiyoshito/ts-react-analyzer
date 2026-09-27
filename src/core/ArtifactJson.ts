import fs from "node:fs/promises";

export type JsonArtifactReadResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * 成果物 JSON を読み込み、壊れていても例外を投げずに結果として返す。
 * 成果物は CI の途中失敗などで欠損・切り詰めが起きやすく、1 ファイルの破損で
 * 品質レポート全体が落ちるのは避けたい。呼び出し側はエラーを警告として記録し、
 * 該当指標を手動判定 (manual) に留める。
 */
export async function readJsonArtifact(filePath: string): Promise<JsonArtifactReadResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: `読み込みに失敗しました: ${describeError(error)}` };
  }

  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch (error) {
    return { ok: false, error: `JSON として解釈できません: ${describeError(error)}` };
  }
}

export async function readTextArtifact(filePath: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fs.readFile(filePath, "utf8") };
  } catch (error) {
    return { ok: false, error: `読み込みに失敗しました: ${describeError(error)}` };
  }
}

export function formatArtifactWarning(filePath: string, reason: string): string {
  return `${filePath}: ${reason}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
