/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-tool registry unit tests.
//
// These are PURE function tests (specs return data, no React) — the
// goal is to lock in the wire-shape mapping for each supported tool so future
// spec edits can't silently drop a field or regress the rows order. Visual
// rendering is verified separately via the browser fixture.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolveToolSpec } from "./registry";
import type { ToolPayload } from "../../App";

function payload(tool: string, input: unknown, extra: Partial<ToolPayload> = {}): ToolPayload {
  return { tool, input, ...extra } as ToolPayload;
}

describe("tool registry", () => {
  it("Bash -> terminal icon + command headerArg + command body", () => {
    const spec = resolveToolSpec("Bash");
    const out = spec.display({ command: "ls -la /tmp" }, payload("Bash", null), "");
    assert.equal(out.name, "Bash");
    assert.equal(out.icon, "terminal");
    assert.equal(out.headerArg, "ls -la /tmp");
    // body=command mounts the terminal-styled block.
    assert.equal(out.body, "command");
    // cmd is no longer a row because it lives in the terminal block; desc / cwd
    // still get rows when present.
    assert.equal(out.rows.find((r) => r.key === "cmd"), undefined);
  });

  it("Bash with description + cwd surfaces both as rows", () => {
    const spec = resolveToolSpec("Bash");
    const out = spec.display(
      { command: "ls", description: "list files", cwd: "/tmp" },
      payload("Bash", null),
      "",
    );
    const keys = out.rows.map((r) => r.key);
    assert.deepEqual(keys, ["desc", "cwd"]);
  });

  it("Read → file icon + compact path + lines from result", () => {
    const spec = resolveToolSpec("Read");
    const out = spec.display(
      { file_path: "/Users/me/project/src/very/deeply/nested/file.ts" },
      payload("Read", null),
      "line one\nline two\nline three\n",
    );
    assert.equal(out.icon, "file");
    // compactPath strips deep dirs to last 3 segments
    assert.match(out.headerArg, /nested\/file\.ts$/);
    assert.equal(out.stateLabel, "3 lines");
  });

  it("Edit → diff body + +/− state from result delta", () => {
    const spec = resolveToolSpec("Edit");
    const out = spec.display(
      { file_path: "/a/b.ts", old_string: "foo", new_string: "foo\nbar\nbaz" },
      payload("Edit", null),
      "+3 -1",
    );
    assert.equal(out.body, "diff");
    assert.equal(out.icon, "edit");
    assert.equal(out.stateLabel, "+3 −1");
  });

  it("MultiEdit and ApplyPatch resolve to the Edit spec", () => {
    assert.equal(resolveToolSpec("MultiEdit").display({}, payload("MultiEdit", null), "").icon, "edit");
    assert.equal(resolveToolSpec("ApplyPatch").display({}, payload("ApplyPatch", null), "").icon, "edit");
  });

  // Regression: the spec used to hard-code "edit" when calling
  // extractEditPairs, so MultiEdit's edits[] never produced diff pairs
  // and body silently fell back to rows-and-raw. Pass the real tool
  // name through and assert the diff body + edits row appear.
  it("MultiEdit with edits[] produces body='diff' and an edits row", () => {
    const spec = resolveToolSpec("MultiEdit");
    const out = spec.display(
      {
        file_path: "/a/b.ts",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "baz", new_string: "qux" },
          { old_string: "x",   new_string: "y" },
        ],
      },
      payload("MultiEdit", null),
      "",
    );
    assert.equal(out.body, "diff");
    assert.equal(out.icon, "edit");
    // "file" + "edits" rows; "edits" only appears when pairs.length > 1.
    const keys = out.rows.map((r) => r.key);
    assert.deepEqual(keys, ["file", "edits"]);
    const editsRow = out.rows.find((r) => r.key === "edits");
    assert.equal(editsRow?.value, "3");
  });

  it("Write → diff body with +N state label", () => {
    const spec = resolveToolSpec("Write");
    const out = spec.display(
      { file_path: "/a/b.ts", content: "line1\nline2\nline3" },
      payload("Write", null),
      "",
    );
    assert.equal(out.icon, "edit");
    assert.equal(out.stateLabel, "+3");
  });

  it("Grep → search icon + quoted pattern + hit count", () => {
    const spec = resolveToolSpec("Grep");
    const out = spec.display(
      { pattern: "TODO" },
      payload("Grep", null),
      "/a/b.ts: TODO fix\n/c/d.ts: TODO other\n",
    );
    assert.equal(out.name, 'Grep "TODO"');
    assert.equal(out.icon, "search");
    assert.equal(out.headerArg, '"TODO"');
    assert.equal(out.stateLabel, "2 hits");
  });

  it("Grep state shows 'no matches' when result is empty-ish", () => {
    const spec = resolveToolSpec("Grep");
    const out = spec.display({ pattern: "TODO" }, payload("Grep", null), "no matches found\n");
    assert.equal(out.stateLabel, "no matches");
  });

  it("Glob → search icon + file count", () => {
    const spec = resolveToolSpec("Glob");
    const out = spec.display(
      { pattern: "**/*.ts" },
      payload("Glob", null),
      "/a/b.ts\n/c/d.ts\n/e/f.ts\n",
    );
    assert.equal(out.icon, "search");
    assert.equal(out.headerArg, "**/*.ts");
    assert.equal(out.stateLabel, "3 files");
  });

  it("TodoWrite → todo body + done/total state", () => {
    const spec = resolveToolSpec("TodoWrite");
    const out = spec.display(
      {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "pending" },
        ],
      },
      payload("TodoWrite", null),
      "",
    );
    assert.equal(out.body, "todo");
    assert.equal(out.icon, "list");
    assert.equal(out.stateLabel, "1 / 3");
  });

  it("Task → agent icon + description as headerArg", () => {
    const spec = resolveToolSpec("Task");
    const out = spec.display(
      { description: "review the diff", prompt: "..." },
      payload("Task", null),
      "",
    );
    assert.equal(out.icon, "agent");
    assert.equal(out.headerArg, "review the diff");
  });

  it("ExitPlanMode -> plan body + 'awaiting approval' state", () => {
    const spec = resolveToolSpec("ExitPlanMode");
    const out = spec.display(
      { plan: "## Step 1\n\nFirst do this.\n\n## Step 2\n\nThen that." },
      payload("ExitPlanMode", null),
      "",
    );
    assert.equal(out.body, "plan");
    assert.equal(out.icon, "plan");
    assert.equal(out.stateLabel, "awaiting approval");
    // headerArg is the first non-empty line of the plan markdown
    assert.match(out.headerArg, /Step 1/);
  });

  it("ExitPlanMode with empty plan falls back to rows-and-raw", () => {
    const spec = resolveToolSpec("ExitPlanMode");
    const out = spec.display({}, payload("ExitPlanMode", null), "");
    assert.equal(out.body, "rows-and-raw");
    assert.equal(out.stateLabel, "");
  });

  // Regression: a resolved (approved/denied) plan card was stuck
  // showing "awaiting approval" forever. Spec now flips state to
  // "done" when payload.has_result / _paired_result / result is set,
  // so historical cards in the timeline read as completed.
  it("ExitPlanMode shows 'done' state once the call has a result", () => {
    const spec = resolveToolSpec("ExitPlanMode");
    // has_result on the payload — daemon marks this when the tool_result
    // block lands.
    const out1 = spec.display(
      { plan: "## Step 1\n\nFirst do this." },
      payload("ExitPlanMode", null, { has_result: true }),
      "",
    );
    assert.equal(out1.body, "plan");
    assert.equal(out1.stateLabel, "done");
    // _paired_result is the web's internal flag set by
    // mergeAdjacentToolPairs — also counts as resolved.
    const out2 = spec.display(
      { plan: "## Step 1" },
      payload("ExitPlanMode", null, { _paired_result: true }),
      "",
    );
    assert.equal(out2.stateLabel, "done");
    // Plain non-empty result text — same.
    const out3 = spec.display(
      { plan: "## Step 1" },
      payload("ExitPlanMode", null),
      "approved",
    );
    assert.equal(out3.stateLabel, "done");
  });

  it("AskUserQuestion → question body", () => {
    const spec = resolveToolSpec("AskUserQuestion");
    const out = spec.display(
      {
        questions: [
          { question: "Pick one", header: "h", multiSelect: false, options: [{ label: "A", description: "" }] },
        ],
      },
      payload("AskUserQuestion", null),
      "",
    );
    assert.equal(out.body, "question");
  });

  it("Unknown tools fall through to the default spec", () => {
    const spec = resolveToolSpec("mcp__notion__create_page");
    const out = spec.display({ title: "hello" }, payload("mcp__notion__create_page", null), "");
    assert.equal(out.icon, "tool");
    // titleCaseTool strips the mcp prefix
    assert.match(out.name, /create page/i);
  });

  it("Default spec uses output preview when no structured input fields exist", () => {
    const spec = resolveToolSpec("MysteryTool");
    const out = spec.display({}, payload("MysteryTool", null), "result line one\nmore stuff\n");
    assert.equal(out.headerArg, "result line one");
    // rows fall back to "output" key
    assert.equal(out.rows[0]?.key, "output");
  });
});
