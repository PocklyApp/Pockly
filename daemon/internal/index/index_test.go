// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"context"
	"database/sql"
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
	mustWriteFile(t, filepath.Join(codexHome, "session_index.jsonl"), `
{"id":"`+codexID+`","thread_name":"old generated title","updated_at":"2026-05-18T10:00:02Z"}
{"id":"`+codexID+`","thread_name":"Generated Network Title","updated_at":"2026-05-18T10:00:05Z"}
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
			if s.Title != "Generated Network Title" {
				t.Fatalf("codex title = %q, want Codex thread_name", s.Title)
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

func TestReadCodexSessionTitlesPrefersSessionIndexLatestEntry(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "11111111-2222-3333-4444-555555555555"
	mustWriteFile(t, filepath.Join(codexHome, "session_index.jsonl"), `
{"id":"`+sessionID+`","thread_name":"Old Draft Title","updated_at":"2026-06-24T14:33:00Z"}
{"id":"`+sessionID+`","thread_name":"Final Generated Title","updated_at":"2026-06-24T14:34:00Z"}
`)

	titles := readCodexSessionTitles(codexHome)
	if got := titles[sessionID]; got != "Final Generated Title" {
		t.Fatalf("title = %q, want latest session_index thread_name", got)
	}
}

func TestReadCodexSessionTitlesFallsBackToStateDB(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "22222222-2222-2222-2222-222222222222"
	writeCodexStateDBTitle(t, filepath.Join(codexHome, "state_5.sqlite"), sessionID, "State DB Title")

	titles := readCodexSessionTitles(codexHome)
	if got := titles[sessionID]; got != "State DB Title" {
		t.Fatalf("title = %q, want state_5.sqlite title", got)
	}
}

func TestReadCodexSessionTitlesSessionIndexBeatsStateDB(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "33333333-3333-3333-3333-333333333333"
	mustWriteFile(t, filepath.Join(codexHome, "session_index.jsonl"), `{"id":"`+sessionID+`","thread_name":"Session Index Title"}`+"\n")
	writeCodexStateDBTitle(t, filepath.Join(codexHome, "state_5.sqlite"), sessionID, "State DB Title")

	titles := readCodexSessionTitles(codexHome)
	if got := titles[sessionID]; got != "Session Index Title" {
		t.Fatalf("title = %q, want session_index title", got)
	}
}

func TestCodexArchivedStateFiltersCatalogAndLookup(t *testing.T) {
	codexHome := t.TempDir()
	liveID := "44444444-4444-4444-4444-444444444444"
	archivedID := "55555555-5555-5555-5555-555555555555"
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", liveID, "2026-06-29T08-41-34", "/tmp/codex/project", "live")
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", archivedID, "2026-06-29T08-42-34", "/tmp/codex/project", "archived")
	writeCodexStateDBMetadata(t, filepath.Join(codexHome, "state_5.sqlite"), []codexStateDBRow{
		{id: liveID, title: "Live Title", archived: false},
		{id: archivedID, title: "Archived Title", archived: true},
	})

	idx := New(Config{CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	projects := idx.Projects()
	if len(projects) != 1 || len(projects[0].Sessions) != 1 {
		t.Fatalf("projects = %+v, want one visible codex session", projects)
	}
	if got := projects[0].Sessions[0].SessionID; got != liveID {
		t.Fatalf("visible session id = %q, want %q", got, liveID)
	}
	if _, ok := idx.FindSession(archivedID); ok {
		t.Fatalf("archived codex session %q must not be in lookup map", archivedID)
	}
	deleted := idx.DeletedSessions()
	if len(deleted) != 1 || deleted[0].SessionID != archivedID || deleted[0].Agent != agentCodex {
		t.Fatalf("deleted sessions = %+v, want archived codex tombstone", deleted)
	}
}

func TestCodexArchivedStateFiltersSessionWithNullTitle(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "44444444-4444-4444-4444-555555555555"
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", sessionID, "2026-06-29T08-41-34", "/tmp/codex/project", "archived")
	writeCodexStateDBMetadata(t, filepath.Join(codexHome, "state_5.sqlite"), []codexStateDBRow{
		{id: sessionID, title: "", archived: true},
	})

	idx := New(Config{CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	if projects := idx.Projects(); len(projects) != 0 {
		t.Fatalf("archived codex session with empty title should be hidden, got %+v", projects)
	}
	if _, ok := idx.FindSession(sessionID); ok {
		t.Fatalf("archived codex session %q must not be in lookup map", sessionID)
	}
}

func TestCodexArchivedDirectoryFiltersCatalog(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "66666666-6666-6666-6666-666666666666"
	writeCodexRollout(t, codexHome, "archived_sessions", sessionID, "2026-06-29T08-41-34", "/tmp/codex/project", "archived")

	idx := New(Config{CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	if projects := idx.Projects(); len(projects) != 0 {
		t.Fatalf("archived_sessions rollout should be hidden, got %+v", projects)
	}
	if _, ok := idx.FindSession(sessionID); ok {
		t.Fatalf("archived_sessions rollout %q must not be in lookup map", sessionID)
	}
	deleted := idx.DeletedSessions()
	if len(deleted) != 1 || deleted[0].SessionID != sessionID || deleted[0].Agent != agentCodex {
		t.Fatalf("deleted sessions = %+v, want archived_sessions tombstone", deleted)
	}
}

func TestCodexArchivedStateKeepsSessionIndexTitlePriority(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "77777777-7777-7777-7777-777777777777"
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", sessionID, "2026-06-29T08-41-34", "/tmp/codex/project", "live")
	mustWriteFile(t, filepath.Join(codexHome, "session_index.jsonl"), `{"id":"`+sessionID+`","thread_name":"Session Index Title"}`+"\n")
	writeCodexStateDBMetadata(t, filepath.Join(codexHome, "state_5.sqlite"), []codexStateDBRow{
		{id: sessionID, title: "State DB Title", archived: false},
	})

	idx := New(Config{CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	projects := idx.Projects()
	if len(projects) != 1 || len(projects[0].Sessions) != 1 {
		t.Fatalf("projects = %+v, want one visible codex session", projects)
	}
	if got := projects[0].Sessions[0].Title; got != "Session Index Title" {
		t.Fatalf("title = %q, want session_index title", got)
	}
}

func TestCodexArchivedStateMissingColumnKeepsLegacyBehavior(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "88888888-8888-8888-8888-888888888888"
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", sessionID, "2026-06-29T08-41-34", "/tmp/codex/project", "live")
	writeCodexStateDBTitle(t, filepath.Join(codexHome, "state_5.sqlite"), sessionID, "Legacy State DB Title")

	idx := New(Config{CodexHome: codexHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	projects := idx.Projects()
	if len(projects) != 1 || len(projects[0].Sessions) != 1 {
		t.Fatalf("legacy sqlite without archived column should keep session visible, got %+v", projects)
	}
	if got := projects[0].Sessions[0].Title; got != "Legacy State DB Title" {
		t.Fatalf("title = %q, want legacy state title", got)
	}
}

func TestCodexArchivedStateChangesSnapshotSignature(t *testing.T) {
	codexHome := t.TempDir()
	sessionID := "99999999-9999-9999-9999-999999999999"
	dbPath := filepath.Join(codexHome, "state_5.sqlite")
	writeCodexRollout(t, codexHome, "sessions/2026/06/29", sessionID, "2026-06-29T08-41-34", "/tmp/codex/project", "live")
	writeCodexStateDBMetadata(t, dbPath, []codexStateDBRow{{id: sessionID, title: "Live Title", archived: false}})

	projects, _, deleted, err := buildSnapshot(Config{CodexHome: codexHome})
	if err != nil {
		t.Fatal(err)
	}
	before := snapshotSignature(projects, deleted)
	markCodexStateDBArchived(t, dbPath, sessionID, true)
	projects, _, deleted, err = buildSnapshot(Config{CodexHome: codexHome})
	if err != nil {
		t.Fatal(err)
	}
	after := snapshotSignature(projects, deleted)
	if before == after {
		t.Fatalf("snapshot signature must change when codex session becomes archived: %q", before)
	}
	if !strings.Contains(after, sessionID) {
		t.Fatalf("archived-only snapshot signature = %q, want deleted tombstone session id", after)
	}
}

func TestShouldRefreshForCodexStateDBSidecars(t *testing.T) {
	for _, path := range []string{
		"/tmp/.codex/state_5.sqlite",
		"/tmp/.codex/state_5.sqlite-wal",
		"/tmp/.codex/state_5.sqlite-shm",
		"/tmp/.codex/state_5.sqlite-journal",
	} {
		if !shouldRefreshForPath(path) {
			t.Fatalf("shouldRefreshForPath(%q) = false, want true", path)
		}
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

func TestRefreshEmitsChangeWhenOnlyTurnCountChanges(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "56565656-5656-5656-5656-565656565656"
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
`)
	idx := New(Config{ClaudeHome: claudeHome})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	expectChange(t, idx.Changes())

	// Reuse the same timestamp/cached title fields; the snapshot must still
	// change because the local turn count changed and should wake Nexus sync.
	mustWriteFile(t, sessionPath, `
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
`)
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	expectChange(t, idx.Changes())
}

func TestTurnCountCacheUsesAppendTailFastPath(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	sessionID := "66666666-6666-6666-6666-666666666666"
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	mustWriteFile(t, sessionPath, `{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello"}}
`)
	idx := New(Config{ClaudeHome: claudeHome})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	initial := idx.Projects()[0].Sessions[0].TurnCount
	if initial != 1 {
		t.Fatalf("initial TurnCount = %d, want 1", initial)
	}

	f, err := os.OpenFile(sessionPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"sessionId":"` + sessionID + `","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
`); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	if got := idx.Projects()[0].Sessions[0].TurnCount; got != 2 {
		t.Fatalf("appended TurnCount = %d, want 2", got)
	}
}

func TestRefreshForNexusSyncDoesNotRunBeforeInitialScan(t *testing.T) {
	idx := New(Config{})
	if idx.FirstScanComplete() {
		t.Fatal("first scan unexpectedly complete before Refresh")
	}
	if err := idx.RefreshForNexusSync(time.Nanosecond); err != nil {
		t.Fatalf("RefreshForNexusSync before first scan: %v", err)
	}
	if idx.FirstScanComplete() {
		t.Fatal("RefreshForNexusSync should not complete first scan")
	}
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	if !idx.FirstScanComplete() {
		t.Fatal("first scan should be complete after Refresh")
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

func writeCodexStateDBTitle(t *testing.T, path, sessionID, title string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO threads (id, title) VALUES (?, ?)`, sessionID, title); err != nil {
		t.Fatal(err)
	}
}

func writeCodexRollout(t *testing.T, codexHome, relDir, sessionID, stamp, cwd, prompt string) {
	t.Helper()
	dir := filepath.Join(codexHome, filepath.FromSlash(relDir))
	mustMkdirAll(t, dir)
	mustWriteFile(t, filepath.Join(dir, "rollout-"+stamp+"-"+sessionID+".jsonl"), `
{"timestamp":"2026-06-29T08:41:00Z","type":"session_meta","payload":{"id":"`+sessionID+`","cwd":"`+cwd+`"}}
{"timestamp":"2026-06-29T08:41:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"`+prompt+`"}]}}
`)
}

type codexStateDBRow struct {
	id       string
	title    string
	archived bool
}

func writeCodexStateDBMetadata(t *testing.T, path string, rows []codexStateDBRow) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		archived := 0
		if row.archived {
			archived = 1
		}
		if _, err := db.Exec(`INSERT INTO threads (id, title, archived) VALUES (?, ?, ?)`, row.id, row.title, archived); err != nil {
			t.Fatal(err)
		}
	}
}

func markCodexStateDBArchived(t *testing.T, path, sessionID string, archived bool) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	value := 0
	if archived {
		value = 1
	}
	if _, err := db.Exec(`UPDATE threads SET archived = ?, archived_at = ? WHERE id = ?`, value, time.Now().Unix(), sessionID); err != nil {
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
