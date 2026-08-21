import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { shouldIncludeInAnalysisScope } from "./FileConventions.js";
import type {
  AnalysisScope,
  CacheRecord,
  ParsedFile,
  ScanResult,
} from "../types/index.js";

interface FileScannerOptions {
  excludePatterns: string[];
  maxFileSizeBytes: number;
  cacheDir: string;
  enableCache: boolean;
  analysisScope?: AnalysisScope;
}

export class FileScanner {
  private readonly excludePatterns: RegExp[];
  private readonly seenSymlinks = new Set<string>();
  private readonly maxFileSizeBytes: number;
  private readonly cacheDir: string;
  private readonly enableCache: boolean;
  private readonly analysisScope: AnalysisScope;
  private readonly cacheIndex = new Map<string, CacheRecord>();
  private readonly nextCacheIndex = new Map<string, CacheRecord>();

  constructor(config: FileScannerOptions) {
    this.excludePatterns = config.excludePatterns.map((pattern) => this.toRegExp(pattern));
    this.maxFileSizeBytes = config.maxFileSizeBytes;
    this.cacheDir = config.cacheDir;
    this.enableCache = config.enableCache;
    this.analysisScope = config.analysisScope ?? "all";
  }

  async scanProject(rootPath: string): Promise<ScanResult> {
    const absoluteRoot = path.resolve(rootPath);
    const cacheFile = this.getCacheFilePath(absoluteRoot);
    await this.loadCacheIndex(cacheFile);

    const result: ScanResult = {
      parsed: [],
      skipped: [],
      errors: [],
      cacheStats: { hits: 0, misses: 0 },
    };

    const files = await this.recurseDirectory(absoluteRoot, result, new Set<string>());

    for (const filePath of files) {
      try {
        const parsed = await this.parseFile(filePath, result);
        result.parsed.push(parsed);
      } catch (error) {
        result.errors.push({
          filePath,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      }
    }

    await this.persistCacheIndex(cacheFile);
    return result;
  }

  private async recurseDirectory(
    dirPath: string,
    result: ScanResult,
    visited: Set<string>,
  ): Promise<string[]> {
    const files: string[] = [];
    const realPath = await fs.realpath(dirPath).catch(() => dirPath);

    if (visited.has(realPath)) {
      result.skipped.push({
        filePath: dirPath,
        reason: "Directory cycle detected",
        isDirectory: true,
      });
      return files;
    }
    visited.add(realPath);

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();

        if (this.isExcluded(fullPath)) {
          result.skipped.push({
            filePath: fullPath,
            reason: "Excluded pattern match",
            isDirectory,
          });
          continue;
        }

        if (entry.isSymbolicLink()) {
          const realLinkPath = await fs.realpath(fullPath).catch(() => fullPath);
          if (this.seenSymlinks.has(realLinkPath)) {
            result.skipped.push({
              filePath: fullPath,
              reason: "Symlink cycle detected",
              isDirectory: true,
            });
            continue;
          }
          this.seenSymlinks.add(realLinkPath);

          const resolvedStat = await fs.stat(fullPath).catch(() => null);
          if (resolvedStat) {
            isDirectory = resolvedStat.isDirectory();
            isFile = resolvedStat.isFile();
          }
        }

        if (isDirectory) {
          files.push(...(await this.recurseDirectory(fullPath, result, visited)));
          continue;
        }

        if (!isFile || !this.isRelevantFile(fullPath)) {
          continue;
        }

        const stat = await fs.stat(fullPath);
        if (stat.size > this.maxFileSizeBytes) {
          result.skipped.push({
            filePath: fullPath,
            reason: `File size exceeds ${this.maxFileSizeBytes} bytes`,
            isDirectory: false,
          });
          continue;
        }

        if (!shouldIncludeInAnalysisScope(fullPath, this.analysisScope)) {
          result.skipped.push({
            filePath: fullPath,
            reason: `Excluded by analysis scope (${this.analysisScope})`,
            isDirectory: false,
          });
          continue;
        }

        files.push(fullPath);
      }
    } catch (error) {
      result.errors.push({
        filePath: dirPath,
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
    }

    return files;
  }

  private async parseFile(filePath: string, result: ScanResult): Promise<ParsedFile> {
    const fileBuffer = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    const hasBom = fileBuffer.length >= 3 &&
      fileBuffer[0] === 0xef &&
      fileBuffer[1] === 0xbb &&
      fileBuffer[2] === 0xbf;
    const sourceCode = hasBom ? fileBuffer.subarray(3).toString("utf8") : fileBuffer.toString("utf8");
    const sha256 = this.createHash(sourceCode);
    const cacheKey = filePath;
    const previous = this.cacheIndex.get(cacheKey);

    if (
      this.enableCache &&
      previous &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.sha256 === sha256 &&
      previous.byteSize === fileBuffer.byteLength
    ) {
      result.cacheStats.hits += 1;
    } else {
      result.cacheStats.misses += 1;
    }

    const scriptKind = this.detectScriptKind(filePath);
    // AST は初回アクセス時に生成する。解析キャッシュにヒットしたファイルは
    // AST を一度も使わないため、遅延化で warm 実行のパースコストを省く。
    let lazySourceFile: ts.SourceFile | undefined;
    let lazyParseDiagnosticCount = 0;
    const parseSource = (): ts.SourceFile => {
      if (!lazySourceFile) {
        lazySourceFile = ts.createSourceFile(
          filePath,
          sourceCode,
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

    const parsed: ParsedFile = {
      filePath,
      get sourceFile(): ts.SourceFile {
        return parseSource();
      },
      sourceCode,
      metadata: {
        lineCount: sourceCode.split(/\r?\n/u).length,
        byteSize: fileBuffer.byteLength,
        hasTrailingNewline: /\r?\n$/u.test(sourceCode),
        lastModifiedMs: stat.mtimeMs,
        lastNewlineOffset: sourceCode.lastIndexOf("\n"),
        encoding: hasBom ? "utf-8-bom" : "utf-8",
        scriptKind,
        sha256,
        get parseDiagnosticCount(): number {
          parseSource();
          return lazyParseDiagnosticCount;
        },
      },
    };

    this.nextCacheIndex.set(cacheKey, {
      filePath,
      mtimeMs: stat.mtimeMs,
      sha256,
      byteSize: fileBuffer.byteLength,
      timestamp: Date.now(),
    });

    return parsed;
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
    switch (path.extname(filePath)) {
      case ".tsx":
        return ts.ScriptKind.TSX;
      case ".ts":
        return ts.ScriptKind.TS;
      case ".jsx":
        return ts.ScriptKind.JSX;
      case ".js":
        return ts.ScriptKind.JS;
      default:
        return ts.ScriptKind.Unknown;
    }
  }

  private isRelevantFile(filePath: string): boolean {
    return /\.(tsx?|jsx?)$/u.test(filePath);
  }

  private isExcluded(filePath: string): boolean {
    return this.excludePatterns.some((pattern) => pattern.test(filePath));
  }

  private toRegExp(pattern: string): RegExp {
    try {
      return new RegExp(pattern);
    } catch {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    }
  }
}
