import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigManager, DependencyAnalyzer, FileScanner, TypeCheckAnalyzer, resolveTsConfigLeaves } from "../src/core/index.js";

interface SolutionProject {
  projectRoot: string;
  rootTsConfigPath: string;
  appTsConfigPath: string;
  appFilePath: string;
  buttonFilePath: string;
}

// Vite / Next テンプレートと同じ solution 型 tsconfig (files: [] + references) を持つ一時プロジェクトを作る
async function createSolutionProject(prefix: string): Promise<SolutionProject> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const componentsDir = path.join(projectRoot, "src", "components");
  await fs.mkdir(componentsDir, { recursive: true });

  const rootTsConfigPath = path.join(projectRoot, "tsconfig.json");
  const appTsConfigPath = path.join(projectRoot, "tsconfig.app.json");
  const appFilePath = path.join(projectRoot, "src", "App.tsx");
  const buttonFilePath = path.join(componentsDir, "Button.tsx");

  await fs.writeFile(rootTsConfigPath, JSON.stringify({
    files: [],
    references: [{ path: "./tsconfig.app.json" }],
  }, null, 2), "utf8");
  await fs.writeFile(appTsConfigPath, JSON.stringify({
    compilerOptions: {
      strict: true,
      jsx: "react-jsx",
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    },
    include: ["src"],
  }, null, 2), "utf8");
  await fs.writeFile(buttonFilePath, "export const Button = () => null;\n", "utf8");
  await fs.writeFile(appFilePath, [
    "import { Button } from \"@/components/Button\";",
    "export const App = () => Button;",
    "const n: number = \"oops\";",
    "",
  ].join("\n"), "utf8");

  return { projectRoot, rootTsConfigPath, appTsConfigPath, appFilePath, buttonFilePath };
}

async function scanFile(projectRoot: string, filePath: string) {
  const scanner = new FileScanner({
    excludePatterns: [],
    maxFileSizeBytes: 1024 * 1024,
    cacheDir: path.join(projectRoot, ".cache"),
    enableCache: false,
  });
  const scanResult = await scanner.scanProject(projectRoot);
  const parsedFile = scanResult.parsed.find((file) => file.filePath === filePath);
  assert.ok(parsedFile, `scanned file not found: ${filePath}`);
  return parsedFile!;
}

test("resolveTsConfigLeaves follows project references of a solution-style tsconfig", async () => {
  const project = await createSolutionProject("analyzer-solution-leaves-");
  try {
    const resolution = resolveTsConfigLeaves(project.rootTsConfigPath);

    assert.equal(resolution.isSolution, true);
    assert.deepEqual(resolution.leaves.map((leaf) => leaf.tsConfigPath), [project.appTsConfigPath]);
    assert.ok(resolution.leaves[0]!.fileNameSet.has(project.appFilePath));
    assert.ok(resolution.leaves[0]!.fileNameSet.has(project.buttonFilePath));

    const plain = resolveTsConfigLeaves(project.appTsConfigPath);
    assert.equal(plain.isSolution, false);
    assert.deepEqual(plain.leaves.map((leaf) => leaf.tsConfigPath), [project.appTsConfigPath]);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("resolveTsConfigLeaves terminates on circular project references", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-solution-cycle-"));
  try {
    const first = path.join(projectRoot, "tsconfig.json");
    const second = path.join(projectRoot, "tsconfig.other.json");
    await fs.writeFile(first, JSON.stringify({ files: [], references: [{ path: "./tsconfig.other.json" }] }), "utf8");
    await fs.writeFile(second, JSON.stringify({ files: [], references: [{ path: "./tsconfig.json" }] }), "utf8");

    const resolution = resolveTsConfigLeaves(first);
    assert.equal(resolution.isSolution, true);
    assert.equal(resolution.leaves.length, 0);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("DependencyAnalyzer resolves aliases through a solution-style tsconfig", async () => {
  const project = await createSolutionProject("analyzer-solution-deps-");
  try {
    const appFile = await scanFile(project.projectRoot, project.appFilePath);
    const analyzer = new DependencyAnalyzer(project.projectRoot, {});
    const extracted = analyzer.extractDependencies(appFile.sourceFile, appFile.filePath);

    assert.equal(extracted.internalCount, 1);
    assert.equal(extracted.externalCount, 0);
    assert.equal(extracted.dependencies[0]?.isExternal, false);
    assert.equal(extracted.dependencies[0]?.target, project.buttonFilePath);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("ConfigManager.loadFromTSConfig reads compiler options from the referenced leaf config", async () => {
  const project = await createSolutionProject("analyzer-solution-config-");
  try {
    const loaded = new ConfigManager().loadFromTSConfig(project.rootTsConfigPath);

    assert.equal(loaded.tsConfigPath, project.rootTsConfigPath);
    assert.equal(loaded.tsCompilerOptions?.strict, true);
    assert.deepEqual(loaded.pathMappings, { "@/*": ["src/*"] });
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("TypeCheckAnalyzer type-checks the leaf configs of a solution-style tsconfig", async () => {
  const project = await createSolutionProject("analyzer-solution-typecheck-");
  try {
    const summary = new TypeCheckAnalyzer().analyzeProject(project.projectRoot, project.rootTsConfigPath, {
      includedFilePaths: [project.appFilePath, project.buttonFilePath],
    });

    assert.equal(summary.skippedReason, undefined);
    assert.equal(summary.checkedFiles, 2);
    assert.equal(summary.totalErrors, 1);
    assert.equal(summary.issues[0]?.filePath, project.appFilePath);
    assert.equal(summary.issues[0]?.code, 2322);
    assert.equal(summary.tsConfigPath, project.rootTsConfigPath);
    assert.equal(summary.strictnessSummary?.configCount, 1);
    assert.equal(summary.strictnessSummary?.strictConfigCount, 1);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("TypeCheckAnalyzer degrades to a skipped summary when the type check throws", async () => {
  const project = await createSolutionProject("analyzer-typecheck-throw-");
  try {
    // cacheDir に通常ファイルを指定すると増分検査の準備 (mkdir) が例外を投げる
    const cacheDirAsFile = path.join(project.projectRoot, "not-a-directory");
    await fs.writeFile(cacheDirAsFile, "", "utf8");

    const summary = new TypeCheckAnalyzer().analyzeProject(project.projectRoot, project.appTsConfigPath, {
      cacheDir: cacheDirAsFile,
    });

    assert.equal(summary.totalErrors, 0);
    assert.equal(summary.checkedFiles, 0);
    assert.deepEqual(summary.issues, []);
    assert.ok(summary.skippedReason);
    assert.match(summary.skippedReason!, /型検査をスキップしました/u);
  } finally {
    await fs.rm(project.projectRoot, { recursive: true, force: true });
  }
});

test("DependencyAnalyzer falls back to configured pathMappings when tsconfig has no paths", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-path-mappings-"));
  try {
    const componentsDir = path.join(projectRoot, "src", "components");
    await fs.mkdir(componentsDir, { recursive: true });
    const appFilePath = path.join(projectRoot, "src", "App.tsx");
    const buttonFilePath = path.join(componentsDir, "Button.tsx");
    await fs.writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { jsx: "react-jsx", strict: true },
      include: ["src"],
    }), "utf8");
    await fs.writeFile(buttonFilePath, "export const Button = () => null;\n", "utf8");
    await fs.writeFile(appFilePath, "import { Button } from \"@/components/Button\";\nexport const App = () => Button;\n", "utf8");

    const appFile = await scanFile(projectRoot, appFilePath);

    const withoutMappings = new DependencyAnalyzer(projectRoot, {});
    const unresolved = withoutMappings.extractDependencies(appFile.sourceFile, appFile.filePath);
    assert.equal(unresolved.dependencies[0]?.isExternal, true);

    const withMappings = new DependencyAnalyzer(projectRoot, {}, { pathMappings: { "@/*": ["src/*"] } });
    const resolved = withMappings.extractDependencies(appFile.sourceFile, appFile.filePath);
    assert.equal(resolved.internalCount, 1);
    assert.equal(resolved.externalCount, 0);
    assert.equal(resolved.dependencies[0]?.target, buttonFilePath);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
