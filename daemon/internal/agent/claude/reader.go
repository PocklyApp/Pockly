// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package claude reads Claude Code session storage from disk.
//
// Claude Code persists sessions as append-only JSONL files under
// ~/.claude/projects/<dirname>/<session-id>.jsonl. <dirname> is the
// session's working directory with separators converted to dashes — e.g.,
// /Users/alice/work becomes -Users-alice-work.
//
// This package provides:
//   - DefaultHome:  resolve ~/.claude/projects from the OS user home
//   - ListProjects: enumerate every project directory and its sessions
//   - FindSession:  locate a session by UUID across all projects
//   - ParseRecords: stream JSONL records as iter.Seq2[Record, error]
//
// The package does not interpret records into UI blocks; that lives in
// a future blocks.go (mirrors the spike layout).
package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// DefaultHome returns the standard Claude Code project store
// (~/.claude/projects), or an error if the user home is not resolvable.
func DefaultHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// Project groups session files by their original working directory.
type Project struct {
	// Cwd is the working directory the session was recorded in. It is
	// reconstructed from the project directory name by replacing leading
	// dashes with a slash and remaining dashes with slashes — best-effort
	// only, since the original path could legitimately contain dashes.
	Cwd string

	// DirName is the literal subdirectory name under the project store.
	DirName string

	// Sessions are the session files in this project, sorted by filename
	// (which is `<session-id>.jsonl`).
	Sessions []SessionFile
}

// SessionFile is one Claude Code session jsonl on disk.
type SessionFile struct {
	// ID is the session UUID (the filename without the .jsonl suffix).
	ID string

	// Path is the absolute path to the .jsonl file.
	Path string
}

// ListProjects scans home for project directories containing session
// files. Empty or hidden directories are ignored. Directories whose
// names start with "." are skipped to match the spike behavior.
//
// Errors from individual subdirectories are not fatal — a project that
// can't be read is dropped from the result silently. Only failures
// reading the home directory itself bubble up.
func ListProjects(home string) ([]Project, error) {
	entries, err := os.ReadDir(home)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", home, err)
	}

	out := make([]Project, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		dirPath := filepath.Join(home, entry.Name())
		sessions, err := listSessionFiles(dirPath)
		if err != nil || len(sessions) == 0 {
			continue
		}
		cwd := inferProjectCwd(sessions, cwdFromDirName(entry.Name()))
		out = append(out, Project{
			Cwd:      cwd,
			DirName:  entry.Name(),
			Sessions: sessions,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].DirName < out[j].DirName })
	return out, nil
}

func inferProjectCwd(sessions []SessionFile, fallback string) string {
	for _, session := range sessions {
		for rec, err := range ParseRecords(session.Path) {
			if err != nil {
				continue
			}
			if strings.TrimSpace(rec.Cwd) != "" {
				return rec.Cwd
			}
		}
	}
	return fallback
}

func listSessionFiles(dir string) ([]SessionFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]SessionFile, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		out = append(out, SessionFile{
			ID:   id,
			Path: filepath.Join(dir, e.Name()),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// cwdFromDirName converts -Users-alice-Desktop-workspace back into
// /Users/alice/Desktop/workspace. This is best-effort: if the
// original path contained dashes, the round-trip is lossy. The cwd is
// only used for display and for finding the directory to spawn
// `claude --resume` from, so a wrong reconstruction will surface as a
// "directory does not exist" error rather than silent corruption.
func cwdFromDirName(dirName string) string {
	trimmed := strings.TrimPrefix(dirName, "-")
	return "/" + strings.ReplaceAll(trimmed, "-", "/")
}

// ErrSessionNotFound is returned when FindSession can't locate a session
// with the requested ID.
var ErrSessionNotFound = errors.New("claude: session not found")

// FindSession locates a session by its UUID across all project
// directories under home. Returns ErrSessionNotFound if absent.
func FindSession(home, sessionID string) (SessionFile, error) {
	projects, err := ListProjects(home)
	if err != nil {
		return SessionFile{}, err
	}
	for _, p := range projects {
		for _, s := range p.Sessions {
			if s.ID == sessionID {
				return s, nil
			}
		}
	}
	return SessionFile{}, ErrSessionNotFound
}

// Record is a single JSONL line decoded just enough to identify what
// kind of record it is and where it sits in the conversation tree. The
// raw payload is preserved as RawMessage for downstream block extraction
// (kept loose because the schema evolves and we don't want strict
// decoding to break newer Claude Code versions).
type Record struct {
	Type        string          `json:"type"`
	UUID        string          `json:"uuid,omitempty"`
	ParentUUID  string          `json:"parentUuid,omitempty"`
	SessionID   string          `json:"sessionId,omitempty"`
	Cwd         string          `json:"cwd,omitempty"`
	Timestamp   string          `json:"timestamp,omitempty"`
	IsSidechain bool            `json:"isSidechain,omitempty"`
	Message     json.RawMessage `json:"message,omitempty"`
	Subtype     string          `json:"subtype,omitempty"`
	Content     json.RawMessage `json:"content,omitempty"`
	Attachment  json.RawMessage `json:"attachment,omitempty"`
	// ToolUseResult is the rich, structured result Claude attaches to a
	// tool_result record. For Edit/Write/MultiEdit it carries
	// `structuredPatch` — Claude's own computed unified diff — which we surface
	// so the reader can show which files changed without re-diffing the
	// tool call's old/new strings.
	ToolUseResult json.RawMessage `json:"toolUseResult,omitempty"`

	// Raw retains the entire line so callers needing fields beyond the
	// typed shape (e.g. usage stats, gitBranch, version) can decode again.
	Raw json.RawMessage `json:"-"`
}

// ParseRecords streams records from a JSONL file. Lines that fail to
// parse as JSON are skipped (Claude Code occasionally writes during a
// torn flush, and aborting on the first bad line would lose the rest of
// the conversation). The iterator yields a non-nil error only for I/O
// failures opening the file; per-line decode errors are surfaced via the
// second yield value but iteration continues.
//
// Caller should use the Go 1.23 range-over-func form:
//
//	for rec, err := range claude.ParseRecords(path) {
//	    if err != nil { continue }
//	    // use rec
//	}
func ParseRecords(path string) iter.Seq2[Record, error] {
	return func(yield func(Record, error) bool) {
		f, err := os.Open(path)
		if err != nil {
			yield(Record{}, fmt.Errorf("open %s: %w", path, err))
			return
		}
		defer f.Close()

		scanner := bufio.NewScanner(f)
		// Claude Code lines can be very large (long tool results, big
		// pasted prompts). Default 64KiB is too small; allow up to 16MiB
		// per line which matches what spike has handled in practice.
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 16*1024*1024)

		for scanner.Scan() {
			line := scanner.Bytes()
			line = trimASCIISpace(line)
			if len(line) == 0 {
				continue
			}
			var rec Record
			if err := json.Unmarshal(line, &rec); err != nil {
				if !yield(Record{}, fmt.Errorf("decode line: %w", err)) {
					return
				}
				continue
			}
			rec.Raw = append(rec.Raw[:0], line...)
			if !yield(rec, nil) {
				return
			}
		}
		if err := scanner.Err(); err != nil {
			yield(Record{}, fmt.Errorf("scan %s: %w", path, err))
		}
	}
}

// LatestModel returns the model id from the most recent assistant
// record in the session jsonl — the ground-truth model the running
// claude actually used last (e.g. "anthropic-compatible-fast", or a full
// "claude-sonnet-4-..." id). Returns "" when the file has no
// assistant turn yet or can't be opened.
//
// Used by the agent-settings adapter to show a concrete model name in
// the web's model pill instead of a bare "default" when Pockly never
// explicitly set a model on the session. Scans forward and keeps the
// last hit — consistent with ExtractBlocks' full-read cost on the
// same files, and the GET that calls this fires on session-open, not
// in a tight poll.
func LatestModel(path string) string {
	latest := ""
	for rec, err := range ParseRecords(path) {
		if err != nil || rec.Type != "assistant" || len(rec.Message) == 0 {
			continue
		}
		var m struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(rec.Message, &m) == nil && m.Model != "" {
			latest = m.Model
		}
	}
	return latest
}

// LatestCurrentModel returns the latest model observation in session order.
// Assistant message.model is ground truth after a turn completes; /model stdout
// is ground truth immediately after a successful runtime switch and before the
// next assistant message exists.
func LatestCurrentModel(path string) string {
	latest := ""
	for rec, err := range ParseRecords(path) {
		if err != nil || len(rec.Message) == 0 {
			continue
		}
		switch rec.Type {
		case "assistant":
			var m struct {
				Model string `json:"model"`
			}
			if json.Unmarshal(rec.Message, &m) == nil && strings.TrimSpace(m.Model) != "" {
				latest = strings.TrimSpace(m.Model)
			}
		case "user":
			if target := modelCommandTargetFromMessage(rec.Message); target != "" {
				latest = target
			}
		}
	}
	return latest
}

type ModelCommandObservation struct {
	Count        int
	LatestTarget string
}

var ansiEscapeRE = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// LatestModelCommandTarget returns how many successful /model command stdout
// records Claude wrote, plus the latest resolved target. Claude records these
// as user local-command-stdout rows such as:
//
//	<local-command-stdout>Set model to \x1b[1manthropic-compatible-pro\x1b[22m for this session</local-command-stdout>
//
// The observation is used to distinguish an accepted PTY write from a model
// switch that was swallowed by a native permission sheet or another TUI state.
func LatestModelCommandTarget(path string) ModelCommandObservation {
	var obs ModelCommandObservation
	for rec, err := range ParseRecords(path) {
		if err != nil || rec.Type != "user" || len(rec.Message) == 0 {
			continue
		}
		target := modelCommandTargetFromMessage(rec.Message)
		if target == "" {
			continue
		}
		obs.Count++
		obs.LatestTarget = target
	}
	return obs
}

// CountModelCommandTarget returns how many successful /model stdout records
// resolved to target in this jsonl file. Unlike LatestModelCommandTarget, this
// is safe for confirmation polling after the user has switched between several
// models in the same session; old stdout rows for other targets do not affect
// the count.
func CountModelCommandTarget(path, target string) int {
	target = strings.TrimSpace(target)
	if target == "" {
		return 0
	}
	count := 0
	for rec, err := range ParseRecords(path) {
		if err != nil || rec.Type != "user" || len(rec.Message) == 0 {
			continue
		}
		if modelCommandTargetFromMessage(rec.Message) == target {
			count++
		}
	}
	return count
}

func modelCommandTargetFromMessage(raw json.RawMessage) string {
	var msg struct {
		Content any `json:"content"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return ""
	}
	content, ok := msg.Content.(string)
	if !ok || !strings.Contains(content, "Set model to") {
		return ""
	}
	content = strings.ReplaceAll(content, "\u001b", "\x1b")
	content = ansiEscapeRE.ReplaceAllString(content, "")
	start := strings.Index(content, "Set model to")
	if start < 0 {
		return ""
	}
	rest := strings.TrimSpace(content[start+len("Set model to"):])
	for _, suffix := range []string{
		" for this session",
		" and saved as your default for new sessions",
	} {
		if idx := strings.Index(rest, suffix); idx >= 0 {
			rest = rest[:idx]
			break
		}
	}
	rest = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(rest, "<local-command-stdout>"), "</local-command-stdout>"))
	return rest
}

func trimASCIISpace(b []byte) []byte {
	for len(b) > 0 && isASCIISpace(b[0]) {
		b = b[1:]
	}
	for len(b) > 0 && isASCIISpace(b[len(b)-1]) {
		b = b[:len(b)-1]
	}
	return b
}

func isASCIISpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}
