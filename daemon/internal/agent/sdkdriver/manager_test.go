//go:build !windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Whole file is Unix-only: the mock harness spawns /bin/true /
// /usr/bin/true to satisfy exec.Cmd.Start without running real
// claude, and assertions compare against absolute /usr/local/bin/
// paths. Neither translates to NT. Cross-platform manager testing
// is W3 polish — for W1 we accept that this package's unit suite
// runs on POSIX runners only. The exercised manager.go code itself
// IS portable; only the test mock is Unix-coupled.

package sdkdriver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/codexapp"
	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// recordingExec captures every exec.Command call so the test can assert
// what was spawned without actually running anything. The returned
// *exec.Cmd uses /bin/true as its binary so cmd.Start succeeds on every
// supported platform — we throw the process away after Start.
type recordingExec struct {
	mu    sync.Mutex
	calls []recordedCall
}

type recordedCall struct {
	Binary string
	Args   []string
}

type fakeCodexAppRuntime struct {
	mu             sync.Mutex
	cfg            codexapp.Config
	threadStarts   []codexapp.ThreadStartParams
	threadResumes  []codexapp.ThreadResumeParams
	turnStarts     []codexapp.TurnStartParams
	threadID       string
	blockTurn      bool
	ignoreTurnCtx  bool
	silentTurn     bool
	emptyCompleted bool
	signalOnly     bool
	errorOnly      bool
	closed         bool
}

func (f *fakeCodexAppRuntime) factory(ctx context.Context, cfg codexapp.Config) (CodexAppRuntime, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cfg = cfg
	return f, nil
}

func (f *fakeCodexAppRuntime) ThreadStart(ctx context.Context, p codexapp.ThreadStartParams) (codexapp.ThreadStartResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.threadStarts = append(f.threadStarts, p)
	id := f.threadID
	if id == "" {
		id = "codex-thread-new"
	}
	return codexapp.ThreadStartResult{ThreadID: id, Cwd: p.Cwd, Model: p.Model}, nil
}

func (f *fakeCodexAppRuntime) ThreadResume(ctx context.Context, p codexapp.ThreadResumeParams) (codexapp.ThreadStartResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.threadResumes = append(f.threadResumes, p)
	return codexapp.ThreadStartResult{ThreadID: p.ThreadID, Cwd: p.Cwd, Model: p.Model}, nil
}

func (f *fakeCodexAppRuntime) TurnStart(ctx context.Context, p codexapp.TurnStartParams) error {
	f.mu.Lock()
	f.turnStarts = append(f.turnStarts, p)
	cfg := f.cfg
	block := f.blockTurn
	ignoreCtx := f.ignoreTurnCtx
	f.mu.Unlock()
	if ignoreCtx {
		select {}
	}
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	if f.silentTurn {
		return nil
	}
	if cfg.OnNotification != nil {
		if f.signalOnly {
			cfg.OnNotification(codexapp.Notification{
				Method: "item/unknownSignal",
				Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turnId":"turn-signal-only","item":{"id":"sig-1","type":"unknown"}}`),
			})
			cfg.OnNotification(codexapp.Notification{
				Method: "turn/completed",
				Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turn":{"id":"turn-signal-only","status":"completed","items":[]}}`),
			})
			return nil
		}
		if f.errorOnly {
			cfg.OnNotification(codexapp.Notification{
				Method: "error",
				Params: json.RawMessage(`{"code":"rate_limit_exceeded","error":{"message":"DeepSeek quota exceeded"},"details":"retry later"}`),
			})
			cfg.OnNotification(codexapp.Notification{
				Method: "turn/completed",
				Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turn":{"id":"turn-error-only","status":"failed","items":[]}}`),
			})
			return nil
		}
		if f.emptyCompleted {
			cfg.OnNotification(codexapp.Notification{
				Method: "turn/completed",
				Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turn":{"id":"turn-empty","status":"completed","items":[]}}`),
			})
			return nil
		}
		cfg.OnNotification(codexapp.Notification{
			Method: "item/completed",
			Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turnId":"turn-1","item":{"id":"msg-1","type":"agentMessage","text":"codex ok"}}`),
		})
		cfg.OnNotification(codexapp.Notification{
			Method: "turn/completed",
			Params: json.RawMessage(`{"threadId":"` + p.ThreadID + `","turn":{"id":"turn-1","status":"completed","items":[]}}`),
		})
	}
	return nil
}

func (f *fakeCodexAppRuntime) ModelList(ctx context.Context) ([]codexapp.Model, error) {
	return []codexapp.Model{{ID: "gpt-5.4", Model: "gpt-5.4", DisplayName: "GPT-5.4"}}, nil
}

func (f *fakeCodexAppRuntime) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}

func (f *fakeCodexAppRuntime) snapshot() (starts []codexapp.ThreadStartParams, resumes []codexapp.ThreadResumeParams, turns []codexapp.TurnStartParams) {
	f.mu.Lock()
	defer f.mu.Unlock()
	starts = append([]codexapp.ThreadStartParams(nil), f.threadStarts...)
	resumes = append([]codexapp.ThreadResumeParams(nil), f.threadResumes...)
	turns = append([]codexapp.TurnStartParams(nil), f.turnStarts...)
	return starts, resumes, turns
}

func (f *fakeCodexAppRuntime) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func (r *recordingExec) Capture(ctx context.Context, name string, args ...string) *exec.Cmd {
	r.mu.Lock()
	r.calls = append(r.calls, recordedCall{Binary: name, Args: args})
	r.mu.Unlock()
	// Run /bin/true so the subprocess succeeds + exits immediately. The
	// driver's wait goroutine sees a clean exit and emits
	// EventSessionExited; tests asserting argument shapes don't care
	// about the brief lifetime.
	c := exec.CommandContext(ctx, trueBinary())
	return c
}

func trueBinary() string {
	for _, p := range []string{"/bin/true", "/usr/bin/true"} {
		if _, err := exec.LookPath(p); err == nil {
			return p
		}
	}
	return "/usr/bin/true"
}

func (r *recordingExec) Snapshot() []recordedCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]recordedCall, len(r.calls))
	copy(out, r.calls)
	return out
}

func fakeResolve(name string) (string, error) {
	// Pretend whichever binary the manager asks for lives at a
	// predictable path. The recordingExec ignores the path anyway —
	// what matters is that EnsureDriver doesn't ENOENT before reaching
	// Driver.Start.
	return "/usr/local/bin/" + name, nil
}

func TestManagerSpawnsClaudeWithCorrectArgs(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:          termMgr,
		Exec:              rec.Capture,
		DaemonBinaryPath:  "/opt/pockly-daemon",
		DaemonLocalAPIURL: "http://127.0.0.1:8947",
		BinaryResolve:     fakeResolve,
	})

	_, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("EnsureDriver claude: %v", err)
	}

	// Wait for the spawn goroutine to actually invoke Exec. Driver.Start
	// calls cmd.Start synchronously, so the recordedCall should appear
	// almost immediately — but the goroutine model means we poll.
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		return len(rec.Snapshot()) > 0
	}) {
		t.Fatal("timed out waiting for claude spawn")
	}

	calls := rec.Snapshot()
	if len(calls) != 1 {
		t.Fatalf("expected exactly 1 spawn, got %d: %+v", len(calls), calls)
	}
	call := calls[0]
	if call.Binary != "/usr/local/bin/claude" {
		t.Fatalf("binary = %q, want /usr/local/bin/claude", call.Binary)
	}
	joined := strings.Join(call.Args, " ")
	for _, want := range []string{
		"--resume sess_a",
		"--print",
		"--output-format=stream-json",
		"--input-format=stream-json",
		"--verbose",
		"--permission-prompt-tool mcp__pockly__request_permission",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("expected claude args to contain %q; full args: %s", want, joined)
		}
	}
	// --mcp-config flag should appear AND the temp file should have
	// been written. We don't assert the exact path (it's a temp).
	if !strings.Contains(joined, "--mcp-config ") {
		t.Errorf("expected --mcp-config flag in args: %s", joined)
	}
}

func TestManagerSpawnsClaudeThroughLauncherSpec(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:          termMgr,
		Exec:              rec.Capture,
		DaemonBinaryPath:  "/opt/pockly-daemon",
		DaemonLocalAPIURL: "http://127.0.0.1:8947",
		ClaudeLauncherResolve: func() (claudelauncher.CommandSpec, error) {
			return claudelauncher.CommandSpec{
				Path:       "/usr/local/bin/cc-switch-launcher",
				PrefixArgs: []string{"switch", "exec", "claude"},
				Source:     claudelauncher.LauncherJSONEnv,
			}, nil
		},
	})

	if _, err := m.EnsureDriver(context.Background(), "sess_launcher", "/tmp", AgentClaude); err != nil {
		t.Fatalf("EnsureDriver claude launcher: %v", err)
	}
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		return len(rec.Snapshot()) > 0
	}) {
		t.Fatal("timed out waiting for claude launcher spawn")
	}
	call := rec.Snapshot()[0]
	if call.Binary != "/usr/local/bin/cc-switch-launcher" {
		t.Fatalf("binary = %q, want launcher", call.Binary)
	}
	wantPrefix := []string{"switch", "exec", "claude", "--resume", "sess_launcher"}
	if len(call.Args) < len(wantPrefix) {
		t.Fatalf("args too short: %#v", call.Args)
	}
	for i, want := range wantPrefix {
		if call.Args[i] != want {
			t.Fatalf("arg[%d] = %q, want %q (args=%#v)", i, call.Args[i], want, call.Args)
		}
	}
}

func TestManagerCodexUsesAppServerForNewSession(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-real"}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if fake.cfg.BinaryPath == "" {
		t.Fatal("codex app-server should be initialized during EnsureNewDriver")
	}
	// Codex thread creation is still input-lazy, but EnsureNewDriver now
	// validates app-server support up front. The first input uses
	// thread/start + turn/start rather than `codex exec`.
	if got := len(rec.Snapshot()); got != 0 {
		t.Fatalf("codex should not spawn at EnsureDriver time, got %d calls", got)
	}

	if err := ext.SendRaw("hello codex\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		_, _, turns := fake.snapshot()
		return len(turns) > 0
	}) {
		t.Fatal("timed out waiting for codex app-server turn/start")
	}
	starts, resumes, turns := fake.snapshot()
	if len(starts) != 1 {
		t.Fatalf("thread/start calls = %d, want 1", len(starts))
	}
	if len(resumes) != 0 {
		t.Fatalf("thread/resume calls = %d, want 0", len(resumes))
	}
	if len(turns) != 1 {
		t.Fatalf("turn/start calls = %d, want 1", len(turns))
	}
	if turns[0].ThreadID != "codex-thread-real" || turns[0].Text != "hello codex" {
		t.Fatalf("bad turn/start params: %+v", turns[0])
	}
	if got := ext.ClaudeSessionID(); got != "codex-thread-real" {
		t.Fatalf("ExternalSession sid = %q, want codex-thread-real", got)
	}
	if len(rec.Snapshot()) != 0 {
		t.Fatalf("app-server fake should not spawn legacy process, got %+v", rec.Snapshot())
	}
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		seenUser := false
		seenAssistant := false
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventUserInput) && e.SessionID == "codex-thread-real" {
				seenUser = true
			}
			if e.Kind == "message_added" && e.SessionID == "codex-thread-real" {
				seenAssistant = true
			}
		}
		return seenUser && seenAssistant
	}) {
		t.Fatalf("codex app-server notification was not forwarded with real thread id: %+v", sink.Snapshot())
	}
	events := sink.Snapshot()
	userIndex := -1
	assistantIndex := -1
	for i, e := range events {
		if e.SessionID != "codex-thread-real" {
			continue
		}
		if userIndex < 0 && e.Kind == string(terminal.EventUserInput) {
			userIndex = i
		}
		if assistantIndex < 0 && e.Kind == "message_added" {
			assistantIndex = i
		}
	}
	if userIndex < 0 || assistantIndex < 0 || userIndex > assistantIndex {
		t.Fatalf("codex user_input must precede app-server assistant notification, user=%d assistant=%d events=%+v", userIndex, assistantIndex, events)
	}
}

func TestManagerCodexTurnTimeoutEmitsRetryableAgentErrorAndClosesAppServer(t *testing.T) {
	oldTimeout := codexTurnTimeout
	codexTurnTimeout = 50 * time.Millisecond
	defer func() { codexTurnTimeout = oldTimeout }()

	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-timeout", blockTurn: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-timeout", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("hang please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_timeout") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("codex turn timeout agent_error was not forwarded; events=%+v", sink.Snapshot())
	}
	if !fake.isClosed() {
		t.Fatal("timed-out codex app-server should be closed so next turn can restart it")
	}
	m.mu.Lock()
	drv := m.drivers["provisional-codex-timeout"].driver
	m.mu.Unlock()
	if drv == nil {
		t.Fatal("driver entry should remain retryable after turn timeout")
	}
	if drv.TurnInFlight() {
		t.Fatal("TurnInFlight stayed true after codex turn timeout")
	}
}

func TestManagerCodexSilentTurnCompletionTimeoutEmitsRetryableAgentError(t *testing.T) {
	oldTimeout := codexTurnTimeout
	codexTurnTimeout = 50 * time.Millisecond
	defer func() { codexTurnTimeout = oldTimeout }()

	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-silent", silentTurn: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-silent", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("silent please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_timeout: turn did not complete") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("codex silent turn timeout agent_error was not forwarded; events=%+v", sink.Snapshot())
	}
	if !fake.isClosed() {
		t.Fatal("silent timed-out codex app-server should be closed so next turn can restart it")
	}
}

func TestManagerCodexEmptyCompletedTurnEmitsRetryableAgentError(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-empty", emptyCompleted: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-empty", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("empty please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_empty") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("empty codex completed turn did not emit agent_error; events=%+v", sink.Snapshot())
	}
}

func TestManagerCodexSignalOnlyCompletedTurnEmitsRetryableAgentError(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-signal-only", signalOnly: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-signal-only", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("signal only please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_empty") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("signal-only codex completed turn did not emit agent_error; events=%+v", sink.Snapshot())
	}
}

func TestManagerCodexErrorNotificationCompletesWithUpstreamError(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-error-only", errorOnly: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-error-only", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("error only please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) &&
				strings.Contains(e.Error, "codex_turn_error") &&
				strings.Contains(e.Error, "DeepSeek quota exceeded") &&
				!strings.Contains(e.Error, "codex_turn_empty") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("codex error notification did not surface upstream error; events=%+v", sink.Snapshot())
	}
}

func TestManagerCodexBlockedTurnStartStillTimesOut(t *testing.T) {
	oldTimeout := codexTurnTimeout
	codexTurnTimeout = 50 * time.Millisecond
	defer func() { codexTurnTimeout = oldTimeout }()

	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-blocked", ignoreTurnCtx: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-blocked", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("blocked please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_timeout: turn did not complete") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("blocked codex turn/start did not emit watchdog agent_error; events=%+v", sink.Snapshot())
	}
	if !fake.isClosed() {
		t.Fatal("blocked codex app-server should be closed by watchdog")
	}
}

func TestManagerReaperConvertsStuckCodexTurnToRetryableAgentError(t *testing.T) {
	oldTimeout := codexTurnTimeout
	codexTurnTimeout = 50 * time.Millisecond
	defer func() { codexTurnTimeout = oldTimeout }()

	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	fake := &fakeCodexAppRuntime{threadID: "codex-thread-reaper", ignoreTurnCtx: true}
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:        termMgr,
		Exec:            rec.Capture,
		BinaryResolve:   fakeResolve,
		CodexAppFactory: fake.factory,
		EventSink:       sink,
	})

	ext, err := m.EnsureNewDriver(context.Background(), "provisional-codex-reaper", t.TempDir(), AgentCodex)
	if err != nil {
		t.Fatalf("EnsureDriver codex: %v", err)
	}
	if err := ext.SendRaw("blocked please\r"); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	var drv *Driver
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		m.mu.Lock()
		entry := m.drivers["provisional-codex-reaper"]
		if entry != nil {
			drv = entry.driver
		}
		m.mu.Unlock()
		return drv != nil && drv.TurnInFlight()
	}) {
		t.Fatalf("codex turn never entered in-flight state; events=%+v", sink.Snapshot())
	}
	m.reapIdleDrivers(drv.LastActivity().Add(codexTurnTimeout + time.Millisecond))
	if !pollUntil(10*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == string(terminal.EventAgentError) && strings.Contains(e.Error, "codex_turn_timeout: turn did not complete") {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("reaper did not emit retryable codex timeout; events=%+v", sink.Snapshot())
	}
	if drv.TurnInFlight() {
		t.Fatal("TurnInFlight stayed true after reaper timeout")
	}
	if !fake.isClosed() {
		t.Fatal("reaper timeout should close codex app-server")
	}
}

func TestManagerCodexRequiresAppServer(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		CodexAppFactory: func(ctx context.Context, cfg codexapp.Config) (CodexAppRuntime, error) {
			return nil, errors.New("unknown subcommand: app-server")
		},
	})

	_, err := m.EnsureNewDriver(context.Background(), "provisional-codex", t.TempDir(), AgentCodex)
	if err == nil {
		t.Fatal("expected app-server capability error")
	}
	if !strings.Contains(err.Error(), "codex_app_server_unavailable") || !strings.Contains(err.Error(), "upgrade Codex CLI") {
		t.Fatalf("error = %q, want upgrade gate", err.Error())
	}
	if got := len(rec.Snapshot()); got != 0 {
		t.Fatalf("must not fall back to legacy codex exec, got exec calls: %+v", rec.Snapshot())
	}
}

func TestCodexAppServerApprovalUsesPermissionStore(t *testing.T) {
	store := permission.New()
	ext := terminal.NewExternalSession()
	ext.BindSessionMetadata("codex-thread-1", t.TempDir())
	driver := New(Config{
		Agent:             AgentCodex,
		SessionID:         "codex-thread-1",
		Cwd:               t.TempDir(),
		BinaryPath:        "/usr/local/bin/codex",
		TerminalSessionID: "ts-codex",
		PermissionStore:   store,
	}, ext)
	events, unsubscribe := ext.Subscribe(16)
	defer unsubscribe()

	done := make(chan json.RawMessage, 1)
	go func() {
		raw, err := driver.handleCodexServerRequest(context.Background(), codexapp.ServerRequest{
			ID:     "approval-1",
			Method: "item/commandExecution/requestApproval",
			Params: json.RawMessage(`{"threadId":"codex-thread-1","turnId":"turn-1","itemId":"cmd-1","command":"rm tmp.txt","cwd":"/tmp","startedAtMs":1}`),
		})
		if err != nil {
			done <- json.RawMessage(`{"error":"` + err.Error() + `"}`)
			return
		}
		done <- raw
	}()

	if !pollUntil(20*time.Millisecond, 1500*time.Millisecond, func() bool {
		return len(store.List()) == 1
	}) {
		t.Fatalf("permission request not registered: %+v", store.List())
	}
	if !pollUntil(20*time.Millisecond, 1500*time.Millisecond, func() bool {
		for {
			select {
			case evt := <-events:
				if evt.Kind == terminal.EventKind("permission_request") && strings.Contains(evt.Payload, `"request_id":"approval-1"`) {
					return true
				}
			default:
				return false
			}
		}
	}) {
		t.Fatal("permission_request event was not emitted")
	}
	if err := store.Decide("approval-1", permission.DecisionAllow); err != nil {
		t.Fatalf("Decide: %v", err)
	}
	select {
	case raw := <-done:
		var res struct {
			Decision string `json:"decision"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			t.Fatalf("approval response json: %v raw=%s", err, raw)
		}
		if res.Decision != "accept" {
			t.Fatalf("decision = %q, want accept", res.Decision)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("approval handler did not return after web decision")
	}
}

// TestManagerReusesExternalSessionAfterSubprocessExit is the regression
// test for SDK process recovery: if the claude subprocess exits, the
// ExternalSession (and its terminal_session_id) MUST persist. Web's
// attachExistingLiveSessionBridge requires session_status=="live" or
// "starting" to attach an SSE bridge — if the session goes "exited"
// after a clean process exit, follow-up assistant replies never reach
// the browser because there's no subscriber to forward them to.
//
// Expectations:
//  1. Two back-to-back EnsureDriver calls on the same sid (the second
//     after the first subprocess has finished) return the SAME
//     ExternalSession pointer.
//  2. Each call spawns its own claude subprocess (so we see 2 spawn
//     records).
func TestManagerReusesExternalSessionAfterSubprocessExit(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})

	ext1, err := m.EnsureDriver(context.Background(), "sess_persist", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}

	// Wait for the first subprocess (/bin/true) to exit and the
	// SubprocessDone goroutine to clear entry.driver.
	if !pollUntil(20*time.Millisecond, 2*time.Second, func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		e, ok := m.drivers["sess_persist"]
		return ok && e.driver == nil
	}) {
		t.Fatal("timed out waiting for first subprocess to clear entry.driver")
	}

	ext2, err := m.EnsureDriver(context.Background(), "sess_persist", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}

	if ext1 != ext2 {
		t.Fatalf("EnsureDriver should return the SAME ExternalSession across turns; got %p then %p", ext1, ext2)
	}

	// Wait for the second spawn to record.
	if !pollUntil(20*time.Millisecond, 2*time.Second, func() bool {
		return len(rec.Snapshot()) >= 2
	}) {
		t.Fatalf("expected 2 spawn records by now, got %d", len(rec.Snapshot()))
	}

	calls := rec.Snapshot()
	if len(calls) != 2 {
		t.Fatalf("expected exactly 2 spawns across two turns, got %d", len(calls))
	}
}

// persistentClaudeExec returns a helper subprocess that mimics the
// Claude Code stream-json protocol closely enough for driver lifecycle
// tests: it stays alive, reads every stdin JSON line as a user turn, and
// emits assistant + result records for each turn.
type persistentClaudeExec struct {
	mu    sync.Mutex
	calls []recordedCall
}

func (p *persistentClaudeExec) Capture(ctx context.Context, name string, args ...string) *exec.Cmd {
	p.mu.Lock()
	p.calls = append(p.calls, recordedCall{Binary: name, Args: args})
	p.mu.Unlock()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestPersistentClaudeHelperProcess", "--", "pockly-sdkdriver-helper")
	return cmd
}

func (p *persistentClaudeExec) Snapshot() []recordedCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]recordedCall, len(p.calls))
	copy(out, p.calls)
	return out
}

func countResultEvents(events []SDKTerminalEvent) int {
	count := 0
	for _, event := range events {
		if event.Kind == string(terminal.EventMessageAdded) && strings.Contains(event.Payload, `"type":"result"`) {
			count++
		}
	}
	return count
}

func TestClaudeDriverKeepsStreamJSONProcessAliveAcrossInputs(t *testing.T) {
	rec := &persistentClaudeExec{}
	termMgr := terminal.NewManager()
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		EventSink:     sink,
	})
	t.Cleanup(m.StopAll)

	ext, err := m.EnsureDriver(context.Background(), "sess_persistent", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	if err := ext.SendInput("first"); err != nil {
		t.Fatalf("first SendInput: %v", err)
	}
	if !pollUntil(20*time.Millisecond, 2*time.Second, func() bool {
		return countResultEvents(sink.Snapshot()) >= 1
	}) {
		t.Fatalf("first result never reached sink; events=%+v", sink.Snapshot())
	}
	if err := ext.SendInput("second"); err != nil {
		t.Fatalf("second SendInput: %v", err)
	}
	if !pollUntil(20*time.Millisecond, 2*time.Second, func() bool {
		return countResultEvents(sink.Snapshot()) >= 2
	}) {
		t.Fatalf("second result never reached sink; events=%+v", sink.Snapshot())
	}
	if got := len(rec.Snapshot()); got != 1 {
		t.Fatalf("persistent claude driver should use one subprocess for two inputs, got %d spawns", got)
	}
}

// TestManagerAllowsConcurrentSidsAndIdempotentSameSid covers the
// post-issue-#4 contract: distinct sids are allowed to have live
// drivers in parallel, while a second EnsureDriver for the same sid
// folds into the cached entry without spawning a duplicate.
//
// Pre-fix this scenario returned ErrBusy on `sess_b` and made the web
// "New Conversation" button unusable while any previous SDK session
// was alive (which is always, given persistent stream-json).
func TestManagerAllowsConcurrentSidsAndIdempotentSameSid(t *testing.T) {
	// Use the persistent helper, NOT recordingExec(/bin/true). Claude in
	// stream-json mode keeps its subprocess alive across turns (stdin
	// stays open — see "keep stream-json stdin open across turns"), so a
	// repeat EnsureDriver on a still-live sid must fold into the cached
	// entry. recordingExec exits instantly, which would let the
	// subprocess-exit recovery path (intentionally) respawn sess_a and
	// report 3 spawns — that models a *dead* process, not the idempotent
	// "same sid, still running" case this test is about.
	rec := &persistentClaudeExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	t.Cleanup(m.StopAll)

	if _, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	// Concurrent sid: must NOT return ErrBusy. The two sids run in
	// parallel; resource management for many concurrent claude
	// subprocesses is a separate concern (issue #4 follow-up if a
	// scheduling policy is ever needed).
	if _, err := m.EnsureDriver(context.Background(), "sess_b", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("expected sess_b to be accepted alongside sess_a, got: %v", err)
	}
	// Same sid: returns cached driver without spawning again. The
	// recordingExec snapshot at this point must show exactly two
	// spawns (one per distinct sid), not three.
	if _, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("idempotent ensure: %v", err)
	}
	if got := len(rec.Snapshot()); got != 2 {
		t.Fatalf("expected exactly 2 spawns (sess_a + sess_b, sess_a cached), got %d", got)
	}
}

// TestManagerReapsIdleDrivers is the regression for the SDK subprocess
// leak: the stream-json claude subprocess keeps stdin open across turns
// (so follow-ups are instant) and therefore never self-exits. Without
// the idle reaper, every web conversation leaks a persistent
// `claude --print` + mcp-permission process until daemon shutdown. The
// reaper reclaims a driver once it's been idle past idleTimeout and is
// not mid-turn; the next inject re-creates a fresh driver.
func TestManagerReapsIdleDrivers(t *testing.T) {
	rec := &persistentClaudeExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	t.Cleanup(m.StopAll)

	ext1, err := m.EnsureDriver(context.Background(), "sess_idle", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	m.mu.Lock()
	drv := m.drivers["sess_idle"].driver
	m.mu.Unlock()
	if drv == nil {
		t.Fatal("no driver after ensure")
	}

	// Within the idle window → must NOT be reaped.
	m.reapIdleDrivers(drv.LastActivity().Add(idleTimeout - time.Minute))
	m.mu.Lock()
	_, stillThere := m.drivers["sess_idle"]
	m.mu.Unlock()
	if !stillThere {
		t.Fatal("driver reaped while still within the idle window")
	}

	// Past the idle window → reclaimed (entry removed synchronously).
	m.reapIdleDrivers(drv.LastActivity().Add(idleTimeout + time.Minute))
	m.mu.Lock()
	_, gone := m.drivers["sess_idle"]
	m.mu.Unlock()
	if gone {
		t.Fatal("idle driver was not reaped past idleTimeout")
	}

	// Next inject re-creates a fresh driver (cold respawn after reclaim).
	ext2, err := m.EnsureDriver(context.Background(), "sess_idle", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("re-ensure after reap: %v", err)
	}
	if ext1 == ext2 {
		t.Fatal("expected a fresh ExternalSession after reclaim, got the reaped one")
	}
}

// failThenSucceedExec fails cmd.Start() on the first spawn (an absolute path
// with a slash skips LookPath, so the ENOENT surfaces at Start, not
// construction), then runs /bin/true on every later call. It simulates a
// transient first-spawn failure (temp dir full, ETXTBSY mid-binary-upgrade,
// fork pressure) so a test can prove the failure doesn't pin a dead session.
type failThenSucceedExec struct {
	mu    sync.Mutex
	calls int
}

func (f *failThenSucceedExec) Capture(ctx context.Context, name string, args ...string) *exec.Cmd {
	f.mu.Lock()
	f.calls++
	first := f.calls == 1
	f.mu.Unlock()
	if first {
		return exec.CommandContext(ctx, "/nonexistent/pockly-sdk-start-fail")
	}
	return exec.CommandContext(ctx, trueBinary())
}

// TestManagerStartFailureDoesNotBrickSession guards the permanent-brick fix.
// When the FIRST subprocess spawn fails (Driver.Start errors after the entry
// is registered), the manager Stop()s the freshly created ExternalSession.
// Before the fix it ALSO left the entry behind with driver==nil; the idle
// reaper skips driver==nil entries, so that entry (pinning a now-closed ext)
// was never reaped, and every later inject reused the dead ext and failed with
// sdk_send_failed forever. The entry must be deleted on first-spawn failure so
// a later inject registers a fresh ext and recovers.
func TestManagerStartFailureDoesNotBrickSession(t *testing.T) {
	rec := &failThenSucceedExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:          termMgr,
		Exec:              rec.Capture,
		DaemonBinaryPath:  "/opt/pockly-daemon",
		DaemonLocalAPIURL: "http://127.0.0.1:8947",
		BinaryResolve:     fakeResolve,
	})

	// First spawn fails at cmd.Start().
	if _, err := m.EnsureDriver(context.Background(), "sess_brick", t.TempDir(), AgentClaude); err == nil {
		t.Fatal("expected EnsureDriver to fail when the first spawn cannot start")
	}

	// The regression: a bricked entry (driver==nil + closed ext) must NOT linger
	// in m.drivers — the reaper would never reclaim it.
	m.mu.Lock()
	_, lingering := m.drivers["sess_brick"]
	m.mu.Unlock()
	if lingering {
		t.Fatal("first-spawn failure left a bricked entry in m.drivers (reaper skips driver==nil → permanent sdk_send_failed until restart)")
	}

	// Recovery: a later inject registers a FRESH ExternalSession and succeeds
	// (second exec call runs /bin/true), proving the dead ext was not reused.
	ext, err := m.EnsureDriver(context.Background(), "sess_brick", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("re-ensure after a transient start failure should recover, got: %v", err)
	}
	if ext == nil {
		t.Fatal("expected a live ExternalSession after recovery")
	}
	m.mu.Lock()
	_, present := m.drivers["sess_brick"]
	m.mu.Unlock()
	if !present {
		t.Fatal("recovered session should be registered in m.drivers")
	}
}

// TestManagerSeqContinuesAcrossReap guards the multi-turn seq-scramble
// fix. The relay keys turns on (session, seq); when the idle reaper drops
// a driver and a later follow-up re-creates the ExternalSession, the new
// instance must continue the seq above the prior high-water instead of
// restarting at 0 — otherwise the follow-up's events collide with and
// OVERWRITE the original turn's relay rows (the bug: original user
// message dropped, assistant replies reordered).
func TestManagerSeqContinuesAcrossReap(t *testing.T) {
	rec := &persistentClaudeExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	t.Cleanup(m.StopAll)

	ext1, err := m.EnsureDriver(context.Background(), "sess_seq", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	// Simulate a turn's worth of streamed events advancing the seq well
	// past the two startup emits.
	for i := 0; i < 5; i++ {
		ext1.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, "line", "")
	}
	highWater := ext1.Seq()
	if highWater < 5 {
		t.Fatalf("expected seq to advance past startup emits, got %d", highWater)
	}

	m.mu.Lock()
	drv := m.drivers["sess_seq"].driver
	m.mu.Unlock()
	m.reapIdleDrivers(drv.LastActivity().Add(idleTimeout + time.Minute))
	m.mu.Lock()
	_, gone := m.drivers["sess_seq"]
	m.mu.Unlock()
	if gone {
		t.Fatal("idle driver was not reaped")
	}

	ext2, err := m.EnsureDriver(context.Background(), "sess_seq", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("re-ensure after reap: %v", err)
	}
	if ext1 == ext2 {
		t.Fatal("expected a fresh ExternalSession after reclaim")
	}
	// The re-created session must NOT restart seq from 0: it must be seeded
	// at or above the prior instance's high-water.
	if got := ext2.Seq(); got < highWater {
		t.Fatalf("seq restarted below high-water after reap: ext2.Seq()=%d, want >= %d", got, highWater)
	}
	// And a follow-up event must land strictly above everything the first
	// instance emitted, so it can never overwrite an original-turn row.
	ext2.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, "followup", "")
	if got := ext2.Seq(); got <= highWater {
		t.Fatalf("follow-up event seq %d did not exceed prior high-water %d", got, highWater)
	}
}

// TestBuildArgsEffort guards the SDK route of the effort pill: a real
// reasoning-effort level is forwarded as --effort, and the "none"/empty
// no-op sentinel is dropped (claude's --effort would reject it).
func TestBuildArgsEffort(t *testing.T) {
	mk := func(effort string) []string {
		d := New(Config{Agent: AgentClaude, SessionID: "sess_e", Effort: effort}, terminal.NewExternalSession())
		args, _, _, err := d.buildArgs()
		if err != nil {
			t.Fatalf("buildArgs(effort=%q): %v", effort, err)
		}
		return args
	}
	hasPair := func(args []string, flag, val string) bool {
		for i := 0; i+1 < len(args); i++ {
			if args[i] == flag && args[i+1] == val {
				return true
			}
		}
		return false
	}
	hasFlag := func(args []string, flag string) bool {
		for _, a := range args {
			if a == flag {
				return true
			}
		}
		return false
	}
	for _, lvl := range []string{"low", "medium", "high", "xhigh", "max"} {
		if a := mk(lvl); !hasPair(a, "--effort", lvl) {
			t.Errorf("effort %q should forward --effort %s, got %v", lvl, lvl, a)
		}
	}
	for _, noop := range []string{"", "none"} {
		if a := mk(noop); hasFlag(a, "--effort") {
			t.Errorf("effort %q is a no-op sentinel and must not add --effort, got %v", noop, a)
		}
	}
}

// TestBuildArgsRefusesBypassPermissionMode guards the L1 fix. SDK sessions must
// keep canUseTool wired so tool approvals forward to the web as permission
// cards; passing --permission-mode bypassPermissions (or dontAsk) makes claude
// skip the permission-prompt-tool and auto-execute tools with no remote
// approval. The mode reaches buildArgs straight from routeStartTask's
// req.PermissionMode unchecked, so buildArgs is the last line of defense.
func TestBuildArgsRefusesBypassPermissionMode(t *testing.T) {
	mk := func(mode string) []string {
		d := New(Config{Agent: AgentClaude, SessionID: "sess_x", PermissionMode: mode}, terminal.NewExternalSession())
		args, _, _, err := d.buildArgs()
		if err != nil {
			t.Fatalf("buildArgs(%q): %v", mode, err)
		}
		return args
	}
	has := func(args []string, v string) bool {
		for _, a := range args {
			if a == v {
				return true
			}
		}
		return false
	}
	// A valid mode passes through to claude unchanged.
	if a := mk("plan"); !has(a, "--permission-mode") || !has(a, "plan") {
		t.Errorf("permission-mode plan should pass through, got %v", a)
	}
	// Bypass modes must be refused (no --permission-mode flag → claude default,
	// which still routes tool approvals through our MCP permission tool).
	for _, mode := range []string{"bypassPermissions", "dontAsk"} {
		a := mk(mode)
		if has(a, "--permission-mode") || has(a, mode) {
			t.Errorf("%s must be refused for SDK sessions (would bypass web approval), got %v", mode, a)
		}
	}
}

// TestDriverDropsInputSubscriptionOnSubprocessExit guards the C1 fix. When a
// claude subprocess exits on its own (crash / rate-limit / one-shot exit)
// rather than via Stop(), wait() must cancel procCtx so the driver's pumpStdin
// goroutine exits and drops its SendInput subscription on the SHARED
// ExternalSession. Without that, the next inject's reuse-respawn adds a SECOND
// pumpStdin and ExternalSession.SendInput broadcasts the prompt to both — the
// dead subprocess's pump writes to its closed stdin and the user's follow-up
// is silently lost.
func TestDriverDropsInputSubscriptionOnSubprocessExit(t *testing.T) {
	rec := &recordingExec{} // runs /bin/true → subprocess exits immediately
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	t.Cleanup(m.StopAll)

	ext, err := m.EnsureDriver(context.Background(), "sess_exit", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	// The subprocess exits ~immediately; wait() then cancels procCtx and
	// pumpStdin must unsubscribe. Poll until it does (or fail). A leaked
	// subscriber stays at 1 forever (pumpStdin blocked on its input channel).
	deadline := time.Now().Add(2 * time.Second)
	for ext.InputSubscriberCount() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := ext.InputSubscriberCount(); n != 0 {
		t.Fatalf("stale input subscriber after natural subprocess exit: got %d, want 0 (pumpStdin leaked → would steal a reuse-respawn's input)", n)
	}
}

// TestPermissionMCPConfigCarriesDecisionWindow guards the C2 fix: the
// SDK driver must hand mcp-permission a generous --timeout so the remote
// human has a realistic approval window. The default 30s caused Claude
// to time out + retry the tool with a fresh reqID, leaving the web card's
// reqID stale → a late Allow decided a dead request (not_found, "tool
// was blocked").
func TestPermissionMCPConfigCarriesDecisionWindow(t *testing.T) {
	path, cleanup, err := writePermissionMCPConfig("/opt/pockly-daemon", "sess_x", "ts_x", "http://127.0.0.1:8947")
	if err != nil {
		t.Fatalf("writePermissionMCPConfig: %v", err)
	}
	defer cleanup()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg struct {
		MCPServers map[string]struct {
			Args []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("parse config: %v (raw=%s)", err, raw)
	}
	args := strings.Join(cfg.MCPServers["pockly"].Args, " ")
	if !strings.Contains(args, "--interactive") {
		t.Fatalf("expected --interactive in mcp-permission args: %s", args)
	}
	if !strings.Contains(args, "--timeout "+permissionDecisionWindow.String()) {
		t.Fatalf("expected --timeout %s (the decision window) in args: %s", permissionDecisionWindow, args)
	}
	if permissionDecisionWindow < 60*time.Second {
		t.Fatalf("permissionDecisionWindow=%s is too short for a remote human to approve", permissionDecisionWindow)
	}
}

// stubSessionResolver records lookups so the test can assert the
// fallback path fires when EnsureDriver receives an empty cwd.
type stubSessionResolver struct {
	calls []string
	cwd   string
}

func (s *stubSessionResolver) CwdForSession(sid string) string {
	s.calls = append(s.calls, sid)
	return s.cwd
}

// TestManagerFallsBackToSessionResolverWhenCwdEmpty covers the
// mixed-version safety net: a relay that doesn't yet populate
// InjectRequest.Cwd (pre-M9 build) lands here with cwd="". Without the
// fallback, `claude --resume` would launch in the daemon's $HOME and
// silently lose CLAUDE.md / project files. With it, the index resolves
// the session's cwd and the spawn lands in the right project.
func TestManagerFallsBackToSessionResolverWhenCwdEmpty(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	resolver := &stubSessionResolver{cwd: t.TempDir()}
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		Sessions:      resolver,
	})

	if _, err := m.EnsureDriver(context.Background(), "sess_a", "", AgentClaude); err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	if len(resolver.calls) != 1 || resolver.calls[0] != "sess_a" {
		t.Fatalf("resolver should have been asked once for sess_a; got %+v", resolver.calls)
	}
	// Wait for the spawn so we can assert cmd.Dir was actually the
	// fallback value. We can't read cmd.Dir from recordingExec (it
	// returns a fresh /usr/bin/true cmd), but we CAN verify the
	// spawn proceeded — if cwd recovery had failed, Driver.Start
	// would have inherited "" and the test would still pass spuriously.
	// So the assertion above on resolver.calls is the real
	// regression guard.
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		return len(rec.Snapshot()) > 0
	}) {
		t.Fatal("timed out waiting for spawn")
	}
}

func TestManagerRejectsWhenCwdCannotBeResolved(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})

	_, err := m.EnsureDriver(context.Background(), "sess_missing_cwd", "", AgentClaude)
	if !errors.Is(err, ErrMissingCwd) {
		t.Fatalf("expected ErrMissingCwd, got %v", err)
	}
	if got := len(rec.Snapshot()); got != 0 {
		t.Fatalf("driver should not spawn without cwd, got %d calls", got)
	}
}

// TestManagerSkipsResolverWhenCwdAlreadyProvided guards the explicit
// escape hatch: an absolute local cwd from tests or local callers should
// be trusted and should not trigger an index lookup.
func TestManagerSkipsResolverWhenCwdAlreadyProvided(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	resolver := &stubSessionResolver{cwd: "/tmp/wrong"}
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		Sessions:      resolver,
	})

	if _, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	if len(resolver.calls) != 0 {
		t.Fatalf("resolver should not be called when cwd is provided; got %+v", resolver.calls)
	}
}

// stubEventSink captures forwarded events so tests can assert the
// driver tag and the registration → keepalive → exit flow lights up the
// relay path correctly. Buffered so the test doesn't deadlock if the
// driver emits more events than the test plans to drain.
type stubEventSink struct {
	mu     sync.Mutex
	events []SDKTerminalEvent
}

func (s *stubEventSink) ForwardSDKTerminalEvent(evt SDKTerminalEvent) {
	s.mu.Lock()
	s.events = append(s.events, evt)
	s.mu.Unlock()
}

func (s *stubEventSink) Snapshot() []SDKTerminalEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SDKTerminalEvent, len(s.events))
	copy(out, s.events)
	return out
}

// TestManagerTagsExternalSessionAsSDK guards the connection_mode
// correctness fix: a freshly-registered SDK session must report
// Driver="sdk" via terminal.Manager.List() so the daemon's reconnect
// re-announce loop in control.runOnce tags keepalives correctly. If this
// regresses, the relay's deriveSessionConnectionMode would bucket SDK
// rows as pty_backed_duplex and the UI control state would be wrong.
func TestManagerTagsExternalSessionAsSDK(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	if _, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	summaries := termMgr.List()
	if len(summaries) == 0 {
		t.Fatal("terminal.Manager.List returned no sessions")
	}
	var got string
	for _, s := range summaries {
		got = s.Driver
	}
	if got != "sdk" {
		t.Fatalf("Summary.Driver = %q, want sdk", got)
	}
}

// TestManagerForwardsEventsWithSDKDriverTag covers the full event
// pipeline: SDK driver emits → ExternalSession.Subscribe → Manager
// forwarder goroutine → EventSink.ForwardSDKTerminalEvent. The relay
// uses these to upsert terminal_sessions rows with Driver="sdk". If the
// sink doesn't see anything, the row never gets written and
// deriveSessionConnectionMode never reports sdk_running.
func TestManagerForwardsEventsWithSDKDriverTag(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		EventSink:     sink,
	})
	if _, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude); err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	// Driver.Start emits EventSessionStarted + EventSessionReady right
	// after the subscription is wired, so the sink should pick them up
	// quickly.
	if !pollUntil(50*time.Millisecond, 1500*time.Millisecond, func() bool {
		return len(sink.Snapshot()) >= 2
	}) {
		t.Fatalf("sink saw %d events, want >=2", len(sink.Snapshot()))
	}
	for _, e := range sink.Snapshot() {
		if e.SessionID != "sess_a" {
			t.Errorf("SDKTerminalEvent.SessionID = %q, want sess_a", e.SessionID)
		}
		if e.TerminalSessionID == "" {
			t.Errorf("SDKTerminalEvent.TerminalSessionID empty; relay needs this to upsert")
		}
	}
}

// TestClaudeDriverWaitsForStdinPumpBeforeReturning is the regression
// test for the SDK driver race fix. Pre-fix, Driver.Start spawned the
// stdin pump as `go d.pumpStdin(ctx)` and returned immediately. If
// routeInject called SendInput before the goroutine reached
// SubscribeInput, the non-blocking broadcast in
// ExternalSession.SendInput would find zero subscribers and drop the
// user's first message silently. Codex's branch had a ready channel
// already; claude was missing it.
//
// Strategy: send input immediately after EnsureDriver returns; if the
// race regressed, the input pump (which writes JSON to stdin) wouldn't
// see anything. We can't easily inspect cmd.Stdin (recordingExec returns
// /usr/bin/true which closes its stdin immediately), so we observe via
// the user_input event emitted by SendInput itself — that event only
// fires when there's a subscriber to broadcast to, and the
// ExternalSession's own internal subscriber list is what we want to
// verify is non-empty.
func TestClaudeDriverWaitsForStdinPumpBeforeReturning(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	sink := &stubEventSink{}
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
		EventSink:     sink,
	})
	ext, err := m.EnsureDriver(context.Background(), "sess_a", t.TempDir(), AgentClaude)
	if err != nil {
		t.Fatalf("EnsureDriver: %v", err)
	}
	// Immediately send input — no sleep, no poll. Pre-fix this would
	// race; post-fix Start blocks until SubscribeInput has registered.
	if err := ext.SendInput("hello"); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	// SendInput emits an EventUserInput event to all session
	// subscribers when accepted. The sink subscriber (registered by
	// the manager's forwarder goroutine) should see it.
	if !pollUntil(20*time.Millisecond, 1500*time.Millisecond, func() bool {
		for _, e := range sink.Snapshot() {
			if e.Kind == "user_input" {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("user_input event never reached sink — pumpStdin likely raced past SubscribeInput")
	}
}

func TestManagerRejectsUnknownAgent(t *testing.T) {
	rec := &recordingExec{}
	termMgr := terminal.NewManager()
	m := NewManager(ManagerConfig{
		Terminal:      termMgr,
		Exec:          rec.Capture,
		BinaryResolve: fakeResolve,
	})
	_, err := m.EnsureDriver(context.Background(), "sess_x", t.TempDir(), Agent("hermes"))
	if !errors.Is(err, ErrUnsupportedAgent) {
		t.Fatalf("expected ErrUnsupportedAgent, got %v", err)
	}
}

func TestPersistentClaudeHelperProcess(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "pockly-sdkdriver-helper" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	turn := 0
	for scanner.Scan() {
		var input struct {
			Message struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			fmt.Fprintf(os.Stdout, `{"type":"result","subtype":"error","is_error":true,"result":"bad input: %s","session_id":"sess_persistent"}`+"\n", err.Error())
			continue
		}
		turn++
		text := ""
		if len(input.Message.Content) > 0 {
			text = input.Message.Content[0].Text
		}
		assistant := map[string]any{
			"type":       "assistant",
			"session_id": "sess_persistent",
			"message": map[string]any{
				"role":    "assistant",
				"content": []map[string]any{{"type": "text", "text": fmt.Sprintf("echo %d: %s", turn, text)}},
			},
		}
		result := map[string]any{
			"type":       "result",
			"subtype":    "success",
			"is_error":   false,
			"num_turns":  turn,
			"result":     fmt.Sprintf("done %d", turn),
			"session_id": "sess_persistent",
		}
		_ = json.NewEncoder(os.Stdout).Encode(assistant)
		_ = json.NewEncoder(os.Stdout).Encode(result)
	}
	os.Exit(0)
}

func pollUntil(interval, deadline time.Duration, ok func() bool) bool {
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		if ok() {
			return true
		}
		time.Sleep(interval)
	}
	return ok()
}
