// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package localsetup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestServerHappyPath(t *testing.T) {
	s := &Server{
		AllowedOrigins: []string{"https://example.test"},
		Deadline:       5 * time.Second,
	}
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Close()

	if s.Nonce() == "" {
		t.Fatal("Nonce empty")
	}
	if s.Port() == 0 {
		t.Fatal("Port not assigned")
	}

	body, _ := json.Marshal(map[string]any{
		"nonce": s.Nonce(),
		"claim": Claim{
			DaemonDeviceID:    "daemon-1",
			UserEmail:         "u@example.test",
			DeviceAccessToken: "acc",
		},
	})
	req, _ := http.NewRequest(http.MethodPost, s.CallbackURL(), bytes.NewReader(body))
	req.Header.Set("Origin", "https://example.test")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, err := s.Wait(ctx)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if c == nil || c.DaemonDeviceID != "daemon-1" || c.UserEmail != "u@example.test" {
		t.Fatalf("bad claim: %+v", c)
	}
}

func TestServerRejectsBadNonce(t *testing.T) {
	s := &Server{
		AllowedOrigins: []string{"https://example.test"},
		Deadline:       2 * time.Second,
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	body, _ := json.Marshal(map[string]any{
		"nonce": "wrong-nonce",
		"claim": Claim{DaemonDeviceID: "x", DeviceAccessToken: "y"},
	})
	req, _ := http.NewRequest(http.MethodPost, s.CallbackURL(), bytes.NewReader(body))
	req.Header.Set("Origin", "https://example.test")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for bad nonce, got %d", resp.StatusCode)
	}
}

func TestServerRejectsBadOrigin(t *testing.T) {
	s := &Server{
		AllowedOrigins: []string{"https://example.test"},
		Deadline:       2 * time.Second,
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	body, _ := json.Marshal(map[string]any{
		"nonce": s.Nonce(),
		"claim": Claim{DaemonDeviceID: "x", DeviceAccessToken: "y"},
	})
	req, _ := http.NewRequest(http.MethodPost, s.CallbackURL(), bytes.NewReader(body))
	req.Header.Set("Origin", "https://evil.test")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for bad origin, got %d", resp.StatusCode)
	}
}

func TestServerRejectsGet(t *testing.T) {
	s := &Server{Deadline: 2 * time.Second}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	resp, err := http.Get(s.CallbackURL())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET, got %d", resp.StatusCode)
	}
}

func TestServerSingleShot(t *testing.T) {
	s := &Server{
		AllowedOrigins: []string{"https://example.test"},
		Deadline:       3 * time.Second,
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	body, _ := json.Marshal(map[string]any{
		"nonce": s.Nonce(),
		"claim": Claim{DaemonDeviceID: "d", DeviceAccessToken: "t"},
	})
	post := func() int {
		req, _ := http.NewRequest(http.MethodPost, s.CallbackURL(), bytes.NewReader(body))
		req.Header.Set("Origin", "https://example.test")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post(); got != http.StatusOK {
		t.Fatalf("first post = %d", got)
	}
	if got := post(); got != http.StatusConflict {
		t.Fatalf("second post = %d, want %d", got, http.StatusConflict)
	}
	// Drain the first claim so the server's shutdown timer can run.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.Wait(ctx); err != nil {
		t.Fatalf("Wait: %v", err)
	}
}

func TestSetupURLEmbedsNonceInFragment(t *testing.T) {
	s := &Server{Deadline: 2 * time.Second}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	u, err := s.SetupURL("https://pockly.example")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(u, "#") {
		t.Fatalf("setup url missing fragment: %s", u)
	}
	if !strings.Contains(u, "nonce=") {
		t.Fatalf("setup url missing nonce: %s", u)
	}
	if !strings.Contains(u, fmt.Sprintf("cb=http%%3A%%2F%%2F127.0.0.1%%3A%d%%2Fcallback", s.Port())) {
		t.Fatalf("setup url missing encoded callback: %s", u)
	}
	// Anything before the `#` must NOT contain the nonce.
	idx := strings.Index(u, "#")
	if strings.Contains(u[:idx], "nonce=") {
		t.Fatalf("nonce leaked into query string: %s", u)
	}
}

func TestServerTimeout(t *testing.T) {
	s := &Server{Deadline: 200 * time.Millisecond}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.Wait(ctx); err == nil {
		t.Fatal("expected timeout error")
	}
}
