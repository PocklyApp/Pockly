// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestJSONLOwnsCLI guards against binding a wrapper to a desktop-owned
// Claude JSONL file. A project directory can host both CLI-owned and
// desktop-owned logs; newestJSONLAfter must prefer the CLI one even when
// the desktop file has the newer mtime, because only the CLI session is
// reachable through the wrapper's PTY.
func TestJSONLOwnsCLI(t *testing.T) {
	dir := t.TempDir()
	mk := func(name, firstLine string, mtime time.Time) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(firstLine+"\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
		return path
	}

	now := time.Now()

	cliPath := mk("cli.jsonl",
		`{"type":"user","entrypoint":"cli","cwd":"/x","sessionId":"cli"}`,
		now.Add(1*time.Second))
	desktopPath := mk("desktop.jsonl",
		`{"type":"user","entrypoint":"claude-desktop","cwd":"/x","sessionId":"desktop"}`,
		now.Add(5*time.Second)) // newer mtime — Desktop is "winning" naive mtime selection
	unknownPath := mk("unknown.jsonl",
		`{"type":"system","subtype":"hi"}`, // no entrypoint field yet
		now.Add(2*time.Second))
	emptyPath := mk("empty.jsonl", "", now.Add(3*time.Second))

	t.Run("CLI jsonl accepted", func(t *testing.T) {
		if !jsonlOwnsCLI(cliPath) {
			t.Fatalf("CLI jsonl should be accepted")
		}
	})
	t.Run("Desktop jsonl rejected even though mtime newer", func(t *testing.T) {
		if jsonlOwnsCLI(desktopPath) {
			t.Fatalf("Desktop jsonl must be rejected — wrapper has no PTY to it")
		}
	})
	t.Run("jsonl without entrypoint field accepted (uncertain bucket)", func(t *testing.T) {
		// Brand-new CLI sessions may not have written entrypoint yet.
		// Rejecting would lose the very-first-tick rebound we want.
		if !jsonlOwnsCLI(unknownPath) {
			t.Fatalf("entrypoint-less jsonl should be accepted (could be brand-new CLI)")
		}
	})
	t.Run("empty file accepted (also uncertain)", func(t *testing.T) {
		if !jsonlOwnsCLI(emptyPath) {
			t.Fatalf("empty jsonl should be accepted")
		}
	})

	// Now exercise the integration: newestJSONLAfter must pick cli even
	// though desktop has a newer mtime — that's the whole point.
	t.Run("newestJSONLAfter skips Desktop, picks CLI", func(t *testing.T) {
		// Reset entrypoint cache so each test variant is independent.
		entrypointCacheMu.Lock()
		entrypointCache = map[string]entrypointCacheEntry{}
		entrypointCacheMu.Unlock()

		sid, path, ok := newestJSONLAfter(dir, now)
		if !ok {
			t.Fatalf("expected a match")
		}
		// Hard contract: never pick the Desktop jsonl even though its
		// mtime is the newest in the directory. Anything else in this
		// corpus (cli / unknown-entrypoint / empty) is fine — they all
		// fall in the accept-or-uncertain bucket.
		if sid == "desktop" {
			t.Fatalf("must NOT pick desktop jsonl (mtime is newest but it's Claude Desktop); path=%q", path)
		}
	})
}

// TestEntrypointCacheInvalidatesOnMtime ensures the cache doesn't pin a
// stale entrypoint after the file is rewritten with different content
// (extremely rare in practice but exercises the cache key correctness).
func TestEntrypointCacheInvalidatesOnMtime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rotate.jsonl")

	// Reset cache for hermeticity.
	entrypointCacheMu.Lock()
	entrypointCache = map[string]entrypointCacheEntry{}
	entrypointCacheMu.Unlock()

	// First content: Desktop. Cache should remember Desktop.
	if err := os.WriteFile(path,
		[]byte(`{"type":"user","entrypoint":"claude-desktop"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if jsonlOwnsCLI(path) {
		t.Fatalf("Desktop entrypoint should reject")
	}

	// Rewrite with CLI content + bump mtime explicitly so the cache
	// notices.
	if err := os.WriteFile(path,
		[]byte(`{"type":"user","entrypoint":"cli"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(1 * time.Second)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if !jsonlOwnsCLI(path) {
		t.Fatalf("after rewrite to CLI, cache should re-scan and accept")
	}
}
