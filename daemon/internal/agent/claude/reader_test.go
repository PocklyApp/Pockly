// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCwdFromDirName(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"-Users-alice-work", "/Users/alice/work"},
		{"-tmp", "/tmp"},
		{"-Users-alice-Desktop-workspace-cleantrack-group", "/Users/alice/Desktop/workspace/cleantrack/group"},
	}
	for _, c := range cases {
		if got := cwdFromDirName(c.in); got != c.want {
			t.Errorf("cwdFromDirName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTrimASCIISpace(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"  hello  ", "hello"},
		{"\t\thello\n", "hello"},
		{"\r\nhello\r\n", "hello"},
		{"hello", "hello"},
		{"   ", ""},
		{"", ""},
	}
	for _, c := range cases {
		got := string(trimASCIISpace([]byte(c.in)))
		if got != c.want {
			t.Errorf("trimASCIISpace(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// fixture lines mimic the real Claude Code jsonl shape (taken from spike data).
const fixtureJSONL = `
{"type":"last-prompt","leafUuid":"u1","sessionId":"sess-1"}
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"hello"},"uuid":"u-user","timestamp":"2026-05-17T12:00:00Z","sessionId":"sess-1","cwd":"/tmp/work"}
not-valid-json-skip-me
{"parentUuid":"u-user","isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"uuid":"u-asst","timestamp":"2026-05-17T12:00:01Z","sessionId":"sess-1"}
`

func TestLatestModel(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "sess.jsonl")
	// Two assistant turns with different models + a user turn (no model)
	// + a bad line. LatestModel must return the LAST assistant model and
	// ignore the rest.
	body := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"hi"}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-5","content":[]}}`,
		`not-json`,
		`{"type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-fast","content":[]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := LatestModel(path); got != "anthropic-compatible-fast" {
		t.Fatalf("LatestModel = %q, want anthropic-compatible-fast (last assistant turn)", got)
	}
}

func TestLatestCurrentModelUsesLastModelEvent(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "sess.jsonl")
	body := strings.Join([]string{
		`{"type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-fast","content":[]}}`,
		`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1manthropic-compatible-pro\u001b[22m for this session</local-command-stdout>"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := LatestCurrentModel(path); got != "anthropic-compatible-pro" {
		t.Fatalf("LatestCurrentModel = %q, want latest /model stdout target", got)
	}

	body += `{"type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-fast","content":[]}}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if got := LatestCurrentModel(path); got != "anthropic-compatible-fast" {
		t.Fatalf("LatestCurrentModel = %q, want latest assistant model", got)
	}
}

func TestLatestModelEmptyWhenNoAssistantTurn(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "sess.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"user","message":{"role":"user","content":"hi"}}`+"\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := LatestModel(path); got != "" {
		t.Fatalf("LatestModel with no assistant turn = %q, want empty", got)
	}
	// Missing file is also empty, not a panic.
	if got := LatestModel(filepath.Join(dir, "nope.jsonl")); got != "" {
		t.Fatalf("LatestModel(missing) = %q, want empty", got)
	}
}

func TestLatestModelCommandTarget(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "sess.jsonl")
	body := strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-args>opus</command-args>"}}`,
		`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1manthropic-compatible-pro\u001b[22m for this session</local-command-stdout>"}}`,
		`{"type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-pro","content":[]}}`,
		`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1manthropic-compatible-fast\u001b[22m for this session</local-command-stdout>"}}`,
		`{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1manthropic-compatible-pro\u001b[22m and saved as your default for new sessions</local-command-stdout>"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := LatestModelCommandTarget(path)
	if got.Count != 3 {
		t.Fatalf("Count = %d, want 3", got.Count)
	}
	if got.LatestTarget != "anthropic-compatible-pro" {
		t.Fatalf("LatestTarget = %q, want anthropic-compatible-pro", got.LatestTarget)
	}
	if got := CountModelCommandTarget(path, "anthropic-compatible-pro"); got != 2 {
		t.Fatalf("CountModelCommandTarget(pro) = %d, want 2", got)
	}
	if got := CountModelCommandTarget(path, "anthropic-compatible-fast"); got != 1 {
		t.Fatalf("CountModelCommandTarget(flash) = %d, want 1", got)
	}
	if got := CountModelCommandTarget(path, "missing-model"); got != 0 {
		t.Fatalf("CountModelCommandTarget(missing) = %d, want 0", got)
	}
}

func writeFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "-tmp-work")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(projectDir, "sess-1.jsonl")
	if err := os.WriteFile(path, []byte(strings.TrimSpace(fixtureJSONL)+"\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return dir
}

func writeLossyDirFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "-Users-dev-Documents-Codex-2026-05-19-https-github-com-pocklyapp-https-github")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir lossy fixture: %v", err)
	}
	body := strings.TrimSpace(`
{"type":"user","message":{"role":"user","content":"hello"},"uuid":"u-user","timestamp":"2026-05-17T12:00:00Z","sessionId":"sess-lossy","cwd":"/Users/dev/Documents/Codex/2026-05-19/https-github-com-pocklyapp-https-github"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"uuid":"u-asst","timestamp":"2026-05-17T12:00:01Z","sessionId":"sess-lossy"}
`) + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, "sess-lossy.jsonl"), []byte(body), 0o644); err != nil {
		t.Fatalf("write lossy fixture: %v", err)
	}
	return dir
}

func TestParseRecords_FixtureSkipsBadLines(t *testing.T) {
	home := writeFixture(t)
	path := filepath.Join(home, "-tmp-work", "sess-1.jsonl")

	var (
		count    int
		errCount int
	)
	for rec, err := range ParseRecords(path) {
		if err != nil {
			errCount++
			continue
		}
		count++
		if rec.Type == "" {
			t.Errorf("expected non-empty Type, got record %+v", rec)
		}
		if len(rec.Raw) == 0 {
			t.Errorf("expected Raw populated, got empty for type %q", rec.Type)
		}
	}

	if count != 3 {
		t.Errorf("expected 3 valid records, got %d", count)
	}
	if errCount != 1 {
		t.Errorf("expected 1 decode error (bad line), got %d", errCount)
	}
}

func TestListProjects_Fixture(t *testing.T) {
	home := writeFixture(t)

	projects, err := ListProjects(home)
	if err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	p := projects[0]
	if p.Cwd != "/tmp/work" {
		t.Errorf("Cwd = %q, want /tmp/work", p.Cwd)
	}
	if p.DirName != "-tmp-work" {
		t.Errorf("DirName = %q, want -tmp-work", p.DirName)
	}
	if len(p.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(p.Sessions))
	}
	if p.Sessions[0].ID != "sess-1" {
		t.Errorf("Session.ID = %q, want sess-1", p.Sessions[0].ID)
	}
}

func TestListProjects_PrefersRecordedCwdForLossyDirName(t *testing.T) {
	home := writeLossyDirFixture(t)

	projects, err := ListProjects(home)
	if err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	if got, want := projects[0].Cwd, "/Users/dev/Documents/Codex/2026-05-19/https-github-com-pocklyapp-https-github"; got != want {
		t.Fatalf("Cwd = %q, want %q", got, want)
	}
}

func TestListProjects_SkipsHiddenAndEmpty(t *testing.T) {
	home := t.TempDir()
	// hidden directory
	if err := os.MkdirAll(filepath.Join(home, ".cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	// empty directory (no jsonl)
	if err := os.MkdirAll(filepath.Join(home, "-empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	// real project
	dir := filepath.Join(home, "-real-project")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "abc.jsonl"), []byte(`{"type":"x"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ListProjects(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].DirName != "-real-project" {
		t.Errorf("expected only -real-project, got %+v", got)
	}
}

func TestListProjects_MissingHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "missing")

	got, err := ListProjects(home)
	if err != nil {
		t.Fatalf("ListProjects missing home: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no projects for missing home, got %+v", got)
	}
}

func TestFindSession_NotFound(t *testing.T) {
	home := writeFixture(t)
	_, err := FindSession(home, "no-such-session")
	if err != ErrSessionNotFound {
		t.Errorf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestFindSession_OK(t *testing.T) {
	home := writeFixture(t)
	sf, err := FindSession(home, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if sf.ID != "sess-1" {
		t.Errorf("ID = %q, want sess-1", sf.ID)
	}
	if !strings.HasSuffix(sf.Path, "sess-1.jsonl") {
		t.Errorf("Path = %q, want suffix sess-1.jsonl", sf.Path)
	}
}

// TestParseRecords_RealData runs the parser against the user's actual
// ~/.claude/projects if it exists. Skipped in CI / when unavailable.
func TestParseRecords_RealData(t *testing.T) {
	home, err := DefaultHome()
	if err != nil {
		t.Skipf("no user home: %v", err)
	}
	if _, err := os.Stat(home); err != nil {
		t.Skipf("no claude home at %s", home)
	}
	projects, err := ListProjects(home)
	if err != nil {
		t.Fatalf("ListProjects: %v", err)
	}
	if len(projects) == 0 {
		t.Skip("no claude projects on disk")
	}

	// Parse one session per project to exercise schema variance.
	for _, p := range projects {
		if len(p.Sessions) == 0 {
			continue
		}
		s := p.Sessions[0]
		var (
			records   int
			decodeErr int
		)
		for rec, err := range ParseRecords(s.Path) {
			if err != nil {
				decodeErr++
				continue
			}
			records++
			if rec.Type == "" {
				t.Errorf("%s: empty Type for record", s.Path)
			}
		}
		t.Logf("%s [%s]: %d records (%d decode err)", p.Cwd, s.ID, records, decodeErr)
	}
}
