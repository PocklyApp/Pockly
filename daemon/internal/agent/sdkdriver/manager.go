// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package sdkdriver

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// Manager owns SDK drivers keyed by Claude session_id. It's the
// SDK-mode peer to terminal.Manager's wrapper-backed sessions; both
// register ExternalSessions in the same terminal.Manager so the inject
// path (control.LookupExternalForInject) finds either driver
// transparently.
//
// Concurrency: any number of sids can have live drivers in parallel.
// Same-sid double-inject serialization (one in-flight turn per sid) is
// preserved by the entry.driver != nil + SubprocessDone gate inside
// ensureDriver; we don't need a global lock for that. Resource pressure
// from many concurrent claude subprocesses is the caller's problem —
// callers that want a single-session-at-a-time UX (e.g. legacy PTY)
// enforce that one layer up.
//
// SettingsReader returns the per-sid agent-settings the SDK driver
// should honor when spawning. Implementations must be cheap (in-memory
// map lookup) — EnsureDriver calls this in the hot path.
//
// PermissionModeForSDKSession returns the mode to launch the next
// `claude --resume` with, or "" when the user hasn't picked one (claude
// treats empty as its built-in default). Following the Claude-native
// pass-through model, this may be any mode Claude accepts on the launch
// line: default / acceptEdits / plan / auto / bypassPermissions /
// dontAsk. buildArgs forwards it verbatim as --permission-mode and
// Claude owns the policy.
//
// Note on bypassPermissions: in that mode Claude auto-approves and does
// not invoke the --permission-prompt-tool, so Pockly's approval cards
// won't appear — that's the user's explicit choice when they select it,
// not a Pockly default. The driver still always wires canUseTool (the
// MCP prompt tool), so every other mode keeps forwarding approvals to
// the web exactly as PTY mode does.
type SettingsReader interface {
	ModelForSDKSession(sid string) string
	PermissionModeForSDKSession(sid string) string
	// EffortForSDKSession returns the reasoning-effort level to launch the
	// next `claude --resume` with (low/medium/high/xhigh/max), or "" /
	// "none" when the user hasn't picked one (claude uses its default).
	// buildArgs forwards a real level verbatim as --effort.
	EffortForSDKSession(sid string) string
}

// TerminalEventSink receives every event the SDK driver's terminal
// session emits. Implementations forward them to Nexus (typically via
// control.runner.forwardTerminalEvent). The events are already
// driver-tagged (Driver="sdk"), so Nexus connection-mode derivation
// reports sdk_running / sdk_headless correctly instead of treating the
// row as PTY.
type TerminalEventSink interface {
	ForwardSDKTerminalEvent(evt SDKTerminalEvent)
}

// SDKTerminalEvent is the driver-agnostic shape Manager hands to the
// TerminalEventSink. control.runner re-wraps this into its own
// TerminalEvent struct before sending on the WS — sdkdriver intentionally
// doesn't depend on the control package's wire types to avoid a
// dependency cycle.
type SDKTerminalEvent struct {
	TerminalSessionID string
	SessionID         string
	Agent             string
	Cwd               string
	Kind              string
	SessionStatus     string
	TurnStatus        string
	Payload           string
	Error             string
	Seq               int64
	Timestamp         time.Time
}

// SessionResolver fills in metadata the inject path didn't carry. As of
// 2026-05-25 Nexus populates InjectRequest.Cwd from the session catalog, but
// mixed-version deployments (newer daemon, older Nexus)
// will arrive with Cwd empty; falling back to the daemon's local
// index keeps `claude --resume` rooted in the original project
// directory rather than defaulting to $HOME (which silently loses
// CLAUDE.md / cwd-scoped MCP / on-disk files).
type SessionResolver interface {
	CwdForSession(sid string) string
	// PathForSession returns the on-disk rollout/jsonl path for a known session,
	// or "" if unknown. Codex resumes by this path (it loads the thread directly
	// from disk), which a freshly-spawned app-server cannot do from threadId alone.
	PathForSession(sid string) string
}

type Manager struct {
	terminal              *terminal.Manager
	exec                  ExecFunc
	logger                func(format string, args ...any)
	daemonBin             string
	daemonURL             string
	binaryResolve         func(name string) (string, error)
	claudeLauncherResolve func() (claudelauncher.CommandSpec, error)
	settings              SettingsReader
	sessions              SessionResolver
	eventSink             TerminalEventSink
	permissionStore       *permission.Store
	codexAppFactory       CodexAppFactory
	codexAppTransport     string
	codexAppSocketPath    string

	// driverCtx is the long-lived context that owns every SDK
	// subprocess. Crucially this is NOT the inject handler's ctx —
	// that one is cancelled by control.handle's defer the moment the
	// inject HTTP response returns, which would SIGKILL claude
	// before it finishes init. Bound to the daemon's lifetime via
	// NewManager / context.Background().
	driverCtx context.Context

	mu      sync.Mutex
	drivers map[string]*entry // sid → entry
	// lastSeqBySid carries a session's high-water event seq across
	// ExternalSession re-creation. Nexus keys turns on (session, seq);
	// a fresh ExternalSession restarts seq from 0, so without this a
	// follow-up turn (after the idle reaper dropped the driver) would emit
	// seqs that collide with — and overwrite — the original turn's rows.
	// Survives reaping (never deleted with the driver entry); lost only on
	// daemon restart. Guarded by mu.
	lastSeqBySid map[string]int64
}

type entry struct {
	driver            *Driver
	terminalSession   *terminal.ExternalSession
	terminalSessionID string
}

// ManagerConfig configures a freshly constructed Manager. Most fields
// come straight from cmd/pockly-daemon/main.go where the daemon
// composes its singletons.
type ManagerConfig struct {
	Terminal *terminal.Manager
	Exec     ExecFunc
	Logger   func(format string, args ...any)
	// Context owns SDK subprocess lifetime. Production should pass the
	// daemon process context so shutdown cancels in-flight SDK drivers.
	// Defaults to context.Background for tests.
	Context           context.Context
	DaemonBinaryPath  string
	DaemonLocalAPIURL string
	BinaryResolve     func(name string) (string, error) // nil → ResolveExecutable
	// ClaudeLauncherResolve resolves Claude Code's executable / argv launcher.
	// nil uses POCKLY_REAL_CLAUDE, POCKLY_CLAUDE_LAUNCHER_JSON, then PATH while
	// skipping the Pockly wrapper. Tests that set BinaryResolve keep the old
	// deterministic behavior unless they explicitly set this field.
	ClaudeLauncherResolve func() (claudelauncher.CommandSpec, error)
	// Settings is read on every EnsureDriver to honor per-sid model /
	// permission-mode the user picked via the agent-settings pills in
	// web. nil disables the integration (claude spawns with its
	// default model and prompts for permissions as normal).
	Settings SettingsReader
	// Sessions resolves cwd from sid when the inject request didn't
	// carry an absolute local directory. Production should wire
	// internal/index.Index here; without it, SDK mode refuses to spawn
	// rather than silently running `claude --resume` from the daemon's
	// own cwd and losing project context.
	Sessions SessionResolver
	// EventSink receives terminal events emitted by every SDK driver
	// this manager owns. nil means events stay local to the daemon
	// (subscribers via terminal.Manager still see them, but Nexus
	// doesn't, so the catalog never updates to sdk_running). Production
	// daemons must wire this; main.go does so via a thin adapter that
	// forwards into control.runner's existing terminalEvents channel.
	EventSink TerminalEventSink
	// PermissionStore lets Codex app-server approval requests use the same
	// transient Web allow/deny broker as Claude permission prompts.
	PermissionStore *permission.Store
	// CodexAppFactory starts the Codex app-server runtime. nil uses the real
	// stdio JSON-RPC transport; tests can inject a fake runtime.
	CodexAppFactory    CodexAppFactory
	CodexAppTransport  string
	CodexAppSocketPath string
}

var (
	ErrUnsupportedAgent = errors.New("sdkdriver: unsupported agent")
	ErrMissingCwd       = errors.New("sdkdriver: session cwd unavailable")
)

// ErrBusy is preserved as an exported sentinel so external matchers
// (control.mapSDKError, web's typed-error map) still compile, but the
// Manager itself no longer returns it: concurrent sids are allowed now
// and same-sid double-injects fold into the cached driver. Kept until
// the next major version so we don't break callers that switch on it.
//
// Deprecated: never returned from EnsureDriver. Will be removed in a
// future release.
var ErrBusy = errors.New("sdkdriver: another driver is in flight")

func NewManager(cfg ManagerConfig) *Manager {
	if cfg.Terminal == nil {
		panic("sdkdriver.NewManager: Terminal manager required")
	}
	if cfg.Logger == nil {
		cfg.Logger = func(string, ...any) {}
	}
	customBinaryResolve := cfg.BinaryResolve != nil
	if cfg.BinaryResolve == nil {
		cfg.BinaryResolve = ResolveExecutable
	}
	if cfg.ClaudeLauncherResolve == nil {
		if customBinaryResolve {
			resolve := cfg.BinaryResolve
			cfg.ClaudeLauncherResolve = func() (claudelauncher.CommandSpec, error) {
				path, err := resolve("claude")
				if err != nil {
					return claudelauncher.CommandSpec{}, err
				}
				return claudelauncher.CommandSpec{Path: path, Source: "binary_resolve"}, nil
			}
		} else {
			wrapperPath := pocklyWrapperPathFromDaemon(cfg.DaemonBinaryPath)
			cfg.ClaudeLauncherResolve = func() (claudelauncher.CommandSpec, error) {
				return claudelauncher.Resolve("", wrapperPath)
			}
		}
	}
	if cfg.Context == nil {
		cfg.Context = context.Background()
	}
	m := &Manager{
		terminal:              cfg.Terminal,
		exec:                  cfg.Exec,
		logger:                cfg.Logger,
		daemonBin:             cfg.DaemonBinaryPath,
		daemonURL:             cfg.DaemonLocalAPIURL,
		binaryResolve:         cfg.BinaryResolve,
		claudeLauncherResolve: cfg.ClaudeLauncherResolve,
		settings:              cfg.Settings,
		sessions:              cfg.Sessions,
		eventSink:             cfg.EventSink,
		permissionStore:       cfg.PermissionStore,
		codexAppFactory:       cfg.CodexAppFactory,
		codexAppTransport:     cfg.CodexAppTransport,
		codexAppSocketPath:    cfg.CodexAppSocketPath,
		driverCtx:             cfg.Context,
		drivers:               map[string]*entry{},
		lastSeqBySid:          map[string]int64{},
	}
	// Reap SDK subprocesses that have been idle past idleTimeout. The
	// Claude stream-json subprocess keeps stdin open across turns (so
	// follow-ups are instant), which means it never self-exits — without
	// this reaper every web conversation would leak a persistent
	// `claude --print` + its mcp-permission child until daemon shutdown.
	// Reclaimed sessions re-spawn cold on the next inject via EnsureDriver.
	go m.runIdleReaper()
	return m
}

func pocklyWrapperPathFromDaemon(daemonBin string) string {
	daemonBin = strings.TrimSpace(daemonBin)
	if daemonBin == "" {
		if exe, err := os.Executable(); err == nil {
			daemonBin = exe
		}
	}
	if daemonBin == "" {
		return ""
	}
	name := "pockly-claude-wrapper"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	candidate := filepath.Join(filepath.Dir(daemonBin), name)
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return ""
}

// idleReaperInterval is how often the reaper scans for idle drivers.
// With idleTimeout=5m this reclaims an idle subprocess within ~5-6m of
// its last turn.
const idleReaperInterval = time.Minute

// runIdleReaper periodically reclaims idle SDK drivers until the
// manager's context is cancelled (daemon shutdown).
func (m *Manager) runIdleReaper() {
	ticker := time.NewTicker(idleReaperInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.driverCtx.Done():
			return
		case <-ticker.C:
			m.reapIdleDrivers(time.Now())
		}
	}
}

// reapIdleDrivers stops and removes every driver whose last turn is
// older than idleTimeout and which is not mid-turn. Split from the
// ticker loop so tests can drive it with a synthetic `now` instead of
// sleeping. Reclaim is full: Stop() cancels the subprocess and closes
// the ExternalSession (so the Nexus catalog flips the session out of
// "live"), and the entry is dropped — the next inject re-creates a
// fresh driver via EnsureDriver. A turn arriving concurrently is safe:
// the SubprocessDone watcher's `e.driver == drv` guard no-ops once the
// entry is gone.
func (m *Manager) reapIdleDrivers(now time.Time) {
	type victim struct {
		sid string
		drv *Driver
	}
	var victims []victim
	var codexTimeouts []victim
	m.mu.Lock()
	for sid, e := range m.drivers {
		if e.driver == nil {
			continue
		}
		if e.driver.TurnInFlight() {
			if e.driver.cfg.Agent == AgentCodex && now.Sub(e.driver.LastActivity()) >= codexTurnTimeout {
				codexTimeouts = append(codexTimeouts, victim{sid: sid, drv: e.driver})
			}
			continue
		}
		if now.Sub(e.driver.LastActivity()) < idleTimeout {
			continue
		}
		victims = append(victims, victim{sid: sid, drv: e.driver})
		// Carry the high-water seq forward so the next re-created
		// ExternalSession continues above it instead of restarting at 0.
		if e.terminalSession != nil {
			if cur := e.terminalSession.Seq(); cur > m.lastSeqBySid[sid] {
				m.lastSeqBySid[sid] = cur
			}
		}
		delete(m.drivers, sid)
	}
	m.mu.Unlock()
	for _, v := range victims {
		m.logger("sdkdriver: reaping idle session sid=%s (idle > %s)", v.sid, idleTimeout)
		_ = v.drv.Stop()
	}
	for _, v := range codexTimeouts {
		_ = v.drv.timeoutCodexTurnFromReaper(now)
	}
}

type CodexAppServerInfo struct {
	Source         string
	FallbackReason string
}

func (m *Manager) CodexAppServerInfo(sid string) CodexAppServerInfo {
	m.mu.Lock()
	var drv *Driver
	e := m.drivers[sid]
	if e == nil || e.driver == nil {
		for _, candidate := range m.drivers {
			if candidate == nil || candidate.driver == nil || candidate.terminalSession == nil {
				continue
			}
			if candidate.terminalSession.ClaudeSessionID() == sid {
				e = candidate
				break
			}
		}
	}
	if e != nil {
		drv = e.driver
	}
	m.mu.Unlock()
	if drv == nil {
		return CodexAppServerInfo{}
	}
	drv.mu.Lock()
	defer drv.mu.Unlock()
	return CodexAppServerInfo{
		Source:         drv.codexAppServerSource,
		FallbackReason: drv.codexAppServerFallbackReason,
	}
}

// EnsureDriver returns the driver bound to sid, spawning a new
// subprocess if none exists. Idempotent for live drivers. Multiple sids
// may have live drivers in parallel; each sid's turns serialize through
// the cached entry so callers don't need to coordinate.
//
// The returned ExternalSession is registered with terminal.Manager so
// control.injectIntoPTY's existing lookup → SendInput path works
// without branching. The caller does NOT need to do anything extra to
// route the inject after EnsureDriver returns.
//
// Agent matrix:
//   - AgentClaude: full stream-json duplex via `claude --resume`, with
//     permission prompts bridged through Claude Code's native prompt tool.
//   - AgentCodex: primary path is Codex app-server thread/start + turn/start,
//     with approval requests bridged from app-server server requests. Codex
//     CLI builds without app-server are rejected up front with an upgrade
//     message; Pockly does not fall back to `codex exec resume --json`.
func (m *Manager) EnsureDriver(ctx context.Context, sid, cwd string, agent Agent) (*terminal.ExternalSession, error) {
	return m.ensureDriver(ctx, sid, cwd, agent, false)
}

// EnsureNewDriver spawns an SDK driver for a brand-new session_id
// that doesn't have a jsonl on disk yet. Identical to EnsureDriver
// except claude is launched with `--session-id <sid>` instead of
// `--resume <sid>`, so claude creates the jsonl itself.
//
// Wired from control.routeStartTask as a fallback when terminal.Create
// can't allocate /dev/ptmx (LaunchAgent context limitation on macOS).
// PTY-backed wrapper is still the preferred driver for new sessions
// when the user is at a real terminal — this is the headless route.
func (m *Manager) EnsureNewDriver(ctx context.Context, sid, cwd string, agent Agent) (*terminal.ExternalSession, error) {
	return m.ensureDriver(ctx, sid, cwd, agent, true)
}

func (m *Manager) ensureDriver(ctx context.Context, sid, cwd string, agent Agent, newSession bool) (*terminal.ExternalSession, error) {
	if agent != AgentClaude && agent != AgentCodex {
		return nil, fmt.Errorf("%w: %s", ErrUnsupportedAgent, agent)
	}
	if sid == "" {
		return nil, errors.New("sid required")
	}

	m.mu.Lock()
	// Existing entry path: same sid already has an ExternalSession.
	// Reuse it across turns so web SSE bridges (which key on
	// terminal_session_id and require session_status="live") stay
	// attached. Two sub-cases:
	//   (a) subprocess still running → caller is double-injecting on a
	//       live turn; return existing ext and let SendInput buffer.
	//   (b) subprocess finished → spawn a fresh subprocess attached to
	//       the SAME ext below (so ts_id and "live" status persist).
	if e, ok := m.drivers[sid]; ok {
		if e.driver != nil {
			select {
			case <-e.driver.SubprocessDone():
				// fall through to respawn-on-existing-ext
			default:
				m.mu.Unlock()
				return e.terminalSession, nil
			}
		}
	}
	// No global activeID check: multiple sids may have live drivers in
	// parallel. Same-sid double-inject is handled by the cached-entry
	// branch above (returns the existing ExternalSession and lets
	// SendInput buffer on the input bus while the in-flight turn
	// completes).

	// Resolve cwd to an ABSOLUTE local path. Nexus sends only the cwd
	// leaf label (see relay/sync.go:safeCwdLabel — "/home/u/repo" →
	// "repo") so users' filesystem layout doesn't leave the daemon.
	// That's the right privacy boundary, but it means InjectRequest.Cwd
	// is unusable as cmd.Dir directly: `exec.Command(...).Dir = "demo"`
	// would chdir relative to the daemon's own cwd (typically $HOME)
	// and fail with "no such file or directory".
	//
	// The local session index is the authoritative source for the full
	// path on this machine. We use the Nexus value only as a hint /
	// fallback for sessions the index can't resolve yet.
	//
	// New-session mode (web's "New conversation") skips the resolver
	// because there's no jsonl on disk yet and the index has no row
	// for sid. control.routeStartTask validates + absolutizes the cwd
	// before calling us; we trust it here.
	if !newSession {
		if resolved := m.resolveCwd(cwd, sid); resolved != "" {
			cwd = resolved
		}
	}
	if cwd == "" {
		m.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrMissingCwd, sid)
	}

	var (
		binaryPath        string
		commandPrefixArgs []string
		launcherSource    string
		err               error
	)
	if agent == AgentClaude {
		spec, err := m.claudeLauncherResolve()
		if err != nil {
			m.mu.Unlock()
			return nil, fmt.Errorf("resolve claude: %w", err)
		}
		binaryPath = spec.Path
		commandPrefixArgs = spec.PrefixArgs
		launcherSource = spec.Source
	} else {
		binaryPath, err = m.binaryResolve("codex")
		if err != nil {
			m.mu.Unlock()
			return nil, fmt.Errorf("resolve codex: %w", err)
		}
	}

	// Reuse-or-create the ExternalSession. On reuse, the existing
	// event-sink subscriber goroutine stays attached (subscribe is
	// attached to ext, not to driver), so per-turn stream_event
	// forwarding keeps working across subprocess respawns.
	var (
		ext     *terminal.ExternalSession
		tsID    string
		isReuse bool
	)
	if e, ok := m.drivers[sid]; ok {
		ext = e.terminalSession
		tsID = e.terminalSessionID
		isReuse = true
	} else {
		var regErr error
		tsID, ext, regErr = m.terminal.RegisterExternal("")
		if regErr != nil {
			m.mu.Unlock()
			return nil, fmt.Errorf("register external: %w", regErr)
		}
		// Tag the session as SDK-owned so terminal.Manager.List() returns
		// Driver="sdk" — the reconnect re-announce loop in control.runOnce
		// then sends keepalives with the right driver to Nexus.
		ext.SetDriver("sdk")
		// Continue the seq above the prior (reaped) instance's high-water
		// so a follow-up turn's events never collide with — and overwrite —
		// the original turn rows (keyed on (session, seq)).
		if hw := m.lastSeqBySid[sid]; hw > 0 {
			ext.SeedSeq(hw)
		}
	}

	var model, permissionMode, effort string
	if m.settings != nil {
		model = m.settings.ModelForSDKSession(sid)
		permissionMode = m.settings.PermissionModeForSDKSession(sid)
		effort = m.settings.EffortForSDKSession(sid)
	}
	// Resolve the on-disk rollout path for a resumed session so the codex driver
	// can resume by path (loading the thread from disk) instead of by threadId
	// alone, which a freshly-spawned app-server rejects with "thread not found".
	resumePath := ""
	if !newSession && m.sessions != nil {
		resumePath = m.sessions.PathForSession(sid)
	}
	driver := New(Config{
		SessionID:                sid,
		Agent:                    agent,
		Cwd:                      cwd,
		ResumePath:               resumePath,
		BinaryPath:               binaryPath,
		CommandPrefixArgs:        commandPrefixArgs,
		LauncherSource:           launcherSource,
		DaemonBinaryPath:         m.daemonBin,
		DaemonLocalAPIURL:        m.daemonURL,
		TerminalSessionID:        tsID,
		Model:                    model,
		PermissionMode:           permissionMode,
		Effort:                   effort,
		Exec:                     m.exec,
		Logger:                   m.logger,
		NewSession:               newSession,
		PermissionStore:          m.permissionStore,
		CodexAppFactory:          m.codexAppFactory,
		CodexAppTransport:        firstNonEmpty(m.codexAppTransport, "auto"),
		CodexAppSocketPath:       m.codexAppSocketPath,
		CodexAppAllowDaemonStart: true,
	}, ext)

	m.drivers[sid] = &entry{driver: driver, terminalSession: ext, terminalSessionID: tsID}
	m.mu.Unlock()

	// Forward every event the SDK driver's session emits to Nexus
	// (via the sink). Subscribe is attached to ext (not driver), so on
	// subsequent turns (isReuse==true) the existing subscriber is still
	// running and we MUST NOT add a second one — double subscription
	// duplicates every event downstream.
	//
	// CRITICAL: first-time subscription must register BEFORE Driver.Start
	// runs, otherwise the session_started / session_ready events Start
	// emits synchronously land before any subscriber exists and Nexus
	// never sees the "live" transition.
	if m.eventSink != nil && !isReuse {
		sub, unsubscribe := ext.Subscribe(256)
		go func(sid, tsID, agentStr, cwd string) {
			defer unsubscribe()
			for event := range sub {
				currentSID := ext.ClaudeSessionID()
				if currentSID == "" {
					currentSID = sid
				}
				currentCwd := ext.Cwd()
				if currentCwd == "" {
					currentCwd = cwd
				}
				m.eventSink.ForwardSDKTerminalEvent(SDKTerminalEvent{
					TerminalSessionID: tsID,
					SessionID:         currentSID,
					Agent:             agentStr,
					Cwd:               currentCwd,
					Kind:              string(event.Kind),
					SessionStatus:     string(event.SessionStatus),
					TurnStatus:        string(event.TurnStatus),
					Payload:           event.Payload,
					Error:             event.Error,
					Seq:               event.Seq,
					Timestamp:         event.Timestamp,
				})
			}
		}(sid, tsID, string(agent), cwd)
	}

	// Use the Manager's long-lived driverCtx, NOT the caller's ctx.
	// The caller (control.handle → routeInject) cancels its ctx the
	// moment the inject HTTP response returns; that would SIGKILL
	// claude before it finishes initialization, leaving zero output
	// in the jsonl and a confusing "exited cleanly code=-1" log.
	// The SDK subprocess only needs to live until its turn completes
	// (it self-exits on EOF + result), or until the daemon shuts down.
	_ = ctx // accept for API symmetry; not propagated to subprocess
	if err := driver.Start(m.driverCtx); err != nil {
		m.mu.Lock()
		if e, ok := m.drivers[sid]; ok && e.driver == driver {
			if isReuse {
				// Reuse path: the ExternalSession predates this attempt and is
				// still live (Driver.Stop never closes it), so keep the entry +
				// ext and just clear the dead driver — the next inject reuses
				// the live ext and respawns onto it.
				e.driver = nil
			} else {
				// First-spawn path: we created `ext` above and Stop() (close) it
				// just below. Leaving the entry behind would pin a CLOSED ext
				// under sid, and the idle reaper skips entries whose
				// driver==nil (see reapIdleDrivers) so it would NEVER be cleaned.
				// Every future inject would then hit the reuse branch, reuse the
				// dead ext, and fail with sdk_send_failed forever (permanent
				// brick until daemon restart). Delete the entry so the next
				// inject registers a fresh ExternalSession and retries cleanly.
				delete(m.drivers, sid)
			}
		}
		m.mu.Unlock()
		if !isReuse {
			_ = m.terminal.Stop(tsID)
		}
		return nil, fmt.Errorf("start driver: %w", err)
	}

	// When the subprocess exits, clear entry.driver so the next inject
	// on this sid spawns a fresh subprocess attached to the SAME
	// ExternalSession. We deliberately do NOT delete the entry — the
	// ExternalSession (and ts_id) must persist across turns or web's
	// SSE bridge filter (session_status=="live") breaks for follow-up
	// sends.
	go func(sid string, drv *Driver) {
		<-drv.SubprocessDone()
		m.mu.Lock()
		if e, ok := m.drivers[sid]; ok && e.driver == drv {
			e.driver = nil
		}
		m.mu.Unlock()
	}(sid, driver)

	return ext, nil
}

// resolveCwd turns a possibly-truncated cwd hint from Nexus into an
// absolute path that `exec.Command(...).Dir = ...` can actually chdir
// into. Precedence:
//  1. If `hint` is an absolute, locally-existing directory, trust it.
//     (Happens in tests where the caller passes a tempdir; also the
//     escape hatch for non-indexed sessions.)
//  2. Otherwise consult the local session index. Index entries carry
//     the absolute path the wrapper actually launched from. This is
//     the production path for real Pockly users — Nexus only ever
//     sent us the cwd leaf label for privacy.
//  3. Empty result means SDK driver will refuse to spawn and surface
//     an error; better than silently chdir-ing to $HOME.
func (m *Manager) resolveCwd(hint, sid string) string {
	if filepath.IsAbs(hint) {
		if info, err := os.Stat(hint); err == nil && info.IsDir() {
			return hint
		}
	}
	if m.sessions != nil {
		if resolved := m.sessions.CwdForSession(sid); resolved != "" {
			return resolved
		}
	}
	return ""
}

// Stop terminates the driver bound to sid (if any). The driver's
// goroutines tear down on their own; this is the externally callable
// hook for "user pressed stop in the web".
func (m *Manager) Stop(sid string) error {
	m.mu.Lock()
	e, ok := m.drivers[sid]
	m.mu.Unlock()
	// e.driver is nil between a subprocess exit and the next inject
	// (the SubprocessDone watcher clears it but keeps the entry), so
	// guard against a nil-deref here.
	if !ok || e.driver == nil {
		return nil
	}
	return e.driver.Stop()
}

// StopAll terminates every active driver. Called on daemon shutdown so
// orphaned claude subprocesses don't linger.
func (m *Manager) StopAll() {
	m.mu.Lock()
	drivers := make([]*Driver, 0, len(m.drivers))
	for _, e := range m.drivers {
		if e.driver != nil {
			drivers = append(drivers, e.driver)
		}
	}
	m.mu.Unlock()
	for _, d := range drivers {
		_ = d.Stop()
	}
}
