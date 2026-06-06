/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// R2 — AskUserQuestion spec.
//
// Selects body="question" so ToolCallCard mounts ToolQuestionCard
// with the parsed questions array. R5 will upgrade ToolQuestionCard
// from "static Q/A list" to "clickable options that inject the
// answer back into the conversation" — the spec contract doesn't
// need to change for that work.

import { extractQuestions } from "../../../App";
import type { ToolSpec } from "../types";

export const askUserQuestionSpec: ToolSpec = {
  match: (name) => name.toLowerCase() === "askuserquestion",
  display: (input, _payload, _result) => {
    const questions = extractQuestions(input);
    return {
      name: "Ask User",
      icon: "shield",
      headerArg: questions[0]?.question ? questions[0].question.slice(0, 56) : "",
      body: questions.length > 0 ? "question" : "rows-and-raw",
      rows: [],
      stateLabel: questions.length > 1 ? `${questions.length} questions` : "",
    };
  },
};
