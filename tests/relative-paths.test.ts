import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyFileType,
  ConfigManager,
  FileScanner,
  shouldIncludeInAnalysisScope,
  toProjectRelativePath,
} from "../src/core/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sampleProject = path.join(workspaceRoot, "tests", "fixtures", "sample-app");

function createDefaultScanner(tempRoot: string, excludePatterns?: string[]): FileScanner {
  const config = new ConfigManager().getDefaults();
  return new FileScanner({
    excludePatterns: excludePatterns ?? config.excludePatterns,
    maxFileSizeBytes: config.maxFileSizeBytes,
    cacheDir: path.join(tempRoot, ".cache"),
    enableCache: false,
    analysisScope: config.analysisScope,
  });
}

test("FileScanner does not apply default exclude groups to directories above the project root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-relative-exclude-"));
  try {
    // プロジェクト自体が build/ 配下にあっても、既定の build 除外に巻き込まれない
    const projectRoot = path.join(tempRoot, "build", "app");
    // 他のテストが fixture 直下へ書き出す .cache や一時出力を巻き込まないよう、
    // ソースと tsconfig だけをコピーする
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.cp(path.join(sampleProject, "src"), path.join(projectRoot, "src"), { recursive: true });
    await fs.copyFile(path.join(sampleProject, "tsconfig.json"), path.join(projectRoot, "tsconfig.json"));

    const result = await createDefaultScanner(tempRoot).scanProject(projectRoot);

    assert.equal(result.errors.length, 0);
    assert.equal(result.parsed.length, 4);
    const parsedPaths = result.parsed.map((file) => file.filePath.split(path.sep).join("/")).sort();
    assert.deepEqual(
      parsedPaths.map((filePath) => path.posix.relative(projectRoot.split(path.sep).join("/"), filePath)),
      ["src/App.tsx", "src/components/Button.tsx", "src/lazy.ts", "src/utils/helper.ts"],
    );
    assert.ok(!result.skipped.some((entry) => entry.reason === "Excluded pattern match"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("FileScanner matches exclude patterns against project-relative paths", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-relative-patterns-"));
  try {
    const projectRoot = path.join(tempRoot, "proj");
    await fs.mkdir(path.join(projectRoot, "src", "build"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "src", "legacy"), { recursive: true });
    await fs.mkdir(path.join(projectRoot, "src", "components"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const index = 1;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "src", "build", "x.ts"), "export const x = 1;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "src", "legacy", "old.ts"), "export const old = 1;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "src", "components", "Button.tsx"), "export const Button = () => null;\n", "utf8");

    // 既定グループ: src/build は build-output グループに一致して除外される (ドキュメント化された挙動)
    const defaultResult = await createDefaultScanner(tempRoot).scanProject(projectRoot);
    const defaultParsed = defaultResult.parsed.map((file) => file.filePath.split(path.sep).join("/"));
    assert.ok(!defaultParsed.some((filePath) => filePath.endsWith("src/build/x.ts")));
    assert.ok(defaultParsed.some((filePath) => filePath.endsWith("src/legacy/old.ts")));

    const buildSkip = defaultResult.skipped.find((entry) => entry.reason === "Excluded pattern match");
    assert.ok(buildSkip, "src/build should be recorded in skipped");
    assert.equal(buildSkip.isDirectory, true);
    assert.equal(
      path.relative(projectRoot, buildSkip.filePath).split(path.sep).join("/"),
      "src/build",
    );

    // ユーザー定義 excludePatterns: 先頭アンカー付きの相対パスパターンが効く
    const userResult = await createDefaultScanner(tempRoot, ["^src/legacy/"]).scanProject(projectRoot);
    const userParsed = userResult.parsed.map((file) => file.filePath.split(path.sep).join("/"));
    assert.ok(!userParsed.some((filePath) => filePath.endsWith("src/legacy/old.ts")));
    assert.ok(userParsed.some((filePath) => filePath.endsWith("src/build/x.ts")));
    assert.ok(userParsed.some((filePath) => filePath.endsWith("src/components/Button.tsx")));
    assert.ok(userResult.skipped.some((entry) =>
      entry.reason === "Excluded pattern match"
      && path.relative(projectRoot, entry.filePath).split(path.sep).join("/") === "src/legacy/old.ts"
    ));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("FileScanner applies source-only scope relative to the project root", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-relative-scope-"));
  try {
    // "tests" という上位ディレクトリ名がスコープ判定に混入しない
    const projectRoot = path.join(tempRoot, "tests", "proj");
    await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(projectRoot, "src", "index.ts"), "export const index = 1;\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "src", "index.test.ts"), "export const t = 1;\n", "utf8");

    const config = new ConfigManager().getDefaults();
    const scanner = new FileScanner({
      excludePatterns: config.excludePatterns,
      maxFileSizeBytes: config.maxFileSizeBytes,
      cacheDir: path.join(tempRoot, ".cache"),
      enableCache: false,
      analysisScope: "source-only",
    });
    const result = await scanner.scanProject(projectRoot);

    assert.equal(result.parsed.length, 1);
    assert.match(result.parsed[0]?.filePath ?? "", /src[\\/]index\.ts$/u);
    assert.ok(result.skipped.some((entry) =>
      entry.reason.startsWith("Excluded by analysis scope") && /index\.test\.ts$/u.test(entry.filePath)
    ));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("shouldIncludeInAnalysisScope ignores directories above the project root", () => {
  assert.equal(
    shouldIncludeInAnalysisScope("/home/me/tests/proj/src/index.ts", "source-only", "/home/me/tests/proj"),
    true,
  );
  assert.equal(
    shouldIncludeInAnalysisScope("/home/me/tests/proj/src/index.test.ts", "source-only", "/home/me/tests/proj"),
    false,
  );
  assert.equal(
    shouldIncludeInAnalysisScope("/home/me/tests/proj/src/index.ts", "all", "/home/me/tests/proj"),
    true,
  );
});

test("classifyFileType yields the same result for absolute and project-relative paths", () => {
  assert.equal(
    classifyFileType("/root/proj/src/App.tsx", { projectRoot: "/root/proj" }),
    classifyFileType("src/App.tsx"),
  );
  assert.equal(
    classifyFileType("/root/proj/src/components/Button.tsx", { projectRoot: "/root/proj" }),
    "UI component",
  );
  assert.equal(
    classifyFileType("/home/me/tests/proj/src/utils/format.ts", { projectRoot: "/home/me/tests/proj" }),
    "Utils",
  );
  // projectRoot 外の絶対パスは basename だけで判定し、上位ディレクトリ名を使わない
  assert.equal(
    classifyFileType("/home/me/tests/other/src/utils/format.ts", { projectRoot: "/home/me/tests/proj" }),
    classifyFileType("format.ts"),
  );
});

test("toProjectRelativePath normalizes separators and strips parent directories", () => {
  assert.equal(toProjectRelativePath("/root/proj/src/App.tsx", "/root/proj"), "src/App.tsx");
  assert.equal(toProjectRelativePath("src/App.tsx"), "src/App.tsx");
  assert.equal(toProjectRelativePath("./src/App.tsx"), "src/App.tsx");
  assert.equal(toProjectRelativePath("src\\components\\Button.tsx"), "src/components/Button.tsx");
  assert.equal(toProjectRelativePath("/elsewhere/tests/App.test.tsx", "/root/proj"), "App.test.tsx");
  assert.equal(toProjectRelativePath("/elsewhere/tests/App.test.tsx"), "App.test.tsx");
});
