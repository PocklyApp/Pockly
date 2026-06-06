// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package permission is an in-memory broker for Claude Code permission
// prompts. Pockly does not own a permission policy here: it only parks a
// Claude request, waits for the remote user's allow/deny choice, and returns
// that choice to Claude.
package permission

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type Decision string

const (
	DecisionAllow Decision = "allow"
	DecisionDeny  Decision = "deny"
)

func (d Decision) IsAllow() bool {
	return d == DecisionAllow
}

type Reason string

const (
	ReasonUser      Reason = "user"
	ReasonTimeout   Reason = "timeout"
	ReasonCancelled Reason = "cancelled"
)

type Outcome struct {
	Decision Decision `json:"decision"`
	Reason   Reason   `json:"reason"`
}

type Request struct {
	ID                string          `json:"request_id"`
	TerminalSessionID string          `json:"terminal_session_id"`
	ClaudeSessionID   string          `json:"claude_session_id,omitempty"`
	ToolName          string          `json:"tool_name"`
	Input             json.RawMessage `json:"input,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
}

var ErrNotFound = errors.New("permission: request not found")
var ErrAlreadyExists = errors.New("permission: request already exists")
var ErrTimeout = errors.New("permission: request timed out")

type pending struct {
	req Request
	ch  chan Outcome
}

type Store struct {
	mu      sync.Mutex
	pending map[string]*pending
}

func New() *Store {
	return &Store{pending: make(map[string]*pending)}
}

func (s *Store) Register(req Request) error {
	if req.ID == "" {
		return errors.New("permission: request id is required")
	}
	if req.CreatedAt.IsZero() {
		req.CreatedAt = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.pending[req.ID]; exists {
		return ErrAlreadyExists
	}
	s.pending[req.ID] = &pending{req: req, ch: make(chan Outcome, 1)}
	return nil
}

func (s *Store) Await(ctx context.Context, requestID string, timeout time.Duration) (Outcome, error) {
	s.mu.Lock()
	p, ok := s.pending[requestID]
	s.mu.Unlock()
	if !ok {
		return Outcome{}, ErrNotFound
	}

	var timeoutC <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		timeoutC = t.C
	}

	select {
	case out := <-p.ch:
		s.delete(requestID)
		return out, nil
	case <-timeoutC:
		s.delete(requestID)
		return Outcome{}, ErrTimeout
	case <-ctx.Done():
		return Outcome{}, ctx.Err()
	}
}

func (s *Store) Decide(requestID string, decision Decision) error {
	if decision != DecisionAllow && decision != DecisionDeny {
		return errors.New("permission: decision must be allow or deny")
	}
	s.mu.Lock()
	p, ok := s.pending[requestID]
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	select {
	case p.ch <- Outcome{Decision: decision, Reason: ReasonUser}:
		return nil
	default:
		return nil
	}
}

func (s *Store) Cancel(requestID string) {
	s.mu.Lock()
	p, ok := s.pending[requestID]
	s.mu.Unlock()
	if ok {
		select {
		case p.ch <- Outcome{Decision: DecisionDeny, Reason: ReasonCancelled}:
		default:
		}
	}
}

func (s *Store) List() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Request, 0, len(s.pending))
	for _, p := range s.pending {
		out = append(out, p.req)
	}
	return out
}

func (s *Store) delete(requestID string) {
	s.mu.Lock()
	delete(s.pending, requestID)
	s.mu.Unlock()
}
