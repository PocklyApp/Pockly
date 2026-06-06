// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"sync"
	"testing"
	"time"
)

// TestExternalSessionConcurrentSendAndCloseNoPanic guards the send-on-closed-
// channel crash. SendInput / SendRaw / Emit must not panic when close() (via
// Stop or a terminal Emit) shuts the session's subscriber + input channels
// concurrently.
//
// Before the fix these snapshotted the channel slice under the lock, released
// the lock, then sent with `select { case ch <- x: default: }` — and `default`
// does NOT protect a send to a CLOSED channel, it panics. close() closed those
// same channels after releasing the lock, so a web inject (SendInput) or an
// agent-settings write (SendRaw) that landed exactly as the wrapper POSTed
// session_exited (→ Emit → close) panicked. With no recover() in the daemon,
// that crashed the whole process and took down every other live session.
//
// This mirrors that interleaving with many senders racing a mid-flight close.
func TestExternalSessionConcurrentSendAndCloseNoPanic(t *testing.T) {
	for iter := 0; iter < 100; iter++ {
		mgr := NewManager()
		_, sess, err := mgr.RegisterExternal("")
		if err != nil {
			t.Fatalf("RegisterExternal: %v", err)
		}
		// Register input + event subscribers so close() actually has channels to
		// close concurrently with the senders.
		inCh, _ := sess.SubscribeInput(8)
		evCh, _ := sess.Subscribe(8)
		go func() {
			for range inCh {
			}
		}()
		go func() {
			for range evCh {
			}
		}()

		var wg sync.WaitGroup
		panics := make(chan any, 8)
		guard := func(fn func()) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- r
				}
			}()
			fn()
		}

		for i := 0; i < 4; i++ {
			wg.Add(1)
			go guard(func() {
				for j := 0; j < 100; j++ {
					_ = sess.SendInput("hello")
					_ = sess.SendRaw("\x1b[Z")
				}
			})
		}
		// Close mid-flight — the wrapper POSTing session_exited while a web
		// inject / agent-settings write is in flight.
		wg.Add(1)
		go guard(func() {
			_ = sess.Stop()
		})

		wg.Wait()
		close(panics)
		if r, ok := <-panics; ok {
			t.Fatalf("send raced close() and panicked (send on closed channel): %v", r)
		}
	}
}

func TestExternalSessionSendInputHidesSlashCommands(t *testing.T) {
	sess := NewExternalSession()
	inputs, unsubInputs := sess.SubscribeInput(4)
	events, unsubEvents := sess.Subscribe(8)
	t.Cleanup(func() {
		unsubInputs()
		unsubEvents()
		sess.Stop()
	})

	if err := sess.SendInput("/model haiku"); err != nil {
		t.Fatalf("SendInput slash command: %v", err)
	}
	select {
	case got := <-inputs:
		if got != "/model haiku\r" {
			t.Fatalf("input = %q, want slash command delivered to PTY", got)
		}
	case <-time.After(time.Second):
		t.Fatal("slash command was not delivered to input subscriber")
	}

	deadline := time.After(100 * time.Millisecond)
	for {
		select {
		case ev := <-events:
			if ev.Kind == EventUserInput && ev.Payload == "/model haiku" {
				t.Fatalf("slash command leaked as user_input event: %+v", ev)
			}
		case <-deadline:
			return
		}
	}
}

func TestManagerReapStalePTYExternalSkipsFreshAndSDK(t *testing.T) {
	mgr := NewManager()
	_, fresh, err := mgr.RegisterExternal("ts_fresh")
	if err != nil {
		t.Fatalf("RegisterExternal fresh: %v", err)
	}
	_, stale, err := mgr.RegisterExternal("ts_stale")
	if err != nil {
		t.Fatalf("RegisterExternal stale: %v", err)
	}
	stale.BindSessionMetadata("sid_stale", "/tmp/project")
	_, sdk, err := mgr.RegisterExternal("ts_sdk")
	if err != nil {
		t.Fatalf("RegisterExternal sdk: %v", err)
	}
	sdk.SetDriver("sdk")
	sdk.BindSessionMetadata("sid_sdk", "/tmp/project")

	now := time.Now().UTC()
	stale.mu.Lock()
	stale.lastActivity = now.Add(-time.Minute)
	stale.mu.Unlock()
	sdk.mu.Lock()
	sdk.lastActivity = now.Add(-time.Minute)
	sdk.mu.Unlock()

	reaped := mgr.ReapStalePTYExternal(35*time.Second, now)
	if len(reaped) != 1 {
		t.Fatalf("reaped = %+v, want exactly stale PTY", reaped)
	}
	if reaped[0].ID != "ts_stale" || reaped[0].ClaudeSessionID != "sid_stale" {
		t.Fatalf("unexpected reaped summary: %+v", reaped[0])
	}
	if _, ok := mgr.GetExternal("ts_stale"); ok {
		t.Fatal("stale PTY still registered after reap")
	}
	if _, ok := mgr.GetExternal("ts_fresh"); !ok {
		t.Fatal("fresh PTY was reaped")
	}
	if _, ok := mgr.GetExternal("ts_sdk"); !ok {
		t.Fatal("SDK session was reaped by PTY reaper")
	}
	_ = fresh.Stop()
	_ = sdk.Stop()
}
