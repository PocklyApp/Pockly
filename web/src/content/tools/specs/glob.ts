/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — Glob spec.
//
// Similar to Grep but the pattern IS a glob (not a regex). Result is
// a newline-separated file list; we surface the file count as the
// state label.

import { compactPath, countNonEmptyLines, stringField, truncateMiddle } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const globSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "glob",
  display: (input, _payload, result) => {
    const pattern = stringField(input, ["pattern", "glob"]);
    const path = stringField(input, ["path", "cwd"]);
    const rows: ToolRow[] = [];
    if (path) rows.push({ key: "path", value: compactPath(path) });
    const matchCount = result ? countNonEmptyLines(result) : 0;
    if (matchCount > 0) rows.push({ key: "files", value: String(matchCount) });
    return {
      name: "Glob",
      icon: "search",
      headerArg: pattern ? truncateMiddle(pattern, 56) : "",
      body: "rows-and-raw",
      rows,
      stateLabel: result ? `${matchCount} ${matchCount === 1 ? "file" : "files"}` : "",
    };
  },
};
