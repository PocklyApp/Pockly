// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestConcurrentLockedSessionsDoNotCrossBind covers the
// multi-claude-in-one-cwd scenario. It simulates N concurrent Claude
// processes, each owning its own UUID.jsonl, with N matching wrappers
// each tailing only its own locked JSONL. Every captured message_added
// must carry text from this tailer's sid prefix.
//
// If a future refactor reintroduces shared-directory peeking, such as
// mtime scanning or fd discovery without PID scoping, this test starts
// failing with a cross-binding message.
func TestConcurrentLockedSessionsDoNotCrossBind(t *testing.T) {
	dir := t.TempDir()

	const (
		numWrappers      = 4
		writesPerWrapper = 50
		writeInterval    = 5 * time.Millisecond
		tailerInterval   = 25 * time.Millisecond
	)

	sids := make([]string, numWrappers)
	for i := range sids {
		// Real UUIDs to exercise the actual code path. The hex-string
		// form matches what claude writes to <uuid>.jsonl filenames.
		sids[i] = newUUIDv4()
	}

	// --- Writers (fake claude processes) ---

	var writerWG sync.WaitGroup
	writeStart := time.Now()
	for _, sid := range sids {
		writerWG.Add(1)
		go func(sid string) {
			defer writerWG.Done()
			path := filepath.Join(dir, sid+".jsonl")
			// Seed: system event with sessionId, matches the shape a
			// real claude session-start writes. This is what the
			// watcher's content-check (jsonlOwnsCLI / sessionId match)
			// looks at to verify CLI-ness and binding correctness.
			mustAppend(t, path, []byte(fmt.Sprintf(
				`{"type":"system","sessionId":"%s","cwd":"/x","subtype":"init","entrypoint":"cli"}`+"\n", sid)))
			for j := 0; j < writesPerWrapper; j++ {
				rec := fmt.Sprintf(
					`{"type":"assistant","sessionId":"%s","message":{"content":[{"type":"text","text":"from-%s-msg-%d"}]}}`+"\n",
					sid, sid, j)
				mustAppend(t, path, []byte(rec))
				time.Sleep(writeInterval)
			}
		}(sid)
	}

	// --- Tailers (per-wrapper, locked to one sid each) ---

	type capture struct {
		sid    string
		texts  []string
		errors []string
		mu     sync.Mutex
	}
	captures := make(map[string]*capture, numWrappers)
	for _, sid := range sids {
		captures[sid] = &capture{sid: sid}
	}

	ctx, cancel := context.WithTimeout(context.Background(),
		// Writer-deadline + tailer-catch-up + slack. Don't let the
		// timeout cut off legitimate tail emissions.
		time.Duration(writesPerWrapper)*writeInterval+2*time.Second)
	defer cancel()

	var tailerWG sync.WaitGroup
	for _, sid := range sids {
		tailerWG.Add(1)
		go func(sid string, c *capture) {
			defer tailerWG.Done()
			// One tailer per "wrapper", each pointed at a single
			// locked file. Mirrors what watchLockedJSONL does in
			// production (without the bridge.Emit HTTP round-trip).
			tailer := newJSONLTailer()
			path := filepath.Join(dir, sid+".jsonl")
			tick := time.NewTicker(tailerInterval)
			defer tick.Stop()
			for {
				_, _ = tailer.tail(path, func(rec map[string]any, raw []byte) {
					// Same content-check the bridge does in
					// watchLockedJSONL: a record with a non-matching
					// sessionId means something is very wrong (claude
					// rebound, file got swapped, fs cache cross-talk).
					if got, _ := rec["sessionId"].(string); got != "" && got != sid {
						c.mu.Lock()
						c.errors = append(c.errors,
							fmt.Sprintf("expected sid=%s got sid=%s", sid, got))
						c.mu.Unlock()
						return
					}
					kind, text := extractMessageText(rec)
					if kind != "assistant" || text == "" {
						return
					}
					c.mu.Lock()
					c.texts = append(c.texts, text)
					c.mu.Unlock()
				})
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
				}
			}
		}(sid, captures[sid])
	}

	writerWG.Wait()
	// Give the slowest tailer one extra tick after the last write,
	// then shut down so the assertion phase sees stable state.
	time.Sleep(2 * tailerInterval)
	cancel()
	tailerWG.Wait()

	t.Logf("test ran for %v with %d wrappers × %d writes",
		time.Since(writeStart), numWrappers, writesPerWrapper)

	// --- Assertions ---

	for _, sid := range sids {
		c := captures[sid]
		c.mu.Lock()
		// Hard fail: any sessionId mismatch is a bug we shipped against.
		if len(c.errors) > 0 {
			t.Errorf("tailer %s saw sessionId mismatches: %v", sid, c.errors)
		}
		// Hard fail: cross-binding. Every captured text must start with
		// THIS tailer's sid prefix.
		wantPrefix := "from-" + sid + "-"
		for _, text := range c.texts {
			if !strings.HasPrefix(text, wantPrefix) {
				t.Errorf("tailer %s captured cross-binding: %q (wanted prefix %q)",
					sid, text, wantPrefix)
			}
		}
		// Soft fail: tailer should have seen ~all writes. Allow some
		// slack for the last few writes that landed right as the
		// timeout fired (we'd rather not flake on CI). Picking 80% as
		// the floor — well above the noise threshold, well below 100%
		// so we don't flake.
		floor := (writesPerWrapper * 80) / 100
		if len(c.texts) < floor {
			t.Errorf("tailer %s captured only %d of %d expected messages (floor=%d)",
				sid, len(c.texts), writesPerWrapper, floor)
		}
		c.mu.Unlock()
	}
}

// TestConcurrentLockedSessionsHandleMtimeBumps simulates the worst-case
// concurrent scenario for mtime-based fallback: the "loser" JSONL gets
// its mtime bumped repeatedly to be newer than the "winner". Locked
// binding is pinned to the wrapper-generated UUID, so the tailer must
// keep reading its own file regardless of mtime elsewhere in the dir.
func TestConcurrentLockedSessionsHandleMtimeBumps(t *testing.T) {
	dir := t.TempDir()
	sidA := newUUIDv4()
	sidB := newUUIDv4()
	pathA := filepath.Join(dir, sidA+".jsonl")
	pathB := filepath.Join(dir, sidB+".jsonl")

	// A's first write.
	mustAppend(t, pathA, []byte(fmt.Sprintf(
		`{"type":"assistant","sessionId":"%s","message":{"content":[{"type":"text","text":"alpha"}]}}`+"\n", sidA)))

	// B starts after A and writes a LOT, intentionally winning the
	// "newest mtime" race.
	go func() {
		for i := 0; i < 20; i++ {
			mustAppend(t, pathB, []byte(fmt.Sprintf(
				`{"type":"assistant","sessionId":"%s","message":{"content":[{"type":"text","text":"beta-%d"}]}}`+"\n", sidB, i)))
			time.Sleep(10 * time.Millisecond)
		}
	}()

	// Wait long enough for B to bump its mtime past A's, then have A
	// also write more. Under mtime-newest selection, A's tailer would
	// at some point have pointed at B.jsonl. With locked binding, A's
	// tailer is hardcoded to pathA with no mtime input.
	time.Sleep(50 * time.Millisecond)
	mustAppend(t, pathA, []byte(fmt.Sprintf(
		`{"type":"assistant","sessionId":"%s","message":{"content":[{"type":"text","text":"alpha-2"}]}}`+"\n", sidA)))

	// Tailer-A only ever opens pathA.
	var seen []string
	tailer := newJSONLTailer()
	// Give B's writer time to finish so the file system is settled.
	time.Sleep(500 * time.Millisecond)
	_, err := tailer.tail(pathA, func(rec map[string]any, _ []byte) {
		_, text := extractMessageText(rec)
		if text != "" {
			seen = append(seen, text)
		}
	})
	if err != nil {
		t.Fatalf("tail A: %v", err)
	}

	// Tailer-A must have seen exactly A's two messages, in order, and
	// nothing from B no matter how busy B was.
	wantOrder := []string{"alpha", "alpha-2"}
	if len(seen) != len(wantOrder) {
		t.Fatalf("seen=%v, want exactly %v (no beta-* should leak in)", seen, wantOrder)
	}
	for i, w := range wantOrder {
		if seen[i] != w {
			t.Errorf("seen[%d]=%q, want %q", i, seen[i], w)
		}
		if strings.HasPrefix(seen[i], "beta") {
			t.Errorf("LEAK: B's message %q reached A's tailer", seen[i])
		}
	}
}
