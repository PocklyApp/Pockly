// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// testCtx is a shared context for the PTY-only inject tests. Cancellation
// only matters for SDK-mode spawns, which these tests don't exercise
// (sdkDriver is nil → routeInject never reaches the SDK branch).
var testCtx = context.Background()

// noopSend swallows inject events. routeInject takes a send callback
// so start_task can emit session_created mid-flight; the resume tests
// don't exercise that path but still need to satisfy the signature.
func noopSend(InjectEvent) {}

func TestTerminalEventBatcherMergesTextDeltas(t *testing.T) {
	var sent []TerminalEvent
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 1024, time.Hour)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 1, Kind: "text_delta", Payload: "hel", Timestamp: time.Date(2026, 6, 6, 1, 0, 0, 0, time.UTC)})
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 2, Kind: "text_delta", Payload: "lo", Timestamp: time.Date(2026, 6, 6, 1, 0, 0, 200_000_000, time.UTC)})
	if len(sent) != 0 {
		t.Fatalf("batcher sent before flush: %d", len(sent))
	}

	batcher.FlushTerminal("ts_batch")
	if len(sent) != 1 {
		t.Fatalf("sent events = %d, want 1", len(sent))
	}
	if sent[0].Payload != "hello" {
		t.Fatalf("payload = %q, want hello", sent[0].Payload)
	}
	if sent[0].SeqStart != 1 || sent[0].SeqEnd != 2 {
		t.Fatalf("seq range = %d..%d, want 1..2", sent[0].SeqStart, sent[0].SeqEnd)
	}
	if sent[0].Truncated {
		t.Fatal("first small batch should not be marked truncated")
	}
}

func TestTerminalEventBatcherFlushesBeforeNonTextEvent(t *testing.T) {
	var sent []TerminalEvent
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 1024, time.Hour)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 1, Kind: "text_delta", Payload: "pending"})
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Kind: "session_exited", SessionStatus: "exited"})

	if len(sent) != 2 {
		t.Fatalf("sent events = %d, want 2", len(sent))
	}
	if sent[0].Kind != "text_delta" || sent[0].Payload != "pending" {
		t.Fatalf("first event = %#v, want pending text_delta", sent[0])
	}
	if sent[1].Kind != "session_exited" {
		t.Fatalf("second event kind = %q, want session_exited", sent[1].Kind)
	}
}

func TestTerminalEventBatcherFlushesAtMaxBytes(t *testing.T) {
	var sent []TerminalEvent
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 8, 1024, time.Hour)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 1, Kind: "text_delta", Payload: "1234"})
	if len(sent) != 0 {
		t.Fatalf("sent events after first chunk = %d, want 0", len(sent))
	}
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 2, Kind: "text_delta", Payload: "5678"})
	if len(sent) != 1 {
		t.Fatalf("sent events after max bytes = %d, want 1", len(sent))
	}
	if sent[0].Payload != "12345678" {
		t.Fatalf("payload = %q, want 12345678", sent[0].Payload)
	}
}

func TestTerminalEventBatcherMarksRingOverflowAsTruncated(t *testing.T) {
	var sent []TerminalEvent
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 8, time.Hour)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 1, Kind: "text_delta", Payload: "12345"})
	batcher.FlushTerminal("ts_batch")
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_batch", Seq: 2, Kind: "text_delta", Payload: "67890"})
	batcher.FlushTerminal("ts_batch")

	if len(sent) != 2 {
		t.Fatalf("sent events = %d, want 2", len(sent))
	}
	if sent[0].Truncated {
		t.Fatal("first batch should not be truncated")
	}
	if !sent[1].Truncated {
		t.Fatal("second batch should be truncated after ring overflow")
	}
}

func TestTerminalEventBatcherDropTerminalSealsPendingTextWithoutSending(t *testing.T) {
	var sent []TerminalEvent
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 1024, time.Hour)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_drop", Seq: 1, Kind: "text_delta", Payload: "pending"})
	batcher.DropTerminal("ts_drop")
	batcher.FlushTerminal("ts_drop")

	if len(sent) != 0 {
		t.Fatalf("dropped terminal flushed %d events, want 0", len(sent))
	}
	snapshot, ok := batcher.SnapshotTerminal("ts_drop")
	if !ok {
		t.Fatal("expected dropped text to remain in daemon-local ring")
	}
	if snapshot.Payload != "pending" {
		t.Fatalf("snapshot payload = %q, want pending", snapshot.Payload)
	}
}

func TestTerminalSubscriptionGatesTextDeltasOnly(t *testing.T) {
	r := &runner{}
	text := TerminalEvent{TerminalSessionID: "ts_sub", Kind: string(liveterminal.EventTextDelta), Payload: "hello"}
	status := TerminalEvent{TerminalSessionID: "ts_sub", Kind: string(liveterminal.EventSessionReady), SessionStatus: "live"}

	if r.shouldForwardTerminalEvent(text) {
		t.Fatal("text_delta must not forward before a terminal stream subscribes")
	}
	if !r.shouldForwardTerminalEvent(status) {
		t.Fatal("non-text terminal status events must still forward without a subscriber")
	}
	if got := r.setTerminalSubscribed("ts_sub", true); got != 1 {
		t.Fatalf("subscribe count = %d, want 1", got)
	}
	if !r.shouldForwardTerminalEvent(text) {
		t.Fatal("text_delta should forward while subscribed")
	}
	if got := r.setTerminalSubscribed("ts_sub", true); got != 2 {
		t.Fatalf("second subscribe count = %d, want 2", got)
	}
	if got := r.setTerminalSubscribed("ts_sub", false); got != 1 {
		t.Fatalf("first unsubscribe count = %d, want 1", got)
	}
	if !r.shouldForwardTerminalEvent(text) {
		t.Fatal("text_delta should still forward while one subscriber remains")
	}
	if got := r.setTerminalSubscribed("ts_sub", false); got != 0 {
		t.Fatalf("final unsubscribe count = %d, want 0", got)
	}
	if r.shouldForwardTerminalEvent(text) {
		t.Fatal("text_delta must stop forwarding after all streams unsubscribe")
	}
}

func TestTerminalBatcherRetainsUnsubscribedOutputLocally(t *testing.T) {
	var sent []TerminalEvent
	r := &runner{}
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 1024, time.Hour)
	batcher.SetShouldSend(r.shouldForwardTerminalEvent)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_ring", Seq: 1, Kind: string(liveterminal.EventTextDelta), Payload: "offline "})
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_ring", Seq: 2, Kind: string(liveterminal.EventTextDelta), Payload: "output"})
	batcher.FlushTerminal("ts_ring")
	if len(sent) != 0 {
		t.Fatalf("unsubscribed output sent remotely: %d events", len(sent))
	}
	snapshot, ok := batcher.SnapshotTerminal("ts_ring")
	if !ok || snapshot.Payload != "offline output" {
		t.Fatalf("local snapshot = (%+v, %v), want offline output", snapshot, ok)
	}

	r.setTerminalSubscribed("ts_ring", true)
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_ring", Seq: 3, Kind: string(liveterminal.EventTextDelta), Payload: " live"})
	batcher.FlushTerminal("ts_ring")
	if len(sent) != 1 {
		t.Fatalf("subscribed output sent events = %d, want 1", len(sent))
	}
	if sent[0].Payload != " live" {
		t.Fatalf("subscribed payload = %q, want live delta only", sent[0].Payload)
	}
}

func TestTerminalBatcherReplaysUndeliveredOutputOnSubscribe(t *testing.T) {
	var sent []TerminalEvent
	r := &runner{}
	batcher := newTerminalEventBatcher(func(evt TerminalEvent) {
		sent = append(sent, evt)
	}, time.Hour, 1024, 1024, time.Hour)
	batcher.SetShouldSend(r.shouldForwardTerminalEvent)

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_replay", Seq: 1, Kind: string(liveterminal.EventTextDelta), Payload: "before "})
	batcher.Add(TerminalEvent{TerminalSessionID: "ts_replay", Seq: 2, Kind: string(liveterminal.EventTextDelta), Payload: "open"})
	batcher.FlushTerminal("ts_replay")
	if len(sent) != 0 {
		t.Fatalf("unsubscribed output sent remotely: %d events", len(sent))
	}

	if got := r.setTerminalSubscribed("ts_replay", true); got != 1 {
		t.Fatalf("subscribe count = %d, want 1", got)
	}
	snapshot, ok := batcher.SnapshotUndeliveredTerminal("ts_replay")
	if !ok {
		t.Fatal("expected undelivered snapshot")
	}
	sent = append(sent, snapshot)
	batcher.MarkDelivered(snapshot)
	if len(sent) != 1 || sent[0].Payload != "before open" {
		t.Fatalf("replay sent = %#v, want before open", sent)
	}

	if got := r.setTerminalSubscribed("ts_replay", true); got != 2 {
		t.Fatalf("second subscribe count = %d, want 2", got)
	}
	if snapshot, ok := batcher.SnapshotUndeliveredTerminal("ts_replay"); ok {
		t.Fatalf("duplicate replay snapshot = %#v, want none", snapshot)
	}

	batcher.Add(TerminalEvent{TerminalSessionID: "ts_replay", Seq: 3, Kind: string(liveterminal.EventTextDelta), Payload: " live"})
	batcher.FlushTerminal("ts_replay")
	if len(sent) != 2 {
		t.Fatalf("sent events = %d, want replay + live", len(sent))
	}
	if sent[1].Payload != " live" {
		t.Fatalf("live payload = %q, want live delta only", sent[1].Payload)
	}
}

// TestInjectIntoPTYSucceedsWhenWrapperBound is the v1.6.x happy path:
// when a wrapper has registered an external terminal and bound it to the
// inject's session_id, injectIntoPTY writes the text into the
// ExternalSession's input bus (wrapper.readInputs then writes it to PTY)
// and returns nil.
func TestInjectIntoPTYSucceedsWhenWrapperBound(t *testing.T) {
	manager := liveterminal.NewManager()
	_, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	ext.BindSessionMetadata("sess_live", "/tmp/proj")

	inputs, unsub := ext.SubscribeInput(4)
	defer unsub()

	r := &runner{terminal: manager}
	if err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_x",
		Mode:      "resume_session",
		SessionID: "sess_live",
		Text:      "hello from web",
	}, noopSend); err != nil {
		t.Fatalf("expected injectIntoPTY to succeed: %v", err)
	}

	select {
	case got := <-inputs:
		if !strings.Contains(got, "hello from web") {
			t.Fatalf("PTY input did not receive text: %q", got)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for PTY input")
	}
}

// TestInjectIntoPTYFailureModes covers every reason injectIntoPTY must
// return an error. Each must produce a stable error code we can surface
// to the web UI; "session_not_attached" is the one users will see most
// often (they closed the terminal).
func TestInjectIntoPTYFailureModes(t *testing.T) {
	makeRunner := func(t *testing.T) (*runner, *liveterminal.ExternalSession) {
		t.Helper()
		manager := liveterminal.NewManager()
		_, ext, err := manager.RegisterExternal("")
		if err != nil {
			t.Fatalf("RegisterExternal: %v", err)
		}
		return &runner{terminal: manager}, ext
	}

	cases := []struct {
		name    string
		runner  func(t *testing.T) (*runner, *liveterminal.ExternalSession)
		req     InjectRequest
		bindSID string
		wantErr string
	}{
		{
			name:    "no terminal manager",
			runner:  func(t *testing.T) (*runner, *liveterminal.ExternalSession) { return &runner{terminal: nil}, nil },
			req:     InjectRequest{Mode: "resume_session", SessionID: "x", Text: "y"},
			wantErr: "session_not_attached",
		},
		{
			// start_task is now wired (see routeStartTask) — use a mode
			// that's still unknown so the unsupported_mode path stays
			// covered.
			name:    "unknown mode",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "fork_session", SessionID: "sess_a", Text: "y"},
			bindSID: "sess_a",
			wantErr: "unsupported_mode",
		},
		{
			name:    "start_task missing text",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "start_task", Cwd: "/tmp", Text: ""},
			wantErr: "text_required",
		},
		{
			name:    "start_task invalid cwd",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "start_task", Cwd: "/definitely/not/a/dir/sse-spec", Text: "hi"},
			wantErr: "cwd_invalid: /definitely/not/a/dir/sse-spec",
		},
		{
			name:    "empty session id",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "resume_session", SessionID: "", Text: "y"},
			wantErr: "session_id_required",
		},
		{
			name:    "empty text",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "resume_session", SessionID: "sess_a", Text: "   "},
			bindSID: "sess_a",
			wantErr: "text_required",
		},
		{
			name:    "session id not bound to any wrapper",
			runner:  makeRunner,
			req:     InjectRequest{Mode: "resume_session", SessionID: "sess_missing", Text: "hi"},
			bindSID: "sess_actually_running",
			wantErr: "session_not_attached",
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			r, ext := tt.runner(t)
			if ext != nil && tt.bindSID != "" {
				ext.BindSessionMetadata(tt.bindSID, "/x")
			}
			err := r.routeInject(testCtx, tt.req, noopSend)
			if err == nil {
				t.Fatalf("expected error, got nil")
			}
			if err.Error() != tt.wantErr {
				t.Fatalf("err = %q, want %q", err.Error(), tt.wantErr)
			}
		})
	}
}

// TestInjectIntoPTYReportsDriftWhenSidRotated covers the regression
// this whole rebind series exists to fix: web sends an inject targeting
// sess_old, but the wrapper has since rotated (via in-app /resume) to
// sess_new. Old behavior: the daemon either silently routed text to the
// wrong jsonl OR returned a misleading session_not_attached. New
// behavior: typed "session_drifted current=sess_new" so the web can
// confirm with the user before switching.
func TestInjectIntoPTYReportsDriftWhenSidRotated(t *testing.T) {
	manager := liveterminal.NewManager()
	_, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	ext.BindSessionMetadata("sess_old", "/tmp/proj")
	ext.BindSessionMetadata("sess_new", "")

	r := &runner{terminal: manager}
	err = r.routeInject(testCtx, InjectRequest{
		RequestID: "req_x",
		Mode:      "resume_session",
		SessionID: "sess_old",
		Text:      "hello",
	}, noopSend)
	if err == nil {
		t.Fatal("expected session_drifted error, got nil")
	}
	if !strings.HasPrefix(err.Error(), "session_drifted ") {
		t.Fatalf("err = %q, want prefix \"session_drifted \"", err.Error())
	}
	if !strings.Contains(err.Error(), "current=sess_new") {
		t.Fatalf("drift error must name the current sid; got %q", err.Error())
	}
}

// stubSDKEnsurer captures EnsureDriver calls so the test can assert that
// routeInject reaches the SDK fallback when no PTY wrapper is bound.
// Returns a fresh ExternalSession registered with the same
// terminal.Manager the runner uses, so the post-spawn SendInput lands
// like the real sdkdriver.Manager would set things up.
type stubSDKEnsurer struct {
	terminal *liveterminal.Manager
	ext      *liveterminal.ExternalSession
	calls    []sdkEnsureCall
	err      error
}

type sdkEnsureCall struct {
	SID, Cwd, Agent string
	Opts            StartTaskAgentOptions
}

func (s *stubSDKEnsurer) EnsureDriver(ctx context.Context, sid, cwd, agent string) (*liveterminal.ExternalSession, error) {
	s.calls = append(s.calls, sdkEnsureCall{SID: sid, Cwd: cwd, Agent: agent})
	if s.err != nil {
		return nil, s.err
	}
	if s.ext != nil {
		return s.ext, nil
	}
	_, ext, err := s.terminal.RegisterExternal("")
	if err != nil {
		return nil, err
	}
	ext.BindSessionMetadata(sid, cwd)
	return ext, nil
}

// EnsureNewDriver is the start_task fallback path; tests that don't
// exercise it can ignore the second call slot. Calls are recorded the
// same way EnsureDriver does so a single fixture can assert on both.
func (s *stubSDKEnsurer) EnsureNewDriver(ctx context.Context, sid, cwd, agent string, opts StartTaskAgentOptions) (*liveterminal.ExternalSession, error) {
	s.calls = append(s.calls, sdkEnsureCall{SID: sid, Cwd: cwd, Agent: agent, Opts: opts})
	if s.err != nil {
		return nil, s.err
	}
	if s.ext != nil {
		return s.ext, nil
	}
	_, ext, err := s.terminal.RegisterExternal("")
	if err != nil {
		return nil, err
	}
	ext.BindSessionMetadata(sid, cwd)
	return ext, nil
}

// TestRouteInjectFallsThroughToSDKWhenNoPTY exercises the dual-driver
// inject path: when no wrapper has registered a PTY for the requested
// sid, routeInject must call into the SDK ensurer instead of returning
// session_not_attached. This is the core of the 2026-05-25 redesign
// — without this path the UI keeps showing "detached, can't continue"
// for any session whose wrapper has exited, even though the daemon is
// perfectly capable of running `claude --resume` headlessly.
func TestRouteInjectFallsThroughToSDKWhenNoPTY(t *testing.T) {
	manager := liveterminal.NewManager()
	stub := &stubSDKEnsurer{terminal: manager}
	r := &runner{terminal: manager, sdkDriver: stub}

	if err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_sdk",
		Mode:      "resume_session",
		SessionID: "sess_no_pty",
		Cwd:       "/tmp/proj",
		Agent:     "claude-code",
		Text:      "hello from web",
	}, noopSend); err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("expected 1 SDK ensure call, got %d", len(stub.calls))
	}
	if got := stub.calls[0]; got.SID != "sess_no_pty" || got.Cwd != "/tmp/proj" || got.Agent != "claude-code" {
		t.Fatalf("SDK ensure call = %+v, want sid=sess_no_pty cwd=/tmp/proj agent=claude-code", got)
	}
}

// TestRouteInjectPrefersPTYOverSDK guards against a regression where
// the SDK fallback might preempt a perfectly good PTY wrapper. PTY is
// the higher-fidelity driver (mirrors the user's TUI); SDK should ONLY
// fire when the lookup misses.
func TestRouteInjectPrefersPTYOverSDK(t *testing.T) {
	manager := liveterminal.NewManager()
	_, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	ext.BindSessionMetadata("sess_with_pty", "/tmp/proj")
	inputs, unsub := ext.SubscribeInput(4)
	defer unsub()

	stub := &stubSDKEnsurer{terminal: manager}
	r := &runner{terminal: manager, sdkDriver: stub}

	if err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_pty",
		Mode:      "resume_session",
		SessionID: "sess_with_pty",
		Text:      "hello from web",
	}, noopSend); err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	if len(stub.calls) != 0 {
		t.Fatalf("SDK should not be called when PTY exists; calls=%+v", stub.calls)
	}
	select {
	case got := <-inputs:
		if !strings.Contains(got, "hello from web") {
			t.Fatalf("PTY input wrong: %q", got)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for PTY input")
	}
}

// TestRouteInjectRevalidatesSDKExternalThroughEnsurer covers the SDK
// resume path after the first headless spawn. SDK sessions register as
// ExternalSession rows too, but unlike PTY rows they must go back
// through EnsureDriver so the manager can verify/recreate the backing
// subprocess before SendInput writes to the session bus.
func TestRouteInjectRevalidatesSDKExternalThroughEnsurer(t *testing.T) {
	manager := liveterminal.NewManager()
	_, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	ext.SetDriver("sdk")
	ext.BindSessionMetadata("sess_sdk", "/tmp/proj")
	inputs, unsub := ext.SubscribeInput(4)
	defer unsub()

	stub := &stubSDKEnsurer{terminal: manager, ext: ext}
	r := &runner{terminal: manager, sdkDriver: stub}

	if err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_sdk",
		Mode:      "resume_session",
		SessionID: "sess_sdk",
		Cwd:       "/tmp/proj",
		Agent:     "claude-code",
		Text:      "hello again",
	}, noopSend); err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("expected SDK EnsureDriver to be called once, got %d", len(stub.calls))
	}
	select {
	case got := <-inputs:
		if !strings.Contains(got, "hello again") {
			t.Fatalf("SDK input wrong: %q", got)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for SDK input")
	}
}

func TestRouteStartTaskRejectsAgentThatExitsBeforeReady(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX shell fake claude")
	}
	tmp := t.TempDir()
	fakeClaude := filepath.Join(tmp, "claude")
	if err := os.WriteFile(fakeClaude, []byte("#!/bin/sh\necho 'auth missing'\nsleep 0.2\nexit 42\n"), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	useFakeClaudeLauncher(t, fakeClaude)
	withStartTaskEarlyDeathWindow(t, 15*time.Second)

	manager := liveterminal.NewManager()
	r := &runner{terminal: manager}
	var sent []InjectEvent
	err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_start",
		Mode:      "start_task",
		Cwd:       tmp,
		Agent:     "claude-code",
		Text:      "pwd",
	}, func(evt InjectEvent) {
		sent = append(sent, evt)
	})
	if err == nil {
		t.Fatal("expected startup error, got nil")
	}
	if !strings.Contains(err.Error(), "agent_start_failed") && !strings.Contains(err.Error(), "agent_exited_before_ready") {
		t.Fatalf("err = %q, want agent startup failure", err.Error())
	}
	for _, evt := range sent {
		if evt.Type == "session_created" {
			t.Fatalf("must not emit session_created for dead-on-arrival agent: %+v", sent)
		}
	}
}

func TestControlBackoffGrowsThenCaps(t *testing.T) {
	if got := nextControlBackoff(controlReconnectInitial); got != 2*controlReconnectInitial {
		t.Fatalf("first backoff = %v, want %v", got, 2*controlReconnectInitial)
	}
	if got := nextControlBackoff(controlReconnectMax); got != controlReconnectMax {
		t.Fatalf("backoff at cap = %v, want %v (must not exceed cap)", got, controlReconnectMax)
	}
	d := controlReconnectInitial
	for i := 0; i < 32; i++ {
		next := nextControlBackoff(d)
		if next < d {
			t.Fatalf("backoff went backwards: %v -> %v", d, next)
		}
		if next > controlReconnectMax {
			t.Fatalf("backoff exceeded cap: %v", next)
		}
		d = next
	}
	if d != controlReconnectMax {
		t.Fatalf("backoff never reached cap, stuck at %v", d)
	}
}

func TestJitteredBackoffStaysWithinBounds(t *testing.T) {
	for _, d := range []time.Duration{controlReconnectInitial, time.Second, controlReconnectMax} {
		for i := 0; i < 64; i++ {
			got := jitteredBackoff(d)
			if got > d || got < d-d/4 {
				t.Fatalf("jitteredBackoff(%v) = %v, want within [%v, %v]", d, got, d-d/4, d)
			}
		}
	}
}

// Regression: codex assigns its thread id only after a slow app-server cold
// start. The old 5s ceiling (which also read a stale bound id at timer-fire)
// gave up before the id arrived, so the caller never emitted session_created
// and the web bounced its draft. The bind must be tolerated well past 5s.
func TestWaitForExternalSessionBoundToleratesSlowColdStart(t *testing.T) {
	ext := liveterminal.NewExternalSession()
	events := make(chan liveterminal.Event) // no driver events; rely on the bind poll
	const provisional = "draft_sid"
	const realSID = "019eaafd-2207-7c13-a105-daa8a04d73d8"
	go func() {
		time.Sleep(6 * time.Second) // past the retired 5s ceiling
		ext.BindSessionMetadata(realSID, "")
	}()
	start := time.Now()
	got, err := waitForExternalSessionBound(testCtx, ext, events, provisional)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != realSID {
		t.Fatalf("bound sid = %q, want %q", got, realSID)
	}
	if elapsed := time.Since(start); elapsed < 5*time.Second {
		t.Fatalf("returned before the bind could land (%v) — would have read a stale id", elapsed)
	}
}

func TestRouteStartTaskPrefersSDKDriverWhenAvailable(t *testing.T) {
	tmp := t.TempDir()
	fakeClaude := filepath.Join(tmp, "claude")
	if err := os.WriteFile(fakeClaude, []byte("#!/bin/sh\necho 'pty path must not run' >&2\nexit 42\n"), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	useFakeClaudeLauncher(t, fakeClaude)

	manager := liveterminal.NewManager()
	_, ext, err := manager.RegisterExternal("")
	if err != nil {
		t.Fatalf("register external: %v", err)
	}
	inputs, unsubscribeInputs := ext.SubscribeInput(4)
	defer unsubscribeInputs()
	go func() {
		<-inputs
		ext.Emit(liveterminal.EventMessageAdded, liveterminal.SessionLive, liveterminal.TurnStreaming, `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`, "")
	}()
	stub := &stubSDKEnsurer{terminal: manager, ext: ext}
	r := &runner{terminal: manager, sdkDriver: stub}

	var sent []InjectEvent
	if err := r.routeInject(testCtx, InjectRequest{
		RequestID:      "req_start_sdk",
		Mode:           "start_task",
		Cwd:            tmp,
		Agent:          "claude-code",
		Text:           "hello",
		Model:          "anthropic-compatible-fast",
		PermissionMode: "acceptEdits",
		Effort:         "high",
	}, func(evt InjectEvent) {
		sent = append(sent, evt)
	}); err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("expected SDK EnsureNewDriver to be called once, got %d", len(stub.calls))
	}
	if got := stub.calls[0]; got.Cwd != tmp || got.Agent != "claude-code" || got.Opts.Model != "anthropic-compatible-fast" || got.Opts.PermissionMode != "acceptEdits" || got.Opts.Effort != "high" {
		t.Fatalf("unexpected SDK call: %+v", got)
	}
	created := false
	for _, evt := range sent {
		if evt.Type == "session_created" {
			created = true
		}
	}
	if !created {
		t.Fatalf("SDK start_task should emit session_created: %+v", sent)
	}
}

func TestStartTaskClaudeArgsIncludeInitialModelAndPermission(t *testing.T) {
	args, err := startTaskClaudeArgs("sess_first", "hello", "sonnet", "acceptEdits", "")
	if err != nil {
		t.Fatalf("startTaskClaudeArgs: %v", err)
	}
	want := []string{"--session-id", "sess_first", "--model", "sonnet", "--permission-mode", "acceptEdits", "hello"}
	if strings.Join(args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}

func TestStartTaskClaudeArgsAcceptNativePermissionModes(t *testing.T) {
	for _, mode := range []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"} {
		args, err := startTaskClaudeArgs("sess_first", "hello", "", mode, "")
		if err != nil {
			t.Fatalf("mode %q rejected: %v", mode, err)
		}
		joined := strings.Join(args, "\x00")
		if mode == "default" {
			if strings.Contains(joined, "--permission-mode") {
				t.Fatalf("default mode should be omitted from args: %#v", args)
			}
			continue
		}
		if !strings.Contains(joined, "--permission-mode\x00"+mode) {
			t.Fatalf("mode %q missing from args: %#v", mode, args)
		}
	}
	if _, err := startTaskClaudeArgs("sess_first", "hello", "", "pockly-auto", ""); err == nil {
		t.Fatal("expected unknown permission mode to be rejected")
	}
}

func TestStartTaskClaudeArgsAcceptEffort(t *testing.T) {
	args, err := startTaskClaudeArgs("sess_first", "hello", "", "default", "high")
	if err != nil {
		t.Fatalf("effort rejected: %v", err)
	}
	joined := strings.Join(args, "\x00")
	if !strings.Contains(joined, "--effort\x00high") {
		t.Fatalf("effort missing from args: %#v", args)
	}
	if _, err := startTaskClaudeArgs("sess_first", "hello", "", "default", "minimal"); err == nil {
		t.Fatal("expected Claude fallback to reject unsupported minimal effort")
	}
}

func TestRouteStartTaskWaitsPastSyntheticSessionReady(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX shell fake claude")
	}
	tmp := t.TempDir()
	fakeClaude := filepath.Join(tmp, "claude")
	if err := os.WriteFile(fakeClaude, []byte("#!/bin/sh\nsleep 2\necho 'real output after synthetic ready'\nsleep 10\n"), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	useFakeClaudeLauncher(t, fakeClaude)

	manager := liveterminal.NewManager()
	r := &runner{terminal: manager}
	var sent []InjectEvent
	err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_start_synthetic_ready",
		Mode:      "start_task",
		Cwd:       tmp,
		Agent:     "claude-code",
		Text:      "pwd",
	}, func(evt InjectEvent) {
		sent = append(sent, evt)
	})
	if err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	created := false
	for _, evt := range sent {
		if evt.Type == "session_created" {
			created = true
		}
	}
	if !created {
		t.Fatalf("real output after synthetic session_ready should promote start_task: %+v", sent)
	}
}

func TestRouteStartTaskPromotesSilentLiveProcessAfterEarlyDeathWindow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX shell fake claude")
	}
	tmp := t.TempDir()
	fakeClaude := filepath.Join(tmp, "claude")
	if err := os.WriteFile(fakeClaude, []byte("#!/bin/sh\nsleep 10\n"), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	useFakeClaudeLauncher(t, fakeClaude)

	manager := liveterminal.NewManager()
	r := &runner{terminal: manager}
	var sent []InjectEvent
	err := r.routeInject(testCtx, InjectRequest{
		RequestID: "req_start_silent",
		Mode:      "start_task",
		Cwd:       tmp,
		Agent:     "claude-code",
		Text:      "pwd",
	}, func(evt InjectEvent) {
		sent = append(sent, evt)
	})
	if err != nil {
		t.Fatalf("routeInject: %v", err)
	}
	created := false
	for _, evt := range sent {
		if evt.Type == "session_created" {
			created = true
		}
	}
	if !created {
		t.Fatalf("silent live process should promote after early-death window: %+v", sent)
	}
}

func TestWaitForExternalStartTaskStartedToleratesQuietLiveProcess(t *testing.T) {
	ext := liveterminal.NewExternalSession()
	events, unsubscribe := ext.Subscribe(16)
	defer unsubscribe()
	ext.Emit(liveterminal.EventSessionReady, liveterminal.SessionLive, liveterminal.TurnAwaitingInput, "", "")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := waitForExternalStartTaskStarted(ctx, events); err != nil {
		t.Fatalf("waitForExternalStartTaskStarted: %v", err)
	}
}

func TestWaitForExternalStartTaskStartedAcceptsMessage(t *testing.T) {
	ext := liveterminal.NewExternalSession()
	events, unsubscribe := ext.Subscribe(16)
	defer unsubscribe()
	ext.Emit(liveterminal.EventMessageAdded, liveterminal.SessionLive, liveterminal.TurnStreaming, `{"type":"assistant","message":{"content":"ok"}}`, "")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := waitForExternalStartTaskStarted(ctx, events); err != nil {
		t.Fatalf("waitForExternalStartTaskStarted: %v", err)
	}
}

// TestRouteInjectMapsSDKErrors covers the wire-error vocabulary
// routeInject + mapSDKError surface to web. Each sdkdriver-internal
// error must map to a stable code; web/CLAUDE.md documents these.
func TestRouteInjectMapsSDKErrors(t *testing.T) {
	manager := liveterminal.NewManager()
	cases := []struct {
		name     string
		sdkErr   error
		wantCode string
	}{
		{"busy", errors.New("sdkdriver: another driver is in flight"), "sdk_busy"},
		{"unsupported agent", errors.New("sdkdriver: unsupported agent: hermes"), "sdk_unsupported_agent"},
		{"binary missing", errors.New("resolve claude: claude not found in PATH or common locations"), "binary_missing"},
		{"codex app server unavailable", errors.New("codex_app_server_unavailable: please upgrade Codex CLI to >= 0.130.0"), "codex_app_server_unavailable"},
		{"generic spawn fail", errors.New("start driver: exec context cancelled"), "sdk_spawn_failed: start driver: exec context cancelled"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			stub := &stubSDKEnsurer{terminal: manager, err: tt.sdkErr}
			r := &runner{terminal: manager, sdkDriver: stub}
			err := r.routeInject(testCtx, InjectRequest{
				RequestID: "req",
				Mode:      "resume_session",
				SessionID: "sess",
				Text:      "hi",
			}, noopSend)
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if err.Error() != tt.wantCode {
				t.Fatalf("err = %q, want %q", err.Error(), tt.wantCode)
			}
		})
	}
}

func TestResolveExecutableFindsUserLocalBinWhenPathIsEmpty(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only $HOME / ~/.local convention")
	}
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("PATH", "")
	want := filepath.Join(tmp, ".local", "bin", "claude")
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	if err := os.WriteFile(want, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write claude: %v", err)
	}
	got, err := resolveExecutable("claude")
	if err != nil {
		t.Fatalf("resolveExecutable: %v", err)
	}
	if got != want {
		t.Fatalf("resolveExecutable = %q, want %q", got, want)
	}
}

func useFakeClaudeLauncher(t *testing.T, fakeClaude string) {
	t.Helper()
	t.Setenv("POCKLY_REAL_CLAUDE", fakeClaude)
	t.Setenv("POCKLY_CLAUDE_LAUNCHER_JSON", "")
}

func withStartTaskEarlyDeathWindow(t *testing.T, window time.Duration) {
	t.Helper()
	previous := startTaskEarlyDeathWindow
	startTaskEarlyDeathWindow = window
	t.Cleanup(func() {
		startTaskEarlyDeathWindow = previous
	})
}

func TestParseShellExportsExpandsReferencedVars(t *testing.T) {
	content := io.NopCloser(strings.NewReader(`
export ANTHROPIC_COMPAT_API_KEY="TEST_ONLY_ANTHROPIC_COMPAT_TOKEN"
export ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_COMPAT_API_KEY"
export ANTHROPIC_BASE_URL="https://llm-gateway.example/anthropic"
export OPENAI_COMPAT_API_KEY="TEST_ONLY_OPENAI_COMPAT_TOKEN"
export CODEX_HOME="$HOME/.codex"
export OTHER_VAR="ignored"
`))
	defer content.Close()
	exports := parseShellExports(content, map[string]string{})
	if exports["ANTHROPIC_COMPAT_API_KEY"] != "TEST_ONLY_ANTHROPIC_COMPAT_TOKEN" {
		t.Fatalf("unexpected ANTHROPIC_COMPAT_API_KEY: %q", exports["ANTHROPIC_COMPAT_API_KEY"])
	}
	if exports["ANTHROPIC_AUTH_TOKEN"] != "TEST_ONLY_ANTHROPIC_COMPAT_TOKEN" {
		t.Fatalf("unexpected expanded token: %q", exports["ANTHROPIC_AUTH_TOKEN"])
	}
	if exports["ANTHROPIC_BASE_URL"] != "https://llm-gateway.example/anthropic" {
		t.Fatalf("unexpected base url: %q", exports["ANTHROPIC_BASE_URL"])
	}
	if exports["OPENAI_COMPAT_API_KEY"] != "TEST_ONLY_OPENAI_COMPAT_TOKEN" {
		t.Fatalf("unexpected OPENAI_COMPAT_API_KEY: %q", exports["OPENAI_COMPAT_API_KEY"])
	}
	if !strings.HasSuffix(exports["CODEX_HOME"], ".codex") {
		t.Fatalf("unexpected CODEX_HOME: %q", exports["CODEX_HOME"])
	}
	if _, ok := exports["OTHER_VAR"]; ok {
		t.Fatalf("non-Claude env should be ignored: %v", exports)
	}
}

// The control WS keepalive keeps an idle daemon "online" through the
// proxy infrastructure, which doesn't reliably forward WS PING/PONG control
// frames. It must push DAEMON_STATUS (an ordinary data frame Nexus treats as
// a liveness touch) on a steady cadence.
func TestControlKeepaliveSendsDaemonStatus(t *testing.T) {
	sent := make(chan envelope, 8)
	done := make(chan struct{})
	defer close(done)
	go controlKeepalive(context.Background(), done, 5*time.Millisecond, "dd_keepalive", func(env envelope) error {
		select {
		case sent <- env:
		default:
		}
		return nil
	}, nil)
	select {
	case env := <-sent:
		if env.Type != "DAEMON_STATUS" {
			t.Fatalf("keepalive type = %q, want DAEMON_STATUS", env.Type)
		}
		if env.DeviceID != "dd_keepalive" {
			t.Fatalf("keepalive device_id = %q, want dd_keepalive", env.DeviceID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no keepalive frame sent within 2s")
	}
}

func TestControlKeepaliveStopsWhenDoneClosed(t *testing.T) {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		controlKeepalive(context.Background(), done, time.Hour, "dd", func(env envelope) error { return nil }, nil)
		close(finished)
	}()
	close(done)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("controlKeepalive did not return after done closed")
	}
}

func TestControlKeepaliveStopsOnWriteError(t *testing.T) {
	onErr := make(chan struct{}, 1)
	finished := make(chan struct{})
	go func() {
		controlKeepalive(context.Background(), make(chan struct{}), 5*time.Millisecond, "dd", func(env envelope) error {
			return errors.New("write failed")
		}, func() { onErr <- struct{}{} })
		close(finished)
	}()
	select {
	case <-onErr:
	case <-time.After(2 * time.Second):
		t.Fatal("onWriteErr not invoked on write failure")
	}
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("controlKeepalive did not return after write error")
	}
}

func TestControlDataKeepaliveDisabledByDefault(t *testing.T) {
	t.Setenv("POCKLY_CONTROL_DATA_KEEPALIVE", "")
	if controlDataKeepaliveEnabled() {
		t.Fatal("control data keepalive should be disabled by default")
	}
}

func TestControlDataKeepaliveCanBeEnabled(t *testing.T) {
	t.Setenv("POCKLY_CONTROL_DATA_KEEPALIVE", "1")
	if !controlDataKeepaliveEnabled() {
		t.Fatal("control data keepalive should be enabled by env")
	}
}

func TestSyncHintEnvelopeDecodesAndRoutes(t *testing.T) {
	raw := `{"type":"SYNC_HINT","sync_hint":{"session_id":"sess-1","reason":"recently_opened","preferred_min":100,"synced_turn_count":100,"synced_min_seq":141,"synced_max_seq":240,"next_before_seq":141,"total_turn_count":240,"has_older_turns":true,"window_hash":"sha256:test"}}`
	var msg envelope
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatal(err)
	}
	if msg.SyncHint == nil {
		t.Fatal("sync_hint must decode")
	}
	if msg.SyncHint.SessionID != "sess-1" || msg.SyncHint.Reason != "recently_opened" || msg.SyncHint.PreferredMin != 100 || msg.SyncHint.NextBeforeSeq != 141 || msg.SyncHint.WindowHash != "sha256:test" || !msg.SyncHint.HasOlderTurns {
		t.Fatalf("sync_hint = %+v", msg.SyncHint)
	}

	var received []SyncHintPush
	cfg := Client{SyncHint: func(hint SyncHintPush) { received = append(received, hint) }}
	if msg.SyncHint != nil && cfg.SyncHint != nil {
		cfg.SyncHint(*msg.SyncHint)
	}
	if len(received) != 1 || received[0].SessionID != "sess-1" || received[0].NextBeforeSeq != 141 || received[0].WindowHash != "sha256:test" {
		t.Fatalf("handler received = %+v", received)
	}
}
