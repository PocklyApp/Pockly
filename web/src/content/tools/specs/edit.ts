/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Edit / MultiEdit / ApplyPatch spec.
//
// All three are line-diff producers; they share enough input shape
// (file_path + old/new strings, or edits[] for MultiEdit) that one
// spec covers them. The actual diff extraction stays in App.tsx's
// existing extractEditPairs() — this spec just selects body="diff"
// and ToolCallCard renders <ToolDiffView pairs={...} />.

import { compactPath, editDelta, extractEditPairs, stringField } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const editSpec: ToolSpec = {
  match: (name) => {
    const lower = name.toLowerCase();
    return (
      lower === "edit" ||
      lower === "multiedit" ||
      lower === "applypatch" ||
      lower === "str_replace_editor" ||
      lower === "str_replace_based_edit_tool"
    );
  },
  display: (input, payload, result) => {
    const file = stringField(input, ["file_path", "path", "filename", "file"]);
    // Pass the REAL tool name through. extractEditPairs branches on
    // lowercased tool name: "multiedit" reads input.edits[], others
    // read old_string/new_string. Hard-coding "edit" here meant
    // MultiEdit calls returned [] (no old_string), the spec then fell
    // back to body="rows-and-raw", and ToolCallCard's downstream
    // extractEditPairs(toolName) was never consulted because that
    // branch is gated on display.body === "diff".
    const pairs = extractEditPairs(payload.tool ?? "", input);
    const rows: ToolRow[] = [];
    if (file) rows.push({ key: "file", value: compactPath(file) });
    if (pairs.length > 1) rows.push({ key: "edits", value: String(pairs.length) });
    const delta = result ? editDelta(input, result) : "";
    return {
      name: "Edit",
      icon: "edit",
      headerArg: file ? compactPath(file) : "",
      body: pairs.length > 0 ? "diff" : "rows-and-raw",
      rows,
      stateLabel: delta,
    };
  },
};
