import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// CLI の操作感 (終了コード・ヘルプ・--quiet・短縮オプション) を、実際に dist/src/cli.js を
// 起動して確認する。解析対象は fixture のコピー (一時ディレクトリ) を使い、fixture 自体には
// analysis-reports / analysis.log / キャッシュを書き込まない。

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");
const sampleProject = path.join(workspaceRoot, "tests", "fixtures", "sample-app");
const execFileAsync = promisify(execFile);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function createSampleProjectCopy(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tsra-cli-ux-"));
  await fs.cp(path.join(sampleProject, "src"), path.join(projectRoot, "src"), { recursive: true });
  await fs.copyFile(path.join(sampleProject, "tsconfig.json"), path.join(projectRoot, "tsconfig.json"));
  return projectRoot;
}

test("引数なしで起動するとヘルプを表示して終了コード 1 になる", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 1);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, /使い方:/u);
  assert.match(combined, /ts-react-analyzer analyze <projectDir>/u);
  assert.match(result.stderr, /エラー: コマンドを指定してください/u);
});

test("--help と -h はヘルプを標準出力に出して終了コード 0 になる", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /使い方:/u);
    assert.match(result.stdout, /--quiet, -q/u);
    assert.match(result.stdout, /--help, -h/u);
    assert.match(result.stdout, /--version, -v/u);
  }

  const commandHelp = await runCli(["analyze", "-h"]);
  assert.equal(commandHelp.code, 0, commandHelp.stderr);
  assert.match(commandHelp.stdout, /ts-react-analyzer analyze <projectDir>/u);
});

test("--version と -v は package.json のバージョンを表示する", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v"]) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0, `${flag}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), packageJson.version);
  }
});

test("不明なコマンドは終了コード 1 で、エラーは標準エラーに出る", async () => {
  const result = await runCli(["analyse", "./somewhere"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /エラー: 不明なコマンド 'analyse' です/u);
  assert.match(result.stderr, /使用できるコマンド: analyze, graph, diff, quality, init/u);
});

test("不明なオプションは終了コード 1 で、近いオプションを提案する", async () => {
  const result = await runCli(["analyze", "./somewhere", "--quite"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /不明なオプション '--quite'/u);
  assert.match(result.stderr, /もしかして: --quiet/u);
});

test("--quiet は [INFO] を標準出力に出さず、結果サマリーとログファイルは残す", async () => {
  const projectRoot = await createSampleProjectCopy();
  try {
    const result = await runCli(["--quiet", "analyze", projectRoot, "--format", "json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\[INFO\]/u);
    assert.doesNotMatch(result.stdout, /\[DEBUG\]/u);
    assert.match(result.stdout, /✔ 解析が完了しました/u);
    assert.match(result.stdout, /analysis_report\.json/u);

    const logContent = await fs.readFile(path.join(projectRoot, "analysis.log"), "utf8");
    assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[INFO\] Analysis started /mu);
    assert.match(logContent, /\[INFO\] Reports generated /u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("-q は --quiet の短縮形として動き、--quiet なしでは [INFO] が標準出力に出る", async () => {
  const projectRoot = await createSampleProjectCopy();
  try {
    const quiet = await runCli(["analyze", projectRoot, "-q", "--format", "json"]);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /\[INFO\]/u);
    assert.match(quiet.stdout, /✔ 解析が完了しました/u);

    const verbose = await runCli(["analyze", projectRoot, "--format", "json"]);
    assert.equal(verbose.code, 0, verbose.stderr);
    assert.match(verbose.stdout, /\[INFO\] Analysis started/u);
    assert.match(verbose.stdout, /✔ 解析が完了しました/u);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
