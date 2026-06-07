/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Read tool spec.
//
// File-path-as-header pattern. We do NOT show the file contents in
// the body because Read results are typically large and the user
// already knows what they asked to read; the raw block is available
// on expand. Adds a "lines" row when the daemon reports a count
// (derived from result line count when input.limit is absent).

import { compactPath, countNonEmptyLines, numberField, stringField } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

function basename(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

export const readSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "read",
  display: (input, payload, result) => {
    const file = stringField(input, ["file_path", "path", "filename", "file"]);
    const explicitLimit = numberField(input, ["limit", "lines"]);
    const offset = numberField(input, ["offset"]);
    const rows: ToolRow[] = [];
    if (file) rows.push({ key: "file", value: compactPath(file) });
    const lineCount = explicitLimit || (result ? countNonEmptyLines(result) : 0);
    if (lineCount > 0) rows.push({ key: "lines", value: String(lineCount) });
    // Narrative-card label: "Read <basename>" + optional "(start-end)"
    // line range when the agent passed offset/limit. Matches Claude's
    // "Read App.tsx (7990-8084)" pattern.
    const running = !payload.has_result && !payload._paired_result;
    const verb = running ? "Reading" : "Read";
    let narrativeLabel = file ? `${verb} ${basename(file)}` : `${verb} a file`;
    if (offset && explicitLimit) {
      narrativeLabel += ` (${offset}-${offset + explicitLimit - 1})`;
    } else if (offset) {
      narrativeLabel += ` (from line ${offset})`;
    }
    return {
      name: "Read",
      icon: "file",
      headerArg: file ? compactPath(file) : "",
      body: "rows-and-raw",
      rows,
      stateLabel: lineCount > 0 && result ? `${lineCount} lines` : "",
      narrativeLabel,
    };
  },
};
