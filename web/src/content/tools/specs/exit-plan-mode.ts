/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// ExitPlanMode tool spec.
//
// Claude Code's plan mode emits ExitPlanMode as a tool_call whose
// input.plan is a markdown string describing the proposed plan. The
// user then approves (claude continues) or denies (claude stays in
// plan mode and refines). Treated specially because:
//
//   1. The plan content is markdown, not a one-liner — it needs the
//      same renderer as assistant_text (tables, lists, code blocks).
//   2. The "awaiting approval" state matters for UX — the user might
//      glance and miss that the agent is paused.
//
// Body="plan" tells ToolCallCard to mount <ToolPlanBody> which feeds
// input.plan into MarkdownBlock and adds an approval-waiting footer.
//
// Approval-button wiring intentionally stays out of this spec. The plan
// approval channel piggybacks on the existing assistant-text response path: the
// user sends "approve" or "no, revise" as a message. Native permission prompts
// use their own approval bridge.

import { stringField, truncateMiddle } from "../../../App";
import type { ToolSpec } from "../types";

export const exitPlanModeSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "exitplanmode",
  display: (input, payload, result) => {
    const plan = stringField(input, ["plan"]);
    // Preview = first non-empty line of the plan for the collapsed
    // header summary. truncateMiddle keeps it from blowing out
    // narrow viewports.
    const firstLine = plan.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    // A plan card stays in "awaiting approval" only while the tool
    // call is still pending. Once the user has approved/denied, the
    // daemon emits a tool_result block → has_result=true (and
    // mergeAdjacentToolPairs flips _paired_result on the call). At
    // that point the historical card should not keep telling the user
    // to act — it's done. We surface that as state="done" and let the
    // body strip its footer.
    const resolved = Boolean(payload.has_result || payload._paired_result || result);
    return {
      name: "Plan",
      icon: "plan",
      headerArg: firstLine ? truncateMiddle(firstLine, 56) : "",
      body: plan ? "plan" : "rows-and-raw",
      rows: [],
      stateLabel: !plan ? "" : resolved ? "done" : "awaiting approval",
    };
  },
};
