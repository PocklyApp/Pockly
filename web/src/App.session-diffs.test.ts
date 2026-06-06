/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SessionTurn } from "./api";
import { sessionDiffs } from "./App";

function toolCall(seq: number, tool: string, input: Record<string, unknown>): SessionTurn {
  return {
    session_id: "s",
    seq,
    agent: "claude-code",
    kind: "tool_call",
    timestamp: `2026-06-03T00:00:${String(seq).padStart(2, "0")}Z`,
    payload: { tool, id: `t${seq}`, input },
  };
}

test("sessionDiffs aggregates Edit/Write per file, ignoring non-edit tools", () => {
  const turns: SessionTurn[] = [
    toolCall(1, "Edit", { file_path: "/p/a.ts", old_string: "const x = 1", new_string: "const x = 2\nconst y = 3" }),
    toolCall(2, "Edit", { file_path: "/p/a.ts", old_string: "foo", new_string: "bar" }),
    toolCall(3, "Write", { file_path: "/p/b.ts", content: "line1\nline2\nline3" }),
    toolCall(4, "Bash", { command: "ls" }),
    toolCall(5, "Read", { file_path: "/p/c.ts" }),
  ];
  const diffs = sessionDiffs(turns);
  // a.ts (2 edits) + b.ts (write). Bash + Read are ignored.
  assert.equal(diffs.length, 2);

  const a = diffs[0];
  assert.equal(a.file, "/p/a.ts");
  assert.equal(a.pairs.length, 2, "two edits to a.ts accumulate");
  assert.ok(a.added >= 3 && a.removed >= 2, `a.ts counts: +${a.added} -${a.removed}`);

  const b = diffs[1];
  assert.equal(b.file, "/p/b.ts");
  // A fresh Write is (almost) all-additions; lineDiff treats the empty old
  // string as one phantom line, so removed is at most 1 — consistent with the
  // existing in-card diff rendering.
  assert.ok(b.removed <= 1, `Write removed: ${b.removed}`);
  assert.ok(b.added >= 3);
});

test("sessionDiffs returns [] when nothing was edited", () => {
  const turns: SessionTurn[] = [
    toolCall(1, "Read", { file_path: "/p/a.ts" }),
    toolCall(2, "Bash", { command: "go test ./..." }),
  ];
  assert.deepEqual(sessionDiffs(turns), []);
});

test("sessionDiffs strips an mcp__ prefix from the tool name", () => {
  const turns: SessionTurn[] = [
    toolCall(1, "mcp__fs__Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }),
  ];
  assert.equal(sessionDiffs(turns).length, 1);
});

// ── parseUnifiedDiff (real git diff → drawer files) ──
import { parseUnifiedDiff } from "./App";

test("parseUnifiedDiff: tracked change → file + add/remove counts + hunk lines", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "src/foo.ts");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.ok((files[0].lines ?? []).some((l) => l.kind === "meta" && l.text.startsWith("@@")));
  assert.ok((files[0].lines ?? []).some((l) => l.kind === "add" && l.text === "const b = 3;"));
});

test("parseUnifiedDiff: untracked file (--no-index /dev/null) → all-added", () => {
  const diff = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "new.txt");
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 0);
});

test("parseUnifiedDiff: deleted file → name from --- a/path", () => {
  const diff = [
    "diff --git a/gone.md b/gone.md",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/gone.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-was here",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, "gone.md");
  assert.equal(files[0].removed, 1);
});

test("parseUnifiedDiff: empty diff (clean tree, e.g. after commit) → no files", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
});
