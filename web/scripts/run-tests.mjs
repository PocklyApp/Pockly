/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the web unit tests.
 *
 * Why this exists instead of `tsx --test "src/**\/*.test.ts"`:
 *
 *   - Shell globbing is not portable. zsh expands `**` recursively, the `sh`
 *     that npm uses on Linux does not, and cmd.exe does not glob at all. A
 *     pattern that works on one contributor's machine silently fails or
 *     under-matches on another's.
 *   - Quoting the pattern to let the runtime expand it needs Node 22. This
 *     package supports Node 20, where `--test` accepts no globs and does not
 *     discover `.ts` files by directory.
 *
 * Enumerating in Node sidesteps all of that: same file list on every shell,
 * every platform, and every supported Node version.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(webRoot, "src");

const testFiles = readdirSync(sourceDir, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith(".test.ts"))
  // Normalize Windows separators so the runner receives POSIX-style paths.
  .map((entry) => join("src", entry).split("\\").join("/"))
  .sort();

if (testFiles.length === 0) {
  console.error("web/scripts/run-tests.mjs: found no *.test.ts files under src/");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles, ...process.argv.slice(2)],
  { cwd: webRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(`web/scripts/run-tests.mjs: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
