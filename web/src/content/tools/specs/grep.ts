/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — Grep spec.
//
// Header shows the pattern in quotes (the most informative arg);
// path or glob fall to a row. State label uses the existing
// countLikelyHits heuristic — exact match counts come from result
// shape, e.g. "12 hits" or "no matches".

import { compactPath, countLikelyHits, stringField, truncateMiddle } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const grepSpec: ToolSpec = {
  match: (name) => {
    const lower = name.toLowerCase();
    return lower === "grep" || lower === "search";
  },
  display: (input, _payload, result) => {
    const pattern = stringField(input, ["pattern", "query", "regex"]);
    const path = stringField(input, ["path", "file", "file_path"]);
    const glob = stringField(input, ["glob", "include"]);
    const rows: ToolRow[] = [];
    if (path) rows.push({ key: "path", value: compactPath(path) });
    if (glob) rows.push({ key: "glob", value: truncateMiddle(glob, 56) });
    const hits = result ? countLikelyHits(result) : 0;
    if (hits > 0) rows.push({ key: "hits", value: String(hits) });
    return {
      name: pattern ? `Grep "${truncateMiddle(pattern, 28)}"` : "Grep",
      icon: "search",
      headerArg: pattern ? `"${truncateMiddle(pattern, 44)}"` : "",
      body: "rows-and-raw",
      rows,
      stateLabel: result ? (hits > 0 ? `${hits} ${hits === 1 ? "hit" : "hits"}` : "no matches") : "",
    };
  },
};
