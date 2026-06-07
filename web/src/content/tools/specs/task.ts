/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Task (subagent) spec.
//
// The Task tool spawns a subagent. The card header should advertise
// the subagent's description (Claude passes it as input.description)
// so the user can tell what they're delegating to at a glance. The
// subagent's own turns get nested under the Task card via the
// existing _sidechain_items mechanism in App.tsx (not this spec's
// concern — body="rows-and-raw" is fine because the dispatcher
// adds the SidechainGroup after the body regardless).

import { stringField, truncateMiddle } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const taskSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "task",
  display: (input, _payload, _result) => {
    const description = stringField(input, ["description"]);
    const prompt = stringField(input, ["prompt"]);
    const subagent = stringField(input, ["subagent_type"]);
    const rows: ToolRow[] = [];
    if (subagent) rows.push({ key: "agent", value: subagent });
    if (description) rows.push({ key: "task", value: truncateMiddle(description, 72) });
    return {
      name: "Task",
      icon: "agent",
      headerArg: description ? truncateMiddle(description, 56) : (prompt ? truncateMiddle(prompt, 56) : ""),
      body: "rows-and-raw",
      rows,
      stateLabel: "",
    };
  },
};
