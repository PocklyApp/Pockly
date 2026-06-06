/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { langForPath, parseCodeLines } from "./App";

test("langForPath maps known extensions to highlight.js languages", () => {
  assert.equal(langForPath("src/pairing/PairingService.ts"), "typescript");
  assert.equal(langForPath("a/b/c.tsx"), "typescript");
  assert.equal(langForPath("main.go"), "go");
  assert.equal(langForPath("script.py"), "python");
  assert.equal(langForPath("styles.css"), "css");
  assert.equal(langForPath("index.html"), "xml");
  assert.equal(langForPath("config.YAML"), "yaml");
  assert.equal(langForPath("run.sh"), "bash");
});

test("langForPath returns '' for unknown or missing extensions", () => {
  assert.equal(langForPath("Makefile"), "");
  assert.equal(langForPath("data.bin"), "");
  assert.equal(langForPath(""), "");
  assert.equal(langForPath("/no/extension/here"), "");
});

test("parseCodeLines strips Claude's Read line-number prefixes", () => {
  const lines = parseCodeLines("1\timport x\n2\t\n3\texport const y = 1");
  assert.deepEqual(lines, [
    { num: 1, text: "import x" },
    { num: 2, text: "" },
    { num: 3, text: "export const y = 1" },
  ]);
});

test("parseCodeLines falls back to sequential numbers for un-prefixed code", () => {
  const lines = parseCodeLines("const a = 1\nconst b = 2\n");
  assert.deepEqual(lines, [
    { num: 1, text: "const a = 1" },
    { num: 2, text: "const b = 2" },
  ]);
});

test("parseCodeLines keeps real line numbers even with a gap (range read)", () => {
  const lines = parseCodeLines("42\texport class Foo {\n43\t  bar() {}\n44\t}");
  assert.deepEqual(lines.map((l) => l.num), [42, 43, 44]);
});
