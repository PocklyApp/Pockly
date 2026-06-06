// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package sdkdriver owns daemon-started headless agent sessions. Claude Code
// runs as a stream-json subprocess; Codex runs through the official app-server
// JSON-RPC control plane. Both emit the same terminal.Event surface so relay
// and web do not need agent-specific transport plumbing.
//
// Architectural contract (matches docs/architecture.md, 2026-05-25 entry):
//
//   - One driver = one agent session id.
//   - Driver registers itself with terminal.Manager so the existing
//     inject lookup (LookupExternalForInject) finds it without branching.
//   - Claude stream-json stdout and Codex app-server notifications are parsed
//     into terminal.Event emissions (same EventKind vocabulary the PTY wrapper
//     uses).
//   - Permission-required tools are owned by the upstream agent. Pockly only
//     bridges native approval requests to web and returns the user's decision.
package sdkdriver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agentexec"
	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// Agent enumerates the supported subprocess shapes. Codex lands in M5;
// the manager keeps the switch hidden behind a single Driver type so
// callers don't need to know which CLI is running.
type Agent string

const (
	AgentClaude Agent = "claude-code"
	AgentCodex  Agent = "codex"
)

// ExecFunc is the seam exec.CommandContext satisfies. Tests substitute a
// fake so they don't depend on a real claude binary on PATH.
type ExecFunc func(ctx context.Context, name string, args ...string) *exec.Cmd

// Config bundles everything a Driver needs to spawn its subprocess. Most
// callers fill these via Manager.EnsureDriver — Config is exposed for
// tests that drive a Driver directly without touching the manager.
type Config struct {
	// SessionID is the Claude session_id the subprocess will resume.
	// Required; an empty string is a programming error (the inject path
	// must already have a sid by the time it reaches us).
	SessionID string

	// Agent picks the CLI shape (claude vs codex). MVP only supports
	// claude-code; other values return ErrUnsupportedAgent from Manager.
	Agent Agent

	// Cwd is the working directory the subprocess inherits. Usually the
	// project dir recorded in the session catalog.
	Cwd string

	// BinaryPath is the absolute path to the `claude` (or `codex`)
	// executable. Resolved by the manager via resolveExecutable.
	BinaryPath string

	// CommandPrefixArgs are prepended before the Claude stream-json args.
	// This supports safe argv launchers such as cc-switch wrappers without
	// shell evaluation. Codex app-server does not use this field.
	CommandPrefixArgs []string

	// LauncherSource is a low-cardinality diagnostic label only; it must not
	// contain secrets or full env values.
	LauncherSource string

	// DaemonBinaryPath points at pockly-daemon so the permission MCP
	// subprocess can be spawned by claude. Empty disables the permission
	// hook entirely (SDK mode then runs in default permission_mode
	// without any forwarding — acceptable for tests, not for prod).
	DaemonBinaryPath string

	// DaemonLocalAPIURL is the local daemon URL the mcp-permission
	// subcommand will POST register/await events to. Defaults to
	// http://127.0.0.1:8947 when empty.
	DaemonLocalAPIURL string

	// TerminalSessionID is the ts_id the manager assigned. Required so
	// the mcp-permission flag wiring can route events to the same
	// terminal_session row as the driver's ExternalSession.
	TerminalSessionID string

	// Model is the claude model alias or id (e.g. "sonnet", "opus",
	// "claude-3-5-sonnet"). Empty means use claude's default. Picked up
	// at spawn time from agent-settings store via Manager.settings.
	Model string

	// PermissionMode is the claude --permission-mode flag value:
	// "default" / "acceptEdits" / "plan". Empty leaves the flag off
	// so claude picks its built-in default. "bypassPermissions" is
	// rejected at buildArgs time — the SDK driver always keeps the
	// permission MCP wired so approval forwarding works.
	PermissionMode string

	// Effort is claude's reasoning-effort level (low/medium/high/xhigh/max).
	// Empty / "none" leaves --effort off so claude uses its default. The
	// PTY route applies the same setting via the /effort slash command.
	Effort string

	// Exec is the subprocess factory. nil falls back to exec.CommandContext.
	Exec ExecFunc

	// Logger is a logger for diagnostic output. nil is a no-op.
	Logger func(format string, args ...any)

	// NewSession switches buildArgs to spawn claude with
	// `--session-id <uuid>` instead of `--resume <uuid>`. This is the
	// "create fresh" code path used by control.routeStartTask when the
	// PTY-backed terminal.Create fails (LaunchAgent context can't
	// allocate /dev/ptmx) and the inject's first prompt needs to land
	// in a brand-new session that doesn't have a jsonl on disk yet.
	//
	// Resume mode (default, NewSession=false) is the normal path:
	// claude --resume <sid> binds to an existing jsonl. NewSession=true
	// is "the user clicked New conversation on web" — claude generates
	// the jsonl file itself.
	NewSession bool

	// PermissionStore is the transient approval broker shared with the web
	// relay path. Claude uses it through --permission-prompt-tool; Codex uses
	// it to answer app-server approval server requests.
	PermissionStore *permission.Store

	// CodexAppFactory starts the app-server runtime. nil uses the real
	// `codex app-server --listen stdio://` client. Tests provide fakes.
	CodexAppFactory CodexAppFactory
}

// Driver owns one claude subprocess + its ExternalSession in
// terminal.Manager. Lifecycle: New → Start (spawn) → SendInput (one or
// more turns) → Stop (cancel context).
//
// Concurrency: every public method is goroutine-safe; the underlying
// ExternalSession's mutex guards event emission.
type Driver struct {
	cfg     Config
	session *terminal.ExternalSession

	mu                        sync.Mutex
	cmd                       *exec.Cmd
	stdin                     io.WriteCloser
	stdout                    io.ReadCloser
	stderr                    io.ReadCloser
	cancel                    context.CancelFunc
	mcpCfgPath                string
	mcpCleanup                func()
	stopped                   bool
	turnInFlight              bool
	codexTurnID               int64
	codexTurnHadSignal        bool
	codexTurnHadDurableOutput bool
	codexTurnLastError        string
	// lastActivity is bumped whenever a turn is submitted or completes.
	// The manager's idle reaper reads it (with TurnInFlight) to decide
	// when a long-idle subprocess can be reclaimed.
	lastActivity time.Time
	inputBuf     chan string
	// subprocessDone closes when wait() returns — i.e. the claude
	// subprocess for this driver has exited. Manager watches this to
	// release activeID and clear entry.driver so an unexpected process
	// exit can be recovered by the next inject on the same sid.
	subprocessDone chan struct{}
	codex          CodexAppRuntime
	codexItems     map[string]codexItemState
}

var (
	ErrAlreadyStarted   = errors.New("driver already started")
	ErrNotStarted       = errors.New("driver not started")
	ErrSubprocessClosed = errors.New("driver subprocess closed")
)

// New constructs a Driver and attaches it to the provided ExternalSession.
// The session must already be registered with terminal.Manager so injects
// can find it. The driver does not start the subprocess until Start.
func New(cfg Config, session *terminal.ExternalSession) *Driver {
	if cfg.Exec == nil {
		cfg.Exec = exec.CommandContext
	}
	if cfg.Logger == nil {
		cfg.Logger = func(string, ...any) {}
	}
	if cfg.DaemonLocalAPIURL == "" {
		cfg.DaemonLocalAPIURL = "http://127.0.0.1:8947"
	}
	return &Driver{
		cfg:            cfg,
		session:        session,
		inputBuf:       make(chan string, 4),
		subprocessDone: make(chan struct{}),
		lastActivity:   time.Now(),
		codexItems:     map[string]codexItemState{},
	}
}

// Start spawns the subprocess and begins streaming. Safe to call once;
// subsequent calls return ErrAlreadyStarted. Returns immediately after
// spawn — the goroutines pumping stdin/stdout outlive this call.
//
// Codex lifecycle note: Start validates and initializes app-server up front
// so unsupported Codex CLI versions fail synchronously at EnsureDriver time.
// The actual thread/start still waits for the first SendInput because it needs
// the first prompt context. Claude uses persistent stream-json so it spawns
// immediately and reuses that subprocess across turns.
func (d *Driver) Start(ctx context.Context) error {
	d.mu.Lock()
	if d.cmd != nil {
		d.mu.Unlock()
		return ErrAlreadyStarted
	}
	if d.cfg.SessionID == "" {
		d.mu.Unlock()
		return errors.New("session_id required")
	}
	if d.cfg.BinaryPath == "" {
		d.mu.Unlock()
		return errors.New("binary_path required")
	}
	d.mu.Unlock()

	procCtx, cancel := context.WithCancel(ctx)

	if d.cfg.Agent == AgentCodex {
		if err := d.startCodexApp(procCtx); err != nil {
			cancel()
			return codexAppServerUnavailableError(err)
		}
		// Wait until the pump has actually subscribed to inputs before
		// returning — otherwise an inject arriving "immediately" after Start
		// would race the goroutine and get dropped by ExternalSession.SendInput's
		// non-blocking-send-to-all-subscribers loop.
		d.mu.Lock()
		d.cancel = cancel
		d.mu.Unlock()
		d.session.BindSessionMetadata(d.cfg.SessionID, d.cfg.Cwd)
		d.session.Emit(terminal.EventSessionStarted, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
		d.session.Emit(terminal.EventSessionReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
		ready := make(chan struct{})
		go d.pumpCodexInputs(procCtx, ready)
		<-ready
		go func() {
			<-procCtx.Done()
			d.closeCodexApp()
			close(d.subprocessDone)
		}()
		d.cfg.Logger("sdkdriver: codex driver ready (lazy spawn) sid=%s cwd=%s", d.cfg.SessionID, d.cfg.Cwd)
		return nil
	}

	args, mcpCfgPath, mcpCleanup, err := d.buildArgs()
	if err != nil {
		cancel()
		return fmt.Errorf("build args: %w", err)
	}
	// Track temp cleanup BEFORE spawn so any early failure still removes
	// the file. The lock is short-lived; cleanupMCP locks again from
	// outside Start.
	d.mu.Lock()
	d.mcpCfgPath = mcpCfgPath
	d.mcpCleanup = mcpCleanup
	d.mu.Unlock()

	cmdArgs := append([]string(nil), d.cfg.CommandPrefixArgs...)
	cmdArgs = append(cmdArgs, args...)
	cmd := d.cfg.Exec(procCtx, d.cfg.BinaryPath, cmdArgs...)
	cmd.Dir = d.cfg.Cwd
	envSnap := claudelauncher.Env(os.Environ())
	cmd.Env = envSnap.Env // inherit user's API keys and overlay Claude settings env.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		d.cleanupMCP()
		return fmt.Errorf("stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		cancel()
		d.cleanupMCP()
		return fmt.Errorf("stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		cancel()
		d.cleanupMCP()
		return fmt.Errorf("stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		cancel()
		d.cleanupMCP()
		return fmt.Errorf("spawn %s: %w", d.cfg.BinaryPath, err)
	}
	d.mu.Lock()
	d.cmd = cmd
	d.stdin = stdin
	d.stdout = stdout
	d.stderr = stderr
	d.cancel = cancel
	d.mu.Unlock()

	// Bind session metadata so the manager's sidIndex resolves inject
	// targets correctly. This is the moral equivalent of the wrapper's
	// post-spawn BindSessionMetadata once it discovers the jsonl.
	d.session.BindSessionMetadata(d.cfg.SessionID, d.cfg.Cwd)
	if pid := cmd.Process.Pid; pid > 0 {
		d.session.BindPID(pid)
	}
	d.session.Emit(terminal.EventSessionStarted, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
	d.session.Emit(terminal.EventSessionReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")

	// Block until pumpStdin has actually subscribed to the input bus.
	// ExternalSession.SendInput is a non-blocking broadcast to current
	// subscribers (external.go:121-132) — if the inject SendInput runs
	// before SubscribeInput has registered, the first user message is
	// silently dropped. The codex branch above already does the same
	// dance; this fixes the symmetric race on the claude path.
	ready := make(chan struct{})
	go d.pumpStdin(procCtx, ready)
	<-ready
	go d.pumpStdout()
	go d.drainStderr()
	go d.wait()

	d.cfg.Logger("sdkdriver: started sid=%s pid=%d cwd=%s launcher_source=%s prefix_args=%d settings_env_keys=%q settings_env_error=%q", d.cfg.SessionID, cmd.Process.Pid, d.cfg.Cwd, d.cfg.LauncherSource, len(d.cfg.CommandPrefixArgs), envSnap.SettingsEnvKeys, envSnap.SettingsEnvError)
	return nil
}

// Session returns the terminal.ExternalSession this driver writes events
// to. Useful for callers that want to subscribe to the same event stream
// (e.g. the relay forwarder) without going through the manager.
func (d *Driver) Session() *terminal.ExternalSession { return d.session }

// Stop terminates the subprocess and tears down goroutines. Safe to call
// multiple times; only the first has effect. Does NOT close the
// ExternalSession's event channel — terminal.Manager handles that when
// session.Wait() returns.
func (d *Driver) Stop() error {
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return nil
	}
	d.stopped = true
	cancel := d.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// buildArgs assembles the CLI flags for the active agent.
//
// Claude (stream-json input/output mode): each line on stdin is a JSON
// message {"type":"user","message":{"role":"user","content":"…"}},
// each line on stdout is a stream-json record (system/assistant/user/
// result types). --resume binds the run to the existing jsonl +
// history. Permission flags mirror cmd/pockly-claude-wrapper/
// setupPermissionMCP — temp mcp-config + --permission-prompt-tool —
// so canUseTool routes through the same MCP server the PTY wrapper
// uses.
//
// Codex app-server does not use this argv builder.
func (d *Driver) buildArgs() ([]string, string, func(), error) {
	if d.cfg.Agent == AgentCodex {
		return nil, "", nil, fmt.Errorf("buildArgs not used for codex")
	}
	// New-session mode uses --session-id (claude generates a fresh
	// jsonl for this uuid); resume mode uses --resume (claude looks up
	// the existing jsonl). Both then add --print so stdin/stdout are
	// pipes and no PTY is needed — that's the whole reason routeStartTask
	// falls back here when terminal.Create couldn't allocate /dev/ptmx.
	sessionFlag := "--resume"
	if d.cfg.NewSession {
		sessionFlag = "--session-id"
	}
	args := []string{
		sessionFlag, d.cfg.SessionID,
		"--print",
		"--output-format=stream-json",
		"--input-format=stream-json",
		"--verbose", // required for stream-json output per claude CLI
	}
	if model := strings.TrimSpace(d.cfg.Model); model != "" {
		args = append(args, "--model", model)
	}
	// Reasoning effort: forward a real level as --effort (the SDK route,
	// mirroring the PTY's /effort). Only claude's accepted levels are
	// passed; the "none"/empty no-op sentinel is dropped (the flag rejects
	// anything else). Kept as a local set to avoid coupling sdkdriver to
	// the agentsettings package.
	switch strings.TrimSpace(d.cfg.Effort) {
	case "low", "medium", "high", "xhigh", "max":
		args = append(args, "--effort", strings.TrimSpace(d.cfg.Effort))
	}
	// Permission mode: pass Claude Code's native mode through. Claude owns
	// the policy and may reject modes that are not valid for this session.
	switch strings.TrimSpace(d.cfg.PermissionMode) {
	case "default", "acceptEdits", "plan", "auto":
		args = append(args, "--permission-mode", d.cfg.PermissionMode)
	case "bypassPermissions", "dontAsk":
		// Defense-in-depth: SDK sessions MUST keep canUseTool wired so tool
		// approvals surface as web permission cards (the whole remote-safety
		// model). bypassPermissions / dontAsk make claude skip the
		// permission-prompt-tool, so tools would auto-execute with no remote
		// approval. The SettingsReader contract says these are rejected, but
		// nothing enforced it — and req.PermissionMode reaches buildArgs
		// straight from routeStartTask unchecked. Drop the flag so claude
		// falls back to its default, which still routes through our MCP
		// permission tool. Loud-log the downgrade so it's never silent.
		d.cfg.Logger("sdkdriver: refusing permission-mode %q for SDK session sid=%s (would bypass web approval) — using default", strings.TrimSpace(d.cfg.PermissionMode), d.cfg.SessionID)
	}
	if d.cfg.DaemonBinaryPath == "" {
		return args, "", nil, nil
	}
	mcpCfgPath, cleanup, err := writePermissionMCPConfig(d.cfg.DaemonBinaryPath, d.cfg.SessionID, d.cfg.TerminalSessionID, d.cfg.DaemonLocalAPIURL)
	if err != nil {
		return nil, "", nil, fmt.Errorf("write mcp config: %w", err)
	}
	args = append(args,
		"--mcp-config", mcpCfgPath,
		"--permission-prompt-tool", "mcp__pockly__request_permission",
	)
	return args, mcpCfgPath, cleanup, nil
}

// pumpCodexInputs runs in place of the Claude stdin pump for Codex drivers.
// Each input becomes a Codex app-server turn/start.
func (d *Driver) pumpCodexInputs(ctx context.Context, ready chan<- struct{}) {
	ch, unsubscribe := d.session.SubscribeInput(8)
	defer unsubscribe()
	if ready != nil {
		close(ready)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case text, ok := <-ch:
			if !ok {
				return
			}
			text = strings.TrimRight(text, "\r\n")
			if text == "" {
				continue
			}
			d.cfg.Logger("sdkdriver: codex input received sid=%s bytes=%d", d.cfg.SessionID, len(text))
			d.runCodexTurn(ctx, text)
		}
	}
}

func (d *Driver) cleanupMCP() {
	d.mu.Lock()
	cleanup := d.mcpCleanup
	d.mcpCleanup = nil
	d.mu.Unlock()
	if cleanup != nil {
		cleanup()
	}
}

// pumpStdin owns the subprocess stdin. ExternalSession.SubscribeInput
// gives us a channel that SendInput writes to (with a trailing \r the
// PTY mode needs but we strip; stream-json doesn't want it). Each input
// becomes one stream-json user message line.
//
// `ready` is closed once we're subscribed so Start can block its caller
// until input routing is wired up — otherwise the first inject's
// SendInput races with subscription and silently drops the user's text.
//
// Claude Code's `--input-format=stream-json` is realtime: the CLI
// processes each newline-delimited user message without requiring EOF.
// Keeping stdin open is what makes SDK mode truly multi-turn; closing
// stdin after the first write makes `claude --print` exit and leaves
// follow-up injects targeting a dead subprocess.
func (d *Driver) pumpStdin(ctx context.Context, ready chan<- struct{}) {
	ch, unsubscribe := d.session.SubscribeInput(8)
	defer unsubscribe()
	if ready != nil {
		close(ready)
	}
	defer func() {
		d.mu.Lock()
		stdin := d.stdin
		d.mu.Unlock()
		if stdin != nil {
			_ = stdin.Close()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case text, ok := <-ch:
			if !ok {
				return
			}
			text = strings.TrimRight(text, "\r\n")
			if text == "" {
				continue
			}
			msg := map[string]any{
				"type": "user",
				"message": map[string]any{
					"role":    "user",
					"content": []map[string]any{{"type": "text", "text": text}},
				},
			}
			line, err := json.Marshal(msg)
			if err != nil {
				d.cfg.Logger("sdkdriver: marshal input: %v", err)
				continue
			}
			d.mu.Lock()
			stdin := d.stdin
			d.turnInFlight = true
			d.lastActivity = time.Now()
			d.mu.Unlock()
			if stdin == nil {
				return
			}
			d.cfg.Logger("sdkdriver: pumpStdin writing %d bytes for sid=%s", len(line)+1, d.cfg.SessionID)
			if _, err := stdin.Write(append(line, '\n')); err != nil {
				d.cfg.Logger("sdkdriver: stdin write: %v", err)
				return
			}
		}
	}
}

// pumpStdout reads stream-json from the subprocess, translates each
// record to one terminal.Event emission. The mapping is intentionally
// conservative: structured records (text deltas, tool calls, results)
// land as MessageAdded events whose payload is the raw record JSON, so
// the existing relay-side TurnDelta normalizer can consume them without
// any new path. The wrapper does the same thing via jsonl_watch.go;
// we're just reading from a pipe instead of an on-disk file.
func (d *Driver) pumpStdout() {
	d.mu.Lock()
	stdout := d.stdout
	d.mu.Unlock()
	if stdout == nil {
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	lines := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		lines++
		copied := make([]byte, len(line))
		copy(copied, line)
		d.handleStreamLine(copied)
	}
	if err := scanner.Err(); err != nil {
		d.cfg.Logger("sdkdriver: pumpStdout scan error sid=%s lines=%d: %v", d.cfg.SessionID, lines, err)
	} else {
		d.cfg.Logger("sdkdriver: pumpStdout EOF sid=%s lines=%d", d.cfg.SessionID, lines)
	}
}

// handleStreamLine parses one stream-json record. Stream-json records
// carry a top-level "type" that's one of system/assistant/user/result.
// We forward the raw line as the MessageAdded payload so the relay
// receives the same shape the PTY wrapper sends. The dispatcher in
// internal/agent/claude knows how to decode this.
func (d *Driver) handleStreamLine(line []byte) {
	var probe struct {
		Type      string `json:"type"`
		SessionID string `json:"session_id,omitempty"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		d.cfg.Logger("sdkdriver: parse line: %v", err)
		return
	}
	// claude --resume sometimes emits a `system` init record with the
	// resolved session_id, which can differ from the requested one when
	// claude forked a new jsonl. Track that via BindSessionMetadata so
	// the manager's sidIndex (and relay's prior_session_ids) follow.
	if probe.SessionID != "" {
		d.session.BindSessionMetadata(probe.SessionID, "")
	}
	turnStatus := terminal.TurnStreaming
	switch probe.Type {
	case "result":
		turnStatus = terminal.TurnAwaitingInput
		d.mu.Lock()
		d.turnInFlight = false
		d.lastActivity = time.Now()
		d.mu.Unlock()
	case "system":
		// Don't flip turn state on init/control records.
		turnStatus = ""
	}
	d.session.Emit(terminal.EventMessageAdded, terminal.SessionLive, turnStatus, string(line), "")
}

func (d *Driver) drainStderr() {
	d.mu.Lock()
	stderr := d.stderr
	d.mu.Unlock()
	if stderr == nil {
		return
	}
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 0, 4*1024), 1*1024*1024)
	lines := 0
	for scanner.Scan() {
		lines++
		d.cfg.Logger("sdkdriver[%s]: stderr: %s", d.cfg.SessionID, scanner.Text())
	}
	d.cfg.Logger("sdkdriver: drainStderr EOF sid=%s lines=%d", d.cfg.SessionID, lines)
}

// wait blocks until the subprocess exits, then signals Manager via
// subprocessDone so it can release activeID and allow recovery.
//
// Subprocess exits — clean OR errored — must NOT close the
// ExternalSession. SDK mode decouples subprocess lifetime from the
// logical Pockly session: claude may die for many transient reasons
// (rate limit, killed by user, signal trapped + non-zero exit, CLI
// version quirks). The user should still be able to re-inject and
// have Manager.EnsureDriver re-spawn against the same ExternalSession.
//
// Emit(EventError) is fatal in terminal/external.go (close() the
// session, drop subscribers, fail all future SubscribeInput / SendInput
// silently). The previous heuristic — treat anything not matching
// "signal:" as a hard error — caught the common case of claude
// trapping SIGTERM and exiting with code 143 ("exit status 143"
// without the "signal:" prefix), permanently bricking the session.
// Instead we just log the exit code + error and emit a PromptReady
// transition so web sees "awaiting input" and offers to retry.
func (d *Driver) wait() {
	defer close(d.subprocessDone)
	d.mu.Lock()
	cmd := d.cmd
	d.mu.Unlock()
	if cmd == nil {
		return
	}
	err := cmd.Wait()
	exitCode := -1
	if ps := cmd.ProcessState; ps != nil {
		exitCode = ps.ExitCode()
	}
	d.cleanupMCP()
	// Tear down this dead subprocess's procCtx-scoped goroutines. Critically,
	// pumpStdin holds a SubscribeInput subscription on the SHARED
	// ExternalSession; if it lingers (procCtx never cancelled on a natural
	// exit — only Stop() cancelled before), a reuse-respawn adds a SECOND
	// pumpStdin and ExternalSession.SendInput broadcasts the next prompt to
	// BOTH subscribers — delivering it to this dead subprocess's closed stdin
	// and silently losing the user's follow-up. cancel() only scopes procCtx;
	// the ExternalSession stays live via the PromptReady emit below so the
	// next inject can respawn. Runs before the deferred subprocessDone close,
	// so the stale pumpStdin is gone before the manager reuses the entry.
	d.mu.Lock()
	cancel := d.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if err != nil {
		d.cfg.Logger("sdkdriver: subprocess exited with non-zero status sid=%s code=%d err=%v (session stays live for retry)", d.cfg.SessionID, exitCode, err)
	} else {
		d.cfg.Logger("sdkdriver: subprocess exited cleanly sid=%s code=%d", d.cfg.SessionID, exitCode)
	}
	// Always keep ExternalSession alive across subprocess exits. Web's
	// attachExistingLiveSessionBridge requires session_status == "live"
	// or "starting" to attach an SSE bridge; emitting EventError would
	// close() the session and break every follow-up inject.
	d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
}

// SubprocessDone returns a channel that closes when the subprocess
// finishes. Manager uses it to release the per-sid activeID and clear
// entry.driver without tearing down the underlying ExternalSession.
func (d *Driver) SubprocessDone() <-chan struct{} {
	return d.subprocessDone
}

// writePermissionMCPConfig mirrors cmd/pockly-claude-wrapper.setupPermissionMCP
// for the SDK path. Kept here (not exported from wrapper) because wrapper
// has a sprawling main.go and pulling it as a dep would force a refactor
// that's out of scope for the MVP. If/when both paths share more code,
// extract into internal/permissionmcp.
// permissionDecisionWindow is how long the SDK driver's mcp-permission
// server waits for the web user's allow/deny before timing out (after
// which Claude retries the tool with a fresh reqID — see the --timeout
// note in writePermissionMCPConfig). 120s is the daemon /await endpoint's
// server-side cap (handlePermissionAwait), so this is the largest window
// the bridge supports without churning.
const permissionDecisionWindow = 120 * time.Second

func writePermissionMCPConfig(daemonBin, sessionID, terminalSessionID, daemonURL string) (string, func(), error) {
	tmp, err := os.CreateTemp("", "pockly-sdk-mcp-*.json")
	if err != nil {
		return "", nil, err
	}
	config := map[string]any{
		"mcpServers": map[string]any{
			"pockly": map[string]any{
				"command": daemonBin,
				"args": []string{
					"mcp-permission",
					"--terminal-session-id", terminalSessionID,
					"--session-id", sessionID,
					"--daemon-url", daemonURL,
					"--interactive",
					// Give the remote human a realistic approval window.
					// The default is 30s; on timeout Claude retries the
					// tool with a FRESH reqID, so the web card's reqID goes
					// stale and a late Allow decides a dead request →
					// not_found ("tool was blocked"). 120s is the daemon
					// /await server cap and covers the common "see the card,
					// click within a couple minutes" flow. (Truly-async
					// approval beyond the window still churns — a future
					// keep-alive/decide-rebind would remove that ceiling.)
					"--timeout", permissionDecisionWindow.String(),
				},
			},
		},
	}
	if err := json.NewEncoder(tmp).Encode(config); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return "", nil, err
	}
	_ = tmp.Close()
	path := tmp.Name()
	cleanup := func() { _ = os.Remove(path) }
	return path, cleanup, nil
}

// ResolveExecutable mirrors control.resolveExecutable. Re-implemented
// here to keep sdkdriver decoupled from internal/control (and to avoid
// pulling control into anything that uses sdkdriver). When both paths
// stabilize, share via a new internal/runner subpackage.
func ResolveExecutable(name string) (string, error) {
	resolved, err := agentexec.Resolve(name, os.Getenv("PATH"), "", os.Getenv)
	if err != nil {
		return "", err
	}
	return resolved.Path, nil
}

// idleTimeout is how long a driver lingers after its last turn before
// the manager reclaims it. Kept here as a const because the manager's
// reaper needs the same value; exporting via package var would invite
// flakey tests that toggle it.
const idleTimeout = 5 * time.Minute

// TurnInFlight reports whether a turn is currently being processed
// (input submitted, result not yet received). The idle reaper must
// never reclaim a driver mid-turn.
func (d *Driver) TurnInFlight() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.turnInFlight
}

// LastActivity returns the time of the most recent turn submit or
// completion. The idle reaper compares it against idleTimeout.
func (d *Driver) LastActivity() time.Time {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.lastActivity
}
