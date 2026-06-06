/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — Tool spec registry.
//
// Order matters: the first spec whose `match(name)` returns true wins.
// Place specific specs above the default; the default's match is
// `() => true` so any reordering that puts it first kills the
// registry.
//
// New tools: add a file under specs/, import + register here.

import type { ToolSpec } from "./types";
import { askUserQuestionSpec } from "./specs/ask-user-question";
import { bashSpec } from "./specs/bash";
import { defaultSpec } from "./specs/default";
import { editSpec } from "./specs/edit";
import { exitPlanModeSpec } from "./specs/exit-plan-mode";
import { globSpec } from "./specs/glob";
import { grepSpec } from "./specs/grep";
import { readSpec } from "./specs/read";
import { taskSpec } from "./specs/task";
import { todoWriteSpec } from "./specs/todo-write";
import { writeSpec } from "./specs/write";

export const toolSpecs: ToolSpec[] = [
  // File-edit tools first — they're the most visually distinct and
  // overlap on substring matches (Write contains "rite" etc.) so
  // explicit precedence is clearer than relying on lexicographic
  // ordering.
  editSpec,
  writeSpec,
  // Read-style tools — cheap path / lines display, no body content
  // (raw on expand).
  readSpec,
  // Search tools — share the pattern-as-header pattern.
  grepSpec,
  globSpec,
  // Specialty bodies (todo, question, plan) — pure presentation match
  // on canonical names.
  todoWriteSpec,
  askUserQuestionSpec,
  exitPlanModeSpec,
  // Subagent — Task carries description-as-arg + sidechain nesting.
  taskSpec,
  // Bash + shell variants — common enough to pull above default but
  // currently uses the same rows-and-raw body as default (R3 will
  // give it its own terminal-styled body).
  bashSpec,
  // Catch-all. Keep last.
  defaultSpec,
];

export function resolveToolSpec(toolName: string): ToolSpec {
  const name = toolName || "";
  for (const spec of toolSpecs) {
    if (spec.match(name)) return spec;
  }
  // Unreachable in practice — defaultSpec.match returns true for
  // every input — but keeps the type checker honest.
  return defaultSpec;
}
