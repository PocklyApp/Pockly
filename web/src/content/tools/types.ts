/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-tool config registry types.
//
// A ToolSpec is a pure function bundle that turns a tool_call payload
// into ToolDisplay metadata. The rendering component (ToolCallCard in
// App.tsx) reads ToolDisplay.body to pick which body component to
// mount, then passes the spec's rows / headerArg / stateLabel down.
//
// Specs hold NO React — they're pure TS, unit-testable without DOM.
// React presentation lives in App.tsx where the existing primitives
// (ToolOnelinerSummary, ToolRows, ToolDiffView, ToolTodoView,
// ToolQuestionCard) already cover the body kinds currently shipped.
//
// Adding a new tool: drop a file under specs/, register it in
// registry.ts. The registry matches in array order; the default spec
// at the end catches everything else.

import type { ToolInput, ToolPayload } from "../../App";

export type ToolRow = { key: string; value: string };

// Body component selector. Each kind maps to a body section in
// ToolCallCard's dispatch. "rows-and-raw" is the default — key/value
// rows on top + collapsible raw input/result blocks.
//
// "command": terminal-styled block highlighting the shell command
// + one-click copy. Bash and shell aliases use this.
//
// "plan": renders ExitPlanMode's input.plan as a markdown panel
// with an accent-bordered card and an "awaiting approval" footer.
export type ToolBodyKind = "diff" | "todo" | "question" | "command" | "plan" | "rows-and-raw";

export type ToolDisplay = {
  // Header label shown beside the icon. Title-cased tool name unless
  // overridden (e.g., "Grep" rather than the raw mcp__server__grep).
  name: string;
  // Icon glyph key — must match a name handled by App.tsx's
  // <ToolGlyph>. Adding a new key requires also adding the SVG path
  // in ToolGlyph.
  icon: string;
  // Inline value next to the name in the collapsed one-liner head
  // (file path, command, pattern). Empty string omits the slot.
  headerArg: string;
  // Body section the dispatcher should mount.
  body: ToolBodyKind;
  // Key/value rows below the header. Read by body=rows-and-raw; other
  // bodies may also opt in (e.g. show file path above the diff).
  rows: ToolRow[];
  // Right-aligned state label on the header — typically a numeric
  // result summary ("+12 −3", "5 hits", "32 lines"). Empty string
  // defers to ToolCallCard's running/done/error default.
  stateLabel: string;
  // Sentence-style label shown when the tool's one-liner row sits
  // INSIDE a ToolNarrativeGroup (.ws-narr-body), where icon/arg/state
  // are hidden and the row should read as a verb phrase like
  // "Ran List current directory" or "Read styles.css". When unset
  // the row falls back to `name` (the bare tool name).
  narrativeLabel?: string;
};

export type ToolSpec = {
  // True when this spec handles `toolName`. First match in
  // registry.ts wins; the default spec returns true for everything.
  match: (toolName: string) => boolean;
  // Build the display data. `result` is "" while the turn is still
  // streaming (payload.has_result is false and payload.result is
  // empty).
  display: (input: ToolInput, payload: ToolPayload, result: string) => ToolDisplay;
};
