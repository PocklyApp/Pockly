/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — Default tool spec (fallback).
//
// Matches every tool name; placed last in the registry. Implements
// the same heuristics the pre-registry primaryToolArg /
// toolDisplayName / toolStateLabel / toolRows used, so unknown tools
// (MCP servers, custom integrations) don't regress when the registry
// dispatch replaces the old inline code path.
//
// When a new tool comes up frequently enough that the default doesn't
// look right, write a dedicated spec rather than expanding the
// heuristics here.

import {
  compactPath,
  firstUsefulLine,
  numberField,
  stringField,
  titleCaseTool,
  truncateMiddle,
} from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const defaultSpec: ToolSpec = {
  match: (_name) => true,
  display: (input, payload, result) => {
    const toolName = payload.tool ?? "Tool";
    const file = stringField(input, ["file_path", "path", "filename", "file"]);
    const command = stringField(input, ["command", "cmd"]);
    const pattern = stringField(input, ["pattern", "query", "regex"]);
    const url = stringField(input, ["url", "endpoint"]);
    const cwd = stringField(input, ["cwd", "workdir"]);
    const lines = numberField(input, ["limit", "lines"]);

    // Pick the most informative arg to inline beside the tool name.
    let headerArg = "";
    if (file) headerArg = compactPath(file);
    else if (command) headerArg = truncateMiddle(command, 56);
    else if (pattern) headerArg = `"${truncateMiddle(pattern, 44)}"`;
    else if (url) headerArg = truncateMiddle(url, 56);
    else if (result) {
      const line = firstUsefulLine(result);
      if (line) headerArg = truncateMiddle(line, 56);
    }

    const rows: ToolRow[] = [];
    if (file) rows.push({ key: "file", value: compactPath(file) });
    if (command) rows.push({ key: "cmd", value: truncateMiddle(command, 72) });
    if (pattern) rows.push({ key: "pattern", value: truncateMiddle(pattern, 56) });
    if (cwd) rows.push({ key: "cwd", value: compactPath(cwd) });
    if (lines) rows.push({ key: "lines", value: String(lines) });
    if (rows.length === 0 && result) {
      rows.push({ key: "output", value: truncateMiddle(firstUsefulLine(result), 76) });
    }

    return {
      name: titleCaseTool(toolName),
      icon: "tool",
      headerArg,
      body: "rows-and-raw",
      rows,
      stateLabel: "",
    };
  },
};
