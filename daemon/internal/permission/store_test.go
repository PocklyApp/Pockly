// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package permission

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStoreDecideAllow(t *testing.T) {
	s := New()
	if err := s.Register(Request{ID: "req-1", ToolName: "Bash"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan Outcome, 1)
	errs := make(chan error, 1)
	go func() {
		out, err := s.Await(context.Background(), "req-1", time.Second)
		if err != nil {
			errs <- err
			return
		}
		done <- out
	}()
	if err := s.Decide("req-1", DecisionAllow); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errs:
		t.Fatal(err)
	case out := <-done:
		if out.Decision != DecisionAllow || out.Reason != ReasonUser {
			t.Fatalf("got %+v, want allow/user", out)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for await")
	}
}

func TestStoreRejectsNonClaudeDecisions(t *testing.T) {
	s := New()
	if err := s.Register(Request{ID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Decide("req-1", Decision("allow_always")); err == nil {
		t.Fatal("expected allow_always to be rejected")
	}
}

func TestStoreAwaitTimeoutReturnsErrorNotDeny(t *testing.T) {
	s := New()
	if err := s.Register(Request{ID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	out, err := s.Await(context.Background(), "req-1", time.Nanosecond)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("got err %v, want ErrTimeout", err)
	}
	if out.Decision != "" {
		t.Fatalf("timeout must not synthesize a Pockly deny decision: %+v", out)
	}
	if err := s.Decide("req-1", DecisionAllow); !errors.Is(err, ErrNotFound) {
		t.Fatalf("timed out request should be gone; got %v", err)
	}
}

func TestStoreCancelWakesAwaiterWithDeny(t *testing.T) {
	s := New()
	if err := s.Register(Request{ID: "req-1"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan Outcome, 1)
	errs := make(chan error, 1)
	go func() {
		out, err := s.Await(context.Background(), "req-1", time.Second)
		if err != nil {
			errs <- err
			return
		}
		done <- out
	}()
	s.Cancel("req-1")
	select {
	case err := <-errs:
		t.Fatal(err)
	case out := <-done:
		if out.Decision != DecisionDeny || out.Reason != ReasonCancelled {
			t.Fatalf("got %+v, want deny/cancelled", out)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for await")
	}
}

func TestStoreList(t *testing.T) {
	s := New()
	if err := s.Register(Request{ID: "req-1", ToolName: "Bash"}); err != nil {
		t.Fatal(err)
	}
	if got := s.List(); len(got) != 1 || got[0].ID != "req-1" {
		t.Fatalf("List() = %+v", got)
	}
}
