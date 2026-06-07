// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// TestJSONLTailerIncrementalAppend documents the central correctness claim:
// each call to tail() only emits records *appended since the prior call*.
// Re-reading the same prefix would cause every chat bubble to surface twice
// in the web, so the per-path offset must advance after each tick.
func TestJSONLTailerIncrementalAppend(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()

	// First batch.
	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"))
	mustAppend(t, path, []byte(`{"type":"assistant","seq":2}`+"\n"))

	var firstTick [][]byte
	n, err := tailer.tail(path, func(_ map[string]any, raw []byte) {
		firstTick = append(firstTick, append([]byte(nil), raw...))
	})
	if err != nil {
		t.Fatalf("first tail: %v", err)
	}
	if n != 2 || len(firstTick) != 2 {
		t.Fatalf("first tick: got %d records, want 2", n)
	}

	// Second tick on unchanged file → zero records.
	n, err = tailer.tail(path, func(map[string]any, []byte) { t.Fatalf("no records expected on quiescent tick") })
	if err != nil {
		t.Fatalf("quiescent tail: %v", err)
	}
	if n != 0 {
		t.Fatalf("quiescent tick: got %d, want 0", n)
	}

	// Append a third record. Only that one should fire.
	mustAppend(t, path, []byte(`{"type":"assistant","seq":3}`+"\n"))
	var thirdRaw []byte
	n, err = tailer.tail(path, func(_ map[string]any, raw []byte) {
		thirdRaw = append([]byte(nil), raw...)
	})
	if err != nil {
		t.Fatalf("third tail: %v", err)
	}
	if n != 1 {
		t.Fatalf("third tick: got %d records, want 1 (only the new line)", n)
	}
	if string(thirdRaw) != `{"type":"assistant","seq":3}` {
		t.Fatalf("third record raw mismatch: got %q", thirdRaw)
	}
}

func TestExtractMessageEventsHidesModelCommandRecords(t *testing.T) {
	records := []map[string]any{
		{
			"type": "user",
			"uuid": "cmd",
			"message": map[string]any{
				"content": "<command-name>/model</command-name>\n<command-args>haiku</command-args>",
			},
		},
		{
			"type": "user",
			"uuid": "stdout",
			"message": map[string]any{
					"content": "<local-command-stdout>Set model to \x1b[1manthropic-compatible-fast\x1b[22m and saved as your default for new sessions</local-command-stdout>",
			},
		},
	}

	for _, rec := range records {
		if got := extractMessageEvents(rec); len(got) != 0 {
			t.Fatalf("model command record leaked live events: %#v", got)
		}
	}
}

func TestDaemonBridgeDedupesMessageEventsByUUID(t *testing.T) {
	bridge := &daemonBridge{}
	event := jsonlMessageEvent{UUID: "u1", Role: "assistant", Text: "hello", Segment: 1}
	if !bridge.rememberMessageEvent(event) {
		t.Fatal("first event should be emitted")
	}
	if bridge.rememberMessageEvent(event) {
		t.Fatal("duplicate event should be suppressed")
	}
	if !bridge.rememberMessageEvent(jsonlMessageEvent{UUID: "u1", Role: "assistant", Text: "second segment", Segment: 2}) {
		t.Fatal("different segment should be emitted")
	}
}

// TestJSONLTailerPartialTrailingLine simulates the writer flushing
// mid-record (Claude can hold the file open between newline-terminated
// turns). We must NOT emit the partial line — we leave the offset before
// it so the next tick re-reads and parses the now-complete record.
func TestJSONLTailerPartialTrailingLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()

	// Complete record + half of next.
	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"+`{"type":"assist`))

	var seen []map[string]any
	n, err := tailer.tail(path, func(rec map[string]any, _ []byte) {
		seen = append(seen, rec)
	})
	if err != nil {
		t.Fatalf("first tail: %v", err)
	}
	if n != 1 {
		t.Fatalf("first tick: got %d, want 1 (partial line must be deferred)", n)
	}
	if got, _ := seen[0]["type"].(string); got != "user" {
		t.Fatalf("first record type: got %q, want %q", got, "user")
	}

	// Complete the partial line; on next tick we should now see it.
	mustAppend(t, path, []byte(`ant","seq":2}`+"\n"))
	seen = nil
	n, err = tailer.tail(path, func(rec map[string]any, _ []byte) {
		seen = append(seen, rec)
	})
	if err != nil {
		t.Fatalf("second tail: %v", err)
	}
	if n != 1 {
		t.Fatalf("second tick: got %d, want 1 (the now-complete record)", n)
	}
	if got, _ := seen[0]["type"].(string); got != "assistant" {
		t.Fatalf("second record type: got %q, want %q", got, "assistant")
	}
}

// TestJSONLTailerTruncationResetsOffset covers the case where Claude
// rewrites the file (rare — e.g. compaction, session restart writing to
// the same path). If the new size is smaller than our remembered offset
// we must rewind to 0; otherwise we'd seek past EOF and emit nothing
// until the file grew back past our stale offset.
func TestJSONLTailerTruncationResetsOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()

	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"+`{"type":"user","seq":2}`+"\n"))
	if _, err := tailer.tail(path, func(map[string]any, []byte) {}); err != nil {
		t.Fatalf("first tail: %v", err)
	}

	// Truncate + rewrite with a single shorter record.
	if err := os.WriteFile(path, []byte(`{"type":"user","seq":99}`+"\n"), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	var seen []map[string]any
	n, err := tailer.tail(path, func(rec map[string]any, _ []byte) {
		seen = append(seen, rec)
	})
	if err != nil {
		t.Fatalf("post-truncate tail: %v", err)
	}
	if n != 1 || len(seen) != 1 {
		t.Fatalf("post-truncate tick: got %d records, want 1 (re-read from byte 0)", n)
	}
	if got, _ := seen[0]["seq"].(float64); got != 99 {
		t.Fatalf("post-truncate seq: got %v, want 99", seen[0]["seq"])
	}
}

// TestJSONLTailerSkipsMalformedLine: one bad JSON line shouldn't poison
// the rest of the tick. Claude's writer is reliable in practice; this is
// pure defense against a torn write or an unknown future schema variant.
func TestJSONLTailerSkipsMalformedLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()

	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"+
		`{"type":"assistant","seq":2,malformed`+"\n"+
		`{"type":"assistant","seq":3}`+"\n"))

	var seen []map[string]any
	n, err := tailer.tail(path, func(rec map[string]any, _ []byte) {
		seen = append(seen, rec)
	})
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	// Two valid records pass through; the malformed one is silently dropped.
	if n != 2 || len(seen) != 2 {
		t.Fatalf("got %d records, want 2 (bad line dropped, others survive)", n)
	}
	if got, _ := seen[0]["seq"].(float64); got != 1 {
		t.Fatalf("first record seq: got %v, want 1", seen[0]["seq"])
	}
	if got, _ := seen[1]["seq"].(float64); got != 3 {
		t.Fatalf("second record seq: got %v, want 3", seen[1]["seq"])
	}
}

// TestJSONLTailerResetForcesReread: when the watcher learns the wrapper
// rebound to a different session_id, it calls reset(path) to forget the
// offset so we re-read from byte 0 and catch the new session's intro
// events (system/init records that the live UI uses to render headers).
func TestJSONLTailerResetForcesReread(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()

	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"))
	if _, err := tailer.tail(path, func(map[string]any, []byte) {}); err != nil {
		t.Fatalf("first tail: %v", err)
	}

	tailer.reset(path)

	var seen []map[string]any
	n, err := tailer.tail(path, func(rec map[string]any, _ []byte) {
		seen = append(seen, rec)
	})
	if err != nil {
		t.Fatalf("post-reset tail: %v", err)
	}
	if n != 1 || len(seen) != 1 {
		t.Fatalf("post-reset: got %d records, want 1 (re-read from byte 0)", n)
	}
}

// TestJSONLTailerMissingFileReturnsError just documents the existing
// behavior: tail() is called from the watcher loop which already guards
// path-exists, but if the file is racily removed between stat and open,
// the error propagates rather than silently dropping records.
func TestJSONLTailerMissingFileReturnsError(t *testing.T) {
	tailer := newJSONLTailer()
	if _, err := tailer.tail("/nonexistent/path/no-file.jsonl", func(map[string]any, []byte) {}); err == nil {
		t.Fatalf("expected error reading nonexistent file, got nil")
	}
}

// TestJSONLTailerConcurrentSafe just exercises the mutex — the watcher
// goroutine could in theory be racing a reset() from a session-rotation
// detector. Run a few tails + resets in parallel and confirm no panic.
func TestJSONLTailerConcurrentSafe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := newJSONLTailer()
	mustAppend(t, path, []byte(`{"type":"user","seq":1}`+"\n"))

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = tailer.tail(path, func(map[string]any, []byte) {})
			tailer.reset(path)
		}()
	}
	wg.Wait()
}

// --- extractMessageText / flatten helpers ---

func TestExtractMessageTextUserStringContent(t *testing.T) {
	rec := map[string]any{
		"type":    "user",
		"message": map[string]any{"content": "hello world"},
	}
	kind, text := extractMessageText(rec)
	if kind != "user" || text != "hello world" {
		t.Fatalf("got (%q, %q), want (user, hello world)", kind, text)
	}
}

func TestExtractMessageTextUserToolResultBlocks(t *testing.T) {
	// Real Claude shape: user message containing a tool_result with
	// nested text blocks. flattenUserContent must walk into the list.
	rec := map[string]any{
		"type": "user",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type": "tool_result",
					"content": []any{
						map[string]any{"type": "text", "text": "tool output line 1"},
						map[string]any{"type": "text", "text": "tool output line 2"},
					},
				},
			},
		},
	}
	kind, text := extractMessageText(rec)
	if kind != "user" {
		t.Fatalf("kind = %q, want user", kind)
	}
	want := "tool output line 1\n\ntool output line 2"
	if text != want {
		t.Fatalf("text = %q, want %q", text, want)
	}
}

func TestExtractMessageTextAssistantSkipsToolUseAndThinking(t *testing.T) {
	// Only the assistant's text parts go to the chat bubble. tool_use and
	// thinking blocks render via the separate turn-sync path; putting them
	// in the streaming bubble would dump JSON-ish junk over user-readable text.
	rec := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "let me reason..."},
				map[string]any{"type": "text", "text": "Here is the answer."},
				map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{"command": "ls"}},
				map[string]any{"type": "text", "text": "Hope it helps."},
			},
		},
	}
	kind, text := extractMessageText(rec)
	if kind != "assistant" {
		t.Fatalf("kind = %q, want assistant", kind)
	}
	if text != "Here is the answer.\n\nHope it helps." {
		t.Fatalf("text = %q, want concatenated text-only parts", text)
	}
}

func TestExtractMessageEventsAssistantToolUse(t *testing.T) {
	rec := map[string]any{
		"type":      "assistant",
		"uuid":      "assistant-1",
		"timestamp": "2026-05-28T15:25:13Z",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "not rendered live"},
				map[string]any{"type": "tool_use", "id": "call_web", "name": "WebSearch", "input": map[string]any{"query": "open-design open source project"}},
				map[string]any{"type": "text", "text": "Search complete."},
			},
		},
	}

	events := extractMessageEvents(rec)
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2: %+v", len(events), events)
	}
	if events[0].Role != "tool_call" || events[0].Tool != "WebSearch" || events[0].ID != "call_web" {
		t.Fatalf("tool event = %+v", events[0])
	}
	if events[0].Input["query"] != "open-design open source project" {
		t.Fatalf("tool input = %+v", events[0].Input)
	}
	if events[1].Role != "assistant" || events[1].Text != "Search complete." {
		t.Fatalf("assistant event = %+v", events[1])
	}
}

func TestExtractMessageEventsAssistantThinkingOnlyThenText(t *testing.T) {
	thinking := map[string]any{
		"type": "assistant",
		"uuid": "assistant-thinking",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "thinking", "thinking": "private reasoning"},
			},
		},
	}
	if events := extractMessageEvents(thinking); len(events) != 0 {
		t.Fatalf("thinking-only assistant emitted events: %+v", events)
	}

	text := map[string]any{
		"type": "assistant",
		"uuid": "assistant-text",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "Visible answer."},
			},
		},
	}
	events := extractMessageEvents(text)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(events), events)
	}
	if events[0].Role != "assistant" || events[0].Text != "Visible answer." {
		t.Fatalf("assistant text event = %+v", events[0])
	}
}

func TestExtractMessageEventsAssistantTextSegments(t *testing.T) {
	rec := map[string]any{
		"type":      "assistant",
		"uuid":      "assistant-mixed",
		"timestamp": "2026-05-28T15:25:13Z",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "Before tool."},
				map[string]any{"type": "tool_use", "id": "call_1", "name": "Bash", "input": map[string]any{"command": "pwd"}},
				map[string]any{"type": "text", "text": "After tool."},
			},
		},
	}

	events := extractMessageEvents(rec)
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %+v", len(events), events)
	}
	if events[0].Role != "assistant" || events[0].Text != "Before tool." || events[0].Segment != 1 {
		t.Fatalf("first assistant segment = %+v", events[0])
	}
	if events[1].Role != "tool_call" || events[1].ID != "call_1" {
		t.Fatalf("tool event = %+v", events[1])
	}
	if events[2].Role != "assistant" || events[2].Text != "After tool." || events[2].Segment != 2 {
		t.Fatalf("second assistant segment = %+v", events[2])
	}
	if events[0].UUID != events[2].UUID {
		t.Fatalf("segments should share source uuid: %+v / %+v", events[0], events[2])
	}
}

func TestExtractMessageEventsUserToolResult(t *testing.T) {
	rec := map[string]any{
		"type":      "user",
		"uuid":      "result-1",
		"timestamp": "2026-05-28T15:25:42Z",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type":        "tool_result",
					"tool_use_id": "call_web",
					"content":     "Web search results...",
					"is_error":    false,
				},
			},
		},
	}

	events := extractMessageEvents(rec)
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1: %+v", len(events), events)
	}
	if events[0].Role != "tool_result" || events[0].ID != "call_web" || events[0].Result != "Web search results..." || !events[0].HasResult {
		t.Fatalf("tool result event = %+v", events[0])
	}
}

func TestExtractMessageTextUnknownTypeReturnsEmpty(t *testing.T) {
	// Allow-list semantics: anything we don't recognize (system events,
	// file-history snapshots, future schemas) must not leak into the
	// chat view. Caller skips Emit when kind=="".
	rec := map[string]any{"type": "system", "subtype": "init"}
	kind, text := extractMessageText(rec)
	if kind != "" || text != "" {
		t.Fatalf("unknown type leaked: kind=%q text=%q", kind, text)
	}
}

func TestExtractMessageTextAttachmentJSONFallback(t *testing.T) {
	// If attachment.content isn't a string, we marshal it to JSON so the
	// web at least shows there was *something* attached (collapsed in
	// AttachmentCard's <details>). The exact JSON shape isn't load-
	// bearing — just that we don't drop the attachment silently.
	rec := map[string]any{
		"type": "attachment",
		"attachment": map[string]any{
			"content": map[string]any{"key": "value"},
		},
	}
	kind, text := extractMessageText(rec)
	if kind != "attachment" {
		t.Fatalf("kind = %q, want attachment", kind)
	}
	if text == "" {
		t.Fatalf("text empty — structured attachment content should serialize")
	}
}

// --- helpers ---

func mustAppend(t *testing.T, path string, data []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
