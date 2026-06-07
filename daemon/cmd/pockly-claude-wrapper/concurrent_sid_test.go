// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestConcurrentCLIClaudesRaceMtimeFallback documents why mtime-based
// discovery is unsafe for concurrent Claude CLI sessions in one directory.
//
// Scenario: the user has TWO claude terminals open in the same project
// directory. Each is a separate `claude` invocation, each wrapped by its
// own pockly-claude-wrapper, each with its own child claude PID, each
// writing to its own <uuid>.jsonl in the shared project dir.
//
// The wrapper's resolveActiveSession() tries fd-based discovery first
// (correct: each wrapper sees only its own child's open fds). But if the
// fd path fails — `lsof` missing, /proc locked down inside a container,
// transient permission issue — it falls back to newestJSONLAfter, which
// has no PID information at all. It just picks "whichever CLI jsonl in
// the project dir has the newest mtime ≥ wrapper.startedAt".
//
// With two concurrent claudes both bumping their jsonl mtimes, the
// fallback's pick flip-flops between them. The wrapper that should have
// bound to A ends up tailing B (and vice versa). Web sees the other
// terminal's chat in this terminal's bubble.
//
// This test makes that wrongness explicit and reproducible: we create
// two CLI-marked jsonls representing the two concurrent claudes, give B
// a slightly newer mtime, and assert that mtime-only selection returns B.
// The wrapper now locks onto a generated session id before exec'ing Claude,
// so active-session discovery must not fall back to this guess.
func TestConcurrentCLIClaudesRaceMtimeFallback(t *testing.T) {
	dir := t.TempDir()

	// Reset entrypoint cache so each test variant is independent.
	entrypointCacheMu.Lock()
	entrypointCache = map[string]entrypointCacheEntry{}
	entrypointCacheMu.Unlock()

	mk := func(name, firstLine string, mtime time.Time) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(firstLine+"\n"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatalf("chtimes %s: %v", name, err)
		}
	}

	// Imagine wrapper-A started at startA and spawned claude-A which is
	// writing to A.jsonl. Concurrently wrapper-B started slightly later
	// (startB) and spawned claude-B writing to B.jsonl. Both are CLI
	// sessions, both pass the jsonlOwnsCLI filter.
	startA := time.Now()
	startB := startA.Add(500 * time.Millisecond)

	mk("aaa.jsonl", `{"type":"user","entrypoint":"cli","cwd":"/x","sessionId":"aaa"}`,
		startA.Add(1*time.Second)) // claude-A wrote a turn 1s after wrapper-A started
	mk("bbb.jsonl", `{"type":"user","entrypoint":"cli","cwd":"/x","sessionId":"bbb"}`,
		startB.Add(1500*time.Millisecond)) // claude-B wrote a turn — newer mtime

	// Wrapper-A's mtime fallback asks: "what's the newest CLI jsonl in
	// the project dir, mtime ≥ my startedAt?" Answer: bbb (it's newer
	// than aaa AND newer than startA). That's the bug — wrapper-A would
	// start mirroring bbb's content to its own daemon bridge.
	sid, path, ok := newestJSONLAfter(dir, startA)
	if !ok {
		t.Fatalf("expected newestJSONLAfter to return something")
	}
	if sid != "bbb" {
		t.Fatalf("test setup wrong: expected bbb (the newer one), got %q (%s)", sid, path)
	}
	// newestJSONLAfter still does mtime-newest selection because --continue
	// pre-resolution needs that behavior. The active-session resolver must
	// not fall back to it when PID-scoped discovery fails; with no PID, it
	// should return empty rather than guessing by mtime.
	bridge := &daemonBridge{}
	gotSID, gotPath := bridge.resolveActiveSession(0, dir, startA)
	if gotSID != "" || gotPath != "" {
		t.Fatalf("active-session contract broken: resolveActiveSession(pid=0) must return empty "+
			"(fd-discovery fails, mtime fallback deleted), got sid=%q path=%q. "+
			"If this fails, the mtime fallback was reintroduced into the discovery "+
			"path — reintroducing the concurrent-claude race.",
			gotSID, gotPath)
	}
}

// TestConcurrentCLIClaudesFDDiscoveryIsCorrect documents the *good* path
// for comparison: when fd-based discovery is available (lsof on macOS or
// /proc on Linux), each wrapper's activeJSONL() consults only its own
// child PID's open fd table, so the cross-binding can't happen no matter
// how many concurrent claudes are writing in the same directory.
//
// We can't easily simulate "my PID has this jsonl open" in a unit test
// without spawning real processes, so this test stays as a documented
// invariant — the production guarantee is "fd discovery, when it works,
// is authoritative." The active-session resolver keeps that as the only
// automatic binding guarantee instead of masking fd failures with mtime.
func TestConcurrentCLIClaudesFDDiscoveryIsCorrect(t *testing.T) {
	t.Log("invariant: activeJSONL(pid, dir) is PID-scoped via lsof or /proc/<pid>/fd; " +
		"two concurrent claudes in the same project dir never cross-bind because each " +
		"wrapper only consults its own child PID's open-fd table. " +
		"The risk is fd-discovery failure (containers, missing lsof) silently falling " +
		"through to the mtime path, which active-session discovery must avoid.")
}
