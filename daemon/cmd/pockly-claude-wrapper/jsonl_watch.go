// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
)

// jsonlTailer tracks how far we've read into a single claude jsonl
// file so the next watch tick only handles freshly-appended lines.
// Keyed by absolute path; the same daemon often watches multiple jsonls
// during a wrapper session (resumed jsonl + new spawn jsonl coexist
// briefly, etc.).
//
// Why jsonl-tail over PTY-byte-mirror: PTY bytes are a render stream —
// they include Claude TUI's ANSI cursor moves, statusLine repaints,
// and Ink's per-token paint fragments. Stripping ANSI alone leaves
// statusLine TEXT visible in the web ("◆ Pockly · ⚡ PTY duplex"
// rendered as user-readable noise mid-reply). The jsonl is Claude's
// own canonical persisted format: one JSON record per turn, content
// already structured ({role, content: [{type, text}]}), no terminal
// emulation needed.
//
// Trade-off: jsonl writes are turn-level, not token-level. Web users
// see "wait N seconds then full assistant reply lands" instead of a
// typewriter effect. We considered tracking partial flush positions
// inside an in-progress assistant block but Claude doesn't write the
// turn until it's complete, so token-level streaming via jsonl is
// impossible. The web sidebar already shows "Claude is replying live"
// during the wait, which sets the right expectation.
type jsonlTailer struct {
	mu      sync.Mutex
	offsets map[string]int64
}

func newJSONLTailer() *jsonlTailer {
	return &jsonlTailer{offsets: map[string]int64{}}
}

// tail reads any new bytes appended to path since the last call,
// splits into newline-terminated JSON records, and invokes onRecord
// for each one. Partial trailing lines (the writer was mid-flush)
// are kept in the offset and re-read next tick when complete.
//
// Returns the number of records emitted, mainly for caller logging.
func (t *jsonlTailer) tail(path string, onRecord func(rec map[string]any, raw []byte)) (int, error) {
	t.mu.Lock()
	prev := t.offsets[path]
	t.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	// File shrank → truncated/replaced under us. Reset and re-read
	// from the start so we don't misalign in the middle of a record.
	if size < prev {
		prev = 0
	}
	if size == prev {
		return 0, nil
	}
	if _, err := f.Seek(prev, io.SeekStart); err != nil {
		return 0, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return 0, err
	}

	// Split off the trailing partial line — keep the offset before
	// the partial so we re-read it next tick when it's complete.
	lastNL := bytes.LastIndexByte(data, '\n')
	if lastNL < 0 {
		// No complete line yet — leave offset alone (read it all again
		// next tick once a newline arrives). Don't advance, otherwise
		// we'd lose the partial.
		return 0, nil
	}
	full := data[:lastNL+1]
	consumed := prev + int64(lastNL+1)

	count := 0
	scanner := bufio.NewScanner(bytes.NewReader(full))
	// Allow huge lines (Claude attachments can be big: snippets, screenshots
	// base64). 4 MB ceiling.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal(line, &rec); err != nil {
			// One malformed line shouldn't poison the rest of the
			// tick. Claude's writer is reliable in practice; this is
			// pure defense.
			continue
		}
		// Copy the bytes because scanner.Bytes() reuses the buffer.
		rawCopy := make([]byte, len(line))
		copy(rawCopy, line)
		onRecord(rec, rawCopy)
		count++
	}
	if err := scanner.Err(); err != nil {
		return count, err
	}

	t.mu.Lock()
	t.offsets[path] = consumed
	t.mu.Unlock()
	return count, nil
}

// reset clears the offset for a path. Useful when the watcher learns
// the wrapper has rebound to a different session_id and wants the new
// jsonl read from byte 0 (catch the initial system event).
func (t *jsonlTailer) reset(path string) {
	t.mu.Lock()
	delete(t.offsets, path)
	t.mu.Unlock()
}

type jsonlMessageEvent struct {
	Role      string         `json:"role"`
	Text      string         `json:"text,omitempty"`
	UUID      string         `json:"uuid,omitempty"`
	Segment   int            `json:"segment,omitempty"`
	Timestamp string         `json:"timestamp,omitempty"`
	Tool      string         `json:"tool,omitempty"`
	ID        string         `json:"id,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Result    string         `json:"result,omitempty"`
	IsError   bool           `json:"is_error,omitempty"`
	HasResult bool           `json:"has_result,omitempty"`
}

// extractMessageEvents pulls user-visible live events out of one jsonl
// record. It intentionally emits tool_call/tool_result as structured
// events instead of waiting for catalog sync: live web sessions often show
// the final assistant text before encrypted history is refreshed, and users
// must still see the tool that Claude requested/executed.
//
// kind values map to web-side rendering:
//
//   - "user"        → user prompt (also "you" bubble)
//   - "assistant"   → assistant reply (markdown rendered)
//   - "tool_call"   → Claude tool_use metadata
//   - "tool_result" → Claude tool_result metadata/output
//   - "attachment"  → skill_listing / agent_listing (collapsed card in web)
//
// Everything else returns "" kind, caller skips Emit. This intentional
// allow-list keeps unknown future record types from leaking weird UI.
func extractMessageEvents(rec map[string]any) []jsonlMessageEvent {
	t, _ := rec["type"].(string)
	uuid, _ := rec["uuid"].(string)
	ts, _ := rec["timestamp"].(string)
	withMeta := func(ev jsonlMessageEvent) jsonlMessageEvent {
		ev.UUID = uuid
		ev.Timestamp = ts
		return ev
	}
	switch t {
	case "user":
		return userContentEvents(rec, withMeta)
	case "assistant":
		return assistantContentEvents(rec, withMeta)
	case "attachment":
		text := flattenAttachmentContent(rec)
		if text == "" {
			return nil
		}
		return []jsonlMessageEvent{withMeta(jsonlMessageEvent{Role: "attachment", Text: text})}
	default:
		return nil
	}
}

// extractMessageText is kept for older unit tests and helpers. Runtime code
// uses extractMessageEvents so tool calls are not dropped from the live UI.
func extractMessageText(rec map[string]any) (kind string, text string) {
	t, _ := rec["type"].(string)
	switch t {
	case "user":
		return "user", flattenUserContent(rec)
	case "assistant":
		return "assistant", flattenAssistantContent(rec)
	case "attachment":
		return "attachment", flattenAttachmentContent(rec)
	default:
		return "", ""
	}
}

func userContentEvents(rec map[string]any, withMeta func(jsonlMessageEvent) jsonlMessageEvent) []jsonlMessageEvent {
	msg, ok := rec["message"].(map[string]any)
	if !ok {
		return nil
	}
	switch c := msg["content"].(type) {
	case string:
		if c == "" {
			return nil
		}
		if isHiddenUserCommandRecord(c) {
			return nil
		}
		return []jsonlMessageEvent{withMeta(jsonlMessageEvent{Role: "user", Text: c})}
	case []any:
		var events []jsonlMessageEvent
		var textParts []string
		for _, part := range c {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			if txt, ok := pm["text"].(string); ok && txt != "" {
				if isHiddenUserCommandRecord(txt) {
					continue
				}
				textParts = append(textParts, txt)
				continue
			}
			if pm["type"] == "tool_result" {
				result := flattenToolResultPart(pm)
				id, _ := pm["tool_use_id"].(string)
				isError, _ := pm["is_error"].(bool)
				events = append(events, withMeta(jsonlMessageEvent{
					Role:      "tool_result",
					ID:        id,
					Result:    result,
					IsError:   isError,
					HasResult: true,
				}))
			}
		}
		if text := joinNonEmpty(textParts); text != "" {
			events = append([]jsonlMessageEvent{withMeta(jsonlMessageEvent{Role: "user", Text: text})}, events...)
		}
		return events
	default:
		return nil
	}
}

func isHiddenUserCommandRecord(text string) bool {
	t := strings.TrimSpace(text)
	if strings.Contains(t, "<command-name>/model</command-name>") {
		return true
	}
	if strings.HasPrefix(t, "<local-command-stdout>Set model to ") && strings.HasSuffix(t, "</local-command-stdout>") {
		return true
	}
	return false
}

func assistantContentEvents(rec map[string]any, withMeta func(jsonlMessageEvent) jsonlMessageEvent) []jsonlMessageEvent {
	msg, ok := rec["message"].(map[string]any)
	if !ok {
		return nil
	}
	parts, ok := msg["content"].([]any)
	if !ok {
		return nil
	}
	var events []jsonlMessageEvent
	var textParts []string
	textSegment := 0
	flushText := func() {
		if text := joinNonEmpty(textParts); text != "" {
			textSegment++
			events = append(events, withMeta(jsonlMessageEvent{Role: "assistant", Text: text, Segment: textSegment}))
		}
		textParts = nil
	}
	for _, part := range parts {
		pm, ok := part.(map[string]any)
		if !ok {
			continue
		}
		switch pm["type"] {
		case "text":
			if t, ok := pm["text"].(string); ok && t != "" {
				textParts = append(textParts, t)
			}
		case "tool_use":
			flushText()
			tool, _ := pm["name"].(string)
			id, _ := pm["id"].(string)
			input, _ := pm["input"].(map[string]any)
			events = append(events, withMeta(jsonlMessageEvent{
				Role:  "tool_call",
				Tool:  tool,
				ID:    id,
				Input: input,
			}))
		}
	}
	flushText()
	return events
}

func flattenUserContent(rec map[string]any) string {
	msg, ok := rec["message"].(map[string]any)
	if !ok {
		return ""
	}
	switch c := msg["content"].(type) {
	case string:
		return c
	case []any:
		var b []string
		for _, part := range c {
			pm, ok := part.(map[string]any)
			if !ok {
				continue
			}
			// User messages may carry tool_result entries. Their
			// textual content lives in pm["content"] (string OR list
			// of blocks). We flatten anything we recognize, skip the
			// rest.
			if txt, ok := pm["text"].(string); ok && txt != "" {
				b = append(b, txt)
				continue
			}
			if pm["type"] == "tool_result" {
				if s := flattenToolResultPart(pm); s != "" {
					b = append(b, s)
				}
			}
		}
		return joinNonEmpty(b)
	}
	return ""
}

func flattenToolResultPart(pm map[string]any) string {
	if s, ok := pm["content"].(string); ok && s != "" {
		return s
	}
	if list, ok := pm["content"].([]any); ok {
		var b []string
		for _, sub := range list {
			sm, ok := sub.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := sm["text"].(string); ok && t != "" {
				b = append(b, t)
			}
		}
		return joinNonEmpty(b)
	}
	return ""
}

func flattenAssistantContent(rec map[string]any) string {
	msg, ok := rec["message"].(map[string]any)
	if !ok {
		return ""
	}
	parts, ok := msg["content"].([]any)
	if !ok {
		return ""
	}
	var b []string
	for _, part := range parts {
		pm, ok := part.(map[string]any)
		if !ok {
			continue
		}
		// Only assistant "text" parts contribute visible reply text;
		// tool_use and thinking blocks are structured metadata web
		// renders separately via the catalog turn sync path.
		if pm["type"] == "text" {
			if t, ok := pm["text"].(string); ok && t != "" {
				b = append(b, t)
			}
		}
	}
	return joinNonEmpty(b)
}

func flattenAttachmentContent(rec map[string]any) string {
	att, ok := rec["attachment"].(map[string]any)
	if !ok {
		return ""
	}
	if s, ok := att["content"].(string); ok {
		return s
	}
	// Sometimes content is a structured object/array — return its
	// JSON so the web at least sees there was something attached
	// (collapsed by AttachmentCard's <details>).
	if v, ok := att["content"]; ok {
		if b, err := json.Marshal(v); err == nil {
			return string(b)
		}
	}
	return ""
}

func joinNonEmpty(parts []string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += "\n\n"
		}
		out += p
	}
	return out
}
