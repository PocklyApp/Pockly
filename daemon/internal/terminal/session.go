// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

type SessionStatus string
type TurnStatus string
type EventKind string

const (
	SessionStarting SessionStatus = "starting"
	SessionLive     SessionStatus = "live"
	SessionExited   SessionStatus = "exited"
	SessionError    SessionStatus = "error"

	TurnIdle          TurnStatus = "idle"
	TurnSubmitted     TurnStatus = "submitted"
	TurnStreaming     TurnStatus = "streaming"
	TurnAwaitingInput TurnStatus = "awaiting_input"

	EventSessionStarted EventKind = "session_started"
	EventSessionReady   EventKind = "session_ready"
	EventUserInput      EventKind = "user_input"
	EventTextDelta      EventKind = "text_delta"
	// EventMessageAdded carries one structured chat message extracted
	// from an agent JSONL record. Payload is JSON
	// {role, text, uuid, timestamp}.
	EventMessageAdded  EventKind = "message_added"
	EventPromptReady   EventKind = "prompt_ready"
	EventSessionExited EventKind = "session_exited"
	EventError         EventKind = "error"
	// EventAgentError is a retryable agent-turn failure. Unlike EventError,
	// it must not close ExternalSession; SDK/app-server turns can fail or
	// time out while the logical chat session should remain usable.
	EventAgentError EventKind = "agent_error"
)

type LaunchConfig struct {
	Command        string
	Args           []string
	Cwd            string
	Env            []string
	Cols           uint16
	Rows           uint16
	ReadyDelay     time.Duration
	PromptDelay    time.Duration
	StartupTimeout time.Duration
}

type Event struct {
	Seq           int64         `json:"seq"`
	Kind          EventKind     `json:"kind"`
	SessionStatus SessionStatus `json:"session_status"`
	TurnStatus    TurnStatus    `json:"turn_status"`
	Payload       string        `json:"payload,omitempty"`
	Error         string        `json:"error,omitempty"`
	Timestamp     time.Time     `json:"timestamp"`
}

type Session struct {
	mu            sync.Mutex
	cfg           LaunchConfig
	cmd           *exec.Cmd
	pty           *os.File
	events        chan Event
	subscribers   map[int]chan Event
	nextSubID     int
	done          chan struct{}
	seq           int64
	sessionStatus SessionStatus
	turnStatus    TurnStatus
	readySent     bool
	stopped       bool
	eventsClosed  bool
	activity      chan struct{}
	rawInput      string
}

func Start(ctx context.Context, cfg LaunchConfig) (*Session, error) {
	cfg = normalizeConfig(cfg)
	if cfg.Command == "" {
		return nil, errors.New("command is required")
	}
	if cfg.Cwd != "" {
		info, err := os.Stat(cfg.Cwd)
		if err != nil {
			return nil, fmt.Errorf("cwd invalid: %w", err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("cwd invalid: not a directory")
		}
	}
	cmd := exec.CommandContext(ctx, cfg.Command, cfg.Args...)
	cmd.Dir = cfg.Cwd
	cmd.Env = append(os.Environ(), cfg.Env...)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cfg.Cols, Rows: cfg.Rows})
	if err != nil {
		return nil, err
	}
	s := &Session{
		cfg:           cfg,
		cmd:           cmd,
		pty:           ptmx,
		events:        make(chan Event, 128),
		subscribers:   map[int]chan Event{},
		done:          make(chan struct{}),
		activity:      make(chan struct{}, 1),
		sessionStatus: SessionStarting,
		turnStatus:    TurnIdle,
	}
	s.emit(EventSessionStarted, SessionLive, TurnIdle, "", "")
	go s.readLoop()
	go s.promptReadyLoop()
	go s.waitLoop()
	go s.startupReadyLoop()
	return s, nil
}

func (s *Session) Events() <-chan Event {
	return s.events
}

func (s *Session) Status() (SessionStatus, TurnStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessionStatus, s.turnStatus
}

func (s *Session) Subscribe(buffer int) (<-chan Event, func()) {
	if buffer <= 0 {
		buffer = 128
	}
	ch := make(chan Event, buffer)
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	id := s.nextSubID
	s.nextSubID++
	s.subscribers[id] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		sub, ok := s.subscribers[id]
		if ok {
			delete(s.subscribers, id)
		}
		s.mu.Unlock()
		if ok {
			close(sub)
		}
	}
}

func (s *Session) SendInput(text string) error {
	text = strings.TrimRight(text, "\r\n")
	if strings.TrimSpace(text) == "" {
		return errors.New("text is required")
	}
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		return errors.New("terminal session is not live")
	}
	s.turnStatus = TurnSubmitted
	s.mu.Unlock()

	s.emit(EventUserInput, SessionLive, TurnSubmitted, text, "")
	_, err := io.WriteString(s.pty, text+"\r")
	return err
}

func (s *Session) SendRaw(text string) error {
	if text == "" {
		return nil
	}
	submitted := make([]string, 0, 1)
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		return errors.New("terminal session is not live")
	}
	s.turnStatus = TurnSubmitted
	for _, r := range text {
		switch r {
		case '\r', '\n':
			line := strings.TrimSpace(s.rawInput)
			if line != "" {
				submitted = append(submitted, line)
			}
			s.rawInput = ""
		case '\b', 0x7f:
			if len(s.rawInput) > 0 {
				s.rawInput = s.rawInput[:len(s.rawInput)-1]
			}
		default:
			if r >= 0x20 {
				s.rawInput += string(r)
			}
		}
	}
	s.mu.Unlock()
	_, err := io.WriteString(s.pty, text)
	for _, line := range submitted {
		s.emit(EventUserInput, SessionLive, TurnSubmitted, line, "")
	}
	return err
}

func (s *Session) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		return errors.New("terminal session is not live")
	}
	return pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *Session) Stop() error {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return nil
	}
	s.stopped = true
	s.mu.Unlock()
	_ = s.pty.Close()
	if s.cmd.Process != nil {
		return s.cmd.Process.Kill()
	}
	return nil
}

func (s *Session) Wait() {
	<-s.done
}

func (s *Session) readLoop() {
	reader := bufio.NewReader(s.pty)
	for {
		buf := make([]byte, 4096)
		n, err := reader.Read(buf)
		if n > 0 {
			text := CleanOutput(string(buf[:n]))
			if strings.TrimSpace(text) != "" {
				s.markStreaming()
				s.emit(EventTextDelta, SessionLive, TurnStreaming, text, "")
				s.notifyActivity()
				if looksPromptReady(text) {
					s.markReady()
					s.emit(EventPromptReady, SessionLive, TurnAwaitingInput, "", "")
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func looksPromptReady(text string) bool {
	compact := strings.Join(strings.Fields(text), " ")
	return strings.Contains(compact, "❯") && (strings.Contains(compact, "? for shortcuts") || strings.Contains(compact, "esc to interrupt"))
}

func (s *Session) promptReadyLoop() {
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	active := false
	for {
		select {
		case <-s.activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			active = true
			timer.Reset(s.cfg.PromptDelay)
		case <-timer.C:
			if !active {
				continue
			}
			active = false
			s.markReady()
			s.emit(EventPromptReady, SessionLive, TurnAwaitingInput, "", "")
		case <-s.done:
			return
		}
	}
}

func (s *Session) waitLoop() {
	err := s.cmd.Wait()
	s.mu.Lock()
	stopped := s.stopped
	s.sessionStatus = SessionExited
	s.turnStatus = TurnIdle
	s.mu.Unlock()
	if err != nil && !stopped {
		s.emit(EventError, SessionError, TurnIdle, "", err.Error())
	} else {
		s.emit(EventSessionExited, SessionExited, TurnIdle, "", "")
	}
	s.mu.Lock()
	if s.eventsClosed {
		s.mu.Unlock()
		return
	}
	s.eventsClosed = true
	subscribers := s.detachSubscribersLocked()
	close(s.done)
	close(s.events)
	s.mu.Unlock()
	for _, ch := range subscribers {
		close(ch)
	}
}

func (s *Session) startupReadyLoop() {
	timer := time.NewTimer(s.cfg.ReadyDelay)
	defer timer.Stop()
	select {
	case <-timer.C:
		s.markReady()
		s.emit(EventSessionReady, SessionLive, TurnAwaitingInput, "", "")
	case <-s.done:
	}
}

func (s *Session) markStreaming() {
	s.mu.Lock()
	s.sessionStatus = SessionLive
	s.turnStatus = TurnStreaming
	s.mu.Unlock()
}

func (s *Session) markReady() {
	s.mu.Lock()
	if !s.readySent {
		s.readySent = true
	}
	s.sessionStatus = SessionLive
	s.turnStatus = TurnAwaitingInput
	s.mu.Unlock()
}

func (s *Session) notifyActivity() {
	select {
	case s.activity <- struct{}{}:
	default:
	}
}

func (s *Session) emit(kind EventKind, sessionStatus SessionStatus, turnStatus TurnStatus, payload, errText string) {
	s.mu.Lock()
	if s.eventsClosed {
		s.mu.Unlock()
		return
	}
	s.seq++
	event := Event{
		Seq:           s.seq,
		Kind:          kind,
		SessionStatus: sessionStatus,
		TurnStatus:    turnStatus,
		Payload:       payload,
		Error:         errText,
		Timestamp:     time.Now().UTC(),
	}
	select {
	case s.events <- event:
	case <-s.done:
	default:
	}
	for _, ch := range s.subscribers {
		select {
		case ch <- event:
		case <-s.done:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *Session) detachSubscribersLocked() []chan Event {
	subscribers := make([]chan Event, 0, len(s.subscribers))
	for id, ch := range s.subscribers {
		subscribers = append(subscribers, ch)
		delete(s.subscribers, id)
	}
	return subscribers
}

func normalizeConfig(cfg LaunchConfig) LaunchConfig {
	if cfg.Cwd == "" {
		cfg.Cwd, _ = os.Getwd()
	}
	if cfg.Cols == 0 {
		cfg.Cols = 120
	}
	if cfg.Rows == 0 {
		cfg.Rows = 40
	}
	if cfg.ReadyDelay <= 0 {
		cfg.ReadyDelay = 750 * time.Millisecond
	}
	if cfg.PromptDelay <= 0 {
		cfg.PromptDelay = 1500 * time.Millisecond
	}
	if cfg.StartupTimeout <= 0 {
		cfg.StartupTimeout = 10 * time.Second
	}
	return cfg
}
