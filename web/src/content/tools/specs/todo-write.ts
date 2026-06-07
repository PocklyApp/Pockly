/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// TodoWrite spec.
//
// Selects body="todo" so ToolCallCard mounts ToolTodoView with the
// extracted entries. State label rolls up "X of N done" for a quick
// glance without expanding.

import { extractTodos } from "../../../App";
import type { ToolSpec, ToolRow } from "../types";

export const todoWriteSpec: ToolSpec = {
  match: (name) => {
    const lower = name.toLowerCase();
    return lower === "todowrite" || lower === "todoread";
  },
  display: (input, _payload, _result) => {
    const todos = extractTodos(input);
    const rows: ToolRow[] = [];
    const done = todos.filter((t) => t.status === "completed").length;
    return {
      name: "Todos",
      icon: "list",
      headerArg: "",
      body: todos.length > 0 ? "todo" : "rows-and-raw",
      rows,
      stateLabel: todos.length > 0 ? `${done} / ${todos.length}` : "",
    };
  },
};
