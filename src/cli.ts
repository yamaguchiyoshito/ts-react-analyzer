import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { watch as watchFileSystem } from "node:fs";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

import { AnalysisCache, ComplexityAnalyzer, ConfigManager, DependencyAnalyzer, DiffGenerator, FileScanner, GraphBuilder, Logger, ManualQualityInputLoader, QualityDiffGenerator, QualityReportGenerator, ReportGenerator } from "./core/index.js";
import { shouldIncludeInAnalysisScope } from "./core/FileConventions.js";
import type { AnalysisConfig, AnalysisDiffReport, AnalysisResult, CacheStats, GraphJSON, GraphMetrics, IncrementalStats, ManualQualityMetricInput, OutputFormat, ParseIssue, PersistedAnalysisReport, QualityDiffReport, QualityMetricDiffEntry, QualityReport } from "./types/index.js";

interface RunArtifacts {
  results: AnalysisResult[];
  allResults: AnalysisResult[];
  scanResult: Awaited<ReturnType<FileScanner["scanProject"]>>;
  fullScanResult: Awaited<ReturnType<FileScanner["scanProject"]>>;
  graphBuilder: GraphBuilder;
  graphJson: GraphJSON;
  graphMetrics: GraphMetrics;
  analysisCacheStats: CacheStats;
  incrementalStats: IncrementalStats;
  parseIssues: ParseIssue[];
}

const COMMAND_USAGE: Record<string, { usage: string; description: string }> = {
  analyze: {
    usage: "ts-react-analyzer analyze <projectDir> [オプション]",
    description: "複雑度・依存関係・hot spot・ディレクトリ目的の整合をまとめて解析し、レポートを出力します。",
  },
  graph: {
    usage: "ts-react-analyzer graph <projectDir> [オプション]",
    description: "依存グラフを JSON と DOT で出力します (--format は使いません)。",
  },
  diff: {
    usage: "ts-react-analyzer diff <projectDir> --baseline <report.json> [オプション]",
    description: "baseline (analyze が出力した *_report.json) と現在を比較し、悪化した箇所を影響度スコア付きで出力します。",
  },
  quality: {
    usage: "ts-react-analyzer quality <collect|gate|diff> <projectDir> [オプション]",
    description: "出荷審査の品質レポートを生成し (collect)、出荷可否を機械判定し (gate)、前回リリースと比較します (diff)。report は collect の別名です。",
  },
  init: {
    usage: "ts-react-analyzer init <projectDir> [--yes]",
    description: "対話形式で analyzer.config.json を生成します (--yes で質問を省略して既定値で生成)。",
  },
};

const COMMON_OPTIONS_HELP = `共通オプション:
  --output <dir>                 レポート出力先 (<projectDir> 基準。既定: ./analysis-reports)
  --format <formats>             csv,markdown,json,html,all (カンマ区切り)
  --config <path>                設定ファイルのパス (既定: <projectDir>/analyzer.config.json)
  --prefix <name>                出力ファイル名の接頭辞 (既定: analysis)
  --open                         生成した HTML レポートをブラウザで開く
  --verbose                      詳細ログを有効化
  --max-file-size <bytes>        指定サイズ超のファイルを解析から除外
  --analysis-scope <scope>       all | source-only
  --complexity-threshold <n>     複雑度の警告閾値
  --exclude-groups <groups>      除外グループ (カンマ区切り)
  --exclude-patterns <patterns>  除外パターン (カンマ区切り正規表現)
  --cache-dir <dir>              キャッシュディレクトリ
  --log-file <path>              ログファイルのパス
  --version                      バージョンを表示
  --help                         ヘルプを表示 (例: analyze --help でコマンド別ヘルプ)`;

const COMMAND_OPTIONS_HELP = {
  diff: `diff のオプション:
  --baseline <path>              比較元の *_report.json (省略時: <outputDir>/<prefix>_report.json)
  --impact-threshold <n>         影響度スコアの閾値
  --fail-on-impact               閾値超過で終了コード 2 にする
  --watch                        ファイル変更を監視して diff を自動再実行する (Ctrl+C で終了)`,
  quality: `quality のオプション:
  --quality-profile <profile>    application | library-repo
  --manual-input <path>          手動品質証跡 JSON (既定: <projectDir>/quality.manual.json)
  --baseline <path>              gate / diff の比較元 *_quality_report.json
  --quality-gate-blocking-metrics <ids>
                                 baseline 悪化で gate を落とす指標 ID (カンマ区切り)
  --quality-gate-monitoring-metrics <ids>
                                 baseline 悪化を監視だけに留める指標 ID (カンマ区切り)
  --max-typecheck-root-names <n> この数を超えたら TS 型検査をスキップ`,
  init: `init のオプション:
  --yes                          質問せず既定値で analyzer.config.json を生成する`,
};

function printHelp(command?: string): void {
  const lines: string[] = ["ts-react-analyzer — React / TypeScript プロジェクトの静的解析 CLI", ""];

  const entry = command ? COMMAND_USAGE[command] : undefined;
  if (command && entry) {
    lines.push("使い方:", `  ${entry.usage}`, "", entry.description, "");
    const commandOptions = (COMMAND_OPTIONS_HELP as Partial<Record<string, string>>)[command];
    if (commandOptions) {
      lines.push(commandOptions, "");
    }
    if (command !== "init") {
      lines.push(COMMON_OPTIONS_HELP, "");
    }
  } else {
    lines.push("使い方:");
    for (const entry of Object.values(COMMAND_USAGE)) {
      lines.push(`  ${entry.usage}`);
    }
    lines.push(
      "",
      "各コマンドの詳細は `<コマンド名> --help` で確認できます。",
      "",
      COMMON_OPTIONS_HELP,
      "",
      COMMAND_OPTIONS_HELP.diff,
      "",
      COMMAND_OPTIONS_HELP.quality,
      "",
      COMMAND_OPTIONS_HELP.init,
      "",
    );
  }

  lines.push("終了コード: 0=成功 / 1=実行失敗 / 2=判定による失敗 (diff の閾値超過、quality gate の FAIL)");
  console.log(lines.join("\n"));
}

// ユーザー操作起因の失敗 (パス誤りなど)。message はそのまま画面に出す前提で書く
class CliUserError extends Error {}

const CLI_OPTIONS = {
  output: { type: "string" },
  format: { type: "string" },
  config: { type: "string" },
  prefix: { type: "string" },
  verbose: { type: "boolean" },
  "max-file-size": { type: "string" },
  "analysis-scope": { type: "string" },
  "quality-profile": { type: "string" },
  "complexity-threshold": { type: "string" },
  "impact-threshold": { type: "string" },
  "fail-on-impact": { type: "boolean" },
  "exclude-groups": { type: "string" },
  "exclude-patterns": { type: "string" },
  "cache-dir": { type: "string" },
  "log-file": { type: "string" },
  "manual-input": { type: "string" },
  "quality-gate-blocking-metrics": { type: "string" },
  "quality-gate-monitoring-metrics": { type: "string" },
  "max-typecheck-root-names": { type: "string" },
  baseline: { type: "string" },
  open: { type: "boolean" },
  watch: { type: "boolean" },
  yes: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function parseCliArgs() {
  return parseArgs({
    allowPositionals: true,
    options: CLI_OPTIONS,
  });
}

function editDistance(left: string, right: string): number {
  let previousRow: number[] = Array.from({ length: right.length + 1 }, (_, col) => col);
  for (let row = 1; row <= left.length; row += 1) {
    const currentRow: number[] = [row];
    for (let col = 1; col <= right.length; col += 1) {
      const substitutionCost = left.charAt(row - 1) === right.charAt(col - 1) ? 0 : 1;
      currentRow.push(Math.min(
        (previousRow[col] ?? 0) + 1,
        (currentRow[col - 1] ?? 0) + 1,
        (previousRow[col - 1] ?? 0) + substitutionCost,
      ));
    }
    previousRow = currentRow;
  }
  return previousRow[right.length] ?? 0;
}

function suggestOption(unknownOption: string): string | undefined {
  const name = unknownOption.replace(/^--?/u, "");
  if (!name) {
    return undefined;
  }
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of Object.keys(CLI_OPTIONS)) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best ? `--${best}` : undefined;
}

function reportArgumentError(error: unknown): number {
  const err = error as { code?: string; message?: string };
  if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const unknownOption = /'(--?[^']*)'/u.exec(err.message ?? "")?.[1] ?? "";
    const suggestion = suggestOption(unknownOption);
    console.error(`エラー: 不明なオプション '${unknownOption}' です。${suggestion ? `もしかして: ${suggestion}` : ""}`);
  } else if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    console.error(`エラー: オプションの値が正しくありません。${err.message ?? ""}`);
  } else if (typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS")) {
    console.error(`エラー: 引数を解釈できませんでした。${err.message ?? ""}`);
  } else {
    throw error;
  }
  console.error("--help でオプション一覧を確認できます。");
  return 1;
}

async function printVersion(): Promise<void> {
  try {
    const packageJson = JSON.parse(
      await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    console.log(packageJson.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

async function loadBaselineReport<T>(baselinePath: string, createHint: string): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(baselinePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliUserError(`baseline が見つかりません: ${baselinePath}\n${createHint}`);
    }
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new CliUserError(
      `baseline を JSON として読み込めませんでした: ${baselinePath}\nこのツールが出力したレポート JSON を指定してください。`,
    );
  }
}

async function handleCommandError(error: unknown, logger: Logger, logMessage: string): Promise<number> {
  if (error instanceof CliUserError) {
    console.error(`エラー: ${error.message}`);
    logger.error(logMessage, { error: error.message.split("\n")[0] });
  } else {
    logger.error(logMessage, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await logger.close();
  return 1;
}

function listReportFiles(prefix: string, formats: OutputFormat[], kind: "analyze" | "quality"): string[] {
  const resolved = formats.includes("all") ? ["json", "markdown", "csv", "html"] : formats;
  const files: string[] = [];
  if (kind === "analyze") {
    if (resolved.includes("markdown")) {
      files.push(`${prefix}_report.md`);
    }
    if (resolved.includes("html")) {
      files.push(`${prefix}_report.html`);
    }
    if (resolved.includes("json")) {
      files.push(`${prefix}_report.json`);
    }
    if (resolved.includes("csv")) {
      files.push(`${prefix}_files.csv`, `${prefix}_dependencies.csv`, `${prefix}_components.csv`, `${prefix}_hooks.csv`);
    }
  } else {
    if (resolved.includes("markdown")) {
      files.push(`${prefix}_quality_report.md`);
    }
    if (resolved.includes("html")) {
      files.push(`${prefix}_quality_report.html`);
    }
    if (resolved.includes("json")) {
      files.push(`${prefix}_quality_report.json`);
    }
    if (resolved.includes("csv")) {
      files.push(`${prefix}_quality_summary.csv`);
    }
  }
  return files;
}

function printOutputFiles(lines: string[], outputDir: string, files: string[], firstFileNote: string): void {
  lines.push(`  出力先: ${outputDir}`);
  files.forEach((file, index) => {
    lines.push(`    ${file}${index === 0 ? `  ← ${firstFileNote}` : ""}`);
  });
}

function printAnalyzeSummary(report: PersistedAnalysisReport, config: AnalysisConfig): void {
  const lines: string[] = [""];
  if (report.statistics.fileCount === 0) {
    lines.push("⚠ 解析対象が 0 件でした。projectDir の指定、tsconfig の include、除外設定 (exclude) を確認してください。");
  }
  lines.push(`✔ 解析が完了しました: ${report.statistics.fileCount} ファイル / ${report.executionTimeMs}ms`);
  const summary = report.decisionSummary;
  if (summary) {
    const primary = summary.topHotSpots[0];
    lines.push(`  最優先ファイル: ${primary ? primary.displayPath ?? primary.path : "なし"}`);
    lines.push(`  優先改修候補: ${summary.topHotSpots.length} 件 / ${summary.cycleStatus}`);
  }
  printOutputFiles(lines, config.outputDir, listReportFiles(config.filePrefix, config.outputFormats, "analyze"), "まずこのファイルから読み始めてください");
  console.log(lines.join("\n"));
}

function printDiffSummary(diff: AnalysisDiffReport, config: AnalysisConfig): void {
  const lines: string[] = [""];
  lines.push(`✔ 差分解析が完了しました: 変更 ${diff.summary.changedFiles} / 追加 ${diff.summary.addedFiles} / 削除 ${diff.summary.removedFiles}`);
  printOutputFiles(lines, config.outputDir, [
    `${config.filePrefix}_diff.md`,
    `${config.filePrefix}_diff.html`,
    `${config.filePrefix}_diff.json`,
  ], "まずこのファイルから読み始めてください");
  console.log(lines.join("\n"));
}

function printQualitySummary(report: QualityReport, config: AnalysisConfig, mode: "collect" | "report" | "gate"): void {
  const lines: string[] = [""];
  lines.push(`✔ 品質レポートを生成しました: 総合判定 ${report.summary.overallVerdict.toUpperCase()} (自動FAIL ${report.summary.failCount} 件 / 手動証跡待ち ${report.summary.manualCount} 件)`);
  if (mode === "gate") {
    lines.push("  quality gate: PASS");
  }
  printOutputFiles(lines, config.outputDir, listReportFiles(config.filePrefix, config.outputFormats, "quality"), "まずこのファイルから読み始めてください");
  console.log(lines.join("\n"));
}

// excludeGroups / excludePatterns は上書きではなく合流 (union) されるため対象外
const ENV_OVERRIDABLE_OPTIONS: Array<{ key: keyof AnalysisConfig; cliFlag: string; envVar: string }> = [
  { key: "outputDir", cliFlag: "--output", envVar: "ANALYZER_OUTPUT_DIR" },
  { key: "outputFormats", cliFlag: "--format", envVar: "ANALYZER_FORMATS" },
  { key: "filePrefix", cliFlag: "--prefix", envVar: "ANALYZER_PREFIX" },
  { key: "verbose", cliFlag: "--verbose", envVar: "ANALYZER_VERBOSE" },
  { key: "maxFileSizeBytes", cliFlag: "--max-file-size", envVar: "ANALYZER_MAX_FILE_SIZE" },
  { key: "analysisScope", cliFlag: "--analysis-scope", envVar: "ANALYZER_ANALYSIS_SCOPE" },
  { key: "qualityProfile", cliFlag: "--quality-profile", envVar: "ANALYZER_QUALITY_PROFILE" },
  { key: "complexityThreshold", cliFlag: "--complexity-threshold", envVar: "ANALYZER_COMPLEXITY_THRESHOLD" },
  { key: "impactScoreThreshold", cliFlag: "--impact-threshold", envVar: "ANALYZER_IMPACT_SCORE_THRESHOLD" },
  { key: "failOnImpactThreshold", cliFlag: "--fail-on-impact", envVar: "ANALYZER_FAIL_ON_IMPACT_THRESHOLD" },
  { key: "cacheDir", cliFlag: "--cache-dir", envVar: "ANALYZER_CACHE_DIR" },
  { key: "logFile", cliFlag: "--log-file", envVar: "ANALYZER_LOG_FILE" },
  { key: "manualInputPath", cliFlag: "--manual-input", envVar: "ANALYZER_MANUAL_INPUT" },
  { key: "qualityGateBlockingMetricIds", cliFlag: "--quality-gate-blocking-metrics", envVar: "ANALYZER_QUALITY_GATE_BLOCKING_METRICS" },
  { key: "qualityGateMonitoringMetricIds", cliFlag: "--quality-gate-monitoring-metrics", envVar: "ANALYZER_QUALITY_GATE_MONITORING_METRICS" },
  { key: "maxTypeCheckRootNames", cliFlag: "--max-typecheck-root-names", envVar: "ANALYZER_MAX_TYPECHECK_ROOT_NAMES" },
];

// v0.2.0 で優先順位を CLI 最優先へ変更した。旧仕様 (環境変数 > CLI) を前提に
// している CI が気づけるよう、食い違いがあるときは注意を表示する
function notifyConfigPrecedence(
  cliConfig: Partial<AnalysisConfig>,
  dotEnvConfig: Partial<AnalysisConfig>,
  environmentConfig: Partial<AnalysisConfig>,
): void {
  for (const { key, cliFlag, envVar } of ENV_OVERRIDABLE_OPTIONS) {
    const cliValue = cliConfig[key];
    if (cliValue === undefined) {
      continue;
    }
    const overrideValue = environmentConfig[key] !== undefined ? environmentConfig[key] : dotEnvConfig[key];
    if (overrideValue === undefined) {
      continue;
    }
    if (JSON.stringify(overrideValue) === JSON.stringify(cliValue)) {
      continue;
    }
    const source = environmentConfig[key] !== undefined ? "環境変数" : ".env";
    console.warn(`注意: CLI 引数 ${cliFlag} が ${source} ${envVar} より優先されます (v0.2.0 で優先順位を CLI 最優先へ変更)。`);
  }
}

function openInBrowser(filePath: string): void {
  const [command, args]: [string, string[]] = process.platform === "darwin"
    ? ["open", [filePath]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", filePath]]
      : ["xdg-open", [filePath]];
  // CLI は結果表示直後に終了するため、起動失敗を確実に伝えられる同期実行にする
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    console.warn(`--open: ブラウザを起動できませんでした。手動で開いてください: ${filePath}`);
  }
}

function openHtmlReportIfRequested(
  openReport: boolean | undefined,
  config: AnalysisConfig,
  htmlFileName: string,
  requiresHtmlFormat: boolean,
): void {
  if (!openReport) {
    return;
  }
  if (requiresHtmlFormat && !config.outputFormats.includes("all") && !config.outputFormats.includes("html")) {
    console.warn("--open: --format に html が含まれていないため、HTML レポートを開けません。");
    return;
  }
  const target = path.join(config.outputDir, htmlFileName);
  console.log(`--open: ${target} を開きます`);
  openInBrowser(target);
}

const INIT_OUTPUT_FORMATS = ["csv", "markdown", "json", "html", "all"];

interface InitAnswers {
  outputDir: string;
  outputFormats: string[];
  complexityThreshold: number;
  impactScoreThreshold: number;
  qualityProfile: "application" | "library-repo";
}

async function askText(rl: readline.Interface, label: string, defaultValue: string): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

async function askNumber(rl: readline.Interface, label: string, defaultValue: number): Promise<number> {
  for (;;) {
    const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
    if (!answer) {
      return defaultValue;
    }
    const value = Number.parseInt(answer, 10);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
    console.log("  0 以上の整数を入力してください。");
  }
}

async function askYesNo(rl: readline.Interface, label: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${label} ${suffix}: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}

async function askChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  for (;;) {
    const answer = (await rl.question(`${label} (${choices.join(" / ")}) [${defaultValue}]: `)).trim();
    if (!answer) {
      return defaultValue;
    }
    if ((choices as readonly string[]).includes(answer)) {
      return answer as T;
    }
    console.log(`  ${choices.join(" か ")} を入力してください。`);
  }
}

async function askFormats(rl: readline.Interface, defaultFormats: string[]): Promise<string[]> {
  for (;;) {
    const answer = (await rl.question(`出力フォーマット (${INIT_OUTPUT_FORMATS.join(",")} をカンマ区切り) [${defaultFormats.join(",")}]: `)).trim();
    if (!answer) {
      return [...defaultFormats];
    }
    const formats = answer.split(",").map((value) => value.trim()).filter(Boolean);
    const invalid = formats.filter((format) => !INIT_OUTPUT_FORMATS.includes(format));
    if (formats.length > 0 && invalid.length === 0) {
      return formats;
    }
    console.log(`  使用できない値があります: ${invalid.join(", ") || "(空)"}。${INIT_OUTPUT_FORMATS.join(",")} から選んでください。`);
  }
}

async function runInit(projectRoot: string, assumeYes: boolean): Promise<number> {
  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) {
      console.error(`エラー: ${projectRoot} はディレクトリではありません。`);
      return 1;
    }
  } catch {
    console.error(`エラー: ディレクトリが見つかりません: ${projectRoot}`);
    return 1;
  }

  const configPath = path.join(projectRoot, "analyzer.config.json");
  const configExists = await fs.access(configPath).then(() => true, () => false);
  const defaults: InitAnswers = {
    outputDir: "./analysis-reports",
    outputFormats: ["json", "markdown", "html", "csv"],
    complexityThreshold: 12,
    impactScoreThreshold: 60,
    qualityProfile: "application",
  };
  const interactive = !assumeYes && process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (!interactive && !assumeYes) {
    console.error("エラー: 対話できない環境です。--yes を付けると既定値で生成できます。");
    return 1;
  }

  const answers: InitAnswers = { ...defaults, outputFormats: [...defaults.outputFormats] };
  let showGitlabSnippet = false;

  if (!interactive) {
    if (configExists) {
      console.error(`エラー: 既に ${configPath} があります。--yes では上書きしません。対話モードで実行するか、既存ファイルを削除してください。`);
      return 1;
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log("analyzer.config.json を対話形式で生成します。Enter で [既定値] を採用します。\n");
      if (configExists) {
        const overwrite = await askYesNo(rl, `既に ${configPath} があります。上書きしますか?`, false);
        if (!overwrite) {
          console.log("中止しました。既存の設定はそのままです。");
          return 0;
        }
      }
      answers.outputDir = await askText(rl, "レポートの出力先 (projectDir 基準)", defaults.outputDir);
      answers.outputFormats = await askFormats(rl, defaults.outputFormats);
      answers.complexityThreshold = await askNumber(rl, "複雑度の警告閾値", defaults.complexityThreshold);
      answers.impactScoreThreshold = await askNumber(rl, "diff の影響度スコア閾値 (CI で危険な変更を止める基準。0 で無効)", defaults.impactScoreThreshold);
      answers.qualityProfile = await askChoice(rl, "quality プロファイル", ["application", "library-repo"] as const, defaults.qualityProfile);
      showGitlabSnippet = await askYesNo(rl, "GitLab CI への組み込み例を表示しますか?", false);
    } catch (error) {
      // Ctrl+D / Ctrl+C による入力中断
      if ((error as { code?: string }).code === "ABORT_ERR") {
        console.log("\n中止しました。設定は生成していません。");
        return 1;
      }
      throw error;
    } finally {
      rl.close();
    }
  }

  const configJson = {
    outputDir: answers.outputDir,
    outputFormats: answers.outputFormats,
    complexityThreshold: answers.complexityThreshold,
    impactScoreThreshold: answers.impactScoreThreshold,
    failOnImpactThreshold: false,
    qualityProfile: answers.qualityProfile,
  };
  await fs.writeFile(configPath, `${JSON.stringify(configJson, null, 2)}\n`, "utf8");

  console.log([
    "",
    `✔ 生成しました: ${configPath}`,
    "",
    "次の一歩:",
    `  ts-react-analyzer analyze ${projectRoot}`,
    "    ← まず現状を解析して baseline を作ります",
    `  ts-react-analyzer quality collect ${projectRoot}`,
    "    ← 出荷審査の品質レポートを生成します",
    "",
    "設定項目の意味は docs/configuration.md を参照してください。",
  ].join("\n"));

  if (showGitlabSnippet) {
    console.log([
      "",
      "GitLab CI への組み込み例 (.gitlab-ci.yml):",
      "",
      "  include:",
      '    - remote: "https://raw.githubusercontent.com/yamaguchiyoshito/ts-react-analyzer/master/ci-templates/gitlab/ts-react-analyzer.gitlab-ci.yml"',
      "",
      "ジョブ構成と変数の上書き方法は ci-templates/gitlab/README.md を参照してください。",
    ].join("\n"));
  }
  return 0;
}

const WATCH_IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".ts-analyzer-cache", ".nyc_output"]);
const WATCH_TARGET_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

async function watchDiff(
  projectRoot: string,
  config: AnalysisConfig,
  baselinePath: string,
  openReport: boolean,
): Promise<number> {
  const initialCode = await diffProject(projectRoot, config, baselinePath, { openReport });
  if (initialCode === 1) {
    // baseline 不在などの実行失敗は監視を始めても回復しないため終了する
    return 1;
  }

  console.log("\nwatch モード: ソースの変更を監視して diff を自動再実行します (Ctrl+C で終了)");

  let debounceTimer: NodeJS.Timeout | undefined;
  let running = false;
  let pendingRerun = false;

  const runDiffOnce = async (): Promise<void> => {
    if (running) {
      pendingRerun = true;
      return;
    }
    running = true;
    try {
      console.log(`\n―― ${new Date().toISOString()} 変更を検知したため diff を再実行します ――`);
      await diffProject(projectRoot, config, baselinePath, {});
    } finally {
      running = false;
      if (pendingRerun) {
        pendingRerun = false;
        void runDiffOnce();
      }
    }
  };

  const shouldHandleChange = (fileName: string | null): boolean => {
    if (!fileName) {
      return false;
    }
    const normalized = fileName.split(path.sep).join("/");
    if (normalized.split("/").some((segment) => WATCH_IGNORED_SEGMENTS.has(segment))) {
      return false;
    }
    const absolutePath = path.resolve(projectRoot, fileName);
    if (absolutePath.startsWith(config.outputDir + path.sep) || absolutePath.startsWith(config.cacheDir + path.sep)) {
      return false;
    }
    return WATCH_TARGET_EXTENSIONS.has(path.extname(normalized));
  };

  try {
    const watcher = watchFileSystem(projectRoot, { recursive: true }, (_eventType, fileName) => {
      if (!shouldHandleChange(typeof fileName === "string" ? fileName : null)) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        void runDiffOnce();
      }, 400);
    });
    watcher.on("error", (error) => {
      console.error(`エラー: ファイル監視に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  } catch (error) {
    console.error(`エラー: この環境では --watch を利用できません (${error instanceof Error ? error.message : String(error)})`);
    return 1;
  }

  // Ctrl+C (SIGINT) で終了するまで待ち続ける
  return new Promise<number>(() => {});
}

async function buildArtifacts(
  projectDir: string,
  config: AnalysisConfig,
  logger: Logger,
  options: { includeUnscopedScan?: boolean } = {},
): Promise<RunArtifacts> {
  const preferUnscopedScan = options.includeUnscopedScan && config.analysisScope !== "all";
  const fullScanResult = await new FileScanner({
    ...config,
    analysisScope: preferUnscopedScan ? "all" : config.analysisScope,
  }).scanProject(projectDir);
  const scopedParsedFiles = fullScanResult.parsed.filter((parsedFile) =>
    shouldIncludeInAnalysisScope(parsedFile.filePath, config.analysisScope)
  );
  const scopedFilePaths = new Set(scopedParsedFiles.map((parsedFile) => parsedFile.filePath));
  const scanResult = {
    ...fullScanResult,
    parsed: scopedParsedFiles,
  };
  logger.info("Scan completed", {
    parsed: fullScanResult.parsed.length,
    scopedParsed: scopedParsedFiles.length,
    skipped: fullScanResult.skipped.length,
    errors: fullScanResult.errors.length,
    fileCacheHits: fullScanResult.cacheStats.hits,
    fileCacheMisses: fullScanResult.cacheStats.misses,
  });

  const analysisCache = new AnalysisCache(config.cacheDir, projectDir, config.tsCompilerOptions);
  await analysisCache.initialize();

  const dependencyAnalyzer = new DependencyAnalyzer(path.resolve(projectDir), config.tsCompilerOptions);
  const complexityAnalyzer = new ComplexityAnalyzer();
  const graphBuilder = new GraphBuilder();
  const results: AnalysisResult[] = [];
  const allResults: AnalysisResult[] = [];
  const parseIssues: ParseIssue[] = [];

  for (const parsedFile of fullScanResult.parsed) {
    const analysisContextHash = dependencyAnalyzer.getAnalysisContextHash(parsedFile.filePath);
    const cached = analysisCache.get(parsedFile.filePath, parsedFile.metadata.sha256, analysisContextHash);
    // parseDiagnosticCount へのアクセスは遅延パースを起動するため、キャッシュヒット時は
    // キャッシュ済みの値を使い、AST を生成しない
    const parseDiagnosticCount = cached
      ? cached.parseDiagnosticCount ?? 0
      : parsedFile.metadata.parseDiagnosticCount;
    if (parseDiagnosticCount > 0 && scopedFilePaths.has(parsedFile.filePath)) {
      parseIssues.push({ filePath: parsedFile.filePath, diagnosticCount: parseDiagnosticCount });
    }
    const result = cached
      ? {
          filePath: parsedFile.filePath,
          complexity: cached.complexity,
          dependencies: cached.dependencies,
          dependencyErrors: cached.dependencyErrors,
        }
      : (() => {
          const dependencyResult = dependencyAnalyzer.extractDependencies(parsedFile.sourceFile, parsedFile.filePath);
          const complexity = complexityAnalyzer.analyzeFile(parsedFile.sourceFile, parsedFile.filePath);
          const freshResult: AnalysisResult = {
            filePath: parsedFile.filePath,
            complexity,
            dependencies: dependencyResult.dependencies,
            dependencyErrors: dependencyResult.errors,
          };
          analysisCache.set(parsedFile.filePath, parsedFile.metadata.sha256, analysisContextHash, {
            complexity,
            dependencies: dependencyResult.dependencies,
            dependencyErrors: dependencyResult.errors,
            parseDiagnosticCount: parsedFile.metadata.parseDiagnosticCount,
          });
          return freshResult;
        })();

    if (scopedFilePaths.has(parsedFile.filePath)) {
      for (const dependency of result.dependencies) {
        if (!dependency.isExternal) {
          graphBuilder.addDependency(dependency.source, dependency.target, {
            type: dependency.type,
            isExternal: dependency.isExternal,
          });
        }
      }

      logger.debug(cached ? "File analyzed from cache" : "File analyzed", {
        filePath: parsedFile.filePath,
        dependencies: result.dependencies.length,
        functions: result.complexity.functions.length,
        components: result.complexity.components.length,
      });
      results.push(result);
    }

    allResults.push(result);
  }

  await analysisCache.persist();
  const pageRanks = graphBuilder.calculatePageRank();
  const graphJson = graphBuilder.exportToJSON();
  const sccs = graphBuilder.detectStronglyConnectedComponents();
  const largestStronglyConnectedComponentSize = sccs.reduce((max, component) => Math.max(max, component.length), 0);
  const topInDegree = [...graphJson.nodes]
    .sort((left, right) => right.inDegree - left.inDegree || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((node) => ({ id: node.id, degree: node.inDegree }));
  const topOutDegree = [...graphJson.nodes]
    .sort((left, right) => right.outDegree - left.outDegree || left.id.localeCompare(right.id))
    .slice(0, 10)
    .map((node) => ({ id: node.id, degree: node.outDegree }));
  const graphWarnings = buildGraphWarnings(graphJson, {
    cycles: graphBuilder.detectCycles(),
    largestStronglyConnectedComponentSize,
    topInDegree,
    topOutDegree,
  }, projectDir);
  const graphMetrics: GraphMetrics = {
    cycles: graphBuilder.detectCycles(),
    totalDependencies: results.reduce((sum, result) => sum + result.dependencies.length, 0),
    externalDependencies: results.reduce(
      (sum, result) => sum + result.dependencies.filter((dependency) => dependency.isExternal).length,
      0,
    ),
    stronglyConnectedComponents: sccs,
    weaklyConnectedComponents: graphBuilder.detectWeaklyConnectedComponents(),
    topPageRank: Array.from(pageRanks.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([id, score]) => ({ id, score })),
    topInDegree,
    topOutDegree,
    largestStronglyConnectedComponentSize,
    warnings: graphWarnings,
  };

  return {
    results,
    allResults,
    scanResult: {
      ...scanResult,
      parsed: scopedParsedFiles,
    },
    fullScanResult,
    graphBuilder,
    graphJson,
    graphMetrics,
    analysisCacheStats: analysisCache.getStats(),
    incrementalStats: {
      reusedFiles: analysisCache.getStats().hits,
      recomputedFiles: analysisCache.getStats().misses,
    },
    parseIssues,
  };
}

async function analyzeProject(
  projectDir: string,
  config: AnalysisConfig,
  options: { openReport?: boolean } = {},
): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Analysis started", { projectDir });
    const artifacts = await buildArtifacts(projectDir, config, logger);

    const reportGenerator = new ReportGenerator();
    const report = await reportGenerator.generateReports(artifacts.results, artifacts.graphMetrics, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: config.outputFormats,
      complexityThreshold: config.complexityThreshold,
      executionTimeMs: Date.now() - startTime,
      projectRoot: projectDir,
      skippedFiles: artifacts.scanResult.skipped,
      scanErrors: artifacts.scanResult.errors,
      parseIssues: artifacts.parseIssues,
      cacheStats: artifacts.scanResult.cacheStats,
      analysisCacheStats: artifacts.analysisCacheStats,
      incrementalStats: artifacts.incrementalStats,
      graphJson: artifacts.graphJson,
    });

    logger.info("Reports generated", {
      outputDir: config.outputDir,
      durationMs: Date.now() - startTime,
      analysisCacheHits: artifacts.analysisCacheStats.hits,
      analysisCacheMisses: artifacts.analysisCacheStats.misses,
    });
    await logger.close();
    printAnalyzeSummary(report, config);
    openHtmlReportIfRequested(options.openReport, config, `${config.filePrefix}_report.html`, true);
    return 0;
  } catch (error) {
    return handleCommandError(error, logger, "Analysis failed");
  }
}

async function graphProject(projectDir: string, config: AnalysisConfig): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();

  try {
    logger.info("Graph export started", { projectDir });
    const artifacts = await buildArtifacts(projectDir, config, logger);
    await fs.mkdir(config.outputDir, { recursive: true });
    const graphJsonPath = path.join(config.outputDir, `${config.filePrefix}_graph.json`);
    const graphDotPath = path.join(config.outputDir, `${config.filePrefix}_graph.dot`);

    await fs.writeFile(graphJsonPath, JSON.stringify({
      graph: artifacts.graphJson,
      metrics: artifacts.graphMetrics,
    }, null, 2), "utf8");
    await fs.writeFile(graphDotPath, artifacts.graphBuilder.exportToDOT(), "utf8");

    logger.info("Graph export completed", {
      outputDir: config.outputDir,
      graphJsonPath,
      graphDotPath,
      analysisCacheHits: artifacts.analysisCacheStats.hits,
      analysisCacheMisses: artifacts.analysisCacheStats.misses,
    });
    await logger.close();
    console.log([
      "",
      `✔ 依存グラフを出力しました: ${artifacts.graphJson.nodes.length} ノード / ${artifacts.graphJson.edges.length} エッジ / 循環依存 ${artifacts.graphMetrics.cycles.length} 件`,
      `  出力先: ${config.outputDir}`,
      `    ${config.filePrefix}_graph.json`,
      `    ${config.filePrefix}_graph.dot  ← Graphviz などの可視化ツールに渡せます`,
    ].join("\n"));
    return 0;
  } catch (error) {
    return handleCommandError(error, logger, "Graph export failed");
  }
}

async function diffProject(
  projectDir: string,
  config: AnalysisConfig,
  baselinePath: string,
  options: { openReport?: boolean } = {},
): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Diff started", { projectDir, baselinePath });
    const baseline = await loadBaselineReport<PersistedAnalysisReport>(
      baselinePath,
      "先に analyze を実行して baseline を作成するか、--baseline で既存の *_report.json を指定してください。",
    );
    const artifacts = await buildArtifacts(projectDir, config, logger);

    const reportGenerator = new ReportGenerator();
    const currentReport = await reportGenerator.generateReports(artifacts.results, artifacts.graphMetrics, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: config.outputFormats,
      complexityThreshold: config.complexityThreshold,
      executionTimeMs: Date.now() - startTime,
      projectRoot: projectDir,
      skippedFiles: artifacts.scanResult.skipped,
      scanErrors: artifacts.scanResult.errors,
      parseIssues: artifacts.parseIssues,
      cacheStats: artifacts.scanResult.cacheStats,
      analysisCacheStats: artifacts.analysisCacheStats,
      incrementalStats: artifacts.incrementalStats,
      graphJson: artifacts.graphJson,
    });

    const currentReportPath = path.join(config.outputDir, `${config.filePrefix}_report.json`);
    const diffGenerator = new DiffGenerator();
    const diff = diffGenerator.compare(currentReport, baseline, baselinePath, currentReportPath, { projectRoot: projectDir });
    await diffGenerator.writeReports(diff, config.outputDir, config.filePrefix, {
      projectRoot: projectDir,
      impactScoreThreshold: config.impactScoreThreshold,
    });
    openHtmlReportIfRequested(options.openReport, config, `${config.filePrefix}_diff.html`, false);

    const thresholdViolations = config.impactScoreThreshold > 0
      ? diff.impact.prioritizedFiles.filter((item) => item.score >= config.impactScoreThreshold)
      : [];

    logger.info("Diff completed", {
      outputDir: config.outputDir,
      changedFiles: diff.summary.changedFiles,
      addedFiles: diff.summary.addedFiles,
      removedFiles: diff.summary.removedFiles,
      impactThreshold: config.impactScoreThreshold,
      thresholdViolations: thresholdViolations.length,
    });

    if (config.failOnImpactThreshold && thresholdViolations.length > 0) {
      logger.error("Impact threshold exceeded", {
        threshold: config.impactScoreThreshold,
        offenders: thresholdViolations.slice(0, 10).map((item) => ({
          path: item.path,
          score: item.score,
        })),
      });
      await logger.close();
      const offenders = thresholdViolations
        .slice(0, 3)
        .map((item) => `${item.path} (score ${item.score})`)
        .join(", ");
      console.error([
        "",
        `✖ 影響度しきい値 (${config.impactScoreThreshold}) を超過したファイルが ${thresholdViolations.length} 件あります (終了コード 2)`,
        `  上位: ${offenders}`,
        `  詳細: ${path.join(config.outputDir, `${config.filePrefix}_diff.md`)}`,
      ].join("\n"));
      return 2;
    }

    await logger.close();
    printDiffSummary(diff, config);
    return 0;
  } catch (error) {
    return handleCommandError(error, logger, "Diff failed");
  }
}

async function qualityProject(
  projectDir: string,
  config: AnalysisConfig,
  mode: "collect" | "gate" | "diff",
  baselinePath?: string,
  options: { openReport?: boolean } = {},
): Promise<number> {
  const logger = new Logger(config.verbose ? "DEBUG" : "INFO", config.logFile);
  await logger.initialize();
  const startTime = Date.now();

  try {
    logger.info("Quality analysis started", { projectDir, mode });
    const baselineReport = (mode === "diff" || mode === "gate") && baselinePath
      ? await loadBaselineReport<QualityReport>(
          baselinePath,
          "先に quality collect を実行して baseline を作成するか、--baseline で既存の *_quality_report.json を指定してください。",
        )
      : undefined;
    const artifacts = await buildArtifacts(projectDir, config, logger, { includeUnscopedScan: true });
    const manualInputPath = config.manualInputPath
      ? path.resolve(config.manualInputPath)
      : path.join(projectDir, "quality.manual.json");
    let manualInputs: ManualQualityMetricInput[] = [];

    try {
      await fs.access(manualInputPath);
      manualInputs = await new ManualQualityInputLoader().load(manualInputPath);
      logger.info("Manual quality input loaded", {
        manualInputPath,
        entries: manualInputs.length,
      });
    } catch {
      logger.debug("Manual quality input not found", { manualInputPath });
    }

    const qualityReportGenerator = new QualityReportGenerator();
    const currentReportPath = path.join(config.outputDir, `${config.filePrefix}_quality_report.json`);
    const qualityDiffGenerator = new QualityDiffGenerator();
    let failingAutomaticMetrics: Array<{ category: string; metric: QualityReport["categories"][number]["metrics"][number] }> = [];
    let diff: QualityDiffReport | undefined;
    let blockingRegressionMetrics: ReturnType<typeof selectBlockingRegressionMetrics> = [];

    const report = await qualityReportGenerator.generateReports({
      projectRoot: projectDir,
      analysisResults: artifacts.results,
      parsedFiles: artifacts.scanResult.parsed,
      testEvidenceResults: artifacts.allResults,
      testEvidenceParsedFiles: artifacts.fullScanResult.parsed,
      graphMetrics: artifacts.graphMetrics,
      executionTimeMs: Date.now() - startTime,
      tsConfigPath: config.tsConfigPath,
      qualityProfile: config.qualityProfile,
      testPresenceSettings: config.testPresenceSettings,
      maxTypeCheckRootNames: config.maxTypeCheckRootNames,
      cacheDir: config.enableCache ? config.cacheDir : undefined,
      manualInputs,
    }, {
      outputDir: config.outputDir,
      prefix: config.filePrefix,
      formats: mode === "diff" && !config.outputFormats.includes("json")
        ? [...config.outputFormats, "json"]
        : config.outputFormats,
      onProgress: (message, metadata) => logger.info(message, metadata),
      // レポート書き出し前に gate 判定とベースライン比較を確定させ、
      // 「ゲート判定」「前回比」を md / html 本文へ反映する
      gate: (builtReport) => {
        failingAutomaticMetrics = builtReport.categories
          .flatMap((category) => category.metrics.map((metric) => ({ category: category.label, metric })))
          .filter(({ metric }) => metric.aggregation === "primary" && metric.automation === "automatic" && metric.verdict === "fail");
        const shouldCompareWithBaseline = Boolean(baselineReport && baselinePath && (mode === "diff" || mode === "gate"));
        diff = shouldCompareWithBaseline
          ? qualityDiffGenerator.compare(builtReport, baselineReport!, baselinePath!, currentReportPath)
          : undefined;
        blockingRegressionMetrics = diff ? selectBlockingRegressionMetrics(diff, config) : [];

        if (mode !== "gate" && !diff) {
          return undefined;
        }
        return {
          mode,
          baselinePath: diff ? baselinePath : undefined,
          baselineOverallVerdict: baselineReport?.summary.overallVerdict,
          regressedCount: diff?.summary.regressedMetrics,
          improvedCount: diff?.summary.improvedMetrics,
          gateVerdict: failingAutomaticMetrics.length > 0 || blockingRegressionMetrics.length > 0 ? "fail" : "pass",
          failingAutomaticMetrics: failingAutomaticMetrics.map(({ category, metric }) => ({
            category,
            label: metric.label,
            actual: metric.actual,
            threshold: metric.threshold,
          })),
          blockingRegressions: blockingRegressionMetrics.map((metric) => ({
            category: metric.categoryLabel,
            label: metric.label,
            baselineVerdict: metric.baselineVerdict ?? "不明",
            currentVerdict: metric.currentVerdict ?? "不明",
          })),
        };
      },
    });

    if (diff) {
      await qualityDiffGenerator.writeReports(diff, config.outputDir, config.filePrefix, config.outputFormats);
    }

    if (mode === "diff") {
      if (!baselineReport || !baselinePath) {
        throw new Error("Quality diff requires a baseline report.");
      }
      if (!diff) {
        throw new Error("Quality diff generation failed.");
      }

      logger.info("Quality diff completed", {
        outputDir: config.outputDir,
        changedCategories: diff.summary.changedCategories,
        changedMetrics: diff.summary.changedMetrics,
        regressedMetrics: diff.summary.regressedMetrics,
        automaticRegressions: diff.summary.automaticRegressions,
        durationMs: Date.now() - startTime,
      });

      await logger.close();
      const diffLines: string[] = [""];
      diffLines.push(`✔ 品質差分を生成しました: 悪化 ${diff.summary.regressedMetrics} / 改善 ${diff.summary.improvedMetrics}`);
      // QualityDiffGenerator.resolveFormats と同じ規則で、実際に書き出されたファイルだけを列挙する
      const requestedDiffFormats = config.outputFormats.filter((format) => format !== "all" && format !== "csv");
      const diffFormats = config.outputFormats.includes("all") || requestedDiffFormats.length === 0
        ? ["json", "markdown", "html"]
        : requestedDiffFormats;
      const diffFiles = [
        ...(diffFormats.includes("markdown") ? [`${config.filePrefix}_quality_diff.md`] : []),
        ...(diffFormats.includes("html") ? [`${config.filePrefix}_quality_diff.html`] : []),
        ...(diffFormats.includes("json") ? [`${config.filePrefix}_quality_diff.json`] : []),
      ];
      printOutputFiles(diffLines, config.outputDir, diffFiles, "まずこのファイルから読み始めてください");
      console.log(diffLines.join("\n"));
      if (diffFormats.includes("html")) {
        openHtmlReportIfRequested(options.openReport, config, `${config.filePrefix}_quality_diff.html`, false);
      } else if (options.openReport) {
        console.warn("--open: --format に html が含まれていないため、HTML レポートを開けません。");
      }
      return 0;
    }

    logger.info("Quality analysis completed", {
      outputDir: config.outputDir,
      overallVerdict: report.summary.overallVerdict,
      automaticFailCount: failingAutomaticMetrics.length,
      automaticRegressionCount: blockingRegressionMetrics.length,
      durationMs: Date.now() - startTime,
    });
    openHtmlReportIfRequested(options.openReport, config, `${config.filePrefix}_quality_report.html`, true);

    if (mode === "gate" && failingAutomaticMetrics.length > 0) {
      logger.error("Quality gate failed", {
        offenders: failingAutomaticMetrics.slice(0, 10).map(({ category, metric }) => ({
          category,
          metric: metric.label,
          actual: metric.actual,
          threshold: metric.threshold,
        })),
      });
      await logger.close();
      const offenders = failingAutomaticMetrics
        .slice(0, 3)
        .map(({ category, metric }) => `${category}/${metric.label} (実績 ${metric.actual} / 基準 ${metric.threshold})`)
        .join(", ");
      console.error([
        "",
        `✖ quality gate: FAIL (終了コード 2) — 自動判定 FAIL の親指標が ${failingAutomaticMetrics.length} 件あります`,
        `  上位: ${offenders}`,
        `  詳細: ${path.join(config.outputDir, `${config.filePrefix}_quality_report.md`)} の「要点」`,
      ].join("\n"));
      return 2;
    }

    if (mode === "gate" && diff && blockingRegressionMetrics.length > 0) {
      logger.error("Quality gate failed due to automatic regressions", {
        baselinePath,
        blockingMetricIds: config.qualityGateBlockingMetricIds,
        monitoringMetricIds: config.qualityGateMonitoringMetricIds,
        offenders: blockingRegressionMetrics
          .slice(0, 10)
          .map((metric) => ({
            category: metric.categoryLabel,
            metric: metric.label,
            baselineVerdict: metric.baselineVerdict,
            currentVerdict: metric.currentVerdict,
            baselineActual: metric.baselineActual,
            currentActual: metric.currentActual,
          })),
      });
      await logger.close();
      const offenders = blockingRegressionMetrics
        .slice(0, 3)
        .map((metric) => `${metric.categoryLabel}/${metric.label} (${metric.baselineVerdict ?? "不明"} → ${metric.currentVerdict ?? "不明"})`)
        .join(", ");
      console.error([
        "",
        `✖ quality gate: FAIL (終了コード 2) — baseline から判定が悪化した自動指標が ${blockingRegressionMetrics.length} 件あります`,
        `  上位: ${offenders}`,
        `  詳細: ${path.join(config.outputDir, `${config.filePrefix}_quality_diff.md`)}`,
      ].join("\n"));
      return 2;
    }

    await logger.close();
    printQualitySummary(report, config, mode);
    return 0;
  } catch (error) {
    return handleCommandError(error, logger, "Quality analysis failed");
  }
}

function buildGraphWarnings(
  graphJson: GraphJSON,
  graphStats: {
    cycles: GraphMetrics["cycles"];
    largestStronglyConnectedComponentSize: number;
    topInDegree: GraphMetrics["topInDegree"];
    topOutDegree: GraphMetrics["topOutDegree"];
  },
  projectRoot?: string,
): string[] {
  const toDisplayPath = (filePath: string): string => {
    if (!projectRoot || !path.isAbsolute(filePath)) {
      return filePath;
    }

    const relativePath = path.relative(projectRoot, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return filePath;
    }

    return relativePath.split(path.sep).join("/");
  };
  const warnings: string[] = [];
  const nodeCount = Math.max(graphJson.nodes.length, 1);
  const hubThreshold = Math.max(5, Math.ceil(nodeCount * 0.1));
  const fanOutThreshold = Math.max(5, Math.ceil(nodeCount * 0.18));

  if (graphStats.cycles.length > 0) {
    warnings.push(`循環依存を ${graphStats.cycles.length} 件検出しました。`);
  }
  if (graphStats.largestStronglyConnectedComponentSize >= 4) {
    warnings.push(`最大の強連結成分は ${graphStats.largestStronglyConnectedComponentSize} ファイルにまたがっています。`);
  }
  const topHub = graphStats.topInDegree[0];
  if (topHub && topHub.degree >= hubThreshold) {
    warnings.push(`ハブモジュール警告: ${toDisplayPath(topHub.id)} は ${topHub.degree} モジュールから参照されています。`);
  }
  const topFanOut = graphStats.topOutDegree[0];
  if (topFanOut && topFanOut.degree >= fanOutThreshold) {
    warnings.push(`fan-out 警告: ${toDisplayPath(topFanOut.id)} は ${topFanOut.degree} モジュールに依存しています。`);
  }

  return warnings;
}

function selectBlockingRegressionMetrics(
  diff: QualityDiffReport,
  config: AnalysisConfig,
): QualityMetricDiffEntry[] {
  const monitoringMetricIds = new Set(config.qualityGateMonitoringMetricIds);
  const blockingMetricIds = new Set(config.qualityGateBlockingMetricIds);

  return diff.metrics.filter((metric) => {
    if ((metric.currentAggregation ?? metric.baselineAggregation ?? "primary") !== "primary") {
      return false;
    }
    if (metric.trend !== "regressed" || metric.currentAutomation !== "automatic") {
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

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs();
  } catch (error) {
    return reportArgumentError(error);
  }

  if (parsed.values.version) {
    await printVersion();
    return 0;
  }

  const [command, maybeSubcommand, maybeProjectDir] = parsed.positionals;
  const projectDir = command === "quality" ? maybeProjectDir : maybeSubcommand;
  const qualityMode = command === "quality"
    ? (
      maybeSubcommand === "gate"
        ? "gate"
        : maybeSubcommand === "report"
          ? "report"
          : maybeSubcommand === "collect"
            ? "collect"
            : maybeSubcommand === "diff"
              ? "diff"
              : undefined
    )
    : undefined;

  if (parsed.values.help || !command) {
    printHelp(command && command in COMMAND_USAGE ? command : undefined);
    return 0;
  }

  const validCommands = ["analyze", "graph", "diff", "quality", "init"];
  if (!validCommands.includes(command) || !projectDir || (command === "quality" && !qualityMode)) {
    if (!validCommands.includes(command)) {
      console.error(`エラー: 不明なコマンド '${command}' です。使用できるコマンド: analyze, graph, diff, quality, init\n`);
    } else if (command === "quality" && !qualityMode) {
      console.error(`エラー: quality にはサブコマンド (collect | gate | diff) が必要です。例: quality collect ${maybeSubcommand ?? "./my-app"}\n`);
    } else {
      const commandExample = command === "quality" ? `quality ${qualityMode}` : command;
      console.error(`エラー: 解析対象の <projectDir> を指定してください。例: ${commandExample} ./my-app\n`);
    }
    printHelp(validCommands.includes(command) ? command : undefined);
    return 1;
  }

  if (command === "init") {
    return runInit(path.resolve(projectDir), Boolean(parsed.values.yes));
  }

  if (command === "graph" && typeof parsed.values.format === "string") {
    console.warn("警告: graph は --format を無視し、常に JSON と DOT を出力します。HTML レポートが必要な場合は analyze を使ってください。");
  }
  if (parsed.values.watch && command !== "diff") {
    console.warn("警告: --watch は diff でのみ使用できます。無視して通常実行します。");
  }
  const openReport = Boolean(parsed.values.open);
  if (openReport && command === "graph") {
    console.warn("警告: graph は HTML を出力しないため --open は使えません。analyze を使ってください。");
  }
  if (command === "quality" && qualityMode === "report") {
    console.warn("quality report は quality collect の別名です。今後は collect を使ってください。");
  }

  const projectRoot = path.resolve(projectDir);
  const configManager = new ConfigManager();
  const configPath = typeof parsed.values.config === "string"
    ? path.resolve(parsed.values.config)
    : path.join(projectRoot, "analyzer.config.json");
  const tsConfigPath = path.join(projectRoot, "tsconfig.json");
  const dotEnvPath = path.join(projectRoot, ".env");

  const cliConfig = configManager.loadFromCLI({
    output: typeof parsed.values.output === "string" ? parsed.values.output : undefined,
    format: typeof parsed.values.format === "string" ? parsed.values.format : undefined,
    prefix: typeof parsed.values.prefix === "string" ? parsed.values.prefix : undefined,
    verbose: parsed.values.verbose,
    maxFileSize: typeof parsed.values["max-file-size"] === "string" ? parsed.values["max-file-size"] : undefined,
    analysisScope: typeof parsed.values["analysis-scope"] === "string" ? parsed.values["analysis-scope"] : undefined,
    qualityProfile: typeof parsed.values["quality-profile"] === "string" ? parsed.values["quality-profile"] : undefined,
    complexityThreshold: typeof parsed.values["complexity-threshold"] === "string"
      ? parsed.values["complexity-threshold"]
      : undefined,
    impactScoreThreshold: typeof parsed.values["impact-threshold"] === "string"
      ? parsed.values["impact-threshold"]
      : undefined,
    failOnImpactThreshold: parsed.values["fail-on-impact"],
    excludeGroups: typeof parsed.values["exclude-groups"] === "string" ? parsed.values["exclude-groups"] : undefined,
    excludePatterns: typeof parsed.values["exclude-patterns"] === "string" ? parsed.values["exclude-patterns"] : undefined,
    cacheDir: typeof parsed.values["cache-dir"] === "string" ? parsed.values["cache-dir"] : undefined,
    logFile: typeof parsed.values["log-file"] === "string" ? parsed.values["log-file"] : undefined,
    manualInput: typeof parsed.values["manual-input"] === "string" ? parsed.values["manual-input"] : undefined,
    qualityGateBlockingMetrics: typeof parsed.values["quality-gate-blocking-metrics"] === "string"
      ? parsed.values["quality-gate-blocking-metrics"]
      : undefined,
    qualityGateMonitoringMetrics: typeof parsed.values["quality-gate-monitoring-metrics"] === "string"
      ? parsed.values["quality-gate-monitoring-metrics"]
      : undefined,
    maxTypeCheckRootNames: typeof parsed.values["max-typecheck-root-names"] === "string"
      ? parsed.values["max-typecheck-root-names"]
      : undefined,
  });

  const dotEnvConfig = configManager.loadFromDotEnv(dotEnvPath);
  const environmentConfig = configManager.loadFromEnvironment();
  notifyConfigPrecedence(cliConfig, dotEnvConfig, environmentConfig);

  // v0.2.0 から CLI 引数が最優先 (デフォルト < 設定ファイル < tsconfig < .env < 環境変数 < CLI)
  const config = configManager.mergeConfigs(
    configManager.getDefaults(),
    configManager.loadFromFile(configPath),
    configManager.loadFromTSConfig(tsConfigPath),
    dotEnvConfig,
    environmentConfig,
    cliConfig,
    {
      projectRoot,
      tsConfigPath,
    },
  );

  if (config.outputFormats.length === 0) {
    config.outputFormats = ["json", "markdown", "csv"];
  }

  config.outputDir = path.resolve(projectRoot, config.outputDir);
  config.cacheDir = path.resolve(projectRoot, config.cacheDir);
  config.logFile = path.resolve(projectRoot, config.logFile);
  if (config.manualInputPath) {
    config.manualInputPath = path.resolve(projectRoot, config.manualInputPath);
  }

  if (command === "graph") {
    return graphProject(projectRoot, config);
  }
  if (command === "diff") {
    const baselinePath = typeof parsed.values.baseline === "string"
      ? path.resolve(parsed.values.baseline)
      : path.join(config.outputDir, `${config.filePrefix}_report.json`);
    if (parsed.values.watch) {
      return watchDiff(projectRoot, config, baselinePath, openReport);
    }
    return diffProject(projectRoot, config, baselinePath, { openReport });
  }
  if (command === "quality") {
    if (!qualityMode) {
      printHelp("quality");
      return 1;
    }
    // report は collect の別名 (非推奨)。上で告知済み
    const qualityCommandMode = qualityMode === "report" ? "collect" : qualityMode;
    const baselinePath = qualityCommandMode === "diff"
      ? typeof parsed.values.baseline === "string"
        ? path.resolve(parsed.values.baseline)
        : path.join(config.outputDir, `${config.filePrefix}_quality_report.json`)
      : qualityCommandMode === "gate" && typeof parsed.values.baseline === "string"
        ? path.resolve(parsed.values.baseline)
      : undefined;
    return qualityProject(projectRoot, config, qualityCommandMode, baselinePath, { openReport });
  }

  return analyzeProject(projectRoot, config, { openReport });
}

const exitCode = await main();
process.exit(exitCode);
