/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Bash tool spec.
//
// Matches Claude Code's built-in Bash plus a couple of common
// equivalents from other agents (Codex's `exec_command`, generic
// "shell"). All three share the {command, description?} input shape,
// so a single spec works.
//
// body="command" makes ToolCallCard mount a dedicated terminal-styled block.
// The cwd / description fields stay in `rows` so the header summary stays
// one-liner-shaped while the body shows the command without truncation.

import { stringField, truncateMiddle } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const bashSpec: ToolSpec = {
  match: (name) => {
    const lower = name.toLowerCase();
    return lower === "bash" || lower === "exec_command" || lower === "shell";
  },
  display: (input, payload, _result) => {
    const desc = stringField(input, ["description"]);
    const cwd = stringField(input, ["cwd", "workdir"]);
    const command = stringField(input, ["command", "cmd"]);
    const rows: ToolRow[] = [];
    // No "cmd" row — the command lives in the dedicated terminal
    // body for body="command". Keep cwd / desc as supplementary
    // metadata.
    if (desc) rows.push({ key: "desc", value: truncateMiddle(desc, 56) });
    if (cwd) rows.push({ key: "cwd", value: cwd });
    // Sentence-style row label for narrative cards. Prefers the
    // agent's own `description` ("List current directory") so the row
    // reads like a TL;DR; falls back to the command head or a generic
    // "Ran a command" when neither is available.
    const running = !payload.has_result && !payload._paired_result;
    const verb = running ? "Running" : "Ran";
    let narrativeLabel: string;
    if (desc) {
      narrativeLabel = `${verb} ${desc}`;
    } else if (command) {
      narrativeLabel = `${verb} ${truncateMiddle(command, 48)}`;
    } else {
      narrativeLabel = `${verb} a command`;
    }
    return {
      name: "Bash",
      icon: "terminal",
      headerArg: command ? truncateMiddle(command, 56) : "",
      body: "command",
      rows,
      stateLabel: "",
      narrativeLabel,
    };
  },
};
