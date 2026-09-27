import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { LogEntry, LogLevel } from "../types/index.js";

export interface LoggerConsoleOptions {
  /**
   * true のとき INFO / DEBUG を画面 (標準出力) に出さない。
   * ログファイルへの書き込みと、WARN / ERROR の標準エラー出力は変わらない。
   */
  quiet?: boolean;
}

export class Logger {
  // CLI の --quiet はプロセス全体の設定なので、個々の Logger を生成する箇所を
  // 変えずに済むよう既定値をクラス側に持つ (コンストラクタ引数で個別に上書き可)
  private static defaultConsoleOptions: Required<LoggerConsoleOptions> = { quiet: false };

  private readonly logFile: string;
  private readonly level: LogLevel;
  private readonly quiet: boolean;
  private readonly buffer: LogEntry[] = [];
  private readonly bufferSize = 100;

  constructor(level: LogLevel = "INFO", logFile = "./analysis.log", consoleOptions: LoggerConsoleOptions = {}) {
    this.level = level;
    this.logFile = logFile;
    this.quiet = consoleOptions.quiet ?? Logger.defaultConsoleOptions.quiet;
  }

  /** 以後に生成される Logger の画面出力の既定値を変える (CLI の --quiet 用) */
  static configureConsole(options: LoggerConsoleOptions): void {
    Logger.defaultConsoleOptions = {
      quiet: options.quiet ?? Logger.defaultConsoleOptions.quiet,
    };
  }

  /** ログの書き込み先ファイル (エラー時の案内に使う) */
  get logFilePath(): string {
    return this.logFile;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log(message, "INFO", metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log(message, "WARN", metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log(message, "ERROR", metadata);
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log(message, "DEBUG", metadata);
  }

  async close(): Promise<void> {
    await this.flushBuffer();
  }

  private shouldLog(level: LogLevel): boolean {
    const order: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
    return order.indexOf(level) >= order.indexOf(this.level);
  }

  private log(message: string, level: LogLevel, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
    };

    this.buffer.push(entry);
    this.printToConsole(entry);

    if (this.buffer.length >= this.bufferSize) {
      void this.flushBuffer();
    }
  }

  // WARN / ERROR は標準エラー、INFO / DEBUG は標準出力へ。
  // 人向けのサマリー (✔ ...) は標準出力に出るため、--quiet では INFO / DEBUG だけを抑止し、
  // 警告と失敗は画面に残す。ログファイルの内容と形式は quiet の有無で変わらない。
  private printToConsole(entry: LogEntry): void {
    const line = this.format(entry);
    if (entry.level === "WARN" || entry.level === "ERROR") {
      console.error(line);
      return;
    }
    if (!this.quiet) {
      console.log(line);
    }
  }

  private format(entry: LogEntry): string {
    const metadata = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
    return `[${entry.timestamp}] [${entry.level}] ${entry.message}${metadata}`;
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const content = `${this.buffer.map((entry) => this.format(entry)).join("\n")}\n`;
    this.buffer.length = 0;
    await fs.appendFile(this.logFile, content, "utf8");
    await this.rotateIfNeeded();
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.logFile);
      if (stat.size <= 10 * 1024 * 1024) {
        return;
      }

      const archivePath = `${this.logFile}.${new Date().toISOString().replace(/[:.]/gu, "-")}.gz`;
      await pipeline(
        createReadStream(this.logFile),
        createGzip(),
        createWriteStream(archivePath),
      );
      await fs.writeFile(this.logFile, "", "utf8");
    } catch {
      // Logging must not break the analysis flow.
    }
  }
}
