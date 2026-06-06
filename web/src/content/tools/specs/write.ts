/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — Write spec.
//
// Treated as Edit-with-empty-old: the existing extractEditPairs
// returns a synthetic pair (old="" vs new=content) so ToolDiffView
// renders the new content as an all-additions diff. That keeps the
// visual treatment consistent with Edit / MultiEdit (a file change
// always renders as a diff) and avoids dumping the entire new file
// as a raw block.

import { compactPath, extractEditPairs, stringField } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const writeSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "write",
  display: (input, _payload, _result) => {
    const file = stringField(input, ["file_path", "path", "filename", "file"]);
    const pairs = extractEditPairs("write", input);
    const rows: ToolRow[] = [];
    if (file) rows.push({ key: "file", value: compactPath(file) });
    const newContent = stringField(input, ["content", "new_string", "newText"]);
    const lineCount = newContent ? newContent.split("\n").length : 0;
    if (lineCount > 0) rows.push({ key: "lines", value: String(lineCount) });
    return {
      name: "Write",
      icon: "edit",
      headerArg: file ? compactPath(file) : "",
      body: pairs.length > 0 ? "diff" : "rows-and-raw",
      rows,
      stateLabel: lineCount > 0 ? `+${lineCount}` : "",
    };
  },
};
