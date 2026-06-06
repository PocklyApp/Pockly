// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCleanOutputStripsANSI(t *testing.T) {
	got := CleanOutput("\x1b[31mred\x1b[0m\x1b7\x1b8\x1b]0;title\x07\rnext\x00\x08\x0e")
	if strings.Contains(got, "\x1b") {
		t.Fatalf("expected ANSI to be stripped, got %q", got)
	}
	if strings.ContainsAny(got, "\x00\x08\x0e") {
		t.Fatalf("expected C0 controls to be stripped, got %q", got)
	}
	if strings.Contains(got, "title") {
		t.Fatalf("expected terminal title control sequence to be stripped, got %q", got)
	}
	if !strings.Contains(got, "red") || !strings.Contains(got, "next") {
		t.Fatalf("expected readable text, got %q", got)
	}
}

func TestSessionSendInputStreamsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY prototype is not enabled on windows")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := Start(ctx, LaunchConfig{
		Command:     "/bin/sh",
		Args:        []string{"-c", `while IFS= read -r line; do printf 'reply:%s\n' "$line"; done`},
		ReadyDelay:  10 * time.Millisecond,
		PromptDelay: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()

	if err := waitForKind(ctx, s.Events(), EventSessionReady); err != nil {
		t.Fatal(err)
	}
	if err := s.SendInput("hello pty"); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case event, ok := <-s.Events():
			if !ok {
				t.Fatal("event stream closed before output")
			}
			if event.Kind == EventTextDelta && strings.Contains(event.Payload, "reply:hello pty") {
				return
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for PTY output")
		}
	}
}

func TestSessionSubscribeReceivesSharedEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY prototype is not enabled on windows")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := Start(ctx, LaunchConfig{
		Command:     "/bin/sh",
		Args:        []string{"-c", `while IFS= read -r line; do printf 'reply:%s\n' "$line"; done`},
		ReadyDelay:  10 * time.Millisecond,
		PromptDelay: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()

	sub, unsubscribe := s.Subscribe(32)
	defer unsubscribe()
	if err := waitForKind(ctx, s.Events(), EventSessionReady); err != nil {
		t.Fatal(err)
	}
	if err := s.SendInput("shared stream"); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case event, ok := <-sub:
			if !ok {
				t.Fatal("subscriber stream closed before output")
			}
			if event.Kind == EventTextDelta && strings.Contains(event.Payload, "reply:shared stream") {
				return
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for shared subscriber output")
		}
	}
}

func TestSessionSendRawStreamsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY prototype is not enabled on windows")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := Start(ctx, LaunchConfig{
		Command:     "/bin/sh",
		Args:        []string{"-c", `while IFS= read -r line; do printf 'reply:%s\n' "$line"; done`},
		ReadyDelay:  10 * time.Millisecond,
		PromptDelay: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()

	if err := waitForKind(ctx, s.Events(), EventSessionReady); err != nil {
		t.Fatal(err)
	}
	if err := s.SendRaw("raw mode\n"); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case event, ok := <-s.Events():
			if !ok {
				t.Fatal("event stream closed before raw output")
			}
			if event.Kind == EventTextDelta && strings.Contains(event.Payload, "reply:raw mode") {
				return
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for raw PTY output")
		}
	}
}

func waitForKind(ctx context.Context, events <-chan Event, kind EventKind) error {
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return context.Canceled
			}
			if event.Kind == kind {
				return nil
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
