// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package relay

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
)

var claudeProfile = runner.Profile{ClaudeAlias: runner.AliasClaude}

func TestBuildSyncRequestStableSeq(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "11111111-1111-1111-1111-111111111111"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello from claude"}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"claude reply"}]}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:02Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/x"}}]}}
`)+"\n")

	idx := index.New(index.Config{
		ClaudeHome:      claudeHome,
		RefreshInterval: time.Minute,
	})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	req1, err := BuildSyncRequest(idx, "dd_test", claudeProfile)
	if err != nil {
		t.Fatal(err)
	}
	req2, err := BuildSyncRequest(idx, "dd_test", claudeProfile)
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(req1, req2) {
		t.Fatalf("sync request not stable\nreq1=%+v\nreq2=%+v", req1, req2)
	}
	if req1.Hello.DeviceID != "dd_test" {
		t.Fatalf("hello.device_id = %q", req1.Hello.DeviceID)
	}
	if len(req1.Sessions) != 1 || req1.Sessions[0].LastSeq != 0 || req1.Sessions[0].SyncState != "catalog_only" {
		t.Fatalf("unexpected sessions: %+v", req1.Sessions)
	}
	if req1.Sessions[0].RunnerAlias != "claude" {
		t.Fatalf("runner alias = %q, want claude", req1.Sessions[0].RunnerAlias)
	}
	if req1.Sessions[0].ChannelLastSeenAt == "" {
		t.Fatalf("expected catalog channel_last_seen_at to be set")
	}
	// The catalog carries metadata only; turns ride the per-session sync.
	if len(req1.Turns) != 0 {
		t.Fatalf("len(turns) = %d, want 0 on a catalog sync", len(req1.Turns))
	}
	// E2E removed: the sidebar snippet is the real first user message, in
	// plaintext (no per-recipient ciphertext).
	if req1.Sessions[0].Snippet != "hello from claude" {
		t.Fatalf("snippet = %q, want the plaintext first message", req1.Sessions[0].Snippet)
	}
}

func TestBuildSingleSessionSyncRequestEmitsPlaintextTurns(t *testing.T) {
	idx := fixtureIndex(t)
	req, err := BuildSingleSessionSyncRequest(idx, "dd_test", "11111111-1111-1111-1111-111111111111", claudeProfile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Turns) != 3 {
		t.Fatalf("len(turns) = %d, want 3 plaintext turns", len(req.Turns))
	}
	if len(req.Sessions) != 1 || req.Sessions[0].RunnerAlias != "claude" || req.Sessions[0].ChannelLastSeenAt != "2026-05-18T10:00:02Z" {
		t.Fatalf("unexpected session metadata: %+v", req.Sessions)
	}
	for i, turn := range req.Turns {
		if turn.Seq != i+1 {
			t.Fatalf("turn[%d].seq = %d, want %d", i, turn.Seq, i+1)
		}
		if turn.SessionID != "11111111-1111-1111-1111-111111111111" {
			t.Fatalf("turn[%d].session_id = %q", i, turn.SessionID)
		}
	}
	// Plaintext now: the content the relay stores IS the conversation.
	raw, _ := json.Marshal(req.Turns)
	for _, want := range []string{"hello from claude", "Read"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("plaintext turns missing %q: %s", want, raw)
		}
	}
}

func TestBuildCatalogSyncRequestIncludesSupportedAgentSessions(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, ".claude", "projects")
	codexHome := filepath.Join(root, ".codex")
	mustMkdirAll(t, filepath.Join(claudeHome, "-claude-project"))

	claudeID := "33333333-3333-3333-3333-333333333333"
	codexID := "44444444-4444-4444-4444-444444444444"
	mustWriteFile(t, filepath.Join(claudeHome, "-claude-project", claudeID+".jsonl"), `{"sessionId":"`+claudeID+`","cwd":"/tmp/claude","timestamp":"2026-05-20T10:00:00Z","type":"user","message":{"role":"user","content":"hi"}}`+"\n")
	writeCodexRollout(t, codexHome, "2026-05-20T10-00-01", codexID, "/tmp/codex", "hello from codex", "codex reply")

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	req, err := BuildCatalogSyncRequest(idx, "dd_test", claudeProfile)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Sessions) != 2 {
		t.Fatalf("len(sessions) = %d, want 2", len(req.Sessions))
	}
	agentsByID := map[string]string{}
	for _, session := range req.Sessions {
		agentsByID[session.SessionID] = session.Agent
	}
	if agentsByID[claudeID] != "claude-code" {
		t.Fatalf("claude session agent = %q, want claude-code; sessions=%+v", agentsByID[claudeID], req.Sessions)
	}
	if agentsByID[codexID] != "codex" {
		t.Fatalf("codex session agent = %q, want codex; sessions=%+v", agentsByID[codexID], req.Sessions)
	}
}

func TestBuildSingleSessionSyncRequestEmitsCodexTurns(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, ".claude", "projects")
	codexHome := filepath.Join(root, ".codex")
	codexID := "55555555-5555-5555-5555-555555555555"
	writeCodexRollout(t, codexHome, "2026-05-21T09-00-00", codexID, "/tmp/codex-sync", "list codex files", "codex found README.md")

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	req, err := BuildSingleSessionSyncRequest(idx, "dd_test", codexID, claudeProfile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Sessions) != 1 {
		t.Fatalf("len(sessions) = %d, want 1", len(req.Sessions))
	}
	if req.Sessions[0].Agent != "codex" {
		t.Fatalf("session agent = %q, want codex", req.Sessions[0].Agent)
	}
	if req.Sessions[0].Cwd != "codex-sync" {
		t.Fatalf("session cwd = %q, want codex-sync", req.Sessions[0].Cwd)
	}
	if len(req.Turns) != 2 {
		t.Fatalf("len(turns) = %d, want 2 codex turns", len(req.Turns))
	}
	for i, turn := range req.Turns {
		if turn.Agent != "codex" {
			t.Fatalf("turn[%d].agent = %q, want codex", i, turn.Agent)
		}
		if turn.Seq != i+1 {
			t.Fatalf("turn[%d].seq = %d, want %d", i, turn.Seq, i+1)
		}
	}
	raw, _ := json.Marshal(req.Turns)
	for _, want := range []string{"list codex files", "codex found README.md"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("codex turns missing %q: %s", want, raw)
		}
	}
}

func TestBuildCatalogSyncRequestPropagatesRunnerAlias(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "22222222-2222-2222-2222-222222222222"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-20T10:00:00Z","type":"user","message":{"role":"user","content":"hi"}}
`)+"\n")

	idx := index.New(index.Config{ClaudeHome: claudeHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		profile runner.Profile
		want    string
	}{
		{"claude", runner.Profile{ClaudeAlias: runner.AliasClaude}, "claude"},
		{"claude_ccr", runner.Profile{ClaudeAlias: runner.AliasClaudeCCR}, "claude_ccr"},
		{"custom", runner.Profile{ClaudeAlias: runner.AliasCustom}, "custom"},
		{"unknown_profile_emits_empty", runner.Profile{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := BuildCatalogSyncRequest(idx, "dd_test", tc.profile)
			if err != nil {
				t.Fatal(err)
			}
			if len(req.Sessions) != 1 {
				t.Fatalf("len(sessions) = %d, want 1", len(req.Sessions))
			}
			if got := req.Sessions[0].RunnerAlias; got != tc.want {
				t.Fatalf("runner alias = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildSingleSessionSyncRequestPropagatesRunnerAlias(t *testing.T) {
	idx := fixtureIndex(t)

	cases := []struct {
		name    string
		profile runner.Profile
		want    string
	}{
		{"claude", runner.Profile{ClaudeAlias: runner.AliasClaude}, "claude"},
		{"claude_ccr", runner.Profile{ClaudeAlias: runner.AliasClaudeCCR}, "claude_ccr"},
		{"custom", runner.Profile{ClaudeAlias: runner.AliasCustom}, "custom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := BuildSingleSessionSyncRequest(idx, "dd_test", "11111111-1111-1111-1111-111111111111", tc.profile, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(req.Sessions) != 1 {
				t.Fatalf("len(sessions) = %d, want 1", len(req.Sessions))
			}
			if got := req.Sessions[0].RunnerAlias; got != tc.want {
				t.Fatalf("runner alias = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSelectBlockWindowLatestAndOlderChunks(t *testing.T) {
	blocks := make([]agent.Block, 100)
	for i := range blocks {
		blocks[i] = agent.Block{Kind: agent.BlockAssistantText, Text: "turn"}
	}

	latest, minSeq, maxSeq, hasOlder := selectBlockWindow(blocks, SessionWindow{Limit: 20})
	if len(latest) != 20 || minSeq != 81 || maxSeq != 100 || !hasOlder {
		t.Fatalf("latest window len=%d min=%d max=%d hasOlder=%v, want 20/81/100/true", len(latest), minSeq, maxSeq, hasOlder)
	}

	older, minSeq, maxSeq, hasOlder := selectBlockWindow(blocks, SessionWindow{Limit: 20, BeforeSeq: 81})
	if len(older) != 20 || minSeq != 61 || maxSeq != 80 || !hasOlder {
		t.Fatalf("older window len=%d min=%d max=%d hasOlder=%v, want 20/61/80/true", len(older), minSeq, maxSeq, hasOlder)
	}

	oldest, minSeq, maxSeq, hasOlder := selectBlockWindow(blocks, SessionWindow{Limit: 20, BeforeSeq: 21})
	if len(oldest) != 20 || minSeq != 1 || maxSeq != 20 || hasOlder {
		t.Fatalf("oldest window len=%d min=%d max=%d hasOlder=%v, want 20/1/20/false", len(oldest), minSeq, maxSeq, hasOlder)
	}
}

func TestPayloadForBlockCarriesRichRendererFields(t *testing.T) {
	payload, err := payloadForBlock(agent.Block{
		Kind:                agent.BlockImage,
		UUID:                "u-rich",
		Text:                "hidden text",
		ParentToolUseID:     "tu_task",
		IsSidechain:         true,
		InputTokens:         123,
		OutputTokens:        45,
		CacheCreationTokens: 67,
		CacheReadTokens:     89,
		ImageMediaType:      "image/png",
		ImageData:           "AAAA",
		ImageURL:            "https://example.test/image.png",
	})
	if err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"uuid":                        "u-rich",
		"text":                        "hidden text",
		"parent_tool_use_id":          "tu_task",
		"is_sidechain":                true,
		"input_tokens":                float64(123),
		"output_tokens":               float64(45),
		"cache_creation_input_tokens": float64(67),
		"cache_read_input_tokens":     float64(89),
		"image_media_type":            "image/png",
		"image_data":                  "AAAA",
		"image_url":                   "https://example.test/image.png",
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("payload[%q] = %#v, want %#v in %s", key, got[key], value, payload)
		}
	}
}

// TestPayloadForBlockCarriesEditDiff verifies the v2 edit-diff projection:
// Claude's structuredPatch + filePath + userModified reach the wire payload so
// the web can show which files changed.
func TestPayloadForBlockCarriesEditDiff(t *testing.T) {
	patch := json.RawMessage(`[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":1,"lines":["+hello"]}]`)
	payload, err := payloadForBlock(agent.Block{
		Kind:             agent.BlockToolResult,
		ID:               "tu_edit",
		Result:           "ok",
		HasResult:        true,
		EditFilePath:     "/proj/file.go",
		EditPatch:        patch,
		EditUserModified: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatal(err)
	}
	if got["edit_file_path"] != "/proj/file.go" {
		t.Fatalf("edit_file_path = %#v in %s", got["edit_file_path"], payload)
	}
	if got["edit_user_modified"] != true {
		t.Fatalf("edit_user_modified = %#v in %s", got["edit_user_modified"], payload)
	}
	hunks, ok := got["edit_patch"].([]any)
	if !ok || len(hunks) != 1 {
		t.Fatalf("edit_patch not a 1-hunk array: %#v in %s", got["edit_patch"], payload)
	}

	// A non-edit block must not carry any edit_* keys.
	bare, err := payloadForBlock(agent.Block{Kind: agent.BlockToolResult, ID: "tu_bash", Result: "hi", HasResult: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"edit_file_path", "edit_patch", "edit_user_modified"} {
		if strings.Contains(string(bare), k) {
			t.Fatalf("non-edit payload unexpectedly contains %q: %s", k, bare)
		}
	}
}

func TestBuildSingleSessionSyncRequestEmitsRichRendererFields(t *testing.T) {
	idx := richFixtureIndex(t)
	req, err := BuildSingleSessionSyncRequest(idx, "dd_test", "55555555-5555-5555-5555-555555555555", claudeProfile, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Turns) < 4 {
		t.Fatalf("len(turns) = %d, want at least 4 rich blocks", len(req.Turns))
	}
	// Plaintext: the rich renderer fields are present verbatim (no longer
	// hidden inside ciphertext).
	raw, _ := json.Marshal(req.Turns)
	for _, want := range []string{"sub starting", "image/png", "AAAA", "tu_task", "input_tokens"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("plaintext rich turns missing field %q: %s", want, raw)
		}
	}
}

func fixtureIndex(t *testing.T) *index.Index {
	t.Helper()
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "11111111-1111-1111-1111-111111111111"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello from claude"}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"claude reply"}]}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:02Z","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/x"}}]}}
`)+"\n")

	idx := index.New(index.Config{
		ClaudeHome:      claudeHome,
		RefreshInterval: time.Minute,
	})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	return idx
}

func richFixtureIndex(t *testing.T) *index.Index {
	t.Helper()
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-rich-project")
	mustMkdirAll(t, projectDir)

	sessionID := "55555555-5555-5555-5555-555555555555"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/rich/project","timestamp":"2026-05-20T10:00:00Z","type":"user","uuid":"u-start","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}}
{"sessionId":"`+sessionID+`","timestamp":"2026-05-20T10:00:01Z","type":"assistant","uuid":"a-task","parentUuid":"u-start","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_task","name":"Task","input":{"description":"search","prompt":"do work"}}],"usage":{"input_tokens":123,"output_tokens":45,"cache_creation_input_tokens":67,"cache_read_input_tokens":89}}}
{"sessionId":"`+sessionID+`","timestamp":"2026-05-20T10:00:02Z","type":"assistant","uuid":"a-sub","parentUuid":"a-task","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub starting"}]}}
`)+"\n")

	idx := index.New(index.Config{
		ClaudeHome:      claudeHome,
		RefreshInterval: time.Minute,
	})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	return idx
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeCodexRollout(t *testing.T, codexHome, tsDash, sessionID, cwd, userText, assistantText string) string {
	t.Helper()
	if len(tsDash) != len("2026-05-20T10-00-00") {
		t.Fatalf("bad codex rollout timestamp %q", tsDash)
	}
	recordTS := tsDash[:13] + ":" + tsDash[14:16] + ":" + tsDash[17:19] + "Z"
	dir := filepath.Join(codexHome, "sessions", tsDash[0:4], tsDash[5:7], tsDash[8:10])
	mustMkdirAll(t, dir)
	path := filepath.Join(dir, "rollout-"+tsDash+"-"+sessionID+".jsonl")

	var lines []string
	lines = append(lines, fmt.Sprintf(`{"timestamp":%q,"type":"session_meta","payload":{"id":%q,"cwd":%q}}`, recordTS, sessionID, cwd))
	if userText != "" {
		lines = append(lines, fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":%q}]}}`, recordTS, userText))
	}
	if assistantText != "" {
		lines = append(lines, fmt.Sprintf(`{"timestamp":%q,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":%q}]}}`, recordTS, assistantText))
	}
	mustWriteFile(t, path, strings.Join(lines, "\n")+"\n")
	return path
}

// TestBuildCatalogSyncRequestBoundsBodyToByteBudget is the regression for the
// production 413: a daemon with thousands of sessions built a catalog sync POST
// that blew past nginx's 1 MiB client_max_body_size, so every sync 413'd and
// the relay catalog never updated. The build must cap the body under
// catalogSyncMaxBytes, keeping the MOST RECENT sessions (oldest dropped first).
//
// (Pre-E2E-removal the bulk was per-recipient ciphertext; now it's the
// plaintext metadata + 140-char snippet per session, so the fixture needs more
// sessions to cross the budget — but the cap logic under test is identical.)
func TestBuildCatalogSyncRequestBoundsBodyToByteBudget(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, ".claude", "projects")
	codexHome := filepath.Join(root, ".codex")
	// Two projects with different cwds so the global recency sort matters
	// (idx.Projects() orders projects by cwd, not recency).
	projectDirs := []string{
		filepath.Join(claudeHome, "-tmp-alpha"),
		filepath.Join(claudeHome, "-tmp-bravo"),
	}
	for _, d := range projectDirs {
		mustMkdirAll(t, d)
	}

	// A first message that exceeds the 140-char sidebar cap so every session's
	// plaintext snippet is at its maximum size — the body's bulk.
	bigMessage := strings.Repeat("the quick brown fox jumps ", 10) // ~260 chars → capped to 140

	const total = 3000
	const totalEligible = total + 2
	// sessionTimestamp(i): higher i == more recent. Track them so we can
	// assert the cap keeps the newest sessions.
	tsByID := make(map[string]string, totalEligible)
	for i := 0; i < total; i++ {
		sid := fmt.Sprintf("%08d-1111-1111-1111-111111111111", i)
		tsTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute)
		ts := tsTime.Format(time.RFC3339Nano)
		tsByID[sid] = ts
		cwd := "/tmp/alpha"
		dir := projectDirs[0]
		if i%2 == 1 {
			cwd = "/tmp/bravo"
			dir = projectDirs[1]
		}
		line := fmt.Sprintf(`{"sessionId":%q,"cwd":%q,"timestamp":%q,"type":"user","message":{"role":"user","content":%q}}`+"\n",
			sid, cwd, ts, bigMessage)
		path := filepath.Join(dir, sid+".jsonl")
		mustWriteFile(t, path, line)
		if err := os.Chtimes(path, tsTime, tsTime); err != nil {
			t.Fatal(err)
		}
	}

	recentCodexID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	oldCodexID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	writeCodexRollout(t, codexHome, "2026-01-04T00-00-00", recentCodexID, "/tmp/codex-new", "codex latest", "codex answer")
	writeCodexRollout(t, codexHome, "2025-12-31T23-59-59", oldCodexID, "/tmp/codex-old", "codex oldest", "codex old answer")
	tsByID[recentCodexID] = "2026-01-04T00-00-00"
	tsByID[oldCodexID] = "2025-12-31T23-59-59"

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	req, err := BuildCatalogSyncRequest(idx, "dd_test", claudeProfile)
	if err != nil {
		t.Fatal(err)
	}
	req.FullReconcile = true

	// 1. The marshaled body must be under the budget (and thus under nginx's
	//    1 MiB limit). This is the core invariant the 413 violated.
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > catalogSyncMaxBytes {
		t.Fatalf("catalog sync body = %d bytes, exceeds budget %d", len(body), catalogSyncMaxBytes)
	}

	// 2. The cap must actually have triggered (otherwise the test isn't
	//    exercising the bound — the fixture would need more/bigger sessions).
	if len(req.Sessions) >= totalEligible {
		t.Fatalf("expected the cap to drop some of %d sessions, kept %d (body=%d bytes); fixture too small to exercise the bound", totalEligible, len(req.Sessions), len(body))
	}
	if len(req.Sessions) == 0 {
		t.Fatal("catalog sync dropped ALL sessions; expected the most recent ones to survive")
	}

	// 3. The kept sessions must be the MOST RECENT ones: every dropped
	//    session's timestamp must be <= every kept session's timestamp.
	kept := make(map[string]bool, len(req.Sessions))
	minKeptTS := ""
	for _, s := range req.Sessions {
		kept[s.SessionID] = true
		if minKeptTS == "" || s.LastTimestamp < minKeptTS {
			minKeptTS = s.LastTimestamp
		}
	}
	for sid, ts := range tsByID {
		if !kept[sid] && ts > minKeptTS {
			t.Fatalf("dropped session %s (ts=%s) is NEWER than kept session min ts=%s — recency ordering broken", sid, ts, minKeptTS)
		}
	}
	if !kept[recentCodexID] {
		t.Fatalf("recent codex session was dropped despite being newest; min kept ts=%s", minKeptTS)
	}
	if kept[oldCodexID] {
		t.Fatalf("old codex session was kept while the catalog cap dropped newer sessions")
	}
}
