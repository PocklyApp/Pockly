/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// dedupeAssistantTextEchoes — collapsing ONE assistant reply that the pipeline
// stored twice (live SDK bridge copy with the app-server item uuid + uuid-less
// jsonl sync copy; endemic to codex, whose rollouts persist no per-message
// ids), while preserving genuinely repeated replies.

import test from "node:test";
import assert from "node:assert/strict";

import type { SessionTurn } from "./api";
import { dedupeAssistantTextEchoes, visibleConversationTurns } from "./App";

function reply(
  seq: number,
  text: string,
  opts: { uuid?: string; ts?: string; kind?: string } = {},
): SessionTurn {
  return {
    session_id: "sess",
    device_id: "dev",
    seq,
    agent: "codex",
    kind: opts.kind ?? "assistant_text",
    timestamp: opts.ts ?? "2026-06-10T00:00:10Z",
    payload: { text, ...(opts.uuid ? { uuid: opts.uuid } : {}) },
  };
}

test("bridge copy (uuid) + sync copy (no uuid) of one reply collapse to one", () => {
  const out = dedupeAssistantTextEchoes([
    reply(6, "The answer is 42.", { uuid: "item-1", ts: "2026-06-10T00:00:10Z" }),
    reply(8, "The answer is 42.", { ts: "2026-06-10T00:00:11Z" }),
  ]);
  assert.equal(out.filter((t) => t.kind === "assistant_text").length, 1);
  // The uuid-bearing copy survives.
  assert.equal(out[0].payload?.uuid, "item-1");
});

test("uuid-less sync copy first, bridge copy second — uuid copy still survives at the earlier seq", () => {
  const out = dedupeAssistantTextEchoes([
    reply(6, "The answer is 42.", { ts: "2026-06-10T00:00:10Z" }),
    reply(8, "The answer is 42.", { uuid: "item-1", ts: "2026-06-10T00:00:11Z" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].payload?.uuid, "item-1");
  assert.equal(out[0].seq, 6);
});

test("optimistic live ghost (synthetic seq) collapses against the genuine copy regardless of timestamps", () => {
  const out = dedupeAssistantTextEchoes([
    reply(5, "好的。", { uuid: "item-2", ts: "2026-06-10T00:00:10Z" }),
    reply(1_000_000_002, "好的。", { ts: "2026-06-10T00:09:00Z" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seq, 5);
});

test("two DISTINCT uuids with the same text are genuine repeats — both kept", () => {
  const out = dedupeAssistantTextEchoes([
    reply(5, "Done.", { uuid: "item-a", ts: "2026-06-10T00:00:10Z" }),
    reply(9, "Done.", { uuid: "item-b", ts: "2026-06-10T00:00:40Z" }),
  ]);
  assert.equal(out.length, 2);
});

test("same uuid twice always collapses, even far apart in time", () => {
  const out = dedupeAssistantTextEchoes([
    reply(5, "Done.", { uuid: "item-a", ts: "2026-06-10T00:00:10Z" }),
    reply(9, "Done.", { uuid: "item-a", ts: "2026-06-10T01:00:10Z" }),
  ]);
  assert.equal(out.length, 1);
});

test("uuid-less repeats far apart in time are genuine (history-only session) — both kept", () => {
  const out = dedupeAssistantTextEchoes([
    reply(5, "好的。", { ts: "2026-06-10T00:00:10Z" }),
    reply(40, "好的。", { ts: "2026-06-10T00:30:10Z" }),
  ]);
  assert.equal(out.length, 2);
});

test("whitespace drift between the two copies still collapses", () => {
  const out = dedupeAssistantTextEchoes([
    reply(6, "The answer\nis 42.", { uuid: "item-1", ts: "2026-06-10T00:00:10Z" }),
    reply(8, "The answer is 42. ", { ts: "2026-06-10T00:00:12Z" }),
  ]);
  assert.equal(out.length, 1);
});

test("different texts and non-assistant kinds pass through untouched", () => {
  const turns = [
    reply(1, "hello", { kind: "user_message" }),
    reply(2, "first reply", { uuid: "u1" }),
    reply(3, "second reply"),
    reply(4, "ls -la", { kind: "tool_call" }),
  ];
  assert.deepEqual(dedupeAssistantTextEchoes(turns), turns);
});

test("end-to-end: visibleConversationTurns renders the duplicated reply ONCE (scenario C)", () => {
  const visible = visibleConversationTurns([
    reply(1, "What's 6 times 7?", { kind: "user_message", ts: "2026-06-10T00:00:01Z" }),
    // live bridge copy (uuid) + jsonl sync copy (no uuid) + optimistic ghost
    reply(5, "The answer is **42**.", { uuid: "item-1", ts: "2026-06-10T00:00:10Z" }),
    reply(7, "The answer is **42**.", { ts: "2026-06-10T00:00:11Z" }),
    reply(1_000_000_002, "The answer is **42**.", { ts: "2026-06-10T00:00:09Z" }),
  ]);
  const assistant = visible.filter((t) => t.kind === "assistant_text");
  assert.equal(assistant.length, 1);
  // The reply text appears exactly once — no "answer ... answer" fusion.
  const occurrences = (assistant[0].payload?.text ?? "").split("The answer is").length - 1;
  assert.equal(occurrences, 1);
});
