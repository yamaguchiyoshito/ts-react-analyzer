import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ANALYSIS_CACHE_SCHEMA } from "../src/core/index.js";
import type { CachedAnalysisRecord, PersistedAnalysisReport } from "../src/types/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(workspaceRoot, "dist", "src", "cli.js");
const execFileAsync = promisify(execFile);

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    baseUrl: ".",
    paths: { "@/*": ["src/*"] },
  },
  include: ["src"],
}, null, 2);

async function writeProject(projectRoot: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tsconfig.json"), TSCONFIG, "utf8");
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "cache-fixture", version: "1.0.0", private: true }),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(projectRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

// キャッシュ・出力ともプロジェクト直下の既定パス (.ts-analyzer-cache / analysis-reports) に置き、
// プロジェクトを別パスへ複製したときにキャッシュも一緒に移る状況を再現する
async function runAnalyze(projectRoot: string): Promise<PersistedAnalysisReport> {
  await execFileAsync(process.execPath, [
    cliPath,
    "analyze",
    projectRoot,
    "--format",
    "json",
    "--prefix",
    "cache",
  ], { cwd: workspaceRoot });
  return JSON.parse(
    await fs.readFile(path.join(projectRoot, "analysis-reports", "cache_report.json"), "utf8"),
  ) as PersistedAnalysisReport;
}

function graphOf(report: PersistedAnalysisReport) {
  const graph = report.graphJson;
  assert.ok(graph, "graphJson should be present in the JSON report");
  return {
    nodeIds: graph.nodes.map((node) => node.id).sort(),
    edges: graph.edges.map((edge) => `${edge.source} -> ${edge.target}`).sort(),
  };
}

async function readCacheRecords(projectRoot: string): Promise<CachedAnalysisRecord[]> {
  const analysisDir = path.join(projectRoot, ".ts-analyzer-cache", "analysis");
  const files = (await fs.readdir(analysisDir)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1, "exactly one analysis cache file is expected");
  return JSON.parse(await fs.readFile(path.join(analysisDir, files[0] ?? ""), "utf8")) as CachedAnalysisRecord[];
}

test("analysis cache re-resolves an unchanged importer when its target is renamed b.ts -> b.tsx", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-cache-rename-"));
  try {
    const projectRoot = path.join(tempRoot, "proj");
    await writeProject(projectRoot, {
      "src/a.ts": "import { b } from \"./b\";\nexport const a = b + 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });

    const first = await runAnalyze(projectRoot);
    assert.deepEqual(graphOf(first).edges, ["src/a.ts -> src/b.ts"]);
    assert.equal(first.analysisCacheStats?.hits, 0);

    // a.ts は無変更のまま、解決先だけを改名する
    await fs.rename(path.join(projectRoot, "src", "b.ts"), path.join(projectRoot, "src", "b.tsx"));

    const second = await runAnalyze(projectRoot);
    const graph = graphOf(second);
    assert.deepEqual(graph.edges, ["src/a.ts -> src/b.tsx"]);
    assert.deepEqual(graph.nodeIds, ["src/a.ts", "src/b.tsx"]);
    assert.ok(!graph.nodeIds.includes("src/b.ts"), "the deleted b.ts must not survive as a stale node");
    const aFile = second.files.find((file) => file.path === "src/a.ts");
    assert.ok(aFile);
    assert.deepEqual(aFile.dependencies.map((dependency) => dependency.target), ["src/b.tsx"]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("analysis cache re-resolves when foo/index.ts is added next to an existing foo.ts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-cache-shadow-"));
  try {
    const projectRoot = path.join(tempRoot, "proj");
    await writeProject(projectRoot, {
      "src/a.ts": "import { foo } from \"./foo\";\nexport const a = foo;\n",
      "src/foo.ts": "export const foo = 1;\n",
    });

    const first = await runAnalyze(projectRoot);
    assert.deepEqual(graphOf(first).edges, ["src/a.ts -> src/foo.ts"]);

    // a.ts / foo.ts はどちらも無変更。新しいファイルが増えただけで解決結果が変わり得る
    await fs.mkdir(path.join(projectRoot, "src", "foo"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "foo", "index.ts"), "export const foo = 2;\n", "utf8");

    const second = await runAnalyze(projectRoot);
    const aFile = second.files.find((file) => file.path === "src/a.ts");
    assert.ok(aFile);
    const targets = aFile.dependencies.map((dependency) => dependency.target);
    // どちらへ解決されるかは TypeScript の規則に従うが、キャッシュがヒットしたまま
    // 古い結果を返していないことを、依存が再計算されたことで確認する
    assert.equal(second.analysisCacheStats?.hits, 0, "file-set change must invalidate every record");
    assert.equal(second.analysisCacheStats?.misses, 3);
    assert.equal(targets.length, 1);
    assert.ok(targets[0] === "src/foo.ts" || targets[0] === "src/foo/index.ts");

    // ファイル集合が安定すれば再びヒットする
    const third = await runAnalyze(projectRoot);
    assert.equal(third.analysisCacheStats?.hits, 3);
    assert.equal(third.analysisCacheStats?.misses, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("enableCache: false neither writes the analysis cache nor reports hits", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-cache-disabled-"));
  try {
    const projectRoot = path.join(tempRoot, "proj");
    await writeProject(projectRoot, {
      "src/a.ts": "import { b } from \"./b\";\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
      "analyzer.config.json": JSON.stringify({ enableCache: false }),
    });

    const first = await runAnalyze(projectRoot);
    assert.deepEqual(first.analysisCacheStats, { hits: 0, misses: 2 });
    const second = await runAnalyze(projectRoot);
    assert.deepEqual(second.analysisCacheStats, { hits: 0, misses: 2 });
    assert.deepEqual(second.incrementalStats, { reusedFiles: 0, recomputedFiles: 2 });

    await assert.rejects(
      fs.stat(path.join(projectRoot, ".ts-analyzer-cache", "analysis")),
      { code: "ENOENT" },
      "the analysis cache directory must not be created when the cache is disabled",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("analysis cache copied with the project to another absolute path hits on the first run there", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-cache-relocate-"));
  try {
    const originalRoot = path.join(tempRoot, "checkout-a", "proj");
    await writeProject(originalRoot, {
      "src/App.ts": "import { Button } from \"@/components/Button\";\nimport { helper } from \"./utils/helper\";\nexport const app = Button + helper;\n",
      "src/components/Button.ts": "export const Button = 1;\n",
      "src/utils/helper.ts": "export const helper = 2;\n",
    });

    const first = await runAnalyze(originalRoot);
    assert.deepEqual(first.analysisCacheStats, { hits: 0, misses: 3 });

    // 永続化されたレコードに元の絶対パスが残っていないこと
    const records = await readCacheRecords(originalRoot);
    const serialized = JSON.stringify(records);
    assert.ok(!serialized.includes(originalRoot.split(path.sep).join("/")), "cache must not embed the absolute project path");
    assert.ok(!serialized.includes(originalRoot), "cache must not embed the absolute project path");
    assert.deepEqual(records.map((record) => record.filePath).sort(), [
      "src/App.ts",
      "src/components/Button.ts",
      "src/utils/helper.ts",
    ]);

    // キャッシュディレクトリごと別の絶対パスへ複製する (CI でのキャッシュ復元を模す)
    const relocatedRoot = path.join(tempRoot, "checkout-b", "nested", "proj");
    await fs.mkdir(path.dirname(relocatedRoot), { recursive: true });
    await fs.cp(originalRoot, relocatedRoot, { recursive: true });
    await fs.rm(path.join(relocatedRoot, "analysis-reports"), { recursive: true, force: true });

    const relocated = await runAnalyze(relocatedRoot);
    assert.deepEqual(relocated.analysisCacheStats, { hits: 3, misses: 0 });
    assert.deepEqual(relocated.incrementalStats, { reusedFiles: 3, recomputedFiles: 0 });
    // キャッシュ由来の結果でも、レポート上のパスは新しい位置基準の相対パスになる
    assert.deepEqual(graphOf(relocated).edges, [
      "src/App.ts -> src/components/Button.ts",
      "src/App.ts -> src/utils/helper.ts",
    ]);
    assert.deepEqual(graphOf(relocated), graphOf(first));
    assert.deepEqual(
      relocated.files.map((file) => [file.path, file.dependencies.map((dependency) => dependency.target)]),
      first.files.map((file) => [file.path, file.dependencies.map((dependency) => dependency.target)]),
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("analysis cache ignores records written without the current schema", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-cache-schema-"));
  try {
    const projectRoot = path.join(tempRoot, "proj");
    await writeProject(projectRoot, {
      "src/a.ts": "import { b } from \"./b\";\nexport const a = b;\n",
      "src/b.ts": "export const b = 1;\n",
    });

    const first = await runAnalyze(projectRoot);
    assert.deepEqual(first.analysisCacheStats, { hits: 0, misses: 2 });
    const analysisDir = path.join(projectRoot, ".ts-analyzer-cache", "analysis");
    const [cacheFileName] = (await fs.readdir(analysisDir)).filter((name) => name.endsWith(".json"));
    assert.ok(cacheFileName);
    const cacheFile = path.join(analysisDir, cacheFileName);
    const records = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CachedAnalysisRecord[];
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.schema === ANALYSIS_CACHE_SCHEMA));

    // schema 1 相当: 同じキー・同じハッシュだが schema を持たないレコードに書き換える
    // (payload は壊れた内容にして、ヒットしていればレポートに現れるようにする)
    const legacyRecords = records.map((record) => {
      const { schema: _schema, ...rest } = record;
      return {
        ...rest,
        payload: {
          ...rest.payload,
          dependencies: [],
        },
      };
    });
    await fs.writeFile(cacheFile, JSON.stringify(legacyRecords), "utf8");

    const second = await runAnalyze(projectRoot);
    assert.deepEqual(second.analysisCacheStats, { hits: 0, misses: 2 });
    assert.deepEqual(graphOf(second).edges, ["src/a.ts -> src/b.ts"]);

    // 旧レコードは現行形式で書き直され、次回はヒットする
    const rewritten = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CachedAnalysisRecord[];
    assert.ok(rewritten.every((record) => record.schema === ANALYSIS_CACHE_SCHEMA));
    const third = await runAnalyze(projectRoot);
    assert.deepEqual(third.analysisCacheStats, { hits: 2, misses: 0 });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
