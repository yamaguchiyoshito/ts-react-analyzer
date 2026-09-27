import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import { DependencyAnalyzer, GraphBuilder } from "../src/core/index.js";
import type { Dependency } from "../src/types/index.js";

const projectRoot = "/virtual";

function extract(filePath: string, source: string): Dependency[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return new DependencyAnalyzer(projectRoot, {}).extractDependencies(sourceFile, filePath).dependencies;
}

// cli.ts の buildArtifacts と同じ辺の追加規則: 外部依存と型のみ依存はグラフに載せない
function buildGraph(dependencies: Dependency[]): GraphBuilder {
  const graph = new GraphBuilder();
  for (const dependency of dependencies) {
    if (!dependency.isExternal && !dependency.isTypeOnly) {
      graph.addDependency(dependency.source, dependency.target, {
        type: dependency.type,
        isExternal: dependency.isExternal,
      });
    }
  }
  return graph;
}

test("DependencyAnalyzer marks `import type` and all-type named imports as type-only", () => {
  const dependencies = extract("/virtual/src/a.ts", [
    "import type { B } from './b';",
    "import { type C, type D } from './c';",
    "import type * as NS from './ns';",
    "export interface A { b: B; c: C; d: D; ns: NS.Value }",
  ].join("\n"));

  assert.equal(dependencies.length, 3);
  for (const dependency of dependencies) {
    assert.equal(dependency.isTypeOnly, true, `${dependency.modulePath} should be type-only`);
    assert.equal(dependency.isExternal, false);
  }
});

test("DependencyAnalyzer marks `export type { X } from` re-exports as type-only", () => {
  const dependencies = extract("/virtual/src/index.ts", [
    "export type { X } from './x';",
    "export { type Y } from './y';",
    "export { z } from './z';",
    "export * from './all';",
  ].join("\n"));

  const byModule = new Map(dependencies.map((dependency) => [dependency.modulePath, dependency]));
  assert.equal(byModule.get("./x")?.isTypeOnly, true);
  assert.equal(byModule.get("./y")?.isTypeOnly, true);
  assert.ok(!byModule.get("./z")?.isTypeOnly);
  assert.ok(!byModule.get("./all")?.isTypeOnly);
});

test("DependencyAnalyzer keeps mixed imports with a value binding as value dependencies", () => {
  const dependencies = extract("/virtual/src/a.ts", [
    "import { type A, b } from './b';",
    "import Default, { type C } from './c';",
    "import { d } from './d';",
    "export const use = () => [b, Default, d];",
  ].join("\n"));

  assert.equal(dependencies.length, 3);
  for (const dependency of dependencies) {
    assert.ok(!dependency.isTypeOnly, `${dependency.modulePath} should not be type-only`);
  }
});

test("type-only a<->b cycle does not produce a circular dependency in the graph", async () => {
  // 相対 import の解決先は実在ファイルから拡張子を補うため、実ファイルを置いて a.ts <-> b.ts を突き合わせる
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-type-only-cycle-"));
  try {
    const srcDir = path.join(projectRoot, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const aPath = path.join(srcDir, "a.ts");
    const bPath = path.join(srcDir, "b.ts");
    // 解決先の拡張子補完は実在確認に依存するため、両ファイルを書いてから抽出する
    const extractPair = async (aSource: string, bSource: string): Promise<Dependency[]> => {
      await fs.writeFile(aPath, aSource, "utf8");
      await fs.writeFile(bPath, bSource, "utf8");
      const analyzer = new DependencyAnalyzer(projectRoot, {});
      return [aPath, bPath].flatMap((filePath) => {
        const source = filePath === aPath ? aSource : bSource;
        const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        return analyzer.extractDependencies(sourceFile, filePath).dependencies;
      });
    };

    const typeOnlyDependencies = await extractPair(
      "import type { B } from './b';\nexport interface A { b: B }\n",
      "import { type A } from './a';\nexport interface B { a: A }\n",
    );

    assert.equal(typeOnlyDependencies.length, 2);
    assert.deepEqual(typeOnlyDependencies.map((dependency) => dependency.target), [bPath, aPath]);
    assert.ok(typeOnlyDependencies.every((dependency) => dependency.isTypeOnly === true));
    assert.equal(buildGraph(typeOnlyDependencies).detectCycles().length, 0);

    // 同じ形の値 import であれば循環として検出される (規則が辺の除外によるものであることの対照)
    const valueDependencies = await extractPair(
      "import { b } from './b';\nexport const a = () => b;\n",
      "import { a } from './a';\nexport const b = () => a;\n",
    );
    assert.ok(valueDependencies.every((dependency) => !dependency.isTypeOnly));
    assert.equal(buildGraph(valueDependencies).detectCycles().length, 1);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
