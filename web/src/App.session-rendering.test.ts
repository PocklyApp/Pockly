/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { SessionTurn, TerminalEvent } from "./api";
import { mergeAdjacentAssistantTurns, mergeAdjacentToolPairs, groupConsecutiveTools, renderDuplexChatMessages, visibleConversationTurns, reconcileHydratedTurns, groupTurnsForRender } from "./App";

function turn(kind: string, seq: number, text: string): SessionTurn {
  return {
    session_id: "sess",
    seq,
    agent: "claude-code",
    kind,
    timestamp: `2026-05-23T00:00:${String(seq).padStart(2, "0")}Z`,
    payload: { text },
  };
}

function terminalEvent(kind: TerminalEvent["kind"], payload: string): TerminalEvent {
  return {
    terminal_session_id: "term",
    kind,
    payload,
    timestamp: "2026-05-23T00:00:00Z",
  };
}

test("renderDuplexChatMessages ignores raw ANSI text_delta chat output", () => {
  const messages = renderDuplexChatMessages([
    terminalEvent("text_delta", "\u001b[2J\u001b[38;2;215;119;87mClaude Code\u001b[0m"),
  ]);
  assert.deepEqual(messages, []);
});

test("renderDuplexChatMessages renders clean assistant message_added payloads", () => {
  const messages = renderDuplexChatMessages([
    terminalEvent("message_added", JSON.stringify({ role: "assistant", text: "POWERSHELL_RENDER_OK" })),
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].text, "POWERSHELL_RENDER_OK");
});

test("renderDuplexChatMessages surfaces session_disconnected as a system notice", () => {
  const messages = renderDuplexChatMessages([
    {
      terminal_session_id: "term",
      kind: "session_disconnected",
      error: "wrapper unreachable",
      timestamp: "2026-05-23T00:00:00Z",
    },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].text, /disconnected/i);
  assert.match(messages[0].text, /wrapper unreachable/);
});

test("mergeAdjacentAssistantTurns concatenates consecutive assistant_text", () => {
  const merged = mergeAdjacentAssistantTurns([
    turn("user_message", 1, "ask"),
    turn("assistant_text", 2, "first"),
    turn("assistant_text", 3, "second"),
    turn("assistant_text", 4, "third"),
    turn("user_message", 5, "follow-up"),
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].kind, "user_message");
  assert.equal(merged[1].kind, "assistant_text");
  assert.equal(merged[1].payload?.text, "first\n\nsecond\n\nthird");
  assert.equal(merged[2].kind, "user_message");
});

test("mergeAdjacentAssistantTurns preserves the first turn's seq for stable react keys", () => {
  const merged = mergeAdjacentAssistantTurns([
    turn("assistant_text", 10, "a"),
    turn("assistant_text", 11, "b"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].seq, 10);
});

test("mergeAdjacentAssistantTurns does not merge across tool_call", () => {
  const merged = mergeAdjacentAssistantTurns([
    turn("assistant_text", 1, "before"),
    turn("tool_call", 2, ""),
    turn("assistant_text", 3, "after"),
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].payload?.text, "before");
  assert.equal(merged[2].payload?.text, "after");
});

test("mergeAdjacentAssistantTurns tolerates missing payload text", () => {
  const merged = mergeAdjacentAssistantTurns([
    { session_id: "sess", seq: 1, agent: "claude-code", kind: "assistant_text", timestamp: "t1" },
    turn("assistant_text", 2, "only"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].payload?.text, "only");
});

function toolTurn(
  kind: "tool_call" | "tool_result",
  seq: number,
  id: string,
  extras: NonNullable<SessionTurn["payload"]> = {},
): SessionTurn {
  return {
    session_id: "sess",
    seq,
    agent: "claude-code",
    kind,
    timestamp: `2026-05-23T00:00:${String(seq).padStart(2, "0")}Z`,
    payload: { id, ...extras },
  };
}

test("mergeAdjacentToolPairs folds matching tool_result onto its tool_call", () => {
  const merged = mergeAdjacentToolPairs([
    toolTurn("tool_call", 1, "use_1", { tool: "Edit", input: { file_path: "a.ts" } }),
    toolTurn("tool_result", 2, "use_1", { result: "+10 -2", has_result: true }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, "tool_call");
  assert.equal(merged[0].payload?._paired_result, true);
  assert.equal(merged[0].payload?.result, "+10 -2");
  assert.equal(merged[0].payload?.has_result, true);
  assert.equal(merged[0].payload?.tool, "Edit");
});

test("visibleConversationTurns keeps WebSearch tool call before assistant result", () => {
  const visible = visibleConversationTurns([
    { session_id: "sess", seq: 1, agent: "claude-code", kind: "user_message", timestamp: "t1", payload: { text: "search" } },
    { session_id: "sess", seq: 2, agent: "claude-code", kind: "tool_call", timestamp: "t2", payload: { tool: "WebSearch", id: "call_web", input: { query: "open-design open source project" } } },
    { session_id: "sess", seq: 3, agent: "claude-code", kind: "tool_result", timestamp: "t3", payload: { id: "call_web", result: "Web search results", has_result: true } },
    { session_id: "sess", seq: 4, agent: "claude-code", kind: "assistant_text", timestamp: "t4", payload: { text: "Result summary" } },
  ]);

  assert.deepEqual(visible.map((item) => item.kind), ["user_message", "tool_call", "assistant_text"]);
  assert.equal(visible[1].payload?.tool, "WebSearch");
  assert.equal(visible[1].payload?._paired_result, true);
  assert.equal(visible[1].payload?.result, "Web search results");
});

test("mergeAdjacentToolPairs keeps the later timestamp for stable ordering", () => {
  const merged = mergeAdjacentToolPairs([
    toolTurn("tool_call", 1, "use_1"),
    toolTurn("tool_result", 2, "use_1"),
  ]);
  assert.equal(merged[0].timestamp, "2026-05-23T00:00:02Z");
});

test("mergeAdjacentToolPairs leaves mismatched ids unpaired", () => {
  const merged = mergeAdjacentToolPairs([
    toolTurn("tool_call", 1, "use_a"),
    toolTurn("tool_result", 2, "use_b"),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].payload?._paired_result, undefined);
});

test("mergeAdjacentToolPairs pairs adjacency when ids are missing on either side", () => {
  const merged = mergeAdjacentToolPairs([
    { session_id: "sess", seq: 1, agent: "claude-code", kind: "tool_call", timestamp: "t1", payload: { tool: "Bash" } },
    { session_id: "sess", seq: 2, agent: "claude-code", kind: "tool_result", timestamp: "t2", payload: { result: "ok", has_result: true } },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].payload?.result, "ok");
});

test("mergeAdjacentToolPairs preserves error flags from the result", () => {
  const merged = mergeAdjacentToolPairs([
    toolTurn("tool_call", 1, "use_1", { tool: "Bash" }),
    toolTurn("tool_result", 2, "use_1", { result: "fatal", is_error: true, has_result: true }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].payload?.is_error, true);
});

test("mergeAdjacentToolPairs leaves an unpaired tool_call alone", () => {
  const merged = mergeAdjacentToolPairs([
    toolTurn("tool_call", 1, "use_1", { tool: "Bash" }),
    { session_id: "sess", seq: 2, agent: "claude-code", kind: "assistant_text", timestamp: "t2", payload: { text: "thinking..." } },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].payload?._paired_result, undefined);
});

function callTurn(seq: number, tool: string): SessionTurn {
  return {
    session_id: "sess",
    seq,
    agent: "claude-code",
    kind: "tool_call",
    timestamp: `2026-05-23T00:00:${String(seq).padStart(2, "0")}Z`,
    payload: { tool, id: `use_${seq}` },
  };
}

test("groupConsecutiveTools clusters 4+ same-tool calls into a tool_group", () => {
  const grouped = groupConsecutiveTools([
    callTurn(1, "Browser"),
    callTurn(2, "Browser"),
    callTurn(3, "Browser"),
    callTurn(4, "Browser"),
    callTurn(5, "Browser"),
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "tool_group");
  assert.equal(grouped[0].payload?._group_items?.length, 5);
  assert.equal(grouped[0].payload?.tool, "Browser");
});

test("groupConsecutiveTools leaves 3-run alone (below threshold)", () => {
  const grouped = groupConsecutiveTools([
    callTurn(1, "Browser"),
    callTurn(2, "Browser"),
    callTurn(3, "Browser"),
  ]);
  assert.equal(grouped.length, 3);
  for (const turn of grouped) assert.equal(turn.kind, "tool_call");
});

test("groupConsecutiveTools breaks the run when a different tool interrupts", () => {
  const grouped = groupConsecutiveTools([
    callTurn(1, "Browser"),
    callTurn(2, "Browser"),
    callTurn(3, "Bash"),
    callTurn(4, "Browser"),
    callTurn(5, "Browser"),
    callTurn(6, "Browser"),
    callTurn(7, "Browser"),
  ]);
  // First two Browsers stay (under threshold), Bash alone, then a 4-run Browser group.
  assert.equal(grouped.length, 4);
  assert.equal(grouped[0].kind, "tool_call");
  assert.equal(grouped[1].kind, "tool_call");
  assert.equal(grouped[2].kind, "tool_call");
  assert.equal(grouped[3].kind, "tool_group");
  assert.equal(grouped[3].payload?._group_items?.length, 4);
});

test("groupConsecutiveTools preserves non-tool turns untouched", () => {
  const userMsg: SessionTurn = { session_id: "sess", seq: 0, agent: "claude-code", kind: "user_message", timestamp: "t0", payload: { text: "hi" } };
  const grouped = groupConsecutiveTools([
    userMsg,
    callTurn(1, "Browser"),
    callTurn(2, "Browser"),
    callTurn(3, "Browser"),
    callTurn(4, "Browser"),
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0], userMsg);
  assert.equal(grouped[1].kind, "tool_group");
});

test("groupConsecutiveTools ignores tool_call without a tool name", () => {
  const grouped = groupConsecutiveTools([
    { session_id: "sess", seq: 1, agent: "claude-code", kind: "tool_call", timestamp: "t1", payload: {} },
    { session_id: "sess", seq: 2, agent: "claude-code", kind: "tool_call", timestamp: "t2", payload: {} },
    { session_id: "sess", seq: 3, agent: "claude-code", kind: "tool_call", timestamp: "t3", payload: {} },
    { session_id: "sess", seq: 4, agent: "claude-code", kind: "tool_call", timestamp: "t4", payload: {} },
  ]);
  // No tool name → no grouping
  assert.equal(grouped.length, 4);
});

// Regression: "one send shows two bubbles" on SDK sessions. The live turnHub
// push stamps the user message + assistant reply with the Nexus terminal-event
// seq (small ints), while the jsonl history sync re-stamps the same turns with a
// block-index seq. When the authoritative GET /turns response merges in,
// reconcileHydratedTurns must NOT keep both genuine copies (dedupeUserMessageGhosts
// treats two genuine same-text user turns as a legit double-send). Before the
// fix this rendered the message — user AND assistant — twice until reload.
test("reconcileHydratedTurns(authoritative) drops stale live-seq turns, no double bubble", () => {
  const current: SessionTurn[] = [
    turn("assistant_text", 1, "我是 Claude，由 Anthropic 开发的 AI 助手。"),
    turn("user_message", 2, "ok"),
  ];
  const hydrated: SessionTurn[] = [
    turn("assistant_text", 10, "我是 Claude，由 Anthropic 开发的 AI 助手。"),
    turn("user_message", 11, "ok"),
  ];
  const visible = visibleConversationTurns(reconcileHydratedTurns(current, hydrated, true));
  const okCount = visible.filter((t) => t.kind === "user_message" && t.payload?.text === "ok").length;
  const introCount = visible.filter((t) => t.kind === "assistant_text" && String(t.payload?.text ?? "").startsWith("我是 Claude")).length;
  assert.equal(okCount, 1);
  assert.equal(introCount, 1);
});

// A genuine double-send (user really sent "ok" twice, both persisted) must keep
// BOTH bubbles — the authoritative hydrated set carries both, so dropping stale
// current turns can't collapse them.
test("reconcileHydratedTurns(authoritative) preserves a genuine double-send", () => {
  const current: SessionTurn[] = [turn("user_message", 4, "ok"), turn("user_message", 7, "ok")];
  const hydrated: SessionTurn[] = [turn("user_message", 4, "ok"), turn("user_message", 7, "ok")];
  const visible = visibleConversationTurns(reconcileHydratedTurns(current, hydrated, true));
  assert.equal(visible.filter((t) => t.kind === "user_message" && t.payload?.text === "ok").length, 2);
});

// Regression for the locally-reproduced "send one, see two" on SDK sessions:
// the live SDK bridge pushes the user message with NO jsonl uuid (text only,
// terminal-event seq), then the history-sync copy arrives ADDITIVELY via the
// turnHub (authoritative=false — SDK sessions stay live and never trigger a
// full re-hydration) with a DIFFERENT block-index seq and the jsonl uuid. Two
// genuine integer seqs, same text → the no-uuid live copy must collapse into
// the uuid'd durable copy (one bubble), keyed on uuid so a real double-send
// (distinct uuids) is untouched.
test("reconcileHydratedTurns collapses a no-uuid live user turn into its uuid'd copy (additive)", () => {
  const current: SessionTurn[] = [
    { session_id: "sess", seq: 3, agent: "claude-code", kind: "user_message", timestamp: "2026-06-01T05:55:30Z", payload: { text: "你好！" } },
  ];
  const incoming: SessionTurn[] = [
    { session_id: "sess", seq: 6, agent: "claude-code", kind: "user_message", timestamp: "2026-06-01T05:55:30Z", payload: { uuid: "aba1fc26", text: "你好！" } },
  ];
  const visible = visibleConversationTurns(reconcileHydratedTurns(current, incoming));
  assert.equal(visible.filter((t) => t.kind === "user_message" && String(t.payload?.text ?? "").startsWith("你好")).length, 1);
});

// Nexus can persist the SAME assistant record under two seqs (live SDK
// bridge seq + jsonl history-sync seq), both carrying the same uuid. Keyed on
// seq alone both survive and the reply renders twice. dedupeTurnsByUuid must
// collapse same-uuid turns to one regardless of seq.
test("reconcileHydratedTurns collapses two same-uuid assistant copies at different seqs", () => {
  const current: SessionTurn[] = [
    { session_id: "sess", seq: 6, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-01T05:55:37Z", payload: { uuid: "87f9d1c4", text: "你好！😊" } },
  ];
  const incoming: SessionTurn[] = [
    { session_id: "sess", seq: 8, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-01T05:55:37Z", payload: { uuid: "87f9d1c4", text: "你好！😊" } },
  ];
  const visible = visibleConversationTurns(reconcileHydratedTurns(current, incoming));
  assert.equal(visible.filter((t) => t.kind === "assistant_text").length, 1);
});

// Regression: a single jsonl record expands to MANY blocks that ALL carry the
// record's uuid — a user message is [image, text], an assistant turn is
// [thinking, text, tool_use]. Deduping on uuid alone collapsed the record to
// its first block and dropped the rest (a user's image+text message rendered as
// just the image, losing the text). Every sibling block must survive.
test("reconcileHydratedTurns keeps every block of a multi-part record (same uuid)", () => {
  const recUUID = "rec-user-1";
  const current: SessionTurn[] = [];
  const incoming: SessionTurn[] = [
    { session_id: "sess", seq: 3, agent: "claude-code", kind: "image", timestamp: "2026-06-01T06:00:00Z", payload: { uuid: recUUID, image_media_type: "image/png", image_data: "AAAA" } },
    { session_id: "sess", seq: 4, agent: "claude-code", kind: "user_message", timestamp: "2026-06-01T06:00:00Z", payload: { uuid: recUUID, text: "用户消息为什么显示成这个样子了?" } },
  ];
  const merged = reconcileHydratedTurns(current, incoming);
  assert.equal(merged.filter((t) => t.kind === "image" && t.payload?.uuid === recUUID).length, 1, "image block must survive");
  assert.equal(merged.filter((t) => t.kind === "user_message" && t.payload?.text === "用户消息为什么显示成这个样子了?").length, 1, "user text must survive alongside the image");

  // Parallel tool calls of one assistant record share uuid + kind but differ by
  // tool-use id → both must survive.
  const asstUUID = "rec-asst-1";
  const tools = reconcileHydratedTurns([], [
    { session_id: "sess", seq: 5, agent: "claude-code", kind: "tool_call", timestamp: "2026-06-01T06:00:01Z", payload: { uuid: asstUUID, tool: "Bash", id: "toolu_a", input: {} } },
    { session_id: "sess", seq: 6, agent: "claude-code", kind: "tool_call", timestamp: "2026-06-01T06:00:01Z", payload: { uuid: asstUUID, tool: "Read", id: "toolu_b", input: {} } },
  ]);
  assert.equal(tools.filter((t) => t.kind === "tool_call").length, 2, "parallel tool calls must both survive");
});

// A user-attached image (kind "image") carries no role of its own, so on its
// own it defaults to the assistant side and renders split from — and above —
// the user's text. It shares the record uuid with the user_message block, so
// groupTurnsForRender must attribute it to the USER and group the two together.
test("groupTurnsForRender puts a user's attached image on the user side, with its text", () => {
  const recUUID = "rec-user-img";
  const groups = groupTurnsForRender([
    { session_id: "sess", seq: 3, agent: "claude-code", kind: "image", timestamp: "2026-06-01T06:00:00Z", payload: { uuid: recUUID, image_media_type: "image/png", image_data: "AAAA" } },
    { session_id: "sess", seq: 4, agent: "claude-code", kind: "user_message", timestamp: "2026-06-01T06:00:00Z", payload: { uuid: recUUID, text: "这是用户发送的吗?" } },
    { session_id: "sess", seq: 5, agent: "claude-code", kind: "assistant_text", timestamp: "2026-06-01T06:00:02Z", payload: { uuid: "rec-asst", text: "no, that wasn't you" } },
  ]);
  // image + user_message → one user group; assistant_text → its own group.
  assert.equal(groups.length, 2);
  assert.equal(groups[0].author, "user");
  assert.equal(groups[0].turns.length, 2);
  assert.ok(groups[0].turns.some((t) => t.kind === "image"), "image is in the user group");
  assert.equal(groups[1].author, "assistant");
});

// A single-turn turnHub push (authoritative=false, the default) must stay purely
// additive — it carries one new turn and must never wipe existing history.
test("reconcileHydratedTurns(non-authoritative) single live turn is additive", () => {
  const current: SessionTurn[] = [turn("assistant_text", 5, "hi"), turn("user_message", 6, "ok")];
  const merged = reconcileHydratedTurns(current, [turn("assistant_text", 7, "好的。")]);
  assert.ok(merged.some((t) => t.kind === "user_message" && t.payload?.text === "ok"));
  assert.ok(merged.some((t) => t.kind === "assistant_text" && t.payload?.text === "好的。"));
});
