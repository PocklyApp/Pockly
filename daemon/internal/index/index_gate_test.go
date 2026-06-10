// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"testing"
	"time"
)

// FindSession must block until the first (now background) scan completes —
// correctness paths must never act on the boot-time empty index — and must
// unblock promptly once it does.
func TestFindSessionWaitsForFirstScan(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	idx := New(Config{ClaudeHome: dir, CodexHome: dir, RefreshInterval: time.Hour})
	done := make(chan bool, 1)
	go func() {
		_, ok := idx.FindSession("nope")
		done <- ok
	}()
	select {
	case <-done:
		t.Fatal("FindSession returned before the first scan completed")
	case <-time.After(150 * time.Millisecond):
	}
	if err := idx.Refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	select {
	case ok := <-done:
		if ok {
			t.Fatal("unexpected session hit in an empty home")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("FindSession still blocked after the first scan")
	}
}
