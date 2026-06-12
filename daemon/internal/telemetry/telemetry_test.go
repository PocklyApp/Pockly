// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
)

func TestEnabled(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "")
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "")
	if Enabled() {
		t.Fatal("empty telemetry env should default to disabled")
	}
	t.Setenv("POCKLY_TELEMETRY", "on")
	if !Enabled() {
		t.Fatal("POCKLY_TELEMETRY=on should enable telemetry")
	}
	t.Setenv("POCKLY_TELEMETRY", "off")
	if Enabled() {
		t.Fatal("POCKLY_TELEMETRY=off should disable telemetry")
	}
	t.Setenv("POCKLY_TELEMETRY", "")
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "http://127.0.0.1/telemetry")
	if Enabled() {
		t.Fatal("endpoint alone should not enable telemetry")
	}
}

func TestEndpoint(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "")
	if got := Endpoint("https://nexus.example/"); got != "https://nexus.example/api/telemetry/daemon" {
		t.Fatalf("Endpoint() = %q", got)
	}
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "http://127.0.0.1/telemetry")
	if got := Endpoint("https://nexus.example"); got != "http://127.0.0.1/telemetry" {
		t.Fatalf("Endpoint() override = %q", got)
	}
}

func TestSendDoesNotPostByDefault(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "")
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", "")
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	defer server.Close()

	Send(context.Background(), server.URL, device.Identity{DeviceID: "dd_test"}, Event{Name: "sync_completed"})
	if hits != 0 {
		t.Fatalf("Send() posted %d requests with telemetry disabled", hits)
	}
}

func TestSendDoesNotPostWithEndpointUnlessEnabled(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "")
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	defer server.Close()
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", server.URL+"/diagnostics")

	Send(context.Background(), "https://unused.example", device.Identity{DeviceID: "dd_test"}, Event{Name: "sync_completed"})
	if hits != 0 {
		t.Fatalf("Send() posted %d requests without explicit telemetry opt-in", hits)
	}
}

func TestSendPostsWhenExplicitEndpointConfigured(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "on")
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.URL.Path != "/diagnostics" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", server.URL+"/diagnostics")

	Send(context.Background(), "https://unused.example", device.Identity{DeviceID: "dd_test"}, Event{Name: "sync_completed"})
	if hits != 1 {
		t.Fatalf("Send() posted %d requests with explicit endpoint", hits)
	}
}

func TestSendSerializesSanitizedMetrics(t *testing.T) {
	t.Setenv("POCKLY_TELEMETRY", "on")
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode telemetry body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("POCKLY_TELEMETRY_ENDPOINT", server.URL+"/diagnostics")

	Send(context.Background(), "https://unused.example", device.Identity{DeviceID: "dd_test"}, Event{
		Name:   "sync_completed",
		Status: "ok",
		Metrics: map[string]int64{
			"session_count": 344,
			"Total MS":      50,
			"":              999,
		},
	})

	events, ok := body["events"].([]any)
	if !ok || len(events) != 1 {
		t.Fatalf("events = %#v", body["events"])
	}
	evt := events[0].(map[string]any)
	metrics := evt["metrics"].(map[string]any)
	if got := int64(metrics["session_count"].(float64)); got != 344 {
		t.Fatalf("session_count metric = %d", got)
	}
	if got := int64(metrics["total_ms"].(float64)); got != 50 {
		t.Fatalf("total_ms metric = %d", got)
	}
	if _, ok := metrics[""]; ok {
		t.Fatalf("empty metric key should be dropped: %#v", metrics)
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
		"Nexus Authorization header failed":           "redacted_error",
		"exec: \"claude\": executable file not found": "agent_binary_missing",
		"unsupported agent \"private-agent-name\"":    "unsupported_agent",
		"websocket: bad handshake":                    "websocket_bad_handshake",
		"Post \"https://nexus.example/api\": timeout": "timeout",
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
