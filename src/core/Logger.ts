import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { LogEntry, LogLevel } from "../types/index.js";

export class Logger {
  private readonly logFile: string;
  private readonly level: LogLevel;
  private readonly buffer: LogEntry[] = [];
  private readonly bufferSize = 100;

  constructor(level: LogLevel = "INFO", logFile = "./analysis.log") {
    this.level = level;
    this.logFile = logFile;
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
    console.log(this.format(entry));

    if (this.buffer.length >= this.bufferSize) {
      void this.flushBuffer();
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
