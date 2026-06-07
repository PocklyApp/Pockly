// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"testing"
)

// TestParseHookPayload covers the realistic shapes claude writes for
// the hook types we care about. We deliberately don't test every
// field (the spec evolves) — only that:
//   - valid JSON → no error + the few fields we use roundtrip
//   - empty body → zero payload + no error (defensive degradation)
//   - malformed JSON → error
func TestParseHookPayload(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantErr     bool
		wantTool    string
		wantSession string
	}{
		{
			name: "PreToolUse Bash",
			body: `{
				"session_id": "sess_aaa",
				"transcript_path": "/Users/dev/.claude/projects/x/sess_aaa.jsonl",
				"hook_event_name": "PreToolUse",
				"tool_name": "Bash",
				"tool_input": {"command": "ls -la"}
			}`,
			wantTool:    "Bash",
			wantSession: "sess_aaa",
		},
		{
			name: "PreToolUse Edit",
			body: `{
				"session_id": "sess_bbb",
				"hook_event_name": "PreToolUse",
				"tool_name": "Edit",
				"tool_input": {"file_path":"/tmp/x","old_string":"a","new_string":"b"}
			}`,
			wantTool:    "Edit",
			wantSession: "sess_bbb",
		},
		{
			name: "PreToolUse Skill (no tool_input)",
			body: `{
				"session_id": "sess_ccc",
				"hook_event_name": "PreToolUse",
				"tool_name": "Skill"
			}`,
			wantTool:    "Skill",
			wantSession: "sess_ccc",
		},
		{
			name: "unknown future fields ignored",
			body: `{
				"session_id": "sess_ddd",
				"hook_event_name": "PreToolUse",
				"tool_name": "Bash",
				"tool_input": {"command":"ls"},
				"some_future_field": {"nested": [1, 2, 3]}
			}`,
			wantTool:    "Bash",
			wantSession: "sess_ddd",
		},
		{
			name: "empty body — no-op, no error",
			body: "",
		},
		{
			name: "only whitespace — same",
			body: "   \n\t  ",
		},
		{
			name:    "malformed JSON",
			body:    `{"session_id": "sess_eee", "tool_name":`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseHookPayload([]byte(tc.body))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.ToolName != tc.wantTool {
				t.Errorf("ToolName: got %q, want %q", got.ToolName, tc.wantTool)
			}
			if got.SessionID != tc.wantSession {
				t.Errorf("SessionID: got %q, want %q", got.SessionID, tc.wantSession)
			}
		})
	}
}

// TestWriteEmptyDecision verifies the empty hook response that makes Claude
// fall back to its built-in prompt. Has to be {}\n exactly; anything else gets
// parsed as a real decision and could surprise Claude.
func TestWriteEmptyDecision(t *testing.T) {
	var buf bytes.Buffer
	if err := writeEmptyDecision(&buf); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "{}\n" {
		t.Fatalf("got %q, want %q", got, "{}\n")
	}
}
