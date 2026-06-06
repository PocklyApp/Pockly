// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"
)

// jsonlOwnsCLI returns true if the given jsonl file looks like it's
// written by the CLI `claude` binary (entrypoint=cli) — the only kind of
// session the wrapper can possibly be hosting via PTY. Returns true also
// for files where entrypoint hasn't been written yet (brand-new session)
// to avoid false-rejecting freshly-spawned CLI sessions whose first record
// is still being flushed.
//
// Background: ~/.claude/projects/<cwd>/ collects jsonls from THREE
// independent producers — CLI claude (what wrapper hosts), Claude Desktop,
// and rarely claude-code-extension. They share the directory because the
// project root is keyed on cwd, not on which binary launched. If the user
// runs CLI `/resume <desktop-session-id>`, CLI claude opens that jsonl to
// READ history but writes new turns to a fresh jsonl. Meanwhile Claude
// Desktop (often still running in another window) keeps writing the old
// jsonl — bumping its mtime. The wrapper's mtime-based newestJSONLAfter
// fallback was then picking up the Desktop jsonl and reporting it as the
// "active" session_id, which made PTY duplex bind to a phantom session
// the wrapper had no PTY access to.
//
// This filter restores the invariant: the wrapper only ever advertises
// session_ids it can actually drive via PTY input.
//
// The check reads the file head (a few KB at most) looking for the first
// JSON record carrying an "entrypoint" field. That field is set by every
// non-trivial event Claude writes — by the time mtime updates are worth
// reacting to, entrypoint is present. Decision is cached per (path, mtime)
// so the 1s discovery polling doesn't reread 70-jsonl directories on
// every tick.
func jsonlOwnsCLI(path string) bool {
	ep, ok := readJSONLEntrypointCached(path)
	if !ok {
		// File unreadable, empty, or no entrypoint field within the
		// scan budget. Don't reject — could be brand-new CLI session
		// whose first event hasn't flushed. Defaulting to accept
		// matches the old (no-filter) behavior in the uncertain case.
		return true
	}
	// Empty string here means we saw records but none had an
	// entrypoint key — same uncertain bucket as the no-records case.
	if ep == "" {
		return true
	}
	return ep == "cli"
}

const (
	// jsonlScanBytes caps how far into the file we read looking for an
	// entrypoint marker. CLI claude writes entrypoint=cli on its first
	// user/system event, which lands within the first few KB. 64 KB is
	// generous slack for sessions that start with large attachments.
	jsonlScanBytes = 64 * 1024
)

type entrypointCacheEntry struct {
	mtime      time.Time
	entrypoint string // "" = scanned, no entrypoint field found within budget
}

var (
	entrypointCacheMu sync.Mutex
	entrypointCache   = map[string]entrypointCacheEntry{}
)

// readJSONLEntrypointCached returns the cached entrypoint for path,
// re-reading from disk if the file mtime has advanced since the previous
// scan. The bool is false when the file can't be stat'd or has zero
// bytes — caller treats both as "uncertain, accept".
func readJSONLEntrypointCached(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false
	}
	if info.Size() == 0 {
		return "", false
	}
	mtime := info.ModTime()

	entrypointCacheMu.Lock()
	cached, ok := entrypointCache[path]
	entrypointCacheMu.Unlock()
	if ok && cached.mtime.Equal(mtime) {
		return cached.entrypoint, true
	}

	ep := readJSONLEntrypoint(path)
	entrypointCacheMu.Lock()
	entrypointCache[path] = entrypointCacheEntry{mtime: mtime, entrypoint: ep}
	entrypointCacheMu.Unlock()
	return ep, true
}

// readJSONLEntrypoint scans up to jsonlScanBytes of path looking for the
// first JSON line that has an "entrypoint" string field. Returns the
// field's value or "" if not found within budget. Robust to truncated
// last lines (jsonl writers may flush mid-record).
func readJSONLEntrypoint(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	limited := &lazyReader{r: f, remaining: jsonlScanBytes}
	scanner := bufio.NewScanner(limited)
	// Default bufio scanner buffer is 64K, matching our budget. Bump
	// to handle one oversize line gracefully.
	scanner.Buffer(make([]byte, 0, 4096), jsonlScanBytes+4096)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var rec map[string]json.RawMessage
		if err := json.Unmarshal(line, &rec); err != nil {
			continue
		}
		raw, ok := rec["entrypoint"]
		if !ok {
			continue
		}
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		return s
	}
	return ""
}

// lazyReader caps total bytes read so partial-line scans don't blow up
// the budget — bufio.Scanner pulls in big chunks and we don't want to
// read a full 12MB file just to find that the entrypoint marker is in
// the first 200 bytes.
type lazyReader struct {
	r         interface{ Read(p []byte) (int, error) }
	remaining int
}

func (l *lazyReader) Read(p []byte) (int, error) {
	if l.remaining <= 0 {
		return 0, errReadBudgetExhausted
	}
	if len(p) > l.remaining {
		p = p[:l.remaining]
	}
	n, err := l.r.Read(p)
	l.remaining -= n
	return n, err
}

type budgetErr struct{}

func (budgetErr) Error() string { return "lazyReader: budget exhausted" }

var errReadBudgetExhausted = budgetErr{}
