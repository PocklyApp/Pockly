// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package telemetry

import (
	"errors"
	"testing"
	"time"
)

func TestEnabled(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "")
	if !Enabled() {
		t.Fatal("empty telemetry env should default to enabled")
	}
	t.Setenv("POCKLY_TELEMETRY", "off")
	if Enabled() {
		t.Fatal("POCKLY_TELEMETRY=off should disable telemetry")
	}
}

func TestEndpoint(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "")
	if got := Endpoint("https://pocklyapp.com/"); got != "https://pocklyapp.com/api/telemetry/daemon" {
		t.Fatalf("Endpoint() = %q", got)
	}
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "http://127.0.0.1/telemetry")
	if got := Endpoint("https://pocklyapp.com"); got != "http://127.0.0.1/telemetry" {
		t.Fatalf("Endpoint() override = %q", got)
	}
}

func TestCleanDropsControlCharactersAndTruncates(t *testing.T) {
	got := clean("abc\nxyz", 5)
	if got != "abcxy" {
		t.Fatalf("clean() = %q", got)
	}
}

func TestSafeErrorCodeRedactsPathsAndSecrets(t *testing.T) {
	tests := map[string]string{
		"cwd invalid: /Users/alice/secret/project":    "cwd_invalid",
		"open C:\\Users\\alice\\project\\token.txt":   "redacted_error",
		"relay Authorization header failed":           "redacted_error",
		"exec: \"claude\": executable file not found": "agent_binary_missing",
		"unsupported agent \"private-agent-name\"":    "unsupported_agent",
		"websocket: bad handshake":                    "websocket_bad_handshake",
		"Post \"https://pocklyapp.com/api\": timeout": "timeout",
		"some very noisy error !!! with punctuation":  "some_very_noisy_error_with_punctuation",
	}
	for input, want := range tests {
		if got := SafeErrorCode(input); got != want {
			t.Fatalf("SafeErrorCode(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestCommandFinishedUsesSafeErrorCode(t *testing.T) {
	evt := CommandFinished("setup", time.Now(), errors.New("cwd invalid: /Users/alice/project"))
	if evt.Name != "setup_failed" || evt.Status != "error" || evt.ErrorCode != "cwd_invalid" {
		t.Fatalf("CommandFinished() = %+v", evt)
	}
}
