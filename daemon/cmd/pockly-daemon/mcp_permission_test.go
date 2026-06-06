// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"testing"
)

func TestMCPPermissionDenyMessageIsClaudeNative(t *testing.T) {
	srv := &mcpPermServer{}
	raw := srv.wrapDecision("deny", json.RawMessage(`{"command":"pwd"}`), "operator denied")
	outer, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("wrapDecision returned %T", raw)
	}
	content, ok := outer["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("content = %#v", outer["content"])
	}
	block, ok := content[0].(map[string]any)
	if !ok {
		t.Fatalf("content block = %#v", content[0])
	}
	text, ok := block["text"].(string)
	if !ok {
		t.Fatalf("content text = %#v", block["text"])
	}
	var decision map[string]any
	if err := json.Unmarshal([]byte(text), &decision); err != nil {
		t.Fatalf("decision text is not JSON: %v", err)
	}
	if decision["behavior"] != "deny" {
		t.Fatalf("behavior = %v, want deny", decision["behavior"])
	}
	if decision["message"] != "operator denied" {
		t.Fatalf("message = %v, want raw Claude-facing reason without Pockly prefix", decision["message"])
	}
}
