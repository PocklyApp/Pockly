// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"runtime"
	"testing"
	"time"
)

// TestExternalMetadataBindAndLookup covers the PTY-inject fast-path's
// prereqs:
//   - ExternalSession.BindSessionMetadata updates the current sid on
//     every change (NOT latch-once; rotations matter)
//   - Manager.FindExternalBySessionID resolves the current sid back to
//     the live wrapper
//   - Manager.LookupExternalForInject distinguishes current-sid hits from
//     drifted (prior-sid) hits so callers can report drift instead of a
//     misleading 404
func TestExternalMetadataBindAndLookup(t *testing.T) {
	manager := NewManager()
	tsID, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	if tsID == "" || ext == nil {
		t.Fatal("expected terminal session id and external")
	}

	if _, ok := manager.FindExternalBySessionID("sess_aaa"); ok {
		t.Fatal("expected miss before metadata is bound")
	}
	if got := ext.ClaudeSessionID(); got != "" {
		t.Fatalf("expected empty claude session id, got %q", got)
	}

	ext.BindSessionMetadata("sess_aaa", "/tmp/proj")
	if got := ext.ClaudeSessionID(); got != "sess_aaa" {
		t.Fatalf("ClaudeSessionID = %q, want sess_aaa", got)
	}
	if got := ext.Cwd(); got != "/tmp/proj" {
		t.Fatalf("Cwd = %q, want /tmp/proj", got)
	}

	// Rotation (in-app /resume) updates the current sid and pushes the
	// old one to prior list. Cwd never changes because the wrapper still
	// runs from the same dir.
	prev, changed := ext.BindSessionMetadata("sess_bbb", "/somewhere/else")
	if !changed || prev != "sess_aaa" {
		t.Fatalf("rotation bind reported (prev=%q changed=%v), want (sess_aaa, true)", prev, changed)
	}
	if got := ext.ClaudeSessionID(); got != "sess_bbb" {
		t.Fatalf("ClaudeSessionID after rotation = %q, want sess_bbb", got)
	}
	if got := ext.Cwd(); got != "/tmp/proj" {
		t.Fatalf("Cwd must not change once latched: got %q", got)
	}
	prior := ext.PriorSessionIDs()
	if len(prior) != 1 || prior[0] != "sess_aaa" {
		t.Fatalf("PriorSessionIDs = %v, want [sess_aaa]", prior)
	}

	// Re-binding to the same current sid is a no-op (no rebind callback,
	// no extra entry in priors).
	_, changed = ext.BindSessionMetadata("sess_bbb", "")
	if changed {
		t.Fatal("re-binding to current sid must not report change")
	}

	// Current sid resolves; old sid resolves as drifted.
	found, ok := manager.FindExternalBySessionID("sess_bbb")
	if !ok || found != ext {
		t.Fatal("FindExternalBySessionID failed for current sid")
	}
	if _, ok := manager.FindExternalBySessionID("sess_aaa"); ok {
		t.Fatal("FindExternalBySessionID must NOT report prior sid as current")
	}
	driftedLookup := manager.LookupExternalForInject("sess_aaa")
	if driftedLookup.Ext != ext || !driftedLookup.Drifted || driftedLookup.CurrentSID != "sess_bbb" {
		t.Fatalf("LookupExternalForInject(prior) = %+v, want Ext=non-nil Drifted=true CurrentSID=sess_bbb", driftedLookup)
	}
	currentLookup := manager.LookupExternalForInject("sess_bbb")
	if currentLookup.Ext != ext || currentLookup.Drifted {
		t.Fatalf("LookupExternalForInject(current) = %+v, want Ext=non-nil Drifted=false", currentLookup)
	}

	// Empty query never matches.
	if _, ok := manager.FindExternalBySessionID(""); ok {
		t.Fatal("empty session id must never match")
	}
	if lookup := manager.LookupExternalForInject(""); lookup.Ext != nil {
		t.Fatal("empty session id must never resolve via LookupExternalForInject")
	}

	// After exit, both current and prior sid lookups must miss — no
	// routing text to a dead PTY, and no phantom drift reports either.
	if err := ext.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	ext.Wait()
	if _, ok := manager.FindExternalBySessionID("sess_bbb"); ok {
		t.Fatal("expected miss after session exited (current sid)")
	}
	if lookup := manager.LookupExternalForInject("sess_aaa"); lookup.Ext != nil {
		t.Fatal("expected miss after session exited (prior sid)")
	}
}

func TestManagerCreatesAndStopsSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY prototype is not enabled on windows")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	manager := NewManager()
	id, session, err := manager.Create(ctx, LaunchConfig{
		Command:    "/bin/sh",
		Args:       []string{"-c", `while IFS= read -r line; do printf 'reply:%s\n' "$line"; done`},
		ReadyDelay: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if id == "" {
		t.Fatal("expected terminal session id")
	}
	if _, ok := manager.Get(id); !ok {
		t.Fatal("expected created session to be registered")
	}
	if err := waitForKind(ctx, session.Events(), EventSessionReady); err != nil {
		t.Fatal(err)
	}
	if err := manager.SendInput(id, "hello"); err != nil {
		t.Fatal(err)
	}
	if err := manager.Stop(id); err != nil {
		t.Fatal(err)
	}
	session.Wait()
	if _, ok := manager.Get(id); ok {
		t.Fatal("expected stopped session to be removed")
	}
}
