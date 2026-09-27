import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { FileScanner, GraphBuilder } from "../src/core/index.js";

function buildRing(graph: GraphBuilder, prefix: string, size: number): string[] {
  const ids = Array.from({ length: size }, (_, index) => `/virtual/${prefix}/n${index}.ts`);
  for (let index = 0; index < size; index += 1) {
    graph.addDependency(ids[index]!, ids[(index + 1) % size]!, { type: "import" });
  }
  return ids;
}

async function withTempDir<T>(prefix: string, run: (tempRoot: string) => Promise<T>): Promise<T> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test("GraphBuilder grades cycle severity by strongly connected component size", () => {
  const graph = new GraphBuilder();
  const pair = buildRing(graph, "pair", 2);
  const quad = buildRing(graph, "quad", 4);
  const six = buildRing(graph, "six", 6);
  // 別の SCC へ向かう辺は循環の規模に影響しない
  graph.addDependency(pair[0]!, six[0]!, { type: "import" });
  graph.addDependency("/virtual/leaf.ts", quad[0]!, { type: "import" });

  const cycles = graph.detectCycles();
  assert.equal(cycles.length, 3, "one entry per SCC, however many files it spans");

  const bySize = new Map(cycles.map((cycle) => [cycle.length, cycle]));
  assert.equal(bySize.get(2)?.severity, "medium");
  assert.equal(bySize.get(4)?.severity, "high");
  assert.equal(bySize.get(6)?.severity, "critical");

  for (const cycle of cycles) {
    assert.equal(cycle.affectedFiles, cycle.length);
    assert.equal(cycle.edgeCount, cycle.length, "a simple ring has exactly one internal edge per node");
    assert.deepEqual(cycle.nodes, [...cycle.nodes].sort());
  }

  // 密に絡んだ SCC は edgeCount がファイル数を上回る
  const dense = new GraphBuilder();
  const ids = buildRing(dense, "dense", 3);
  dense.addDependency(ids[0]!, ids[2]!, { type: "dynamic-import" });
  dense.addDependency(ids[2]!, ids[1]!, { type: "import" });
  const [denseCycle] = dense.detectCycles();
  assert.equal(denseCycle?.severity, "high");
  assert.equal(denseCycle?.edgeCount, 5);
});

test("GraphBuilder escapes DOT identifiers and labels them with the basename", () => {
  const graph = new GraphBuilder();
  const quoted = '/tmp/we"ird/src/Comp"onent.tsx';
  const windows = "C:\\repo\\src\\pages\\Home.tsx";
  const multiline = "/tmp/line\nbreak/util.ts";
  graph.addDependency(quoted, windows, { type: "import" });
  graph.addDependency(windows, multiline, { type: "re-export" as never });

  const dot = graph.exportToDOT();
  const lines = dot.split("\n");

  // 生の `"` や改行、エスケープされていない `\` が引用文字列の中に残っていない
  assert.ok(!dot.includes('we"ird'), "double quotes inside identifiers must be escaped");
  assert.ok(!dot.includes('Comp"onent'), "double quotes inside labels must be escaped");
  assert.ok(lines.every((line) => !/^\s*"[^"]*$/u.test(line)), "no quoted string spans multiple lines");
  assert.ok(dot.includes('"/tmp/we\\"ird/src/Comp\\"onent.tsx"'));
  assert.ok(dot.includes('"C:\\\\repo\\\\src\\\\pages\\\\Home.tsx"'));
  assert.ok(dot.includes('"/tmp/line\\nbreak/util.ts"'));

  // ラベルは区切りが `/` でも `\` でも最後の要素
  assert.match(dot, /\[label="Comp\\"onent\.tsx", fillcolor=/u);
  assert.match(dot, /\[label="Home\.tsx", fillcolor=/u);
  assert.match(dot, /\[label="util\.ts", fillcolor=/u);
  assert.ok(!dot.includes('label="C:'), "a Windows path must not be used whole as the label");

  // 各行の `"` はエスケープ分を除くと偶数個 (引用が閉じている)
  for (const line of lines) {
    const unescaped = line.replace(/\\\\/gu, "").replace(/\\"/gu, "");
    const quoteCount = (unescaped.match(/"/gu) ?? []).length;
    assert.equal(quoteCount % 2, 0, `unbalanced quotes in: ${line}`);
  }
  assert.ok(dot.endsWith("}\n"));
});

test("GraphBuilder keeps edge metadata: types are deduped and weight counts statements", () => {
  const graph = new GraphBuilder();
  graph.addDependency("/virtual/a.ts", "/virtual/b.ts", { type: "import" });
  graph.addDependency("/virtual/a.ts", "/virtual/b.ts", { type: "import" });
  graph.addDependency("/virtual/a.ts", "/virtual/b.ts", { type: "dynamic-import" });
  graph.addDependency("/virtual/a.ts", "/virtual/c.ts", { type: "export", isTypeOnly: true });
  graph.addDependency("/virtual/b.ts", "/virtual/c.ts");

  const json = graph.exportToJSON();
  assert.deepEqual(json.edges.map((edge) => [edge.source, edge.target]), [
    ["/virtual/a.ts", "/virtual/b.ts"],
    ["/virtual/a.ts", "/virtual/c.ts"],
    ["/virtual/b.ts", "/virtual/c.ts"],
  ]);

  const [ab, ac, bc] = json.edges;
  assert.deepEqual(ab?.types, ["dynamic-import", "import"]);
  assert.equal(ab?.weight, 3);
  assert.equal(ab?.isTypeOnly, undefined);
  assert.deepEqual(ac?.types, ["export"]);
  assert.equal(ac?.weight, 1);
  assert.equal(ac?.isTypeOnly, true);
  assert.deepEqual(bc?.types, []);
  assert.equal(bc?.weight, 1);

  // outDegree は辺の本数 (依存文の本数ではない)
  const nodeA = json.nodes.find((node) => node.id === "/virtual/a.ts");
  assert.equal(nodeA?.outDegree, 2);
  assert.deepEqual(graph.topologicalSort(), ["/virtual/a.ts", "/virtual/b.ts", "/virtual/c.ts"]);
});

test("FileScanner scans .mts/.cts/.mjs/.cjs files with the matching ScriptKind", async () => {
  await withTempDir("analyzer-module-ext-", async (tempRoot) => {
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "config.mts"), "export const config: { a: number } = { a: 1 };\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "legacy.cts"), "export const legacy: string = 'x';\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "esm.mjs"), "export const esm = 1;\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "cjs.cjs"), "module.exports = { cjs: 1 };\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "notes.md"), "# not source\n", "utf8");

    const scanner = new FileScanner({
      excludePatterns: [],
      maxFileSizeBytes: 1024,
      cacheDir: path.join(tempRoot, ".cache"),
      enableCache: false,
    });
    const result = await scanner.scanProject(tempRoot);

    const byName = new Map(result.parsed.map((entry) => [path.basename(entry.filePath), entry]));
    assert.deepEqual([...byName.keys()].sort(), ["cjs.cjs", "config.mts", "esm.mjs", "legacy.cts"]);
    assert.equal(byName.get("config.mts")?.metadata.scriptKind, ts.ScriptKind.TS);
    assert.equal(byName.get("legacy.cts")?.metadata.scriptKind, ts.ScriptKind.TS);
    assert.equal(byName.get("esm.mjs")?.metadata.scriptKind, ts.ScriptKind.JS);
    assert.equal(byName.get("cjs.cjs")?.metadata.scriptKind, ts.ScriptKind.JS);

    // 型注釈付きの .mts が TS として構文エラーなしにパースされる
    const config = byName.get("config.mts")!;
    assert.equal(config.metadata.parseDiagnosticCount, 0);
    assert.ok(config.sourceFile.statements.length > 0);
    assert.equal(result.warnings.length, 0);
  });
});

test("FileScanner keeps a deterministic parsed order across runs on a 300-file project", async () => {
  await withTempDir("analyzer-many-files-", async (tempRoot) => {
    const expected: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const dir = path.join(tempRoot, "src", `feature${String(index % 12).padStart(2, "0")}`);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `Module${String(index).padStart(3, "0")}.ts`);
      await fs.writeFile(filePath, `export const value${index} = ${index};\n`, "utf8");
      expected.push(filePath);
    }
    expected.sort();

    const options = {
      excludePatterns: [],
      maxFileSizeBytes: 1024,
      cacheDir: path.join(tempRoot, ".cache"),
      enableCache: true,
    };

    const first = await new FileScanner(options).scanProject(tempRoot);
    const second = await new FileScanner(options).scanProject(tempRoot);

    assert.equal(first.parsed.length, 300);
    assert.equal(first.errors.length, 0);
    assert.deepEqual(first.parsed.map((entry) => entry.filePath), expected);
    assert.deepEqual(second.parsed.map((entry) => entry.filePath), first.parsed.map((entry) => entry.filePath));

    // 2 回目は mtime+size 一致でハッシュを再利用し、内容は参照されたときに初めて読む
    assert.equal(first.cacheStats.misses, 300);
    assert.equal(second.cacheStats.hits, 300);
    const sample = second.parsed[42]!;
    assert.equal(sample.metadata.sha256, first.parsed[42]!.metadata.sha256);
    assert.match(sample.sourceCode, /export const value\d+ = \d+;/u);
    assert.equal(sample.metadata.lineCount, 2);
    assert.equal(sample.metadata.hasTrailingNewline, true);
    assert.equal(sample.metadata.encoding, "utf-8");
    assert.equal(sample.sourceFile.statements.length, 1);
  });
});

test("FileScanner reports duplicate symlink targets as duplicates and only ancestors as cycles", async () => {
  await withTempDir("analyzer-symlink-dup-", async (tempRoot) => {
    await fs.mkdir(path.join(tempRoot, "src", "shared"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "shared", "util.ts"), "export const util = 1;\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => null;\n", "utf8");
    // 既に走査した兄弟ディレクトリを指すリンク (重複) と、祖先を指すリンク (循環)
    await fs.symlink(path.join(tempRoot, "src", "shared"), path.join(tempRoot, "src", "zz-shared-alias"));
    await fs.symlink(tempRoot, path.join(tempRoot, "src", "zz-up"));

    const scanner = new FileScanner({
      excludePatterns: [],
      maxFileSizeBytes: 1024,
      cacheDir: path.join(tempRoot, ".cache"),
      enableCache: false,
    });

    for (let run = 0; run < 2; run += 1) {
      const result = await scanner.scanProject(tempRoot);
      const reasons = new Map(result.skipped.map((entry) => [path.basename(entry.filePath), entry.reason]));

      assert.equal(result.parsed.length, 2, "files reached through the duplicate link are not parsed twice");
      assert.equal(reasons.get("zz-shared-alias"), "Duplicate symlink target");
      assert.equal(reasons.get("zz-up"), "Directory cycle detected");
      assert.ok(!result.skipped.some((entry) => entry.filePath.endsWith("zz-shared-alias") && /cycle/u.test(entry.reason)));
      assert.ok(
        result.skipped.every((entry) => entry.reason !== "Symlink cycle detected"),
        "seenSymlinks is reset per scan, so the second run does not misreport the links",
      );
    }
  });
});

test("FileScanner surfaces an invalid exclude regex as a warning instead of silently escaping it", async () => {
  await withTempDir("analyzer-bad-regex-", async (tempRoot) => {
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => null;\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "legacy[.ts"), "export const legacy = 1;\n", "utf8");

    const scanner = new FileScanner({
      excludePatterns: ["src/legacy[", "^src/other/"],
      maxFileSizeBytes: 1024,
      cacheDir: path.join(tempRoot, ".cache"),
      enableCache: false,
    });
    const result = await scanner.scanProject(tempRoot);

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /src\/legacy\[/u);
    assert.match(result.warnings[0] ?? "", /正規表現として不正/u);
    assert.equal(result.errors.length, 0);
    // 文字列そのままの一致にはなる
    assert.ok(result.skipped.some((entry) => entry.filePath.endsWith("legacy[.ts") && entry.reason === "Excluded pattern match"));
    assert.deepEqual(result.parsed.map((entry) => path.basename(entry.filePath)), ["App.tsx"]);
  });
});
