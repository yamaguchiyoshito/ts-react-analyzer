import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import type {
  CacheStats,
  CachedAnalysisPayload,
  CachedAnalysisRecord,
  Dependency,
} from "../types/index.js";

// レコード形式の版。形式やキーの意味を変えたら上げる (旧版のレコードは全てミス扱い)。
//   1: 初版 (絶対パスキー、ファイル集合を見ない)
//   2: プロジェクト相対パスキー、fileSetHash / internalTargets を追加
export const ANALYSIS_CACHE_SCHEMA = 2;

// アナライザ自身の版と TypeScript の版をキャッシュキーへ混ぜ、解析ロジックや
// モジュール解決の挙動が変わった後に旧い解析結果を再利用しないようにする。
const ANALYZER_VERSION = readAnalyzerVersion();

function readAnalyzerVersion(): string {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  // src/core から実行されれば ../../package.json、dist/src/core からなら ../../../package.json
  const candidates = [
    path.join(baseDir, "..", "..", "package.json"),
    path.join(baseDir, "..", "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // 次の候補を試す
    }
  }
  return "0";
}

export interface AnalysisCacheOptions {
  // false ならキャッシュを読まず書かず、ディレクトリも作らない (全件ミスとして数える)
  enabled?: boolean;
  // 走査対象ファイル集合の指紋 (computeFileSetHash)。ファイルの追加・削除・改名で変わり、
  // 未変更ファイルの import 解決先が変わり得るため、一致しないレコードはミス扱いにする
  fileSetHash?: string;
  // キャッシュファイル名 (プロジェクト識別子) の材料。絶対パスに依存しないよう相対化して使う
  tsConfigPath?: string;
}

// 走査候補ファイルの集合から指紋を作る。絶対パスを混ぜないよう projectRoot 相対にする
export function computeFileSetHash(projectRoot: string, filePaths: Iterable<string>): string {
  const root = path.resolve(projectRoot);
  const relativePaths = Array.from(new Set(Array.from(filePaths, (filePath) => toCachePath(root, filePath)))).sort();
  return crypto.createHash("sha256").update(relativePaths.join("\n")).digest("hex");
}

// projectRoot 配下の絶対パスをスラッシュ区切りの相対パスへ。配下でなければそのまま返す
function toCachePath(projectRoot: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join("/");
  }
  const relative = path.relative(projectRoot, filePath);
  if (relative === "") {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative.split(path.sep).join("/");
}

function fromCachePath(projectRoot: string, cachePath: string): string {
  return path.isAbsolute(cachePath) ? cachePath : path.resolve(projectRoot, cachePath);
}

export class AnalysisCache {
  private readonly enabled: boolean;
  private readonly projectRoot: string;
  private readonly cacheFile: string;
  private readonly baseConfigHash: string;
  private readonly fileSetHash: string;
  private readonly records = new Map<string, CachedAnalysisRecord>();
  private readonly nextRecords = new Map<string, CachedAnalysisRecord>();
  private readonly stats: CacheStats = { hits: 0, misses: 0 };
  private dirty = false;

  constructor(
    cacheDir: string,
    projectRoot: string,
    compilerOptions: ts.CompilerOptions,
    options: AnalysisCacheOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.projectRoot = path.resolve(projectRoot);
    this.fileSetHash = options.fileSetHash ?? "";
    const projectKey = this.hash(this.buildProjectIdentity(options.tsConfigPath)).slice(0, 16);
    this.cacheFile = path.join(cacheDir, "analysis", `${projectKey}.json`);
    this.baseConfigHash = this.hash(
      `${ANALYSIS_CACHE_SCHEMA}::${ANALYZER_VERSION}::${ts.version}::${this.stableStringify(compilerOptions)}`,
    );
  }

  static computeFileSetHash(projectRoot: string, filePaths: Iterable<string>): string {
    return computeFileSetHash(projectRoot, filePaths);
  }

  async initialize(): Promise<void> {
    this.records.clear();
    if (!this.enabled) {
      return;
    }
    // 壊れた・読めないキャッシュは黙ってコールドスタートする
    try {
      const content = await fs.readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const record of parsed as Array<Partial<CachedAnalysisRecord>>) {
        if (
          !record
          || typeof record !== "object"
          || record.schema !== ANALYSIS_CACHE_SCHEMA
          || typeof record.filePath !== "string"
        ) {
          continue;
        }
        this.records.set(record.filePath, record as CachedAnalysisRecord);
      }
    } catch {
      this.records.clear();
    }
  }

  get(filePath: string, sourceSha256: string, analysisContextHash: string): CachedAnalysisPayload | null {
    if (!this.enabled) {
      this.stats.misses += 1;
      return null;
    }

    const key = toCachePath(this.projectRoot, filePath);
    const record = this.records.get(key);
    if (
      !record
      || record.schema !== ANALYSIS_CACHE_SCHEMA
      || record.sourceSha256 !== sourceSha256
      || record.configHash !== this.baseConfigHash
      || record.analysisContextHash !== analysisContextHash
      || record.fileSetHash !== this.fileSetHash
      || !this.internalTargetsExist(record)
    ) {
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    this.nextRecords.set(key, record);
    return this.toAbsolutePayload(record.payload, filePath);
  }

  set(filePath: string, sourceSha256: string, analysisContextHash: string, payload: CachedAnalysisPayload): void {
    if (!this.enabled) {
      return;
    }
    this.dirty = true;
    const key = toCachePath(this.projectRoot, filePath);
    const internalTargets = Array.from(new Set(
      payload.dependencies
        .filter((dependency) => !dependency.isExternal)
        .map((dependency) => toCachePath(this.projectRoot, dependency.target)),
    )).sort();
    this.nextRecords.set(key, {
      schema: ANALYSIS_CACHE_SCHEMA,
      filePath: key,
      sourceSha256,
      configHash: this.baseConfigHash,
      analysisContextHash,
      fileSetHash: this.fileSetHash,
      internalTargets,
      payload: this.toRelativePayload(payload),
      timestamp: Date.now(),
    });
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async persist(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    // 全件ヒット (更新も削除もなし) なら内容が変わらないため書き込みを省略する
    if (!this.dirty && this.nextRecords.size === this.records.size) {
      return;
    }
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const records = Array.from(this.nextRecords.values()).sort((left, right) => left.filePath.localeCompare(right.filePath));
    // 途中で落ちても壊れたキャッシュを残さないよう、一時ファイルへ書いてから rename で置き換える。
    // 数十 MB になり得るためインデントなしで直列化する
    const tempFile = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(records), "utf8");
      await fs.rename(tempFile, this.cacheFile);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // 解決先が消えていれば (改名・削除)、参照元が未変更でも辺が古いので再解析する
  private internalTargetsExist(record: CachedAnalysisRecord): boolean {
    if (!Array.isArray(record.internalTargets)) {
      return false;
    }
    return record.internalTargets.every((target) => existsSync(fromCachePath(this.projectRoot, target)));
  }

  // 永続化するパスはプロジェクト相対にし、別の絶対パスへ配置し直した checkout でも再利用できるようにする
  private toRelativePayload(payload: CachedAnalysisPayload): CachedAnalysisPayload {
    return {
      ...payload,
      complexity: {
        ...payload.complexity,
        filePath: toCachePath(this.projectRoot, payload.complexity.filePath),
      },
      dependencies: payload.dependencies.map((dependency) => this.mapDependencyPaths(
        dependency,
        (value) => toCachePath(this.projectRoot, value),
      )),
    };
  }

  private toAbsolutePayload(payload: CachedAnalysisPayload, filePath: string): CachedAnalysisPayload {
    return {
      ...payload,
      complexity: {
        ...payload.complexity,
        filePath: payload.complexity.filePath === toCachePath(this.projectRoot, filePath)
          ? filePath
          : fromCachePath(this.projectRoot, payload.complexity.filePath),
      },
      dependencies: payload.dependencies.map((dependency) => this.mapDependencyPaths(
        dependency,
        (value) => fromCachePath(this.projectRoot, value),
      )),
    };
  }

  private mapDependencyPaths(dependency: Dependency, convert: (value: string) => string): Dependency {
    return {
      ...dependency,
      source: convert(dependency.source),
      // 外部依存の target はパッケージ名なので触らない
      target: dependency.isExternal ? dependency.target : convert(dependency.target),
    };
  }

  // キャッシュファイル名はプロジェクトの絶対パスではなく、package.json の name と
  // tsconfig の相対位置から決める (CI で別パスへ復元しても同じファイルを引ける)
  private buildProjectIdentity(tsConfigPath: string | undefined): string {
    let packageName = "project";
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.projectRoot, "package.json"), "utf8")) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        packageName = parsed.name;
      }
    } catch {
      // package.json が無い・壊れている場合は既定の識別子を使う
    }
    const tsConfigKey = tsConfigPath ? toCachePath(this.projectRoot, path.resolve(this.projectRoot, tsConfigPath)) : "";
    return `${packageName}::${tsConfigKey}`;
  }

  // ハッシュ用の直列化。compilerOptions には tsconfig 解析時に絶対化された baseUrl /
  // configFilePath などが含まれるため、projectRoot 配下の絶対パスは相対化してから混ぜる
  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
    }

    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(",")}}`;
    }

    if (typeof value === "string" && path.isAbsolute(value)) {
      return JSON.stringify(toCachePath(this.projectRoot, value));
    }

    return JSON.stringify(value);
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }
}
