// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package codex — block extraction from Codex rollouts.
//
// Translates spike/codex_blocks.py. Codex's response_item shapes
// (message / function_call / function_call_output / reasoning) map to
// the same agent.Block kinds claude produces, so the renderer is shared.
package codex

import (
	"encoding/json"
	"strings"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
)

// noisePrefixes are the auto-injected user-message prefixes Codex prepends
// to every fresh session: environment context, permissions instructions,
// AGENTS.md docs, collaboration mode framing. They are addressed at the
// agent and contain zero signal for a human reader.
var noisePrefixes = []string{
	"<environment_context>",
	"<permissions instructions>",
	"# AGENTS.md instructions",
	"<collaboration_mode>",
}

// ExtractFirstUserMessage returns the first human user message in the Codex
// rollout at path, with the auto-injected boilerplate prefixes already
// dropped (see ExtractBlocks). Returns "" when no usable message is found.
func ExtractFirstUserMessage(path string) string {
	for rec, decErr := range ParseRecords(path) {
		if decErr != nil || rec.Type != "response_item" {
			continue
		}
		var head struct {
			Type string `json:"type"`
			Role string `json:"role"`
		}
		if err := json.Unmarshal(rec.Payload, &head); err != nil || head.Type != "message" || head.Role != "user" {
			continue
		}
		if b, ok := messageBlock(rec); ok && b.Kind == agent.BlockUserMessage && strings.TrimSpace(b.Text) != "" {
			return b.Text
		}
	}
	return ""
}

// ExtractBlocks reads the rollout at path and produces canonical blocks.
//
// Behavior parity with spike/codex_blocks.py:
//   - Only response_item records contribute. event_msg / turn_context /
//     token_count / session_meta are scanned for metadata only.
//   - response_item.message with role=developer is dropped (system noise).
//   - response_item.message with role=user gets dropped if the body
//     starts with a known noisePrefix (auto-injected boilerplate).
//   - reasoning becomes a thinking block.
//   - function_call + matching function_call_output get fused via call_id.
//
// Read errors return whatever was extracted so far.
func ExtractBlocks(path string) (agent.SessionBlocks, error) {
	out := agent.SessionBlocks{Agent: "codex"}

	// Index function_call_output by call_id ahead of the main scan so
	// out-of-order pairings still work.
	results, err := indexFunctionOutputs(path)
	if err != nil {
		return out, err
	}

	for rec, decErr := range ParseRecords(path) {
		if decErr != nil {
			continue
		}

		// Pull session-level metadata as we encounter it.
		switch rec.Type {
		case "session_meta":
			var pl struct {
				ID  string `json:"id"`
				Cwd string `json:"cwd"`
			}
			if err := json.Unmarshal(rec.Payload, &pl); err == nil {
				if out.SessionID == "" {
					out.SessionID = pl.ID
				}
				if out.Cwd == "" {
					out.Cwd = pl.Cwd
				}
			}
			continue
		case "response_item":
			// fall through
		default:
			continue
		}

		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rec.Payload, &head); err != nil {
			continue
		}

		switch head.Type {
		case "message":
			if b, ok := messageBlock(rec); ok {
				out.Blocks = append(out.Blocks, b)
			}
		case "reasoning":
			if b, ok := reasoningBlock(rec); ok {
				out.Blocks = append(out.Blocks, b)
			}
		case "function_call":
			if b, ok := functionCallBlock(rec, results); ok {
				out.Blocks = append(out.Blocks, b)
			}
			// function_call_output is consumed via the index; no own block.
		}
	}

	return out, nil
}

// payloadMessage matches response_item.message payloads.
type payloadMessage struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

func messageBlock(rec Record) (agent.Block, bool) {
	var pl payloadMessage
	if err := json.Unmarshal(rec.Payload, &pl); err != nil {
		return agent.Block{}, false
	}

	text := flattenMessageContent(pl.Content)
	if text == "" {
		return agent.Block{}, false
	}

	switch pl.Role {
	case "user":
		// Drop the auto-injected boilerplate first user messages.
		stripped := strings.TrimSpace(text)
		for _, p := range noisePrefixes {
			if strings.HasPrefix(stripped, p) {
				return agent.Block{}, false
			}
		}
		return agent.Block{
			Kind:      agent.BlockUserMessage,
			Text:      text,
			Timestamp: rec.Timestamp,
		}, true
	case "assistant":
		return agent.Block{
			Kind:      agent.BlockAssistantText,
			Text:      text,
			Timestamp: rec.Timestamp,
		}, true
	default:
		// developer / tool / system — all silenced for the human view.
		return agent.Block{}, false
	}
}

// flattenMessageContent handles Codex's content shape: an array of
// {type:"input_text"|"output_text"|"text", text:"..."} parts. Raw strings
// are also accepted (defensive; spike data shows arrays only).
func flattenMessageContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if isJSONString(raw) {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	if !isJSONArray(raw) {
		return ""
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	var buf []byte
	for _, p := range parts {
		switch p.Type {
		case "input_text", "output_text", "text":
			if p.Text == "" {
				continue
			}
			if len(buf) > 0 {
				buf = append(buf, '\n')
			}
			buf = append(buf, p.Text...)
		case "input_image":
			if len(buf) > 0 {
				buf = append(buf, '\n')
			}
			buf = append(buf, "[image]"...)
		}
	}
	return string(buf)
}

// payloadReasoning matches response_item.reasoning. We intentionally
// expose only the human-readable summary; encrypted_content is opaque
// and content is rarely used.
type payloadReasoning struct {
	Type    string             `json:"type"`
	Summary []reasoningSummary `json:"summary"`
}

type reasoningSummary struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func reasoningBlock(rec Record) (agent.Block, bool) {
	var pl payloadReasoning
	if err := json.Unmarshal(rec.Payload, &pl); err != nil {
		return agent.Block{}, false
	}
	text := flattenReasoning(pl.Summary)
	if text == "" {
		return agent.Block{}, false
	}
	return agent.Block{
		Kind:      agent.BlockThinking,
		Text:      text,
		Timestamp: rec.Timestamp,
	}, true
}

func flattenReasoning(parts []reasoningSummary) string {
	var buf []byte
	for _, p := range parts {
		if p.Type != "summary_text" || p.Text == "" {
			continue
		}
		if len(buf) > 0 {
			buf = append(buf, '\n', '\n')
		}
		buf = append(buf, p.Text...)
	}
	return string(buf)
}

// payloadFunctionCall matches response_item.function_call.
type payloadFunctionCall struct {
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	CallID    string          `json:"call_id"`
}

func functionCallBlock(rec Record, results map[string]functionResult) (agent.Block, bool) {
	var pl payloadFunctionCall
	if err := json.Unmarshal(rec.Payload, &pl); err != nil {
		return agent.Block{}, false
	}

	// arguments is sometimes a JSON string containing a JSON object,
	// sometimes a JSON object directly. Normalize to a JSON object so
	// the renderer can treat input uniformly.
	input := normalizeArguments(pl.Arguments)

	b := agent.Block{
		Kind:      agent.BlockToolCall,
		Tool:      defaultIfEmpty(pl.Name, "Unknown"),
		ID:        pl.CallID,
		Input:     input,
		Timestamp: rec.Timestamp,
	}
	if r, ok := results[pl.CallID]; ok {
		b.Result = r.Output
		b.IsError = r.IsError
		b.HasResult = true
	}
	return b, true
}

// normalizeArguments handles Codex's two-shaped `arguments` field:
//   - JSON string (the common form): "{"cmd":"ls","workdir":"..."}"
//     → unwrap once, return the inner object as RawMessage
//   - JSON object directly (rare/older): {"cmd":"ls"} → pass through
//   - empty/null/garbage → null RawMessage so omitempty hides it
func normalizeArguments(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	if isJSONNull(raw) {
		return nil
	}
	if isJSONString(raw) {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return nil
		}
		// Validate it parses as JSON before returning; if not, wrap as
		// {"_raw": "..."} so the user can still see it.
		if json.Valid([]byte(s)) {
			return json.RawMessage(s)
		}
		wrapped, _ := json.Marshal(map[string]string{"_raw": s})
		return wrapped
	}
	if json.Valid(raw) {
		return raw
	}
	return nil
}

func isJSONNull(b json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(b))
	return trimmed == "null"
}

// functionResult is the indexed form of a function_call_output.
type functionResult struct {
	Output  string
	IsError bool
}

// payloadFunctionCallOutput matches response_item.function_call_output.
//
// `output` can be a string OR a structured object/array. The
// flattenFunctionOutput helper handles both.
type payloadFunctionCallOutput struct {
	Type   string          `json:"type"`
	CallID string          `json:"call_id"`
	Output json.RawMessage `json:"output"`
}

func indexFunctionOutputs(path string) (map[string]functionResult, error) {
	out := map[string]functionResult{}
	for rec, err := range ParseRecords(path) {
		if err != nil {
			continue
		}
		if rec.Type != "response_item" {
			continue
		}
		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rec.Payload, &head); err != nil {
			continue
		}
		if head.Type != "function_call_output" {
			continue
		}
		var pl payloadFunctionCallOutput
		if err := json.Unmarshal(rec.Payload, &pl); err != nil {
			continue
		}
		if pl.CallID == "" {
			continue
		}
		out[pl.CallID] = functionResult{
			Output: flattenFunctionOutput(pl.Output),
			// Codex doesn't separately tag errors here; UI infers from
			// exit codes / aggregated_output text in the live event
			// stream. Offline view shows IsError=false.
		}
	}
	return out, nil
}

func flattenFunctionOutput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if isJSONString(raw) {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	// Arbitrary structured output → JSON dump so info isn't lost.
	if json.Valid(raw) {
		return string(raw)
	}
	return ""
}

func defaultIfEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func isJSONString(b json.RawMessage) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '"':
			return true
		default:
			return false
		}
	}
	return false
}

func isJSONArray(b json.RawMessage) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '[':
			return true
		default:
			return false
		}
	}
	return false
}
