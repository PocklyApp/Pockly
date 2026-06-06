/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { newConvDirCandidates } from "./App";

test("new conversation defaults to the current session's cwd first", () => {
  assert.deepEqual(
    newConvDirCandidates("/Users/me/proj", "/Users/me/other"),
    ["/Users/me/proj", "/Users/me/other"],
  );
});

test("falls back to the remembered dir when there's no current session cwd", () => {
  assert.deepEqual(newConvDirCandidates("", "/Users/me/other"), ["/Users/me/other"]);
});

test("de-duplicates when current cwd equals the remembered dir", () => {
  assert.deepEqual(newConvDirCandidates("/Users/me/proj", "/Users/me/proj"), ["/Users/me/proj"]);
});

test("returns [] when neither is set (caller uses the daemon default)", () => {
  assert.deepEqual(newConvDirCandidates("", ""), []);
});
