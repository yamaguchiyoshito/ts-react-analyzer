import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigManager, FileScanner } from "../src/core/index.js";

test("FileScanner skips excluded, oversized, and symlink-cycle entries", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-scan-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, ".next"), { recursive: true });

  await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => <div />;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, ".next", "ignored.tsx"), "export const Ignored = 1;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "src", "Large.ts"), "x".repeat(128), "utf8");
  await fs.symlink(tempRoot, path.join(tempRoot, "loop"));

  const scanner = new FileScanner({
    excludePatterns: ["(?:^|[/\\\\])\\.next(?:$|[/\\\\])"],
    maxFileSizeBytes: 64,
    cacheDir: path.join(tempRoot, ".cache"),
    enableCache: true,
  });

  const result = await scanner.scanProject(tempRoot);

  assert.equal(result.parsed.length, 1);
  assert.match(result.parsed[0]?.filePath ?? "", /App\.tsx$/u);
  assert.ok(result.skipped.some((entry) => entry.reason.includes("Excluded pattern")));
  assert.ok(result.skipped.some((entry) => entry.reason.includes("File size exceeds")));
  assert.ok(result.skipped.some((entry) => /cycle/u.test(entry.reason)));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("FileScanner excludes storybook-static assets by default", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-storybook-assets-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "storybook-static", "assets"), { recursive: true });

  await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => <div />;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "storybook-static", "assets", "chunk.ts"), "export const Chunk = 1;\n", "utf8");

  const config = new ConfigManager().getDefaults();
  const scanner = new FileScanner({
    excludePatterns: config.excludePatterns,
    maxFileSizeBytes: config.maxFileSizeBytes,
    cacheDir: path.join(tempRoot, ".cache"),
    enableCache: false,
  });

  const result = await scanner.scanProject(tempRoot);

  assert.equal(result.parsed.length, 1);
  assert.match(result.parsed[0]?.filePath ?? "", /src\/App\.tsx$/u);
  assert.ok(result.skipped.some((entry) =>
    entry.filePath.replace(/\\/gu, "/").endsWith("storybook-static/assets")
      && entry.reason.includes("Excluded pattern")
      && entry.isDirectory
  ));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("FileScanner applies source-only scope before parsing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-source-only-scan-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });

  await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => <div />;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "src", "App.test.tsx"), "export const AppTest = () => null;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "src", "App.stories.tsx"), "export const Primary = {};\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "vite.config.ts"), "export default {};\n", "utf8");

  const scanner = new FileScanner({
    excludePatterns: [],
    maxFileSizeBytes: 1024,
    cacheDir: path.join(tempRoot, ".cache"),
    enableCache: false,
    analysisScope: "source-only",
  });

  const result = await scanner.scanProject(tempRoot);
  const parsedPaths = result.parsed.map((entry) => entry.filePath.replace(/\\/gu, "/"));

  assert.deepEqual(parsedPaths, [path.join(tempRoot, "src", "App.tsx").replace(/\\/gu, "/")]);
  assert.ok(result.skipped.some((entry) =>
    entry.filePath.replace(/\\/gu, "/").endsWith("/src/App.test.tsx")
      && entry.reason.includes("analysis scope")
  ));
  assert.ok(result.skipped.some((entry) =>
    entry.filePath.replace(/\\/gu, "/").endsWith("/src/App.stories.tsx")
      && entry.reason.includes("analysis scope")
  ));
  assert.ok(result.skipped.some((entry) =>
    entry.filePath.replace(/\\/gu, "/").endsWith("/vite.config.ts")
      && entry.reason.includes("analysis scope")
  ));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("ConfigManager exclude groups handle generic generated artifacts and optional package outputs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analyzer-exclude-groups-"));
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, ".firebase", "hosting"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "out"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "packages", "icons", "lib", "esm"), { recursive: true });

  await fs.writeFile(path.join(tempRoot, "src", "App.tsx"), "export const App = () => <div />;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, ".firebase", "hosting", "generated.tsx"), "export const Deploy = 1;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "out", "bundle.ts"), "export const Bundle = 1;\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "packages", "icons", "lib", "esm", "index.js"), "export const Icon = 1;\n", "utf8");

  const configManager = new ConfigManager();
  const defaultConfig = configManager.getDefaults();
  const defaultScanner = new FileScanner({
    excludePatterns: defaultConfig.excludePatterns,
    maxFileSizeBytes: defaultConfig.maxFileSizeBytes,
    cacheDir: path.join(tempRoot, ".cache-default"),
    enableCache: false,
  });

  const defaultResult = await defaultScanner.scanProject(tempRoot);
  const defaultPaths = defaultResult.parsed.map((item) => item.filePath.replace(/\\/gu, "/"));
  assert.equal(defaultPaths.length, 2);
  assert.ok(defaultPaths.some((entry) => entry.endsWith("/src/App.tsx")));
  assert.ok(defaultPaths.some((entry) => entry.endsWith("/packages/icons/lib/esm/index.js")));
  assert.ok(defaultResult.skipped.some((entry) => entry.filePath.replace(/\\/gu, "/").includes("/.firebase")));
  assert.ok(defaultResult.skipped.some((entry) => entry.filePath.replace(/\\/gu, "/").includes("/out")));

  const distributionConfig = configManager.mergeConfigs(
    configManager.getDefaults(),
    { excludeGroups: ["package-distribution"] },
  );
  const distributionScanner = new FileScanner({
    excludePatterns: distributionConfig.excludePatterns,
    maxFileSizeBytes: distributionConfig.maxFileSizeBytes,
    cacheDir: path.join(tempRoot, ".cache-distribution"),
    enableCache: false,
  });

  const distributionResult = await distributionScanner.scanProject(tempRoot);
  assert.equal(distributionResult.parsed.length, 1);
  assert.match(distributionResult.parsed[0]?.filePath ?? "", /src\/App\.tsx$/u);
  assert.ok(distributionResult.skipped.some((entry) =>
    entry.filePath.replace(/\\/gu, "/").includes("/packages/icons/lib/esm")
      && entry.reason.includes("Excluded pattern")
  ));

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("ConfigManager accepts quality profile and typecheck root limit from CLI and environment", () => {
  const configManager = new ConfigManager();
  const cliConfig = configManager.loadFromCLI({
    qualityProfile: "library-repo",
    maxTypeCheckRootNames: "1234",
  });
  const envConfig = configManager.loadFromEnvironment({
    ANALYZER_QUALITY_PROFILE: "application",
    ANALYZER_MAX_TYPECHECK_ROOT_NAMES: "4321",
  });

  const cliMerged = configManager.mergeConfigs(configManager.getDefaults(), cliConfig);
  const envMerged = configManager.mergeConfigs(configManager.getDefaults(), envConfig);

  assert.equal(cliMerged.qualityProfile, "library-repo");
  assert.equal(cliMerged.maxTypeCheckRootNames, 1234);
  assert.equal(envMerged.qualityProfile, "application");
  assert.equal(envMerged.maxTypeCheckRootNames, 4321);
});

test("ConfigManager merges partial test presence settings without dropping defaults", () => {
  const configManager = new ConfigManager();
  const merged = configManager.mergeConfigs(
    configManager.getDefaults(),
    {
      testPresenceSettings: {
        staticImportTraversalMaxDepth: 1,
        knownCallNames: ["scenario"],
      },
    } as unknown as ReturnType<ConfigManager["getDefaults"]>,
  );

  assert.equal(merged.testPresenceSettings.staticImportTraversalMaxDepth, 1);
  assert.deepEqual(merged.testPresenceSettings.knownCallNames, ["scenario"]);
  assert.equal(merged.testPresenceSettings.runtimeLineCoverageMinPercent, 0);
  assert.equal(merged.testPresenceSettings.thresholds.application.pass, 80);
  assert.equal(merged.testPresenceSettings.bucketWeights.route, 5);
});
