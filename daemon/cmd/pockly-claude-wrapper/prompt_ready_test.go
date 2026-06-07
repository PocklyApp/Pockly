// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"testing"
	"time"
)

func TestLooksLikeSlashCommand(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// Real slash commands (no assistant turn → must arm prompt-ready).
		{"/model sonnet", true},
		{"/model", true},
		{"/clear", true},
		{"/compact", true},
		{"/pr-comments", true},
		{"/cost", true},
		{"  /model opus  ", true}, // leading/trailing whitespace tolerated
		// Normal prompts (produce an assistant turn → must NOT arm).
		{"how do I open the workspace?", false},
		{"explain this code", false},
		{"", false},
		{"  ", false},
		// File paths a user might send as a message — embedded slashes or an
		// uppercase start must not be mistaken for a command.
		{"/Users/me/project", false},
		{"/usr/bin/env please run this", false},
		{"/tmp/a/b", false},
		{"//double", false},
		{"/ leading space then word", false},
	}
	for _, c := range cases {
		if got := looksLikeSlashCommand(c.in); got != c.want {
			t.Errorf("looksLikeSlashCommand(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestDetectModelSwitchPrompt(t *testing.T) {
	screen := `
Switch model?
Your next response will be slower and use more tokens

This conversation is cached for the current model.

❯ 1. Yes, switch to anthropic-compatible-fast
  2. No, go back
`
	if !detectModelSwitchPrompt(screen) {
		t.Fatal("expected model switch prompt to be detected")
	}
	if detectModelSwitchPrompt("Switch model? 1. Maybe") {
		t.Fatal("incomplete model switch prompt should not be detected")
	}
}

func TestModelSwitchConfirmerWritesEnter(t *testing.T) {
	writes := make(chan string, 1)
	confirmer := newModelSwitchConfirmer(func(p []byte) (int, error) {
		writes <- string(p)
		return len(p), nil
	})
	confirmer.Feed([]byte("Switch model?\n1. Yes, switch to anthropic-compatible-fast\n2. No, go back\n"))
	select {
	case got := <-writes:
		if got != "\r" {
			t.Fatalf("write = %q, want enter", got)
		}
	case <-time.After(time.Second):
		t.Fatal("model switch confirmer did not write enter")
	}
}
