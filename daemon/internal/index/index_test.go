// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRefreshBuildsSnapshot(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	codexHome := t.TempDir()

	claudeID := "11111111-1111-1111-1111-111111111111"
	claudeDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, claudeDir)
	mustWriteFile(t, filepath.Join(claudeDir, claudeID+".jsonl"), `
{"sessionId":"`+claudeID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello from claude world"}}
{"sessionId":"`+claudeID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:03Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"claude reply"}]}}
`)

	codexID := "22222222-2222-2222-2222-222222222222"
	codexDir := filepath.Join(codexHome, "sessions", "2026", "05", "18")
	mustMkdirAll(t, codexDir)
	mustWriteFile(t, filepath.Join(codexDir, "rollout-2026-05-18T10-00-00-"+codexID+".jsonl"), `
{"timestamp":"2026-05-18T10:00:00Z","type":"session_meta","payload":{"id":"`+codexID+`","cwd":"/tmp/codex/project"}}
{"timestamp":"2026-05-18T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello from codex world"}]}}
{"timestamp":"2026-05-18T10:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"codex reply"}]}}
`)

	idx := New(Config{
		ClaudeHome:      claudeHome,
		CodexHome:       codexHome,
		RefreshInterval: time.Minute,
	})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}

	projects := idx.Projects()
	if len(projects) != 2 {
		t.Fatalf("len(projects) = %d, want 2", len(projects))
	}

	var sawClaude, sawCodex bool
	for _, p := range projects {
		if len(p.Sessions) != 1 {
			t.Fatalf("%s/%s sessions = %d, want 1", p.Agent, p.Cwd, len(p.Sessions))
		}
		s := p.Sessions[0]
		switch p.Agent {
		case agentClaude:
			sawClaude = true
			if s.SessionID != claudeID {
				t.Fatalf("claude session id = %q", s.SessionID)
			}
			// Snippet stays a non-sensitive synthesised title. The
			// catalog is server-stored, so raw user prompt content here
			// would leak into sidebar metadata.
			if !strings.Contains(s.Snippet, "project") || !strings.Contains(s.Snippet, "Claude Code") {
				t.Fatalf("claude snippet = %q", s.Snippet)
			}
			if s.Timestamp == "" {
				t.Fatalf("claude timestamp = %q", s.Timestamp)
			}
		case agentCodex:
			sawCodex = true
			if s.SessionID != codexID {
				t.Fatalf("codex session id = %q", s.SessionID)
			}
			if !strings.Contains(s.Snippet, "project") || !strings.Contains(s.Snippet, "Codex") {
				t.Fatalf("codex snippet = %q", s.Snippet)
			}
			if s.Timestamp == "" {
				t.Fatalf("codex timestamp = %q", s.Timestamp)
			}
		}
	}
	if !sawClaude || !sawCodex {
		t.Fatalf("sawClaude=%v sawCodex=%v", sawClaude, sawCodex)
	}

	ref, ok := idx.FindSession(claudeID)
	if !ok || ref.Agent != agentClaude || !strings.HasSuffix(ref.Path, claudeID+".jsonl") {
		t.Fatalf("bad claude ref: %+v ok=%v", ref, ok)
	}
	ref, ok = idx.FindSession(codexID)
	if !ok || ref.Agent != agentCodex || !strings.HasSuffix(ref.Path, codexID+".jsonl") {
		t.Fatalf("bad codex ref: %+v ok=%v", ref, ok)
	}
}

func TestTruncateSingleLine(t *testing.T) {
	got := truncateSingleLine("  hello \n   world  ", 100)
	if got != "hello world" {
		t.Fatalf("got %q", got)
	}

	got = truncateSingleLine("abcdefghijklmnopqrstuvwxyz", 10)
	if got != "abcdefghi…" {
		t.Fatalf("got %q", got)
	}
}

func TestStart_WatcherPicksUpNewSessionWithoutPolling(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	idx := New(Config{
		ClaudeHome:      claudeHome,
		RefreshInterval: time.Hour,
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go idx.Start(ctx)

	time.Sleep(150 * time.Millisecond)

	sessionID := "33333333-3333-3333-3333-333333333333"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"appeared later"}}
`)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := idx.FindSession(sessionID); ok {
			projects := idx.Projects()
			if len(projects) == 1 && len(projects[0].Sessions) == 1 && strings.Contains(projects[0].Sessions[0].Snippet, "Claude Code") {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("session %s never appeared via watcher", sessionID)
}

func TestRefreshEmitsChangesOnlyWhenSnapshotChanges(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "44444444-4444-4444-4444-444444444444"
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
`)

	idx := New(Config{ClaudeHome: claudeHome})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	expectChange(t, idx.Changes())

	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	expectNoChange(t, idx.Changes())

	time.Sleep(10 * time.Millisecond)
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
`)
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	expectChange(t, idx.Changes())
}

func TestRefreshUpdatesTurnCountWhenSessionFileChanges(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "55555555-5555-5555-5555-555555555555"
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
`)
	idx := New(Config{ClaudeHome: claudeHome})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	projects := idx.Projects()
	if got := projects[0].Sessions[0].TurnCount; got != 1 {
		t.Fatalf("initial TurnCount = %d, want 1", got)
	}

	time.Sleep(10 * time.Millisecond)
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
`)
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	projects = idx.Projects()
	if got := projects[0].Sessions[0].TurnCount; got != 2 {
		t.Fatalf("updated TurnCount = %d, want 2", got)
	}
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

func expectChange(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for change notification")
	}
}

func expectNoChange(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal("unexpected change notification")
	case <-time.After(100 * time.Millisecond):
	}
}
