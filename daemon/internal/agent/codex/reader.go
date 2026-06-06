// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package codex reads OpenAI Codex CLI session storage from disk.
//
// Codex stores conversations as append-only JSONL "rollout" files under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl (live) and
// ~/.codex/archived_sessions/rollout-<ISO>-<UUID>.jsonl (older).
//
// Each line: { "timestamp": "...", "type": "...", "payload": {...} }.
//
// Top-level types:
//
//	session_meta    - one per session, has cwd / id / cli_version
//	response_item   - the canonical conversation log entries
//	event_msg       - UI plumbing (mostly duplicates of response_item)
//	turn_context    - per-turn cwd / model / policy snapshot
//	token_count     - usage stats (we surface in result events later)
//
// This file owns scanning + raw record decoding. blocks.go turns
// records into agent.Blocks.
package codex

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

// DefaultHome returns the standard Codex CLI home (~/.codex).
//
// Honors CODEX_HOME for parity with codex itself.
func DefaultHome() (string, error) {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(home, ".codex"), nil
}

// liveSessionsDir + archivedSessionsDir are subdirs under DefaultHome.
const (
	liveSessionsDir     = "sessions"
	archivedSessionsDir = "archived_sessions"
)

// rollout filename format:
//
//	rollout-2026-05-13T15-01-00-019e2023-8bb6-7d43-a888-86641e1a1a8d.jsonl
//
// The session_id is the trailing UUID, not the leading timestamp.
var filenameRE = regexp.MustCompile(
	`^rollout-` +
		`(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-` +
		`(?P<sid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})` +
		`\.jsonl$`,
)

// SessionFile is one Codex rollout on disk.
type SessionFile struct {
	// SessionID is the UUID embedded in the filename.
	SessionID string

	// Timestamp is the ISO-ish stamp from the filename
	// ("2026-05-13T15-01-00", note dashes between time fields).
	Timestamp string

	// Path is absolute.
	Path string

	// Cwd is decoded from the session_meta line. Populated lazily by
	// ListSessions; may be empty if the file couldn't be read.
	Cwd string

	// Archived is true if the file lives under archived_sessions/.
	Archived bool
}

// Project groups sessions by their original cwd.
type Project struct {
	Cwd      string
	Sessions []SessionFile
}

// ListSessions enumerates every rollout under home/sessions and
// home/archived_sessions. Files whose first record is unreadable or whose
// names don't match the rollout-<ts>-<uuid>.jsonl shape are skipped.
//
// When the same session_id appears under both live and archived (Codex
// archives older files but they keep their UUIDs), the live entry wins.
//
// Output is sorted by timestamp descending — newest first.
func ListSessions(home string) ([]SessionFile, error) {
	seen := map[string]SessionFile{}

	for _, sub := range []string{liveSessionsDir, archivedSessionsDir} {
		root := filepath.Join(home, sub)
		archived := sub == archivedSessionsDir
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				// Missing root is fine (codex may not be installed yet);
				// per-entry errors get skipped silently.
				return nil
			}
			if d.IsDir() {
				return nil
			}
			m := filenameRE.FindStringSubmatch(d.Name())
			if m == nil {
				return nil
			}
			sid := m[2]
			ts := m[1]

			// Live wins over archived.
			if existing, ok := seen[sid]; ok && !existing.Archived {
				return nil
			}

			cwd := readCwd(path)
			if cwd == "" {
				// Can still list it; we just won't have a project group.
				// Skip entirely if we can't even open the file.
				if _, statErr := os.Stat(path); statErr != nil {
					return nil
				}
			}
			seen[sid] = SessionFile{
				SessionID: sid,
				Timestamp: ts,
				Path:      path,
				Cwd:       cwd,
				Archived:  archived,
			}
			return nil
		})
	}

	out := make([]SessionFile, 0, len(seen))
	for _, s := range seen {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp > out[j].Timestamp })
	return out, nil
}

// ListProjects buckets ListSessions output by cwd.
func ListProjects(home string) ([]Project, error) {
	sessions, err := ListSessions(home)
	if err != nil {
		return nil, err
	}
	byCwd := map[string][]SessionFile{}
	for _, s := range sessions {
		byCwd[s.Cwd] = append(byCwd[s.Cwd], s)
	}
	out := make([]Project, 0, len(byCwd))
	for cwd, ss := range byCwd {
		out = append(out, Project{Cwd: cwd, Sessions: ss})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Cwd < out[j].Cwd })
	return out, nil
}

// ErrSessionNotFound is returned when FindSession can't locate a session.
var ErrSessionNotFound = errors.New("codex: session not found")

// FindSession locates a session by UUID.
func FindSession(home, sessionID string) (SessionFile, error) {
	sessions, err := ListSessions(home)
	if err != nil {
		return SessionFile{}, err
	}
	for _, s := range sessions {
		if s.SessionID == sessionID {
			return s, nil
		}
	}
	return SessionFile{}, ErrSessionNotFound
}

// readCwd returns the cwd from the first session_meta record, or "" on
// any failure. We deliberately ignore non-meta first lines (a corrupt
// header shouldn't make the whole file invisible).
func readCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(line, &rec); err != nil {
			return ""
		}
		if rec.Type != "session_meta" {
			return ""
		}
		return rec.Payload.Cwd
	}
	return ""
}

// Record is a Codex JSONL line decoded just enough for downstream
// processing. The full payload stays as RawMessage so blocks.go can
// switch on payload.type without re-decoding the whole frame.
type Record struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`

	// Raw retains the entire line for callers that need fields outside
	// the typed shape.
	Raw json.RawMessage `json:"-"`
}

// ParseRecords streams records from a rollout file. Lines that fail to
// decode are surfaced via the second yield value but iteration
// continues. Open errors abort.
func ParseRecords(path string) iter.Seq2[Record, error] {
	return func(yield func(Record, error) bool) {
		f, err := os.Open(path)
		if err != nil {
			yield(Record{}, fmt.Errorf("open %s: %w", path, err))
			return
		}
		defer f.Close()

		scanner := bufio.NewScanner(f)
		buf := make([]byte, 0, 64*1024)
		// Codex tool outputs can be very large (multi-MB shell logs).
		// 16MiB matches the claude reader.
		scanner.Buffer(buf, 16*1024*1024)

		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var rec Record
			if err := json.Unmarshal([]byte(line), &rec); err != nil {
				if !yield(Record{}, fmt.Errorf("decode line: %w", err)) {
					return
				}
				continue
			}
			rec.Raw = json.RawMessage(line)
			if !yield(rec, nil) {
				return
			}
		}
		if err := scanner.Err(); err != nil {
			yield(Record{}, fmt.Errorf("scan %s: %w", path, err))
		}
	}
}
