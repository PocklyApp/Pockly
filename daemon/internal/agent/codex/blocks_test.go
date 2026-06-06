// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
)

// fixture is a faithful (but minimal) reproduction of a real Codex
// rollout: session_meta first, developer/user/assistant messages, a
// reasoning entry, a function_call paired with function_call_output,
// and a noisy auto-injected user message that must be filtered.
const fixture = `
{"timestamp":"2026-05-13T15:01:00Z","type":"session_meta","payload":{"id":"019e2023-8bb6-7d43-a888-86641e1a1a8d","cwd":"/tmp/codex-test","cli_version":"0.130.0","model_provider":"openai"}}
{"timestamp":"2026-05-13T15:01:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>blah</permissions instructions>"}]}}
{"timestamp":"2026-05-13T15:01:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/tmp/codex-test</cwd>\n</environment_context>"}]}}
{"timestamp":"2026-05-13T15:01:03Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}
{"timestamp":"2026-05-13T15:01:04Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list the dir"}]}}
not-valid-json-skip
{"timestamp":"2026-05-13T15:01:05Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"**Plan**\n\nRun ls."}],"encrypted_content":"opaque"}}
{"timestamp":"2026-05-13T15:01:06Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls\",\"workdir\":\"/tmp/codex-test\"}","call_id":"call_abc"}}
{"timestamp":"2026-05-13T15:01:07Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_abc","output":"README.md\n"}}
{"timestamp":"2026-05-13T15:01:08Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Found one file: README.md"}],"phase":"final"}}
{"timestamp":"2026-05-13T15:01:09Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"..."}}
`

func writeFixture(t *testing.T) (home, sessionPath string) {
	t.Helper()
	home = t.TempDir()
	dir := filepath.Join(home, "sessions", "2026", "05", "13")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "rollout-2026-05-13T15-01-00-019e2023-8bb6-7d43-a888-86641e1a1a8d.jsonl"
	sessionPath = filepath.Join(dir, name)
	if err := os.WriteFile(sessionPath, []byte(strings.TrimSpace(fixture)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return home, sessionPath
}

func TestListSessions_Fixture(t *testing.T) {
	home, _ := writeFixture(t)
	got, err := ListSessions(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d sessions, want 1", len(got))
	}
	s := got[0]
	if s.SessionID != "019e2023-8bb6-7d43-a888-86641e1a1a8d" {
		t.Errorf("SessionID = %q", s.SessionID)
	}
	if s.Cwd != "/tmp/codex-test" {
		t.Errorf("Cwd = %q", s.Cwd)
	}
	if s.Timestamp != "2026-05-13T15-01-00" {
		t.Errorf("Timestamp = %q", s.Timestamp)
	}
	if s.Archived {
		t.Errorf("Archived = true, want false")
	}
}

func TestListProjects_Fixture(t *testing.T) {
	home, _ := writeFixture(t)
	got, err := ListProjects(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d projects, want 1", len(got))
	}
	if got[0].Cwd != "/tmp/codex-test" {
		t.Errorf("Cwd = %q", got[0].Cwd)
	}
}

func TestListSessions_LiveOverArchived(t *testing.T) {
	home := t.TempDir()
	const sid = "abcd1234-0000-0000-0000-000000000001"
	const fname = "rollout-2026-01-01T00-00-00-" + sid + ".jsonl"
	live := filepath.Join(home, "sessions", "2026", "01", "01", fname)
	archived := filepath.Join(home, "archived_sessions", fname)

	body := `{"type":"session_meta","payload":{"id":"` + sid + `","cwd":"/live"}}`
	bodyArch := `{"type":"session_meta","payload":{"id":"` + sid + `","cwd":"/archived"}}`

	if err := os.MkdirAll(filepath.Dir(live), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(archived), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(live, []byte(body+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archived, []byte(bodyArch+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ListSessions(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 (de-duped), got %d", len(got))
	}
	if got[0].Cwd != "/live" {
		t.Errorf("expected live to win, got cwd=%q", got[0].Cwd)
	}
	if got[0].Archived {
		t.Errorf("expected !Archived")
	}
}

func TestFindSession_NotFound(t *testing.T) {
	home, _ := writeFixture(t)
	_, err := FindSession(home, "no-such-uuid")
	if err != ErrSessionNotFound {
		t.Errorf("want ErrSessionNotFound, got %v", err)
	}
}

func TestFindSession_OK(t *testing.T) {
	home, _ := writeFixture(t)
	s, err := FindSession(home, "019e2023-8bb6-7d43-a888-86641e1a1a8d")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(s.Path, ".jsonl") {
		t.Errorf("Path = %q", s.Path)
	}
}

func TestParseRecords_TolerateBadLines(t *testing.T) {
	_, path := writeFixture(t)
	var (
		ok, fail int
	)
	for _, err := range ParseRecords(path) {
		if err != nil {
			fail++
		} else {
			ok++
		}
	}
	if fail != 1 {
		t.Errorf("expected 1 decode error, got %d", fail)
	}
	if ok < 8 {
		t.Errorf("expected ≥8 valid records, got %d", ok)
	}
}

func TestExtractBlocks_Fixture(t *testing.T) {
	_, path := writeFixture(t)
	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}

	if got.Agent != "codex" {
		t.Errorf("agent = %q, want codex", got.Agent)
	}
	if got.SessionID != "019e2023-8bb6-7d43-a888-86641e1a1a8d" {
		t.Errorf("session id = %q", got.SessionID)
	}
	if got.Cwd != "/tmp/codex-test" {
		t.Errorf("cwd = %q", got.Cwd)
	}

	// Expected sequence:
	//   1. user "list the dir"               (developer + auto-injected user dropped)
	//   2. thinking "**Plan**\n\nRun ls."
	//   3. tool_call exec_command (paired with output)
	//   4. assistant "Found one file: README.md"
	want := []struct {
		kind agent.BlockKind
		hint string
	}{
		{agent.BlockUserMessage, "list the dir"},
		{agent.BlockThinking, "**Plan**"},
		{agent.BlockToolCall, "exec_command"},
		{agent.BlockAssistantText, "Found one file"},
	}

	if len(got.Blocks) != len(want) {
		t.Fatalf("got %d blocks, want %d. blocks: %+v", len(got.Blocks), len(want), got.Blocks)
	}

	for i, w := range want {
		b := got.Blocks[i]
		if b.Kind != w.kind {
			t.Errorf("block[%d].kind = %q, want %q", i, b.Kind, w.kind)
		}
		switch b.Kind {
		case agent.BlockUserMessage, agent.BlockAssistantText, agent.BlockThinking:
			if !strings.Contains(b.Text, w.hint) {
				t.Errorf("block[%d].text doesn't contain %q: %q", i, w.hint, b.Text)
			}
		case agent.BlockToolCall:
			if b.Tool != w.hint {
				t.Errorf("block[%d].tool = %q, want %q", i, b.Tool, w.hint)
			}
		}
	}

	// Tool call pairing.
	tc := got.Blocks[2]
	if tc.ID != "call_abc" {
		t.Errorf("tool ID = %q, want call_abc", tc.ID)
	}
	if !tc.HasResult {
		t.Errorf("tool HasResult = false, want true")
	}
	if !strings.Contains(tc.Result, "README.md") {
		t.Errorf("tool Result missing README.md: %q", tc.Result)
	}
	// Input was a JSON string in source; should be unwrapped to a JSON object.
	var args struct {
		Cmd     string `json:"cmd"`
		Workdir string `json:"workdir"`
	}
	if err := json.Unmarshal(tc.Input, &args); err != nil {
		t.Fatalf("input not a JSON object: %s, %v", string(tc.Input), err)
	}
	if args.Cmd != "ls" {
		t.Errorf("input.cmd = %q", args.Cmd)
	}
}

func TestExtractFirstUserMessage_Fixture(t *testing.T) {
	_, path := writeFixture(t)
	got := ExtractFirstUserMessage(path)
	if !strings.Contains(got, "list the dir") {
		t.Fatalf("first user message = %q, want it to contain %q", got, "list the dir")
	}
	// The auto-injected boilerplate (environment_context, etc.) must not leak
	// in — it's the first user-role record but carries zero human signal.
	if strings.Contains(got, "<environment_context>") || strings.Contains(got, "<permissions instructions>") {
		t.Fatalf("first user message leaked boilerplate: %q", got)
	}
}

func TestNoisePrefixesAreDropped(t *testing.T) {
	cases := map[string]bool{
		"<environment_context>...":         false, // dropped
		"<permissions instructions>...":    false, // dropped
		"# AGENTS.md instructions for /x":  false, // dropped
		"<collaboration_mode>Default":      false, // dropped
		"actually a real prompt here":      true,
		"  \n<environment_context>leading": false, // dropped despite leading whitespace
	}
	for body, wantKept := range cases {
		rec := Record{
			Type: "response_item",
			Payload: json.RawMessage(`{"type":"message","role":"user","content":[{"type":"input_text","text":` +
				mustJSON(body) + `}]}`),
		}
		b, ok := messageBlock(rec)
		if ok != wantKept {
			t.Errorf("body=%q: kept=%v want=%v (block=%+v)", body, ok, wantKept, b)
		}
	}
}

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestNormalizeArguments(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  string // empty = nil result
		valid bool
	}{
		{"json string wrapping object", `"{\"cmd\":\"ls\"}"`, `{"cmd":"ls"}`, true},
		{"json object directly", `{"cmd":"ls"}`, `{"cmd":"ls"}`, true},
		{"empty string", `""`, "", false},
		{"null payload", `null`, "", false},
		{"garbage in string", `"not json"`, `{"_raw":"not json"}`, true},
	}
	for _, c := range cases {
		got := normalizeArguments(json.RawMessage(c.in))
		if !c.valid {
			if got != nil {
				t.Errorf("%s: got %q, want nil", c.name, string(got))
			}
			continue
		}
		// JSON values can be re-encoded with whitespace/key order; compare structurally.
		var a, b interface{}
		if err := json.Unmarshal(got, &a); err != nil {
			t.Errorf("%s: result not valid JSON: %s, %v", c.name, string(got), err)
			continue
		}
		if err := json.Unmarshal([]byte(c.want), &b); err != nil {
			t.Fatalf("test data bad: %v", err)
		}
		if !equalJSON(a, b) {
			t.Errorf("%s: got %v, want %v", c.name, a, b)
		}
	}
}

func equalJSON(a, b interface{}) bool {
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ab) == string(bb)
}

// TestExtractBlocks_RealData runs against the user's actual ~/.codex if
// present. Skipped in CI / fresh checkouts.
func TestExtractBlocks_RealData(t *testing.T) {
	home, err := DefaultHome()
	if err != nil {
		t.Skip("no codex home")
	}
	if _, err := os.Stat(home); err != nil {
		t.Skipf("no codex home at %s", home)
	}

	sessions, err := ListSessions(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) == 0 {
		t.Skip("no codex sessions")
	}

	// Sample to keep test wall-clock down on huge histories.
	const maxSample = 10
	if len(sessions) > maxSample {
		sessions = sessions[:maxSample]
	}

	for _, s := range sessions {
		data, err := ExtractBlocks(s.Path)
		if err != nil {
			t.Errorf("%s: %v", s.Path, err)
			continue
		}
		counts := map[agent.BlockKind]int{}
		toolsTotal := 0
		toolsWithResult := 0
		for _, b := range data.Blocks {
			counts[b.Kind]++
			if b.Kind == agent.BlockToolCall {
				toolsTotal++
				if b.HasResult {
					toolsWithResult++
				}
			}
		}
		t.Logf("%s [%s]: blocks=%d (user=%d, asst=%d, think=%d, tool=%d/%d w/result)",
			s.Cwd, s.SessionID, len(data.Blocks),
			counts[agent.BlockUserMessage], counts[agent.BlockAssistantText],
			counts[agent.BlockThinking], toolsWithResult, toolsTotal)
	}
}
