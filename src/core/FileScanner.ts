import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { shouldIncludeInAnalysisScope } from "./FileConventions.js";
import type {
  AnalysisScope,
  CacheRecord,
  FileMetadata,
  ParsedFile,
  ScanError,
  ScanResult,
  SkippedFile,
} from "../types/index.js";

interface FileScannerOptions {
  excludePatterns: string[];
  maxFileSizeBytes: number;
  cacheDir: string;
  enableCache: boolean;
  analysisScope?: AnalysisScope;
  /** ファイル単位の stat / read / hash を同時に走らせる上限 (既定 16) */
  concurrency?: number;
}

type FileOutcome =
  | { kind: "parsed"; parsed: ParsedFile }
  | { kind: "skipped"; skipped: SkippedFile }
  | { kind: "error"; error: ScanError };

interface DecodedSource {
  sourceCode: string;
  hasBom: boolean;
}

const DEFAULT_CONCURRENCY = 16;

/**
 * items を先頭から順に、最大 limit 件まで同時に fn へ渡す。
 * 結果は items と同じ添字に置くので、完了順に依らず並びが決定的になる。
 * fn は reject しないことを前提にする (呼び出し側で捕捉しておく)。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class FileScanner {
  private readonly excludePatterns: RegExp[];
  private readonly patternWarnings: string[] = [];
  private readonly seenSymlinks = new Set<string>();
  private readonly maxFileSizeBytes: number;
  private readonly cacheDir: string;
  private readonly enableCache: boolean;
  private readonly analysisScope: AnalysisScope;
  private readonly concurrency: number;
  private readonly cacheIndex = new Map<string, CacheRecord>();
  private readonly nextCacheIndex = new Map<string, CacheRecord>();

  constructor(config: FileScannerOptions) {
    this.excludePatterns = config.excludePatterns.map((pattern) => this.toRegExp(pattern));
    this.maxFileSizeBytes = config.maxFileSizeBytes;
    this.cacheDir = config.cacheDir;
    this.enableCache = config.enableCache;
    this.analysisScope = config.analysisScope ?? "all";
    this.concurrency = config.concurrency && config.concurrency > 0 ? Math.floor(config.concurrency) : DEFAULT_CONCURRENCY;
  }

  async scanProject(rootPath: string): Promise<ScanResult> {
    const absoluteRoot = path.resolve(rootPath);
    const cacheFile = this.getCacheFilePath(absoluteRoot);
    await this.loadCacheIndex(cacheFile);
    // シンボリックリンクの重複判定はスキャン 1 回ごとに独立させる
    this.seenSymlinks.clear();
    this.nextCacheIndex.clear();

    const result: ScanResult = {
      parsed: [],
      skipped: [],
      errors: [],
      warnings: [...this.patternWarnings],
      cacheStats: { hits: 0, misses: 0 },
    };

    const files = await this.recurseDirectory(absoluteRoot, absoluteRoot, result, new Set<string>(), new Set<string>());

    // ファイル単位の stat / read / hash は I/O 待ちが支配的なので並列化し、
    // 結果は走査順 (添字順) に並べ直して parsed / skipped / errors の順序を保つ
    const outcomes = await mapWithConcurrency(files, this.concurrency, (filePath) => this.processFile(filePath, result));
    for (const outcome of outcomes) {
      switch (outcome.kind) {
        case "parsed":
          result.parsed.push(outcome.parsed);
          break;
        case "skipped":
          result.skipped.push(outcome.skipped);
          break;
        case "error":
          result.errors.push(outcome.error);
          break;
      }
    }

    await this.persistCacheIndex(cacheFile);
    return result;
  }

  private async recurseDirectory(
    rootPath: string,
    dirPath: string,
    result: ScanResult,
    ancestors: Set<string>,
    walked: Set<string>,
  ): Promise<string[]> {
    const files: string[] = [];
    const realPath = await fs.realpath(dirPath).catch(() => dirPath);

    // 走査中の祖先に戻るリンクだけが真の循環。既に走査済みの別ディレクトリを指すリンクは重複として扱う
    if (ancestors.has(realPath)) {
      result.skipped.push({
        filePath: dirPath,
        reason: "Directory cycle detected",
        isDirectory: true,
      });
      return files;
    }
    if (walked.has(realPath)) {
      result.skipped.push({
        filePath: dirPath,
        reason: "Duplicate symlink target",
        isDirectory: true,
      });
      return files;
    }
    walked.add(realPath);
    ancestors.add(realPath);

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      // readdir の順序は OS 依存なので名前順に固定する。
      // 実体を先に、シンボリックリンクを後に処理し、実体側が「重複」扱いにならないようにする。
      entries.sort((left, right) => {
        const linkOrder = Number(left.isSymbolicLink()) - Number(right.isSymbolicLink());
        return linkOrder !== 0 ? linkOrder : (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        // 除外パターンとスコープ判定はスキャンルートからの相対パス (スラッシュ区切り) に対して行う。
        // 絶対パスに照合すると、プロジェクトが /tmp/build/app のような場所にあるだけで
        // 既定の build 除外に全ファイルが巻き込まれてしまう。
        const relativePath = this.toRelativePath(rootPath, fullPath);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();

        if (this.isExcluded(relativePath)) {
          result.skipped.push({
            filePath: fullPath,
            reason: "Excluded pattern match",
            isDirectory,
          });
          continue;
        }

        if (entry.isSymbolicLink()) {
          const realLinkPath = await fs.realpath(fullPath).catch(() => fullPath);
          const resolvedStat = await fs.stat(fullPath).catch(() => null);
          if (resolvedStat) {
            isDirectory = resolvedStat.isDirectory();
            isFile = resolvedStat.isFile();
          }
          if (this.seenSymlinks.has(realLinkPath)) {
            result.skipped.push({
              filePath: fullPath,
              reason: "Duplicate symlink target",
              isDirectory,
            });
            continue;
          }
          this.seenSymlinks.add(realLinkPath);
        }

        if (isDirectory) {
          files.push(...(await this.recurseDirectory(rootPath, fullPath, result, ancestors, walked)));
          continue;
        }

        if (!isFile || !this.isRelevantFile(fullPath)) {
          continue;
        }

        if (!shouldIncludeInAnalysisScope(fullPath, this.analysisScope, rootPath)) {
          result.skipped.push({
            filePath: fullPath,
            reason: `Excluded by analysis scope (${this.analysisScope})`,
            isDirectory: false,
          });
          continue;
        }

        // サイズ判定は stat が要るので、並列化するファイル処理側で行う
        files.push(fullPath);
      }
    } catch (error) {
      result.errors.push({
        filePath: dirPath,
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
    } finally {
      ancestors.delete(realPath);
    }

    return files;
  }

  private async processFile(filePath: string, result: ScanResult): Promise<FileOutcome> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > this.maxFileSizeBytes) {
        return {
          kind: "skipped",
          skipped: {
            filePath,
            reason: `File size exceeds ${this.maxFileSizeBytes} bytes`,
            isDirectory: false,
          },
        };
      }
      return { kind: "parsed", parsed: await this.parseFile(filePath, stat, result) };
    } catch (error) {
      return {
        kind: "error",
        error: {
          filePath,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      };
    }
  }

  private async parseFile(
    filePath: string,
    stat: { size: number; mtimeMs: number },
    result: ScanResult,
  ): Promise<ParsedFile> {
    const cacheKey = filePath;
    const previous = this.cacheIndex.get(cacheKey);

    // mtime とサイズが一致すれば記録済みハッシュを信頼し、読み込みとハッシュ計算を省略する。
    // 内容は sourceFile / sourceCode が実際に参照されたときに初めて読む
    // (解析キャッシュにもヒットしたファイルは一度も読まずに済む)。
    let decoded: DecodedSource | undefined;
    let sha256: string;
    if (
      this.enableCache &&
      previous &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.byteSize === stat.size &&
      previous.sha256
    ) {
      sha256 = previous.sha256;
      result.cacheStats.hits += 1;
    } else {
      decoded = this.decode(await fs.readFile(filePath));
      sha256 = this.createHash(decoded.sourceCode);
      result.cacheStats.misses += 1;
    }

    const loadSource = (): DecodedSource => {
      if (!decoded) {
        // 遅延読み込みは同期 API に頼らざるを得ない (ParsedFile.sourceCode は同期プロパティ)
        decoded = this.decode(readFileSync(filePath));
      }
      return decoded;
    };

    const scriptKind = this.detectScriptKind(filePath);
    // AST は初回アクセス時に生成する。解析キャッシュにヒットしたファイルは
    // AST を一度も使わないため、遅延化で warm 実行のパースコストを省く。
    let lazySourceFile: ts.SourceFile | undefined;
    let lazyParseDiagnosticCount = 0;
    const parseSource = (): ts.SourceFile => {
      if (!lazySourceFile) {
        lazySourceFile = ts.createSourceFile(
          filePath,
          loadSource().sourceCode,
          ts.ScriptTarget.Latest,
          true,
          scriptKind,
        );
        lazyParseDiagnosticCount = ((lazySourceFile as ts.SourceFile & {
          parseDiagnostics?: ts.DiagnosticWithLocation[];
        }).parseDiagnostics ?? []).length;
      }
      return lazySourceFile;
    };

    const metadata: FileMetadata = {
      get lineCount(): number {
        return loadSource().sourceCode.split(/\r?\n/u).length;
      },
      byteSize: stat.size,
      get hasTrailingNewline(): boolean {
        return /\r?\n$/u.test(loadSource().sourceCode);
      },
      lastModifiedMs: stat.mtimeMs,
      get lastNewlineOffset(): number {
        return loadSource().sourceCode.lastIndexOf("\n");
      },
      get encoding(): FileMetadata["encoding"] {
        return loadSource().hasBom ? "utf-8-bom" : "utf-8";
      },
      scriptKind,
      sha256,
      get parseDiagnosticCount(): number {
        parseSource();
        return lazyParseDiagnosticCount;
      },
    };

    const parsed: ParsedFile = {
      filePath,
      get sourceFile(): ts.SourceFile {
        return parseSource();
      },
      get sourceCode(): string {
        return loadSource().sourceCode;
      },
      metadata,
    };

    this.nextCacheIndex.set(cacheKey, {
      filePath,
      mtimeMs: stat.mtimeMs,
      sha256,
      byteSize: stat.size,
      timestamp: Date.now(),
    });

    return parsed;
  }

  private decode(fileBuffer: Buffer): DecodedSource {
    const hasBom = fileBuffer.length >= 3 &&
      fileBuffer[0] === 0xef &&
      fileBuffer[1] === 0xbb &&
      fileBuffer[2] === 0xbf;
    return {
      sourceCode: hasBom ? fileBuffer.subarray(3).toString("utf8") : fileBuffer.toString("utf8"),
      hasBom,
    };
  }

  private async loadCacheIndex(cacheFile: string): Promise<void> {
    if (!this.enableCache) {
      return;
    }

    try {
      const content = await fs.readFile(cacheFile, "utf8");
      const records = JSON.parse(content) as CacheRecord[];
      this.cacheIndex.clear();
      for (const record of records) {
        this.cacheIndex.set(record.filePath, record);
      }
    } catch {
      this.cacheIndex.clear();
    }
  }

  private async persistCacheIndex(cacheFile: string): Promise<void> {
    if (!this.enableCache) {
      return;
    }

    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const records = Array.from(this.nextCacheIndex.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
    await fs.writeFile(cacheFile, JSON.stringify(records, null, 2), "utf8");
  }

  private getCacheFilePath(rootPath: string): string {
    const cacheKey = this.createHash(rootPath).slice(0, 16);
    return path.join(this.cacheDir, `${cacheKey}.json`);
  }

  private createHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private detectScriptKind(filePath: string): ts.ScriptKind {
    switch (path.extname(filePath).toLowerCase()) {
      case ".tsx":
        return ts.ScriptKind.TSX;
      case ".ts":
      case ".mts":
      case ".cts":
        return ts.ScriptKind.TS;
      case ".jsx":
        return ts.ScriptKind.JSX;
      case ".js":
      case ".mjs":
      case ".cjs":
        return ts.ScriptKind.JS;
      default:
        return ts.ScriptKind.Unknown;
    }
  }

  private isRelevantFile(filePath: string): boolean {
    return /\.(?:tsx?|jsx?|[mc]ts|[mc]js)$/iu.test(filePath);
  }

  private isExcluded(relativePath: string): boolean {
    return this.excludePatterns.some((pattern) => pattern.test(relativePath));
  }

  private toRelativePath(rootPath: string, fullPath: string): string {
    return path.relative(rootPath, fullPath).split(path.sep).join("/");
  }

  private toRegExp(pattern: string): RegExp {
    try {
      return new RegExp(pattern);
    } catch (error) {
      // 不正な正規表現は文字列そのままの一致に落とすが、黙って読み替えず結果の warnings で知らせる
      const reason = error instanceof Error ? error.message : String(error);
      this.patternWarnings.push(
        `除外パターン "${pattern}" は正規表現として不正なため、文字列そのままの一致として扱いました (${reason})。`,
      );
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    }
  }
}
