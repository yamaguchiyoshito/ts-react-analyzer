import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileScanner } from "../src/core/index.js";

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
