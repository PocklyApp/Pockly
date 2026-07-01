// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/codexapp"
	"github.com/PocklyApp/Pockly/daemon/internal/agentexec"
	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	relaypkg "github.com/PocklyApp/Pockly/daemon/internal/relay"
	runnerpkg "github.com/PocklyApp/Pockly/daemon/internal/runner"
	"github.com/PocklyApp/Pockly/daemon/internal/telemetry"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
	"github.com/gorilla/websocket"
)

type InjectRequest struct {
	RequestID      string       `json:"request_id"`
	DaemonDeviceID string       `json:"daemon_device_id"`
	Mode           string       `json:"mode"`
	SessionID      string       `json:"session_id,omitempty"`
	Agent          string       `json:"agent,omitempty"`
	Cwd            string       `json:"cwd,omitempty"`
	Text           string       `json:"text,omitempty"`
	Model          string       `json:"model,omitempty"`
	PermissionMode string       `json:"permission_mode,omitempty"`
	Effort         string       `json:"effort,omitempty"`
	Files          []InjectFile `json:"files,omitempty"`
}

// InjectFile is one attachment the web user added to a prompt. Nexus
// forwards the raw bytes (base64 in JSON); the daemon writes each file to a
// local temp dir and appends an @<path> reference to the prompt text so the
// agent (Claude Code / Codex) can read it.
type InjectFile struct {
	Filename string `json:"filename"`
	MimeType string `json:"mime_type,omitempty"`
	Data     []byte `json:"data"`
}

type StoredTurn struct {
	DeviceID   string          `json:"device_id,omitempty"`
	SessionID  string          `json:"session_id"`
	Seq        int             `json:"seq"`
	Agent      string          `json:"agent"`
	Kind       string          `json:"kind"`
	Timestamp  string          `json:"timestamp,omitempty"`
	PayloadRaw json.RawMessage `json:"payload"`
}

type InjectEvent struct {
	RequestID string          `json:"request_id"`
	Type      string          `json:"type"`
	Event     json.RawMessage `json:"event,omitempty"`
	Turn      *StoredTurn     `json:"turn,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Message   string          `json:"message,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type SyncSessionRequest struct {
	RequestID       string `json:"request_id"`
	SessionID       string `json:"session_id"`
	BrowserDeviceID string `json:"browser_device_id"`
	Mode            string `json:"mode,omitempty"`
	Limit           int    `json:"limit,omitempty"`
	BeforeSeq       int    `json:"before_seq,omitempty"`
}

type SyncSessionEvent struct {
	RequestID string       `json:"request_id"`
	SessionID string       `json:"session_id"`
	Stage     string       `json:"stage"`
	Status    string       `json:"status"`
	Processed int          `json:"processed,omitempty"`
	Total     int          `json:"total,omitempty"`
	MinSeq    int          `json:"min_seq,omitempty"`
	MaxSeq    int          `json:"max_seq,omitempty"`
	HasOlder  bool         `json:"has_older,omitempty"`
	TurnCount int          `json:"total_turn_count,omitempty"`
	Message   string       `json:"message,omitempty"`
	Error     string       `json:"error,omitempty"`
	Turns     []StoredTurn `json:"turns,omitempty"`
}

type TerminalRequest struct {
	RequestID         string `json:"request_id"`
	TerminalSessionID string `json:"terminal_session_id"`
	DaemonDeviceID    string `json:"daemon_device_id"`
	BrowserDeviceID   string `json:"browser_device_id,omitempty"`
	SessionID         string `json:"session_id,omitempty"`
	Agent             string `json:"agent,omitempty"`
	Cwd               string `json:"cwd,omitempty"`
	Text              string `json:"text,omitempty"`
}

type TerminalEvent struct {
	RequestID         string    `json:"request_id,omitempty"`
	TerminalSessionID string    `json:"terminal_session_id"`
	Seq               int64     `json:"seq,omitempty"`
	SeqStart          int64     `json:"seq_start,omitempty"`
	SeqEnd            int64     `json:"seq_end,omitempty"`
	Kind              string    `json:"kind"`
	SessionStatus     string    `json:"session_status,omitempty"`
	TurnStatus        string    `json:"turn_status,omitempty"`
	Payload           string    `json:"payload,omitempty"`
	Error             string    `json:"error,omitempty"`
	Timestamp         time.Time `json:"timestamp,omitempty"`
	Truncated         bool      `json:"truncated,omitempty"`
	// Populated by daemon when it spontaneously creates a terminal session
	// for an inject (no preceding TERMINAL_CREATE from Nexus). Nexus
	// uses these to upsert a terminal_sessions row so subsequent
	// deriveSessionConnectionMode lookups report the right mode.
	SessionID string `json:"session_id,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	// Driver names which agent driver owns this terminal: "pty" for the
	// user's interactive wrapper, "sdk" for daemon-spawned headless
	// claude --resume. Empty defaults to "pty" at Nexus (legacy
	// daemon behavior). Nexus groups by driver in the catalog SQL
	// so pty_backed_duplex and sdk_running come out distinct.
	Driver string `json:"driver,omitempty"`
}

type ListDirRequest struct {
	RequestID string `json:"request_id"`
	Path      string `json:"path"`
}

// UpdateRequest is a remote "go run pockly-daemon update" trigger
// forwarded by Nexus (which in turn was POSTed by an authenticated
// browser owner of this daemon). ToVersion is optional — empty means
// "latest." We deliberately don't allow more knobs (--bin-dir,
// --no-restart) because every remote-trigger should be "track latest
// and restart"; anything fancier the user can do via SSH + the CLI.
type UpdateRequest struct {
	RequestID string `json:"request_id"`
	ToVersion string `json:"to_version,omitempty"`
}

// UpdateEvent reports update lifecycle back to Nexus (which forwards to
// any subscribed browser). Status values:
//   - "started"   the daemon accepted the request and dispatched a goroutine
//   - "skipped"   already on the requested version; no-op
//   - "completed" install + restart succeeded (this message MAY not reach
//     the browser since we're mid-process when restart happens;
//     web should fall back to polling /api/sessions)
//   - "failed"    something blew up; Error has details
type UpdateEvent struct {
	RequestID       string `json:"request_id"`
	Status          string `json:"status"`
	PreviousVersion string `json:"previous_version,omitempty"`
	NewVersion      string `json:"new_version,omitempty"`
	Error           string `json:"error,omitempty"`
}

// UpdateHandler is registered by main.go to bridge the WS dispatcher to
// the cmd-package PerformUpdate function (control/ can't import cmd/).
// The handler runs synchronously; caller spawns the goroutine.
type UpdateHandler func(req UpdateRequest) UpdateEvent

type ListDirEntry struct {
	Name   string `json:"name"`
	IsDir  bool   `json:"is_dir"`
	IsGit  bool   `json:"is_git,omitempty"`
	IsLink bool   `json:"is_link,omitempty"`
}

type ListDirResponse struct {
	RequestID string         `json:"request_id"`
	Path      string         `json:"path,omitempty"`
	Parent    string         `json:"parent,omitempty"`
	Entries   []ListDirEntry `json:"entries,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`
	Error     string         `json:"error,omitempty"`
}

// PermissionDecide is the control WS message Nexus sends
// when a web user clicks Approve / Deny on a pending permission card.
// The daemon forwards it to its in-memory permission.Store via
// PermissionDecider (injected from main.go), which unblocks the MCP
// server's parked /await call.
type PermissionDecide struct {
	RequestID string `json:"request_id"`
	// "allow" | "deny"; Claude Code remains the permission authority.
	Decision string `json:"decision"`
}

// PermissionDecideEvent is the daemon's ack back to Nexus so the
// browser can confirm the click landed (vs guessing from the resolved
// permission_request follow-up event). Status: accepted | not_found |
// invalid. The browser uses this to flip a button from "Approving…"
// to "Approved" or surface a "request already decided" toast.
type PermissionDecideEvent struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

// AgentSettingsGet is the Nexus → daemon control WS message that
// triggers the daemon to read its current agent-settings snapshot
// (model + permission_mode + effort + menu options) for the wrapper
// bound to the given Claude session_id. The daemon answers with an
// AGENT_SETTINGS_RESULT envelope. terminal_session_id is included
// when known so the store can key off it (the daemon also looks it
// up via SessionID).
type AgentSettingsGet struct {
	RequestID         string `json:"request_id"`
	SessionID         string `json:"session_id,omitempty"`
	TerminalSessionID string `json:"terminal_session_id,omitempty"`
	Cwd               string `json:"cwd,omitempty"`
	Agent             string `json:"agent,omitempty"`
}

// AgentSettingsSet is the Nexus → daemon message that applies new
// values via the wrapper PTY (model = `/model <name>`, permission_mode
// = Shift+Tab cycle). Only non-empty fields are applied. Effort is
// recorded for the snapshot reply but doesn't touch the PTY — the
// browser prepends a thinking keyword to the next prompt.
type AgentSettingsSet struct {
	RequestID         string `json:"request_id"`
	SessionID         string `json:"session_id"`
	TerminalSessionID string `json:"terminal_session_id,omitempty"`
	Agent             string `json:"agent,omitempty"`
	Model             string `json:"model,omitempty"`
	PermissionMode    string `json:"permission_mode,omitempty"`
	Effort            string `json:"effort,omitempty"`
}

// AgentSettingsResult is the daemon's response to both GET and SET.
// Status: "ok" | "error". On error Nexus re-raises the message
// verbatim to the web; the canonical error strings are the same as
// the inject path ("session_not_attached", "session_drifted current=<sid>").
type AgentSettingsResult struct {
	RequestID                    string             `json:"request_id"`
	Status                       string             `json:"status"`
	Error                        string             `json:"error,omitempty"`
	Model                        string             `json:"model,omitempty"`
	ResolvedModel                string             `json:"resolved_model,omitempty"`
	PermissionMode               string             `json:"permission_mode,omitempty"`
	Effort                       string             `json:"effort,omitempty"`
	AvailableModels              []string           `json:"available_models,omitempty"`
	AvailableModelOptions        []AgentModelOption `json:"available_model_options,omitempty"`
	AvailablePermissionModes     []string           `json:"available_permission_modes,omitempty"`
	AvailableEfforts             []string           `json:"available_efforts,omitempty"`
	CodexAppServerSource         string             `json:"codex_app_server_source,omitempty"`
	CodexAppServerFallbackReason string             `json:"codex_app_server_fallback_reason,omitempty"`
}

type AgentModelOption struct {
	Value         string `json:"value"`
	Label         string `json:"label,omitempty"`
	ResolvedModel string `json:"resolved_model,omitempty"`
	Source        string `json:"source,omitempty"`
}

// AgentSettingsHandler is the bridge between control's WS dispatcher
// and the agentsettings.Store (which the control package can't import
// without creating a cycle — store imports liveterminal too). main.go
// wires this in cmd/pockly-daemon/main.go alongside the store.
type AgentSettingsHandler interface {
	Get(req AgentSettingsGet) AgentSettingsResult
	Set(req AgentSettingsSet) AgentSettingsResult
	// RecordInitial persists the model/permission_mode/effort a fresh
	// PTY-backed claude was launched with, keyed by terminal_session_id.
	// runStartTask calls this once after terminal.Create succeeds so
	// the first web /agent-settings GET against the promoted real
	// session reflects what the wrapper actually started with — instead
	// of the empty default that made the UI snap pills back to "sonnet"
	// after the user had explicitly picked something else in draft mode.
	// No PTY input is driven; the wrapper already received the values
	// via `claude --model ... --permission-mode ...` CLI args.
	RecordInitial(terminalSessionID, model, permissionMode, effort string)
}

// GitDiffGet asks the daemon to compute the real `git diff` for a session's
// working tree — uncommitted changes vs HEAD plus untracked files. This is the
// precise, commit-aware diff behind the web's Diffs drawer: a live git diff, so
// committing naturally clears it (mirrors Codex's /diff).
type GitDiffGet struct {
	RequestID         string `json:"request_id"`
	SessionID         string `json:"session_id,omitempty"`
	TerminalSessionID string `json:"terminal_session_id,omitempty"`
	Cwd               string `json:"cwd,omitempty"`
}

// GitDiffResult is the reply: a unified diff (size-capped) or an error/status.
type GitDiffResult struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"` // "ok" | "not_a_repo" | "error"
	Error     string `json:"error,omitempty"`
	Diff      string `json:"diff,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// GitDiffHandler bridges GIT_DIFF_GET to an implementation in main.go that can
// resolve the session cwd and shell out to git. nil disables the surface.
type GitDiffHandler interface {
	Diff(req GitDiffGet) GitDiffResult
}

// SessionDeleteRequest asks the daemon to PERMANENTLY delete a session's local
// transcript file(s) — the claude jsonl or codex rollout. Irreversible; the
// web gates it behind an explicit confirm dialog.
type SessionDeleteRequest struct {
	RequestID string `json:"request_id"`
	SessionID string `json:"session_id"`
	Agent     string `json:"agent,omitempty"`
}

// SessionDeleteResult reports which files were removed (or why not).
type SessionDeleteResult struct {
	RequestID string   `json:"request_id"`
	Status    string   `json:"status"` // "ok" | "error"
	Error     string   `json:"error,omitempty"`
	Deleted   []string `json:"deleted,omitempty"`
}

// SessionDeleteHandler bridges SESSION_DELETE to main.go (which can resolve
// the on-disk path via the session index). nil disables the surface.
type SessionDeleteHandler interface {
	DeleteSession(req SessionDeleteRequest) SessionDeleteResult
}

// RevealRequest asks the daemon to reveal a local path in the OS file browser
// (Finder on macOS). Used by the sidebar's "show in Finder" project action.
type RevealRequest struct {
	RequestID string `json:"request_id"`
	Path      string `json:"path"`
}

type RevealResult struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"` // "ok" | "error"
	Error     string `json:"error,omitempty"`
}

type RevealHandler interface {
	Reveal(req RevealRequest) RevealResult
}

// AgentDefaultsGet is a session-less variant of AgentSettingsGet that
// asks the daemon to compute the available model / permission_mode /
// effort options for a given cwd, WITHOUT requiring a live
// terminal_session_id. Used by the web's draft-conversation composer
// so the model pill can surface custom names from project/user
// .claude.json before any session exists.
type AgentDefaultsGet struct {
	RequestID string `json:"request_id"`
	Cwd       string `json:"cwd,omitempty"`
	Agent     string `json:"agent,omitempty"`
}

// AgentDefaultsResult mirrors AgentSettingsResult but without the
// "current" fields, since defaults inherently have no current value
// (no session, no chosen state). Web treats empty Model as "let
// claude use its built-in default" — pills render the alias list.
type AgentDefaultsResult struct {
	RequestID string `json:"request_id"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	// DefaultModel is the model claude would launch with absent an
	// explicit --model (resolved from project/user config). Lets the
	// draft composer's model pill show a concrete name instead of a
	// bare "default" before the conversation exists. Empty when no
	// config pins one (claude uses its unnamed built-in default).
	DefaultModel             string             `json:"default_model,omitempty"`
	ResolvedModel            string             `json:"resolved_model,omitempty"`
	AvailableModels          []string           `json:"available_models,omitempty"`
	AvailableModelOptions    []AgentModelOption `json:"available_model_options,omitempty"`
	AvailablePermissionModes []string           `json:"available_permission_modes,omitempty"`
	AvailableEfforts         []string           `json:"available_efforts,omitempty"`
}

// AgentDefaultsHandler computes the defaults snapshot. main.go wires
// this on top of agentsettings.ReadModelOptions + the cycle/effort
// constants — same data source AgentSettingsHandler uses for the
// "available" fields on a real session.
type AgentDefaultsHandler interface {
	Defaults(req AgentDefaultsGet) AgentDefaultsResult
}

// PermissionDecider is the bridge between the control package (which
// doesn't import permission) and the in-memory store wired by main.go.
// Returns nil on success, an error explaining why the decision was
// rejected (already-decided, unknown, invalid) for the Nexus ack.
type PermissionDecider interface {
	Decide(requestID, decision string) error
}

// SyncHintPush is a Nexus→daemon notice that a session should be prioritized
// for lazy window sync (the user just opened it in the web reader). It rides
// the already-open control WS, so pushed hints replace fixed-interval hint
// polling as the default transport.
type SyncHintPush struct {
	SessionID       string `json:"session_id"`
	Reason          string `json:"reason,omitempty"`
	PreferredMin    int    `json:"preferred_min,omitempty"`
	SyncedTurnCount int    `json:"synced_turn_count,omitempty"`
	SyncedMinSeq    int    `json:"synced_min_seq,omitempty"`
	SyncedMaxSeq    int    `json:"synced_max_seq,omitempty"`
	NextBeforeSeq   int    `json:"next_before_seq,omitempty"`
	TotalTurnCount  int    `json:"total_turn_count,omitempty"`
	HasOlderTurns   bool   `json:"has_older_turns,omitempty"`
	WindowHash      string `json:"window_hash,omitempty"`
}

// SyncHintHandler receives Nexus-pushed sync hints. Implementations must be
// fast and non-blocking — it is called from the control WS read loop.
type SyncHintHandler func(SyncHintPush)

type envelope struct {
	Type            string              `json:"type"`
	DeviceID        string              `json:"device_id,omitempty"`
	Version         string              `json:"version,omitempty"`
	Request         *InjectRequest      `json:"request,omitempty"`
	Event           *InjectEvent        `json:"event,omitempty"`
	SyncRequest     *SyncSessionRequest `json:"sync_request,omitempty"`
	SyncEvent       *SyncSessionEvent   `json:"sync_event,omitempty"`
	Terminal        *TerminalRequest    `json:"terminal_request,omitempty"`
	TerminalEvent   *TerminalEvent      `json:"terminal_event,omitempty"`
	SyncHint        *SyncHintPush       `json:"sync_hint,omitempty"`
	ListDirRequest  *ListDirRequest     `json:"list_dir_request,omitempty"`
	ListDirResponse *ListDirResponse    `json:"list_dir_response,omitempty"`
	UpdateRequest   *UpdateRequest      `json:"update_request,omitempty"`
	UpdateEvent     *UpdateEvent        `json:"update_event,omitempty"`
	// Interactive permission decision routing.
	PermissionDecide      *PermissionDecide      `json:"permission_decide,omitempty"`
	PermissionDecideEvent *PermissionDecideEvent `json:"permission_decide_event,omitempty"`
	// Composer-pills surface (model / effort / permission) — paired GET/SET
	// requests that Nexus forwards verbatim to the daemon.
	AgentSettingsGet    *AgentSettingsGet    `json:"agent_settings_get,omitempty"`
	AgentSettingsSet    *AgentSettingsSet    `json:"agent_settings_set,omitempty"`
	AgentSettingsResult *AgentSettingsResult `json:"agent_settings_result,omitempty"`
	// Defaults-only snapshot for the draft composer: no session required,
	// just a cwd to resolve project model aliases.
	AgentDefaultsGet    *AgentDefaultsGet    `json:"agent_defaults_get,omitempty"`
	AgentDefaultsResult *AgentDefaultsResult `json:"agent_defaults_result,omitempty"`
	// Precise git diff for the Diffs drawer (uncommitted changes vs HEAD).
	GitDiffGet    *GitDiffGet    `json:"git_diff_get,omitempty"`
	GitDiffResult *GitDiffResult `json:"git_diff_result,omitempty"`
	// Permanent local-session deletion + reveal-in-Finder (sidebar actions).
	SessionDelete       *SessionDeleteRequest `json:"session_delete,omitempty"`
	SessionDeleteResult *SessionDeleteResult  `json:"session_delete_result,omitempty"`
	Reveal              *RevealRequest        `json:"reveal,omitempty"`
	RevealResult        *RevealResult         `json:"reveal_result,omitempty"`
	RequestID           string                `json:"request_id,omitempty"`
	Busy                bool                  `json:"busy,omitempty"`
}

type Client struct {
	RelayURL               string
	LocalAPIURL            string
	Identity               device.Identity
	Index                  *index.Index
	Terminal               *liveterminal.Manager
	Profile                runnerpkg.Profile
	ExternalTerminalEvents <-chan TerminalEvent
	// UpdateHandler bridges remote update_request messages to the
	// cmd-package PerformUpdate function. nil = remote-update disabled
	// (e.g. dev builds, custom integrations). When nil and a request
	// arrives, daemon answers with status="failed" + error="not enabled".
	UpdateHandler UpdateHandler
	// PermissionDecider bridges PERMISSION_DECIDE control WS messages
	// to the in-memory permission.Store. nil disables the Web forwarding
	// path at the daemon end.
	PermissionDecider PermissionDecider
	// AgentSettings bridges AGENT_SETTINGS_GET/SET messages to the
	// in-memory agentsettings.Store. nil disables the composer-pills
	// surface (web sees the pills as empty/disabled until a daemon
	// upgrade lands).
	AgentSettings AgentSettingsHandler
	// AgentDefaults answers the session-less variant used by the
	// draft composer (no terminal_session_id yet). Optional — nil
	// makes AGENT_DEFAULTS_GET respond with "not enabled" and the
	// web falls back to its bundled alias list.
	AgentDefaults AgentDefaultsHandler
	// GitDiff answers GIT_DIFF_GET by running `git diff` in the session's
	// working tree. nil disables the precise-diff surface.
	GitDiff GitDiffHandler
	// SyncHint receives Nexus-pushed lazy-sync priority hints (the user
	// opened a session in the web). nil = hints only arrive through the
	// optional HTTP poll (POCKLY_SYNC_HINTS_POLL_INTERVAL).
	SyncHint SyncHintHandler
	// SessionDelete answers SESSION_DELETE by removing the session's local
	// transcript file(s). nil disables the surface.
	SessionDelete SessionDeleteHandler
	// Reveal answers REVEAL by opening the path in the OS file browser.
	Reveal RevealHandler
	// SDKDriver is the headless `claude --resume` driver that handles
	// inject requests for sids without a live PTY wrapper. Spec entry:
	// docs/architecture.md "Agent Driver 模型" (2026-05-25). nil disables
	// SDK mode entirely — inject for non-PTY-bound sessions then fails
	// fast with session_not_attached as it did under v1.6.1.
	SDKDriver SDKDriverEnsurer
	// CodexAppTransport configures how Codex app-server JSON-RPC sessions are
	// opened for control-owned Codex process terminals. Empty means auto.
	CodexAppTransport string
	// CodexAppSocketPath optionally points proxy mode at a specific local
	// app-server Unix socket. It is never forwarded to Nexus/Web.
	CodexAppSocketPath string
}

// SDKDriverEnsurer is the interface the inject path uses to lazily spawn
// a `claude --resume` subprocess when no PTY wrapper is bound to the
// requested sid. Kept as an interface so control doesn't import the
// concrete sdkdriver package (which already imports terminal — adding a
// control→sdkdriver dep would cycle if sdkdriver later needs control
// types). main.go composes a *sdkdriver.Manager into this slot.
type SDKDriverEnsurer interface {
	EnsureDriver(ctx context.Context, sid, cwd string, agent string) (*liveterminal.ExternalSession, error)
	// EnsureNewDriver is the routeStartTask fallback. claude is
	// launched with --session-id (no --resume) so it creates a fresh
	// jsonl for sid. Used when terminal.Create can't allocate /dev/ptmx
	// (LaunchAgent context on macOS) and we need a headless path that
	// only uses pipes.
	EnsureNewDriver(ctx context.Context, sid, cwd string, agent string, opts StartTaskAgentOptions) (*liveterminal.ExternalSession, error)
}

type StartTaskAgentOptions struct {
	Model          string
	PermissionMode string
	Effort         string
}

type runner struct {
	mu                  sync.Mutex
	active              map[string]context.CancelFunc
	activeInjects       map[string]activeInject
	terminal            *liveterminal.Manager
	terminalEvents      chan TerminalEvent
	sdkDriver           SDKDriverEnsurer
	codexAppTransport   string
	codexAppSocketPath  string
	codexTerminals      map[string]*codexProcessTerminal
	terminalSubscribers map[string]int
	// agentSettings is the same handler stored on Client; runStartTask
	// uses it to record initial model/permission_mode after a PTY
	// Create succeeds. Nil-safe — older builds that don't wire one
	// just skip the persistence step (web's first agent-settings GET
	// will then return empty values, same as before).
	agentSettings AgentSettingsHandler
}

type activeInject struct {
	RequestID         string
	SessionID         string
	TerminalSessionID string
	ExpiresAt         time.Time
}

const (
	terminalBatchFlushInterval = 200 * time.Millisecond
	terminalBatchMaxBytes      = 16 * 1024
	terminalBatchRingMaxBytes  = 1024 * 1024
	terminalBatchRingMaxAge    = 5 * time.Minute
	activeInjectMirrorTTL      = 10 * time.Minute
)

type codexProcessTerminal struct {
	app       *codexapp.Client
	cancel    context.CancelFunc
	processID string
}

func Run(ctx context.Context, cfg Client) error {
	terminalManager := cfg.Terminal
	if terminalManager == nil {
		terminalManager = liveterminal.NewManager()
	}
	r := &runner{
		active:              map[string]context.CancelFunc{},
		activeInjects:       map[string]activeInject{},
		terminal:            terminalManager,
		terminalEvents:      make(chan TerminalEvent, 1024),
		sdkDriver:           cfg.SDKDriver,
		codexAppTransport:   cfg.CodexAppTransport,
		codexAppSocketPath:  cfg.CodexAppSocketPath,
		codexTerminals:      map[string]*codexProcessTerminal{},
		terminalSubscribers: map[string]int{},
		agentSettings:       cfg.AgentSettings,
	}
	// Reconnect with a self-resetting exponential backoff. A flaky network or a
	// TUN/HTTP proxy in front of the daemon will sever the long-lived control WS
	// at irregular intervals (observed: 1006 / "use of closed network
	// connection" while the request/response HTTP sync sails through). The old
	// fixed 2s delay left the daemon "offline" — and therefore un-injectable —
	// for whole seconds on every cut. Instead: reconnect in well under a second
	// after a healthy connection drops, but back off (capped) when reconnects
	// keep failing back-to-back (e.g. during a deploy) so we don't hammer.
	backoff := controlReconnectInitial
	for {
		attemptStarted := time.Now()
		if err := runOnce(ctx, cfg, r); err != nil {
			connectedFor := time.Since(attemptStarted)
			telemetry.Send(context.Background(), cfg.RelayURL, cfg.Identity, telemetry.Event{Name: "control_disconnected", Command: "serve", Status: "error", ErrorCode: err.Error(), DurationMS: connectedFor})
			// A connection that stayed up past the stable threshold then dropped
			// is treated as healthy: reset to the initial delay so the very next
			// reconnect is near-instant. Only repeated quick failures grow it.
			if connectedFor >= controlReconnectStable {
				backoff = controlReconnectInitial
			}
			delay := jitteredBackoff(backoff)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(delay):
				log.Printf("Nexus control reconnecting after error: %v (after %s)", err, delay.Round(time.Millisecond))
			}
			backoff = nextControlBackoff(backoff)
		}
	}
}

const (
	// controlReconnectInitial is the delay before the first reconnect after a
	// drop. Small so a transient proxy cut on an otherwise-healthy connection is
	// invisible to the user.
	controlReconnectInitial = 500 * time.Millisecond
	// controlReconnectMax caps the backoff so a prolonged outage or rolling
	// deploy doesn't stretch reconnects out to minutes.
	controlReconnectMax = 30 * time.Second
	// controlReconnectStable is how long a connection must survive to be judged
	// healthy; a drop after this resets the backoff to the initial delay.
	controlReconnectStable = 30 * time.Second
)

// nextControlBackoff doubles the delay up to the cap.
func nextControlBackoff(current time.Duration) time.Duration {
	next := current * 2
	if next > controlReconnectMax {
		return controlReconnectMax
	}
	return next
}

// jitteredBackoff trims up to ~25% off the delay so many daemons (or repeated
// attempts) don't resynchronize with server cycles. Uses the wall clock as the
// entropy source to avoid pulling in math/rand (crypto/rand is already aliased
// to `rand` in this file).
func jitteredBackoff(d time.Duration) time.Duration {
	span := int64(d) / 4
	if span <= 0 {
		return d
	}
	return d - time.Duration(time.Now().UnixNano()%span)
}

const (
	// controlKeepaliveInterval is how often the daemon proactively pushes a
	// DAEMON_STATUS frame over the control WS to keep it alive. It must sit
	// comfortably below Nexus's 60s control-WS read deadline; 20s gives a
	// 3x margin and matches Nexus's own server→daemon PING cadence.
	controlKeepaliveInterval = 20 * time.Second
	// controlWriteWait bounds a single control-WS write so a dead or stalled
	// connection (e.g. a proxied socket that silently went away)
	// can't wedge the shared writer — and therefore the keepalive — forever.
	controlWriteWait = 10 * time.Second
	// controlReadWait is how long the read loop tolerates silence before
	// declaring the connection dead. A TUN/HTTP proxy can vanish the underlying
	// TCP without sending a WS close frame; the blocking ReadJSON would then
	// hang forever and the daemon would wrongly believe it is still online while
	// Nexus has already dropped it — exactly the "daemon offline" the user can't
	// clear. We drive a WS ping every controlKeepaliveInterval and require any
	// inbound frame (PONG, or data) within this window, else reconnect. 3x the
	// ping cadence tolerates a couple of lost frames without false positives.
	controlReadWait = 60 * time.Second
)

var (
	startTaskEarlyDeathWindow        = 5 * time.Second
	startTaskPostEvidenceDeathWindow = 2 * time.Second
)

// controlDataKeepaliveEnabled gates ordinary DAEMON_STATUS data keepalive
// frames. It defaults off because protocol-level WebSocket ping is the normal
// lightweight liveness path. Set POCKLY_CONTROL_DATA_KEEPALIVE=1 for
// deployments whose proxy stack does not reliably forward protocol ping/pong
// control frames.
func controlDataKeepaliveEnabled() bool {
	v := strings.TrimSpace(os.Getenv("POCKLY_CONTROL_DATA_KEEPALIVE"))
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") || strings.EqualFold(v, "enabled")
}

// controlKeepalive pushes a DAEMON_STATUS over the control WS every interval so
// an idle daemon (no live wrapped session emitting events) can stay "online" in
// proxy stacks that don't reliably forward WS PING/PONG control frames.
//
// Why this is needed: Nexus closes the control WS after a 60s read
// deadline without traffic, and it relies on WS PING/PONG control frames to
// keep an otherwise-idle daemon alive. Those control frames are NOT reliably
// forwarded consistently by every proxy in front of Nexus, so an idle daemon
// was being cut every ~60s (observed in Nexus logs as repeated
// `i/o timeout` / `1006 unexpected EOF` disconnects) and reconnecting forever.
// A DAEMON_STATUS is an ordinary data frame — forwarded reliably — that the
// Nexus treats as a liveness touch, so a steady drip keeps the dot green.
//
// It returns when ctx or done is closed, or when write fails; on write failure
// it invokes onWriteErr (the caller tears the connection down so the read loop
// unblocks and the outer loop reconnects promptly).
func controlKeepalive(ctx context.Context, done <-chan struct{}, interval time.Duration, deviceID string, write func(envelope) error, onWriteErr func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := write(envelope{
				Type:     "DAEMON_STATUS",
				DeviceID: deviceID,
				Version:  version.String(),
			}); err != nil {
				if onWriteErr != nil {
					onWriteErr()
				}
				return
			}
		case <-done:
			return
		case <-ctx.Done():
			return
		}
	}
}

func runOnce(ctx context.Context, cfg Client, r *runner) error {
	client := pair.NewClient(cfg.RelayURL)
	token, err := client.AuthenticateIdentity(cfg.Identity, "daemon-ws")
	if err != nil {
		return err
	}
	wsURL, err := controlURL(cfg.RelayURL)
	if err != nil {
		return err
	}
	header := http.Header{}
	header.Set("Authorization", "Bearer "+token)
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.WriteJSON(envelope{
		Type:     "DAEMON_HELLO",
		DeviceID: cfg.Identity.DeviceID,
		Version:  version.String(),
	}); err != nil {
		return err
	}
	telemetry.Send(ctx, cfg.RelayURL, cfg.Identity, telemetry.Event{Name: "control_connected", Command: "serve", Status: "ok"})

	// Re-announce every live external terminal after control reconnect so
	// Nexus can rebuild its in-memory terminal session map. Emit synthetic
	// keepalive events through the normal terminal-event upsert path.
	if cfg.Terminal != nil {
		for _, s := range cfg.Terminal.List() {
			if s.SessionStatus != "live" && s.SessionStatus != "starting" {
				continue
			}
			_ = conn.WriteJSON(envelope{
				Type: "TERMINAL_EVENT",
				TerminalEvent: &TerminalEvent{
					TerminalSessionID: s.ID,
					Kind:              "keepalive",
					SessionStatus:     string(s.SessionStatus),
					TurnStatus:        string(s.TurnStatus),
					SessionID:         s.ClaudeSessionID,
					Cwd:               s.Cwd,
					Driver:            s.Driver,
					Timestamp:         time.Now().UTC(),
				},
			})
		}
	}
	sendMu := sync.Mutex{}
	// writeEnvelope serializes every write to the control WS (gorilla permits
	// only one concurrent writer) and stamps a write deadline on each one so a
	// stalled connection can't block the shared writer indefinitely.
	writeEnvelope := func(env envelope) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(controlWriteWait))
		return conn.WriteJSON(env)
	}
	send := func(evt InjectEvent) {
		_ = writeEnvelope(envelope{Type: "INJECT_EVENT", Event: &evt})
	}
	sendSync := func(evt SyncSessionEvent) {
		_ = writeEnvelope(envelope{Type: "SYNC_SESSION_EVENT", SyncEvent: &evt})
	}
	rawSendTerminal := func(evt TerminalEvent) {
		if mirrored, ok := r.mirrorTerminalEventToInject(evt); ok {
			send(mirrored)
		}
		// Surface write failures as local logs plus optional diagnostics so
		// operators can distinguish stream gaps from agent output gaps.
		if err := writeEnvelope(envelope{Type: "TERMINAL_EVENT", TerminalEvent: &evt}); err != nil {
			log.Printf("Nexus terminal_event forward dropped: kind=%s sid=%s err=%v",
				evt.Kind, evt.TerminalSessionID, err)
			telemetry.Send(context.Background(), cfg.RelayURL, cfg.Identity, telemetry.Event{
				Name:      "stream_event_drop",
				Command:   string(evt.Kind),
				Status:    "error",
				ErrorCode: err.Error(),
				// control.TerminalEvent carries the chat session_id in
				// SessionID so diagnostics can correlate dropped events.
				SessionID: evt.SessionID,
			})
		}
	}
	terminalBatcher := newTerminalEventBatcher(rawSendTerminal, terminalBatchFlushInterval, terminalBatchMaxBytes, terminalBatchRingMaxBytes, terminalBatchRingMaxAge)
	terminalBatcher.SetShouldSend(r.shouldForwardTerminalEvent)
	defer terminalBatcher.Close()
	sendTerminal := func(evt TerminalEvent) {
		terminalBatcher.Add(evt)
	}
	done := make(chan struct{})
	defer close(done)
	// Detect a silently-dropped link. A TUN/HTTP proxy can vanish the TCP
	// without a WS close frame, leaving ReadJSON blocked forever while the
	// daemon believes it is still online (and Nexus has already dropped it).
	// Require some inbound frame within controlReadWait; a received PONG (or any
	// data) below pushes the deadline out. Runtimes with hibernated sockets can
	// answer protocol pings without ordinary data frames, and a TUN proxy tunnels
	// control frames transparently, so a missing PONG means the link is genuinely
	// gone.
	_ = conn.SetReadDeadline(time.Now().Add(controlReadWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(controlReadWait))
	})
	// Drive WS pings on the keepalive cadence. WriteControl is safe to call
	// concurrently with the JSON writer; a ping write failure closes the conn so
	// the read loop unblocks and the outer loop reconnects.
	go func() {
		ticker := time.NewTicker(controlKeepaliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(controlWriteWait)); err != nil {
					_ = conn.Close()
					return
				}
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	// Keep an idle control WS alive through edge/proxy infrastructure only
	// when explicitly requested. The default path relies on WS protocol pings;
	// ordinary DAEMON_STATUS data frames are a compatibility fallback for proxy
	// stacks that drop or hide control frames.
	if controlDataKeepaliveEnabled() {
		go controlKeepalive(ctx, done, controlKeepaliveInterval, cfg.Identity.DeviceID, writeEnvelope, func() { _ = conn.Close() })
	}
	go func() {
		for {
			select {
			case evt := <-r.terminalEvents:
				sendTerminal(evt)
			case evt, ok := <-cfg.ExternalTerminalEvents:
				if !ok {
					cfg.ExternalTerminalEvents = nil
					continue
				}
				sendTerminal(evt)
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		var msg envelope
		if err := conn.ReadJSON(&msg); err != nil {
			return err
		}
		// Any inbound frame proves the link is alive; push the read deadline out.
		_ = conn.SetReadDeadline(time.Now().Add(controlReadWait))
		switch msg.Type {
		case "INJECT_REQUEST":
			if msg.Request == nil {
				continue
			}
			telemetry.Send(ctx, cfg.RelayURL, cfg.Identity, telemetry.Event{Name: "inject_started", Command: "serve", Status: "ok"})
			go r.handle(ctx, cfg, *msg.Request, send)
		case "CANCEL_INJECT":
			r.cancel(msg.RequestID)
		case "SYNC_SESSION_REQUEST":
			if msg.SyncRequest == nil {
				continue
			}
			go r.handleSyncSession(ctx, cfg, *msg.SyncRequest, sendSync)
		case "CANCEL_SYNC_SESSION":
			r.cancel(msg.RequestID)
		case "TERMINAL_CREATE":
			if msg.Terminal == nil {
				continue
			}
			go r.handleTerminalCreate(ctx, cfg, *msg.Terminal)
		case "TERMINAL_SUBSCRIBE":
			if msg.Terminal == nil {
				continue
			}
			if r.setTerminalSubscribed(msg.Terminal.TerminalSessionID, true) == 1 {
				if snapshot, ok := terminalBatcher.SnapshotUndeliveredTerminal(msg.Terminal.TerminalSessionID); ok {
					rawSendTerminal(snapshot)
					terminalBatcher.MarkDelivered(snapshot)
				}
			}
		case "TERMINAL_UNSUBSCRIBE":
			if msg.Terminal == nil {
				continue
			}
			if r.setTerminalSubscribed(msg.Terminal.TerminalSessionID, false) == 0 {
				terminalBatcher.DropTerminal(msg.Terminal.TerminalSessionID)
			}
		case "SYNC_HINT":
			if msg.SyncHint == nil || cfg.SyncHint == nil {
				continue
			}
			cfg.SyncHint(*msg.SyncHint)
		case "TERMINAL_INPUT":
			if msg.Terminal == nil {
				continue
			}
			r.handleTerminalInput(*msg.Terminal, sendTerminal)
		case "TERMINAL_OPEN_TERMINAL":
			if msg.Terminal == nil {
				continue
			}
			r.handleTerminalOpen(cfg, *msg.Terminal, sendTerminal)
		case "TERMINAL_STOP":
			if msg.Terminal == nil {
				continue
			}
			r.handleTerminalStop(*msg.Terminal, sendTerminal)
		case "LIST_DIR_REQUEST":
			if msg.ListDirRequest == nil {
				continue
			}
			req := *msg.ListDirRequest
			go func() {
				resp := handleListDir(req)
				sendMu.Lock()
				defer sendMu.Unlock()
				_ = conn.WriteJSON(envelope{Type: "LIST_DIR_RESPONSE", ListDirResponse: &resp})
			}()
		case "UPDATE_REQUEST":
			if msg.UpdateRequest == nil {
				continue
			}
			// Send "started" ack synchronously so Nexus (and
			// subscribed browser) sees we got the message before we
			// possibly kill ourselves via launchctl-driven restart.
			req := *msg.UpdateRequest
			sendUpdate := func(evt UpdateEvent) {
				sendMu.Lock()
				defer sendMu.Unlock()
				_ = conn.WriteJSON(envelope{Type: "UPDATE_EVENT", UpdateEvent: &evt})
			}
			if cfg.UpdateHandler == nil {
				sendUpdate(UpdateEvent{RequestID: req.RequestID, Status: "failed", Error: "remote update not enabled on this daemon"})
				continue
			}
			sendUpdate(UpdateEvent{RequestID: req.RequestID, Status: "started"})
			// Run the update in a goroutine so we keep the WS loop
			// alive long enough to flush the started ack. The handler
			// itself may kill the daemon (launchctl kickstart), in
			// which case the Nexus WS read returns EOF — the
			// browser uses /api/sessions polling as the real "did it
			// land" signal.
			go func() {
				result := cfg.UpdateHandler(req)
				sendUpdate(result)
			}()
		case "PERMISSION_DECIDE":
			if msg.PermissionDecide == nil {
				continue
			}
			req := *msg.PermissionDecide
			sendAck := func(status, errStr string) {
				sendMu.Lock()
				defer sendMu.Unlock()
				_ = conn.WriteJSON(envelope{
					Type:                  "PERMISSION_DECIDE_EVENT",
					PermissionDecideEvent: &PermissionDecideEvent{RequestID: req.RequestID, Status: status, Error: errStr},
				})
			}
			if cfg.PermissionDecider == nil {
				log.Printf("permission decide: reqID=%s decision=%s → invalid (decider not configured)", req.RequestID, req.Decision)
				sendAck("invalid", "permission decider not configured")
				continue
			}
			if err := cfg.PermissionDecider.Decide(req.RequestID, req.Decision); err != nil {
				// not_found here means the request was no longer parked when
				// the Nexus decide arrived (await already returned — timeout,
				// client disconnect, or a prior decide). This is the C2
				// breadcrumb for the "Allow didn't land" reports.
				log.Printf("permission decide: reqID=%s decision=%s → not_found (%v)", req.RequestID, req.Decision, err)
				sendAck("not_found", err.Error())
				continue
			}
			log.Printf("permission decide: reqID=%s decision=%s → accepted", req.RequestID, req.Decision)
			sendAck("accepted", "")
		case "AGENT_SETTINGS_GET":
			if msg.AgentSettingsGet == nil {
				continue
			}
			result := AgentSettingsResult{RequestID: msg.AgentSettingsGet.RequestID, Status: "error", Error: "agent settings handler not configured"}
			if cfg.AgentSettings != nil {
				result = cfg.AgentSettings.Get(*msg.AgentSettingsGet)
			}
			sendMu.Lock()
			_ = conn.WriteJSON(envelope{Type: "AGENT_SETTINGS_RESULT", AgentSettingsResult: &result})
			sendMu.Unlock()
		case "AGENT_SETTINGS_SET":
			if msg.AgentSettingsSet == nil {
				continue
			}
			req := *msg.AgentSettingsSet
			go func() {
				result := AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: "agent settings handler not configured"}
				if cfg.AgentSettings != nil {
					result = cfg.AgentSettings.Set(req)
				}
				sendMu.Lock()
				_ = conn.WriteJSON(envelope{Type: "AGENT_SETTINGS_RESULT", AgentSettingsResult: &result})
				sendMu.Unlock()
			}()
		case "AGENT_DEFAULTS_GET":
			if msg.AgentDefaultsGet == nil {
				continue
			}
			result := AgentDefaultsResult{RequestID: msg.AgentDefaultsGet.RequestID, Status: "error", Error: "agent defaults handler not configured"}
			if cfg.AgentDefaults != nil {
				result = cfg.AgentDefaults.Defaults(*msg.AgentDefaultsGet)
			}
			sendMu.Lock()
			_ = conn.WriteJSON(envelope{Type: "AGENT_DEFAULTS_RESULT", AgentDefaultsResult: &result})
			sendMu.Unlock()
		case "GIT_DIFF_GET":
			if msg.GitDiffGet == nil {
				continue
			}
			req := *msg.GitDiffGet
			// Shelling out to git can take a moment on a large tree, so run it
			// off the reader loop (same pattern as AGENT_SETTINGS_SET).
			go func() {
				result := GitDiffResult{RequestID: req.RequestID, Status: "error", Error: "git diff handler not configured"}
				if cfg.GitDiff != nil {
					result = cfg.GitDiff.Diff(req)
				}
				sendMu.Lock()
				_ = conn.WriteJSON(envelope{Type: "GIT_DIFF_RESULT", GitDiffResult: &result})
				sendMu.Unlock()
			}()
		case "SESSION_DELETE":
			if msg.SessionDelete == nil {
				continue
			}
			deleteReq := *msg.SessionDelete
			go func() {
				result := SessionDeleteResult{RequestID: deleteReq.RequestID, Status: "error", Error: "session delete handler not configured"}
				if cfg.SessionDelete != nil {
					result = cfg.SessionDelete.DeleteSession(deleteReq)
				}
				sendMu.Lock()
				_ = conn.WriteJSON(envelope{Type: "SESSION_DELETE_RESULT", SessionDeleteResult: &result})
				sendMu.Unlock()
			}()
		case "REVEAL":
			if msg.Reveal == nil {
				continue
			}
			revealReq := *msg.Reveal
			go func() {
				result := RevealResult{RequestID: revealReq.RequestID, Status: "error", Error: "reveal handler not configured"}
				if cfg.Reveal != nil {
					result = cfg.Reveal.Reveal(revealReq)
				}
				sendMu.Lock()
				_ = conn.WriteJSON(envelope{Type: "REVEAL_RESULT", RevealResult: &result})
				sendMu.Unlock()
			}()
		}
	}
}

func controlURL(baseURL string) (string, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + "/api/daemon/control")
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported Nexus URL scheme %q", u.Scheme)
	}
	return u.String(), nil
}

// handle routes a web inject either to the user's wrapper-backed PTY
// (when one is bound to the requested sid) or to a daemon-spawned
// `claude --resume` SDK subprocess (when no PTY is bound but daemon is
// otherwise online). v1.6.1's "PTY-only inject" contract was retracted
// on 2026-05-25 in favor of dual-driver routing — see
// docs/architecture.md "Agent Driver 模型". The split-brain hazard the
// earlier spawn path had is now contained by:
//   - terminal.Manager.sidIndex keeping prior_session_ids so any new
//     jsonl claude forks resolves through the same Drifted detection
//     path PTY mode uses; and
//   - sdkdriver.Manager enforcing one active sid at a time globally,
//     and refusing to spawn an SDK driver when a PTY wrapper is still
//     bound to that sid.
func (r *runner) handle(parent context.Context, cfg Client, req InjectRequest, send func(InjectEvent)) {
	if req.RequestID == "" {
		return
	}
	r.mu.Lock()
	if len(r.active) > 0 {
		r.mu.Unlock()
		send(InjectEvent{RequestID: req.RequestID, Type: "inject_failed", Error: "daemon_busy"})
		return
	}
	ctx, cancel := context.WithCancel(parent)
	r.active[req.RequestID] = cancel
	r.activeInjects[req.RequestID] = activeInject{RequestID: req.RequestID, SessionID: req.SessionID, ExpiresAt: time.Now().Add(activeInjectMirrorTTL)}
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.active, req.RequestID)
		r.mu.Unlock()
		cancel()
	}()

	send(InjectEvent{RequestID: req.RequestID, Type: "inject_started", SessionID: req.SessionID})

	if err := r.routeInject(ctx, req, send); err != nil {
		r.clearActiveInject(req.RequestID)
		send(InjectEvent{RequestID: req.RequestID, Type: "inject_failed", Error: err.Error()})
		telemetry.Send(context.Background(), cfg.RelayURL, cfg.Identity, telemetry.Event{Name: "inject_failed", Command: "serve", Status: "error", ErrorCode: err.Error()})
		return
	}
	// The driver (PTY wrapper OR SDK subprocess) will emit message_added
	// events as Claude streams its reply; Nexus correlates them by
	// session_id. We only acknowledge that the inject was accepted.
	send(InjectEvent{RequestID: req.RequestID, Type: "inject_completed", SessionID: req.SessionID})
	telemetry.Send(context.Background(), cfg.RelayURL, cfg.Identity, telemetry.Event{Name: "inject_completed", Command: "serve", Status: "ok"})
}

// routeInject dispatches a /api/sessions/<id>/inject (resume_session)
// or /api/tasks (start_task) request to the right driver. Returns the
// typed errors:
//
//   - unsupported_mode / session_id_required / text_required /
//     cwd_required / cwd_invalid: shape errors web can surface verbatim
//   - session_drifted current=<sid>: a live driver of either kind used
//     to be bound to req.SessionID but has rotated to a new sid (e.g.
//     in-app /resume in TUI mode, or claude --resume forking a new
//     jsonl in SDK mode). Web prompts the user to switch sids.
//   - sdk_busy: another sid is currently mid-turn in SDK mode (MVP
//     single-active-driver limitation). Web should retry shortly.
//   - sdk_unavailable: no SDK driver wired in (binary missing, daemon
//     misconfigured) AND no PTY bound. Equivalent to the legacy
//     session_not_attached but more specific.
//   - session_not_attached: legacy code path, preserved for
//     belt-and-braces in case SDKDriver is nil.
//   - claude_binary_missing / spawn_failed: start_task specific —
//     daemon can't locate or launch `claude`.
//
// send is used by start_task to emit the freshly-minted session_id
// back to web via a session_created event, before the surrounding
// inject_completed lands; web's draft-promotion path keys off this.
func (r *runner) routeInject(ctx context.Context, req InjectRequest, send func(InjectEvent)) error {
	if r == nil || r.terminal == nil {
		return fmt.Errorf("session_not_attached")
	}
	switch req.Mode {
	case "resume_session":
		return r.routeResume(ctx, req)
	case "start_task":
		return r.routeStartTask(ctx, req, send)
	default:
		return fmt.Errorf("unsupported_mode")
	}
}

// routeResume handles the existing /api/sessions/<id>/inject path: a
// web user typed a follow-up message in an existing Claude session,
// and either a live wrapper (PTY) is bound or we fall back to an SDK
// driver (`claude --resume <sid>` headless).
func (r *runner) routeResume(ctx context.Context, req InjectRequest) error {
	if strings.TrimSpace(req.SessionID) == "" {
		return fmt.Errorf("session_id_required")
	}
	// Attachments: write the uploaded files to a local temp dir and append
	// @<path> references to the prompt so the agent reads them. Done once here
	// so every delivery path below (PTY, PTY-sdk, headless-sdk) sees the same
	// augmented text. Empty text + only files is allowed (e.g. "describe this
	// image" attached with no caption), so this runs before the text check.
	if len(req.Files) > 0 {
		augmented, err := writeInjectAttachments(req)
		if err != nil {
			return fmt.Errorf("attachment_write_failed: %v", err)
		}
		req.Text = augmented
	}
	if strings.TrimSpace(req.Text) == "" {
		return fmt.Errorf("text_required")
	}
	lookup := r.terminal.LookupExternalForInject(req.SessionID)
	if lookup.Ext != nil {
		if lookup.Drifted {
			return fmt.Errorf("session_drifted current=%s", lookup.CurrentSID)
		}
		if lookup.Ext.Driver() == "sdk" {
			if r.sdkDriver == nil {
				return fmt.Errorf("session_not_attached")
			}
			ext, err := r.sdkDriver.EnsureDriver(ctx, req.SessionID, req.Cwd, req.Agent)
			if err != nil {
				return mapSDKError(err)
			}
			r.bindActiveInjectTerminal(req.RequestID, req.SessionID, sdkExternalTerminalID(r.terminal, ext))
			if err := sendToSDKExternal(ext, req.Text, req.Agent); err != nil {
				return fmt.Errorf("sdk_send_failed: %v", err)
			}
			return nil
		}
		if err := lookup.Ext.SendInput(req.Text); err != nil {
			return fmt.Errorf("session_not_attached")
		}
		return nil
	}
	// No PTY bound. Fall through to the SDK driver if one is wired.
	if r.sdkDriver == nil {
		return fmt.Errorf("session_not_attached")
	}
	ext, err := r.sdkDriver.EnsureDriver(ctx, req.SessionID, req.Cwd, req.Agent)
	if err != nil {
		return mapSDKError(err)
	}
	r.bindActiveInjectTerminal(req.RequestID, req.SessionID, sdkExternalTerminalID(r.terminal, ext))
	if err := sendToSDKExternal(ext, req.Text, req.Agent); err != nil {
		return fmt.Errorf("sdk_send_failed: %v", err)
	}
	return nil
}

// writeInjectAttachments materializes an inject's file attachments to a local
// temp dir and returns the prompt text with @<abs-path> references appended so
// Claude Code / Codex can read them (works for images and any file type the
// agent can open). Files are deleted after 30 minutes — long enough for the
// agent to read them on its next turn, short enough not to leak disk.
func writeInjectAttachments(req InjectRequest) (string, error) {
	base := filepath.Join(os.TempDir(), "pockly-attachments", sanitizePathComponent(req.RequestID))
	if err := os.MkdirAll(base, 0o700); err != nil {
		return "", err
	}
	refs := make([]string, 0, len(req.Files))
	for i, f := range req.Files {
		name := safeAttachmentName(f.Filename, i)
		dest := filepath.Join(base, name)
		if err := os.WriteFile(dest, f.Data, 0o600); err != nil {
			return "", err
		}
		refs = append(refs, "@"+dest)
	}
	if len(refs) == 0 {
		return req.Text, nil
	}
	// Best-effort cleanup once the agent has had time to read them.
	time.AfterFunc(30*time.Minute, func() { _ = os.RemoveAll(base) })
	label := "Attached file"
	if len(refs) > 1 {
		label = "Attached files"
	}
	preamble := fmt.Sprintf("[%s — read them from these paths:]", label)
	body := strings.TrimRight(req.Text, "\n")
	if body != "" {
		body += "\n\n"
	}
	return body + preamble + "\n" + strings.Join(refs, "\n"), nil
}

// sanitizePathComponent keeps a request id safe to use as a directory name.
func sanitizePathComponent(s string) string {
	out := strings.Map(func(rc rune) rune {
		switch {
		case rc >= 'a' && rc <= 'z', rc >= 'A' && rc <= 'Z', rc >= '0' && rc <= '9', rc == '-', rc == '_':
			return rc
		default:
			return '_'
		}
	}, s)
	if out == "" {
		return "inject"
	}
	return out
}

// safeAttachmentName strips any directory parts from an uploaded filename and
// falls back to attachment-<i> when the name is empty or unusable.
func safeAttachmentName(name string, index int) string {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return fmt.Sprintf("attachment-%d", index+1)
	}
	// Drop any leftover separators / null bytes.
	base = strings.Map(func(rc rune) rune {
		if rc == '/' || rc == '\\' || rc == 0 {
			return '_'
		}
		return rc
	}, base)
	return base
}

// routeStartTask handles /api/tasks: a web user clicked "New
// conversation" and sent the first prompt. Prefer SDK/headless mode
// (`claude --print --output-format=stream-json`) because Web-created
// sessions are not interactive TTY sessions. Claude Code 2.1.x can
// write only the user turn + skill listing when launched as an
// interactive TUI with a positional prompt under a daemon-owned PTY,
// leaving Web stuck waiting for an assistant turn. PTY remains only as
// a legacy/test fallback when no SDK driver is wired.
func (r *runner) routeStartTask(ctx context.Context, req InjectRequest, send func(InjectEvent)) error {
	if strings.TrimSpace(req.Text) == "" {
		return fmt.Errorf("text_required")
	}
	cwd := strings.TrimSpace(req.Cwd)
	if cwd == "" {
		// Web doesn't always know which directory the user wants to
		// work in (chat-without-a-project mode). Fall back to $HOME
		// so claude can at least start.
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("cwd_required")
		}
		cwd = home
	}
	if !isValidDir(cwd) {
		return fmt.Errorf("cwd_invalid: %s", cwd)
	}
	sid := newUUIDv4()
	if !isCodexAgent(req.Agent) {
		if _, err := startTaskClaudeArgs(sid, req.Text, req.Model, req.PermissionMode, req.Effort); err != nil {
			return err
		}
	}
	if r.sdkDriver != nil {
		log.Printf("start_task: ensuring sdk driver sid=%s agent=%s cwd=%s", sid, req.Agent, cwd)
		ext, err := r.sdkDriver.EnsureNewDriver(ctx, sid, cwd, req.Agent, StartTaskAgentOptions{
			Model:          strings.TrimSpace(req.Model),
			PermissionMode: strings.TrimSpace(req.PermissionMode),
			Effort:         strings.TrimSpace(req.Effort),
		})
		if err != nil {
			return mapSDKError(err)
		}
		log.Printf("start_task: sdk driver ready sid=%s agent=%s input_subscribers=%d", sid, req.Agent, ext.InputSubscriberCount())
		r.bindActiveInjectTerminal(req.RequestID, sid, sdkExternalTerminalID(r.terminal, ext))
		events, unsubscribe := ext.Subscribe(256)
		defer unsubscribe()
		if sendErr := sendToSDKExternal(ext, req.Text, req.Agent); sendErr != nil {
			return fmt.Errorf("sdk_send_failed: %v", sendErr)
		}
		log.Printf("start_task: sdk initial prompt sent sid=%s agent=%s", sid, req.Agent)
		var realSID string
		if isCodexAgent(req.Agent) {
			boundSID, waitErr := waitForExternalSessionBound(ctx, ext, events, sid)
			if waitErr != nil {
				return waitErr
			}
			realSID = boundSID
		} else {
			if waitErr := waitForExternalStartTaskStarted(ctx, events); waitErr != nil {
				return waitErr
			}
			realSID = sid
		}
		// SDK driver handles its own event forwarding (Manager.eventSink
		// wired in main.go), so once it has survived early startup we can
		// emit session_created and let web promote the draft.
		send(InjectEvent{
			RequestID: req.RequestID,
			Type:      "session_created",
			SessionID: realSID,
		})
		return nil
	}
	spec, err := resolveClaudeLauncher()
	if err != nil {
		return fmt.Errorf("claude_binary_missing")
	}
	args, err := startTaskClaudeArgs(sid, req.Text, req.Model, req.PermissionMode, req.Effort)
	if err != nil {
		return err
	}
	tsid, session, err := r.terminal.Create(ctx, liveterminal.LaunchConfig{
		Command:     spec.Path,
		Args:        spec.Args(args),
		Cwd:         cwd,
		Env:         mergedProcessEnv(),
		ReadyDelay:  1200 * time.Millisecond,
		PromptDelay: 2500 * time.Millisecond,
	})
	if err != nil {
		return fmt.Errorf("spawn_failed: %v", err)
	}
	events, unsubscribe := session.Subscribe(256)
	pending, err := waitForStartTaskReady(ctx, session, events)
	if err != nil {
		unsubscribe()
		_ = session.Stop()
		return err
	}
	// Persist the initial model / permission_mode / effort for this tsid so the
	// first /agent-settings GET against the promoted real session
	// reflects what the wrapper was actually launched with. Without
	// this, the wrapper started with `claude --model X --permission-mode Y`
	// but the agentsettings.Store is empty → web reads back empty →
	// composer pills snap to "default" and the next message disagrees
	// with what's actually running.
	if r.agentSettings != nil {
		r.agentSettings.RecordInitial(tsid, strings.TrimSpace(req.Model), strings.TrimSpace(req.PermissionMode), strings.TrimSpace(req.Effort))
	}
	// Tell web the real session_id so its draft (session_id=draft_xxx)
	// can be promoted in place. App.tsx promoteDraftConversation listens
	// for this event type specifically. Only emit it after the spawned
	// agent survives startup; otherwise missing auth or an immediately
	// exiting binary creates a fake conversation that can never reply.
	send(InjectEvent{
		RequestID: req.RequestID,
		Type:      "session_created",
		SessionID: sid,
	})
	// Fan terminal events back to Nexus under the request id so SSE
	// subscribers (web's draft session view) see the new session come
	// alive without any extra catalog round-trip.
	go func() {
		defer unsubscribe()
		for _, event := range pending {
			r.forwardTerminalEvent(TerminalEvent{
				RequestID:         req.RequestID,
				TerminalSessionID: tsid,
				Seq:               event.Seq,
				Kind:              string(event.Kind),
				SessionStatus:     string(event.SessionStatus),
				TurnStatus:        string(event.TurnStatus),
				Payload:           event.Payload,
				Error:             event.Error,
				Timestamp:         event.Timestamp,
			})
		}
		for event := range events {
			r.forwardTerminalEvent(TerminalEvent{
				RequestID:         req.RequestID,
				TerminalSessionID: tsid,
				Seq:               event.Seq,
				Kind:              string(event.Kind),
				SessionStatus:     string(event.SessionStatus),
				TurnStatus:        string(event.TurnStatus),
				Payload:           event.Payload,
				Error:             event.Error,
				Timestamp:         event.Timestamp,
			})
		}
	}()
	return nil
}

func sendToSDKExternal(ext *liveterminal.ExternalSession, text, agent string) error {
	if isCodexAgent(agent) {
		if ext.InputSubscriberCount() <= 0 {
			return fmt.Errorf("sdk input pump not ready")
		}
		return ext.SendRaw(strings.TrimRight(text, "\r\n") + "\r")
	}
	return ext.SendInput(text)
}

func isCodexAgent(agent string) bool {
	return strings.TrimSpace(agent) == "codex"
}

func startTaskClaudeArgs(sessionID, text, model, permissionMode, effort string) ([]string, error) {
	args := []string{"--session-id", sessionID}
	if model = strings.TrimSpace(model); model != "" {
		args = append(args, "--model", model)
	}
	switch effort = strings.TrimSpace(effort); effort {
	case "", "none":
		// Let Claude's default effort apply.
	case "low", "medium", "high", "xhigh", "max":
		args = append(args, "--effort", effort)
	default:
		return nil, fmt.Errorf("unknown effort: %s", effort)
	}
	switch permissionMode = strings.TrimSpace(permissionMode); permissionMode {
	case "", "default":
		// Let Claude's default launch mode apply.
	case "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk":
		args = append(args, "--permission-mode", permissionMode)
	default:
		return nil, fmt.Errorf("unknown permission_mode: %s", permissionMode)
	}
	return append(args, text), nil
}

func waitForStartTaskReady(ctx context.Context, session *liveterminal.Session, events <-chan liveterminal.Event) ([]liveterminal.Event, error) {
	timer := time.NewTimer(startTaskEarlyDeathWindow)
	defer timer.Stop()
	var pending []liveterminal.Event
	for {
		select {
		case <-ctx.Done():
			return pending, ctx.Err()
		case <-timer.C:
			status, _ := session.Status()
			if status == liveterminal.SessionError {
				return pending, fmt.Errorf("agent_start_failed")
			}
			if status == liveterminal.SessionExited {
				return pending, fmt.Errorf("agent_exited_before_ready")
			}
			// Absence of output is not proof of failure: Claude may be doing
			// slow auth/model startup or long initial thinking. Promote after
			// the early-death window and let web's no-turn watchdog recover if
			// the session never materializes.
			return pending, nil
		case event, ok := <-events:
			if !ok {
				status, _ := session.Status()
				if status == liveterminal.SessionError {
					return pending, fmt.Errorf("agent_start_failed")
				}
				return pending, fmt.Errorf("agent_exited_before_ready")
			}
			pending = append(pending, event)
			switch event.Kind {
			case liveterminal.EventError:
				if strings.TrimSpace(event.Error) != "" {
					return pending, fmt.Errorf("agent_start_failed: %s", event.Error)
				}
				return pending, fmt.Errorf("agent_start_failed")
			case liveterminal.EventSessionExited:
				return pending, fmt.Errorf("agent_exited_before_ready")
			case liveterminal.EventTextDelta:
				if strings.TrimSpace(event.Payload) != "" {
					more, err := waitForEarlyExitAfterStartEvidence(ctx, session, events)
					pending = append(pending, more...)
					return pending, err
				}
			case liveterminal.EventPromptReady:
				return pending, nil
			}
		}
	}
}

func waitForEarlyExitAfterStartEvidence(ctx context.Context, session *liveterminal.Session, events <-chan liveterminal.Event) ([]liveterminal.Event, error) {
	timer := time.NewTimer(startTaskPostEvidenceDeathWindow)
	defer timer.Stop()
	var pending []liveterminal.Event
	for {
		select {
		case <-ctx.Done():
			return pending, ctx.Err()
		case <-timer.C:
			status, _ := session.Status()
			if status == liveterminal.SessionError {
				return pending, fmt.Errorf("agent_start_failed")
			}
			if status == liveterminal.SessionExited {
				return pending, fmt.Errorf("agent_exited_before_ready")
			}
			return pending, nil
		case event, ok := <-events:
			if !ok {
				status, _ := session.Status()
				if status == liveterminal.SessionError {
					return pending, fmt.Errorf("agent_start_failed")
				}
				return pending, fmt.Errorf("agent_exited_before_ready")
			}
			pending = append(pending, event)
			switch event.Kind {
			case liveterminal.EventError:
				if strings.TrimSpace(event.Error) != "" {
					return pending, fmt.Errorf("agent_start_failed: %s", event.Error)
				}
				return pending, fmt.Errorf("agent_start_failed")
			case liveterminal.EventSessionExited:
				return pending, fmt.Errorf("agent_exited_before_ready")
			case liveterminal.EventPromptReady:
				return pending, nil
			}
		}
	}
}

func waitForExternalStartTaskStarted(ctx context.Context, events <-chan liveterminal.Event) error {
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			// SDK --print often emits nothing until the final answer, so this
			// function is only an early-death guard. A live-but-quiet process is
			// allowed to promote; web will keep syncing and surface no-response
			// if no turn ever lands.
			return nil
		case event, ok := <-events:
			if !ok {
				return fmt.Errorf("agent_exited_before_ready")
			}
			switch event.Kind {
			case liveterminal.EventMessageAdded, liveterminal.EventTextDelta:
				if strings.TrimSpace(event.Payload) != "" {
					return nil
				}
			case liveterminal.EventError:
				if strings.TrimSpace(event.Error) != "" {
					return fmt.Errorf("agent_start_failed: %s", event.Error)
				}
				return fmt.Errorf("agent_start_failed")
			case liveterminal.EventSessionExited:
				return fmt.Errorf("agent_exited_before_ready")
			}
		}
	}
}

func waitForExternalSessionBound(ctx context.Context, ext *liveterminal.ExternalSession, events <-chan liveterminal.Event, provisionalSID string) (string, error) {
	// Codex assigns its own thread id asynchronously, only after its app-server
	// cold starts (process spawn + handshake + thread/start). On a first spawn
	// that routinely takes well over five seconds. The previous 5s ceiling fired
	// before the id was assigned, and — because the bound id was only sampled at
	// the top of each loop iteration — the timer branch read a stale empty value
	// and returned agent_start_failed. The caller then skipped session_created,
	// so the web never learned the real session id and bounced its draft back to
	// the picker, even though codex went on to finish the turn a beat later.
	//
	// Poll the bound id on a short ticker (so we detect the bind without waiting
	// for a driver event) and give the cold start real headroom. Genuine startup
	// failures still return promptly via the error / exited events below.
	const bindTimeout = 30 * time.Second
	timer := time.NewTimer(bindTimeout)
	defer timer.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	boundSID := func() string {
		if sid := strings.TrimSpace(ext.ClaudeSessionID()); sid != "" && sid != provisionalSID {
			return sid
		}
		return ""
	}
	if sid := boundSID(); sid != "" {
		return sid, nil
	}
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-timer.C:
			if sid := boundSID(); sid != "" {
				return sid, nil
			}
			return "", fmt.Errorf("agent_start_failed: codex thread id not assigned")
		case <-ticker.C:
			if sid := boundSID(); sid != "" {
				return sid, nil
			}
		case event, ok := <-events:
			if !ok {
				return "", fmt.Errorf("agent_exited_before_ready")
			}
			switch event.Kind {
			case liveterminal.EventError:
				if strings.TrimSpace(event.Error) != "" {
					return "", fmt.Errorf("agent_start_failed: %s", event.Error)
				}
				return "", fmt.Errorf("agent_start_failed")
			case liveterminal.EventSessionExited:
				return "", fmt.Errorf("agent_exited_before_ready")
			default:
				if sid := boundSID(); sid != "" {
					return sid, nil
				}
			}
		}
	}
}

// newUUIDv4 returns a fresh random UUID in canonical 8-4-4-4-12 form.
// Used by routeStartTask to pre-bind `claude --session-id <uuid>` so
// the resulting jsonl path is predictable. Mirrors wrapper's
// newUUIDv4 in cmd/pockly-claude-wrapper/main.go — hand-rolled
// instead of importing github.com/google/uuid to keep go.mod lean
// (RFC 4122 v4 is 6 lines).
func newUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		ts := time.Now().UnixNano()
		return fmt.Sprintf("%08x-%04x-4%03x-%04x-%012x",
			uint32(ts), uint16(ts>>32), uint16(ts>>16)&0xfff,
			uint16(0x8000)|uint16(ts&0x3fff), ts)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// mapSDKError translates sdkdriver-returned errors to wire-friendly
// codes that match the Nexus/web error vocabulary. Kept as a free
// function (not a method) so it can be unit-tested without spinning up
// a runner.
func mapSDKError(err error) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "another driver is in flight"):
		return fmt.Errorf("sdk_busy")
	case strings.Contains(msg, "unsupported agent"):
		return fmt.Errorf("sdk_unsupported_agent")
	case strings.Contains(msg, "codex_app_server_unavailable"):
		return fmt.Errorf("codex_app_server_unavailable")
	case strings.Contains(msg, "session is not live"):
		return fmt.Errorf("session_not_attached")
	case strings.Contains(msg, "resolve") || strings.Contains(msg, "executable file not found") || strings.Contains(msg, "not found in PATH"):
		return fmt.Errorf("binary_missing")
	default:
		return fmt.Errorf("sdk_spawn_failed: %v", err)
	}
}

func (r *runner) cancel(requestID string) {
	r.mu.Lock()
	cancel := r.active[requestID]
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *runner) handleTerminalCreate(parent context.Context, cfg Client, req TerminalRequest) {
	if req.TerminalSessionID == "" {
		return
	}
	if isCodexAgent(req.Agent) {
		r.handleCodexTerminalCreate(parent, cfg, req)
		return
	}
	if req.Agent != "" && req.Agent != "claude-code" {
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: "only claude-code live terminal is supported", Timestamp: time.Now().UTC()})
		return
	}
	cwd, err := resolveTerminalCWD(cfg, req)
	if err != nil {
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
		return
	}
	spec, err := resolveClaudeLauncher()
	if err != nil {
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
		return
	}
	ctx, cancel := context.WithCancel(parent)
	_, session, err := r.terminal.CreateWithID(ctx, req.TerminalSessionID, liveterminal.LaunchConfig{
		Command:     spec.Path,
		Args:        spec.Args(nil),
		Cwd:         cwd,
		Env:         mergedProcessEnv(),
		ReadyDelay:  1200 * time.Millisecond,
		PromptDelay: 2500 * time.Millisecond,
	})
	if err != nil {
		cancel()
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
		return
	}
	events, unsubscribe := session.Subscribe(256)
	go func() {
		defer cancel()
		defer unsubscribe()
		for event := range events {
			r.forwardTerminalEvent(TerminalEvent{
				RequestID:         req.RequestID,
				TerminalSessionID: req.TerminalSessionID,
				Seq:               event.Seq,
				Kind:              string(event.Kind),
				SessionStatus:     string(event.SessionStatus),
				TurnStatus:        string(event.TurnStatus),
				Payload:           event.Payload,
				Error:             event.Error,
				Timestamp:         event.Timestamp,
			})
		}
	}()
}

func (r *runner) handleCodexTerminalCreate(parent context.Context, cfg Client, req TerminalRequest) {
	cwd, err := resolveTerminalCWD(cfg, req)
	if err != nil {
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: req.Cwd})
		return
	}
	bin, err := resolveExecutable("codex")
	if err != nil {
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
		return
	}
	ctx, cancel := context.WithCancel(parent)
	app, err := codexapp.Start(ctx, codexapp.Config{
		BinaryPath:       bin,
		Cwd:              cwd,
		Logger:           log.Printf,
		Transport:        firstNonEmpty(r.codexAppTransport, codexapp.TransportAuto),
		SocketPath:       r.codexAppSocketPath,
		AllowDaemonStart: true,
		OnNotification: func(n codexapp.Notification) {
			r.handleCodexTerminalNotification(req, n)
		},
	})
	if err != nil {
		cancel()
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
		return
	}
	r.mu.Lock()
	r.codexTerminals[req.TerminalSessionID] = &codexProcessTerminal{app: app, cancel: cancel, processID: req.TerminalSessionID}
	r.mu.Unlock()
	r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventSessionStarted), SessionStatus: "live", TurnStatus: "idle", Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
	r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventSessionReady), SessionStatus: "live", TurnStatus: "idle", Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
	go func() {
		result, err := app.CommandExec(ctx, codexapp.CommandExecParams{
			ProcessID: req.TerminalSessionID,
			Command:   codexTerminalCommand(),
			Cwd:       cwd,
			TTY:       true,
		})
		if err != nil {
			r.removeCodexTerminal(req.TerminalSessionID)
			r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
			return
		}
		r.removeCodexTerminal(req.TerminalSessionID)
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventSessionExited), SessionStatus: "exited", TurnStatus: "idle", Error: fmt.Sprintf("exit_code=%d", result.ExitCode), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: cwd})
	}()
}

func (r *runner) handleCodexTerminalNotification(req TerminalRequest, n codexapp.Notification) {
	switch n.Method {
	case "command/exec/outputDelta":
		var p struct {
			ProcessID   string `json:"processId"`
			DeltaBase64 string `json:"deltaBase64"`
		}
		if json.Unmarshal(n.Params, &p) != nil || p.ProcessID != req.TerminalSessionID || p.DeltaBase64 == "" {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(p.DeltaBase64)
		if err != nil {
			return
		}
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventTextDelta), SessionStatus: "live", TurnStatus: "idle", Payload: string(raw), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: req.Cwd})
	case "process/outputDelta":
		var p struct {
			ProcessHandle string `json:"processHandle"`
			DeltaBase64   string `json:"deltaBase64"`
		}
		if json.Unmarshal(n.Params, &p) != nil || p.ProcessHandle != req.TerminalSessionID || p.DeltaBase64 == "" {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(p.DeltaBase64)
		if err != nil {
			return
		}
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventTextDelta), SessionStatus: "live", TurnStatus: "idle", Payload: string(raw), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: req.Cwd})
	case "process/exited":
		var p struct {
			ProcessHandle string `json:"processHandle"`
			ExitCode      int    `json:"exitCode"`
		}
		if json.Unmarshal(n.Params, &p) != nil || p.ProcessHandle != req.TerminalSessionID {
			return
		}
		r.removeCodexTerminal(req.TerminalSessionID)
		r.forwardTerminalEvent(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: string(liveterminal.EventSessionExited), SessionStatus: "exited", TurnStatus: "idle", Error: fmt.Sprintf("exit_code=%d", p.ExitCode), Timestamp: time.Now().UTC(), Agent: "codex", Cwd: req.Cwd})
	}
}

func codexTerminalCommand() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd.exe"}
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return []string{shell}
	}
	return []string{"/bin/sh"}
}

func (r *runner) forwardTerminalEvent(evt TerminalEvent) {
	select {
	case r.terminalEvents <- evt:
	default:
	}
}

func (r *runner) bindActiveInjectTerminal(requestID, sessionID, terminalSessionID string) {
	if strings.TrimSpace(requestID) == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.activeInjects == nil {
		r.activeInjects = map[string]activeInject{}
	}
	r.pruneExpiredActiveInjectsLocked(time.Now())
	current := r.activeInjects[requestID]
	current.RequestID = requestID
	if current.ExpiresAt.IsZero() {
		current.ExpiresAt = time.Now().Add(activeInjectMirrorTTL)
	}
	if strings.TrimSpace(sessionID) != "" {
		current.SessionID = sessionID
	}
	if strings.TrimSpace(terminalSessionID) != "" {
		current.TerminalSessionID = terminalSessionID
	}
	r.activeInjects[requestID] = current
}

func sdkExternalTerminalID(manager *liveterminal.Manager, ext *liveterminal.ExternalSession) string {
	if manager == nil || ext == nil {
		return ""
	}
	for _, summary := range manager.List() {
		candidate, ok := manager.GetExternal(summary.ID)
		if ok && candidate == ext {
			return summary.ID
		}
	}
	return ""
}

func (r *runner) mirrorTerminalEventToInject(evt TerminalEvent) (InjectEvent, bool) {
	if evt.Kind != string(liveterminal.EventAgentError) && evt.Kind != string(liveterminal.EventPromptReady) {
		return InjectEvent{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneExpiredActiveInjectsLocked(time.Now())
	for _, active := range r.activeInjects {
		if active.RequestID == "" {
			continue
		}
		if active.TerminalSessionID != "" && evt.TerminalSessionID != "" && active.TerminalSessionID == evt.TerminalSessionID {
			delete(r.activeInjects, active.RequestID)
			return injectEventFromTerminal(active, evt), true
		}
		if active.SessionID != "" && evt.SessionID != "" && active.SessionID == evt.SessionID {
			delete(r.activeInjects, active.RequestID)
			return injectEventFromTerminal(active, evt), true
		}
	}
	return InjectEvent{}, false
}

func (r *runner) clearActiveInject(requestID string) {
	if strings.TrimSpace(requestID) == "" {
		return
	}
	r.mu.Lock()
	delete(r.activeInjects, requestID)
	r.mu.Unlock()
}

func (r *runner) pruneExpiredActiveInjectsLocked(now time.Time) {
	for requestID, active := range r.activeInjects {
		if !active.ExpiresAt.IsZero() && now.After(active.ExpiresAt) {
			delete(r.activeInjects, requestID)
		}
	}
}

func injectEventFromTerminal(active activeInject, evt TerminalEvent) InjectEvent {
	sessionID := firstNonEmpty(evt.SessionID, active.SessionID)
	if evt.Kind == string(liveterminal.EventAgentError) {
		msg := firstNonEmpty(strings.TrimSpace(evt.Error), strings.TrimSpace(evt.Payload), "agent turn failed")
		return InjectEvent{
			RequestID: active.RequestID,
			Type:      "inject_failed",
			SessionID: sessionID,
			Error:     msg,
		}
	}
	return InjectEvent{
		RequestID: active.RequestID,
		Type:      "inject_ready",
		SessionID: sessionID,
		Message:   "agent prompt ready",
	}
}

func (r *runner) setTerminalSubscribed(terminalSessionID string, subscribed bool) int {
	if strings.TrimSpace(terminalSessionID) == "" {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.terminalSubscribers == nil {
		r.terminalSubscribers = map[string]int{}
	}
	count := r.terminalSubscribers[terminalSessionID]
	if subscribed {
		count++
		r.terminalSubscribers[terminalSessionID] = count
		return count
	}
	if count <= 1 {
		delete(r.terminalSubscribers, terminalSessionID)
		return 0
	}
	count--
	r.terminalSubscribers[terminalSessionID] = count
	return count
}

func (r *runner) shouldForwardTerminalEvent(evt TerminalEvent) bool {
	if evt.Kind != string(liveterminal.EventTextDelta) {
		return true
	}
	if strings.TrimSpace(evt.TerminalSessionID) == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.terminalSubscribers[evt.TerminalSessionID] > 0
}

func resolveTerminalCWD(cfg Client, req TerminalRequest) (string, error) {
	cwd := strings.TrimSpace(req.Cwd)
	if isValidDir(cwd) {
		return cwd, nil
	}
	if strings.TrimSpace(req.SessionID) != "" && cfg.Index != nil {
		ref, ok := cfg.Index.FindSession(req.SessionID)
		if !ok {
			return "", fmt.Errorf("session not found")
		}
		if isValidDir(ref.Cwd) {
			return ref.Cwd, nil
		}
		if resolved := resolveKnownProjectCWD(cfg, firstNonEmpty(cwd, ref.Cwd)); resolved != "" {
			return resolved, nil
		}
		if strings.TrimSpace(ref.Cwd) != "" {
			return "", fmt.Errorf("cwd invalid: %s", ref.Cwd)
		}
	}
	if resolved := resolveKnownProjectCWD(cfg, cwd); resolved != "" {
		return resolved, nil
	}
	if cwd == "" {
		return "", fmt.Errorf("cwd is required")
	}
	return "", fmt.Errorf("cwd invalid: %s", cwd)
}

func resolveKnownProjectCWD(cfg Client, cwd string) string {
	name := filepath.Base(strings.TrimSpace(cwd))
	if name == "." || name == string(filepath.Separator) || name == "" {
		return ""
	}
	if cfg.Index != nil {
		for _, project := range cfg.Index.Projects() {
			if filepath.Base(strings.TrimRight(project.Cwd, string(filepath.Separator))) == name && isValidDir(project.Cwd) {
				return project.Cwd
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	for _, root := range []string{
		filepath.Join(home, "code"),
		filepath.Join(home, "Documents", "Codex"),
	} {
		if resolved := findDirectoryByBase(root, name, 6); resolved != "" {
			return resolved
		}
	}
	return ""
}

func findDirectoryByBase(root, name string, maxDepth int) string {
	if !isValidDir(root) {
		return ""
	}
	root = filepath.Clean(root)
	var found string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || found != "" {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr == nil && rel != "." && strings.Count(rel, string(filepath.Separator)) >= maxDepth {
			return filepath.SkipDir
		}
		if d.Name() == name && isValidDir(path) {
			found = path
			return filepath.SkipDir
		}
		return nil
	})
	return found
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isValidDir(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func (r *runner) handleTerminalInput(req TerminalRequest, send func(TerminalEvent)) {
	if term := r.getCodexTerminal(req.TerminalSessionID); term != nil {
		delta := base64.StdEncoding.EncodeToString([]byte(req.Text))
		if err := term.app.CommandExecWrite(context.Background(), term.processID, delta, false); err != nil {
			send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex"})
		}
		return
	}
	if err := r.terminal.SendInput(req.TerminalSessionID, req.Text); err != nil {
		send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
	}
}

func (r *runner) handleTerminalOpen(cfg Client, req TerminalRequest, send func(TerminalEvent)) {
	if r.getCodexTerminal(req.TerminalSessionID) != nil {
		send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "live", TurnStatus: "idle", Error: "opening a Codex app-server process in the local Terminal app is not supported", Timestamp: time.Now().UTC(), Agent: "codex"})
		return
	}
	if _, ok := r.terminal.Get(req.TerminalSessionID); !ok {
		send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: "terminal session not found", Timestamp: time.Now().UTC()})
		return
	}
	if err := openLocalTerminalAttach(cfg.LocalAPIURL, req.TerminalSessionID); err != nil {
		send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
	}
}

func (r *runner) handleTerminalStop(req TerminalRequest, send func(TerminalEvent)) {
	if term := r.getCodexTerminal(req.TerminalSessionID); term != nil {
		if err := term.app.CommandExecTerminate(context.Background(), term.processID); err != nil {
			send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC(), Agent: "codex"})
			return
		}
		return
	}
	if err := r.terminal.Stop(req.TerminalSessionID); err != nil {
		send(TerminalEvent{RequestID: req.RequestID, TerminalSessionID: req.TerminalSessionID, Kind: "error", SessionStatus: "error", TurnStatus: "idle", Error: err.Error(), Timestamp: time.Now().UTC()})
	}
}

func (r *runner) getCodexTerminal(terminalSessionID string) *codexProcessTerminal {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.codexTerminals[terminalSessionID]
}

func (r *runner) removeCodexTerminal(terminalSessionID string) {
	r.mu.Lock()
	term := r.codexTerminals[terminalSessionID]
	delete(r.codexTerminals, terminalSessionID)
	r.mu.Unlock()
	if term != nil {
		_ = term.app.Close()
		if term.cancel != nil {
			term.cancel()
		}
	}
}

func openLocalTerminalAttach(localAPIURL, terminalSessionID string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("open terminal is only supported on macOS")
	}
	if strings.TrimSpace(localAPIURL) == "" {
		localAPIURL = "http://127.0.0.1:8947"
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := strings.Join([]string{
		shellQuote(exe),
		"live-attach",
		"--daemon-url", shellQuote(strings.TrimRight(localAPIURL, "/")),
		"--terminal-session-id", shellQuote(terminalSessionID),
		"--display", "transcript",
	}, " ")
	f, err := os.CreateTemp("", "pockly-live-attach-*.command")
	if err != nil {
		return err
	}
	path := f.Name()
	if _, err := fmt.Fprintf(f, "#!/bin/zsh\nexec %s\n", command); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return err
	}
	return exec.Command("open", "-a", "Terminal", path).Run()
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func (r *runner) handleSyncSession(parent context.Context, cfg Client, req SyncSessionRequest, send func(SyncSessionEvent)) {
	if req.RequestID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	r.mu.Lock()
	if len(r.active) > 0 {
		r.mu.Unlock()
		send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "failed", Status: "failed", Error: "daemon_busy"})
		cancel()
		return
	}
	r.active[req.RequestID] = cancel
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.active, req.RequestID)
		r.mu.Unlock()
		cancel()
	}()

	send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "queued", Status: "running", Message: "Queued"})
	client := pair.NewClient(cfg.RelayURL)
	// History sync reads local agent logs and uploads the selected window.
	progress := func(p relaypkg.SyncProgress) {
		send(SyncSessionEvent{
			RequestID: req.RequestID,
			SessionID: req.SessionID,
			Stage:     p.Stage,
			Status:    "running",
			Processed: p.Processed,
			Total:     p.Total,
			MinSeq:    p.MinSeq,
			MaxSeq:    p.MaxSeq,
			HasOlder:  p.HasOlder,
			TurnCount: p.TurnCount,
			Message:   p.Message,
		})
	}
	window := relaypkg.SessionWindow{Limit: req.Limit, BeforeSeq: req.BeforeSeq}
	syncReq, err := relaypkg.BuildSingleSessionWindowSyncRequestContext(ctx, cfg.Index, cfg.Identity.DeviceID, req.SessionID, cfg.Profile, window, progress)
	if err != nil {
		send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "failed", Status: "failed", Error: syncErrorCode(err)})
		return
	}
	meta := syncWindowMeta(syncReq.Sessions)
	if req.BeforeSeq > 0 {
		send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "completed", Status: "completed", Processed: len(syncReq.Turns), Total: len(syncReq.Turns), MinSeq: meta.MinSeq, MaxSeq: meta.MaxSeq, HasOlder: meta.HasOlder, TurnCount: meta.TurnCount, Message: "Session window loaded", Turns: storedTurnsFromSync(syncReq.Turns, cfg.Identity.DeviceID)})
		return
	}
	send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "uploading", Status: "running", Processed: len(syncReq.Turns), Total: len(syncReq.Turns), MinSeq: meta.MinSeq, MaxSeq: meta.MaxSeq, HasOlder: meta.HasOlder, TurnCount: meta.TurnCount, Message: "Uploading history"})
	if _, err := client.SyncHistoryContext(ctx, cfg.Identity, syncReq); err != nil {
		send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "failed", Status: "failed", Error: "upload_failed"})
		return
	}
	send(SyncSessionEvent{RequestID: req.RequestID, SessionID: req.SessionID, Stage: "completed", Status: "completed", Processed: len(syncReq.Turns), Total: len(syncReq.Turns), MinSeq: meta.MinSeq, MaxSeq: meta.MaxSeq, HasOlder: meta.HasOlder, TurnCount: meta.TurnCount, Message: "Session synced"})
}

func storedTurnsFromSync(turns []pair.SyncTurn, deviceID string) []StoredTurn {
	out := make([]StoredTurn, 0, len(turns))
	for _, turn := range turns {
		out = append(out, StoredTurn{
			DeviceID:   deviceID,
			SessionID:  turn.SessionID,
			Seq:        turn.Seq,
			Agent:      turn.Agent,
			Kind:       turn.Kind,
			Timestamp:  turn.Timestamp,
			PayloadRaw: turn.Payload,
		})
	}
	return out
}

func syncWindowMeta(sessions []pair.SyncSession) pair.SyncSession {
	if len(sessions) == 0 {
		return pair.SyncSession{}
	}
	return sessions[0]
}

func syncErrorCode(err error) string {
	msg := err.Error()
	for _, code := range []string{"session_not_found", "extract_failed"} {
		if strings.Contains(msg, code) {
			return code
		}
	}
	return "sync_failed"
}

func resolveExecutable(name string) (string, error) {
	resolved, err := agentexec.Resolve(name, os.Getenv("PATH"), "", os.Getenv)
	if err != nil {
		return "", err
	}
	return resolved.Path, nil
}

func resolveClaudeLauncher() (claudelauncher.CommandSpec, error) {
	return claudelauncher.Resolve("", "")
}

func mergedProcessEnv() []string {
	envMap := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			envMap[key] = value
		}
	}
	for key, value := range shellConfigExports() {
		envMap[key] = value
	}
	out := make([]string, 0, len(envMap))
	for key, value := range envMap {
		out = append(out, key+"="+value)
	}
	return out
}

func shellConfigExports() map[string]string {
	exports := map[string]string{}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return exports
	}
	for _, path := range []string{
		filepath.Join(home, ".zshrc"),
		filepath.Join(home, ".bashrc"),
		filepath.Join(home, ".bash_profile"),
		filepath.Join(home, ".profile"),
	} {
		for key, value := range parseShellExportsFile(path, exports) {
			exports[key] = value
		}
	}
	return exports
}

func parseShellExportsFile(path string, base map[string]string) map[string]string {
	file, err := os.Open(path)
	if err != nil {
		return map[string]string{}
	}
	defer file.Close()
	return parseShellExports(file, base)
}

func parseShellExports(r io.Reader, base map[string]string) map[string]string {
	env := map[string]string{}
	for key, value := range base {
		env[key] = value
	}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || !strings.HasPrefix(line, "export ") {
			continue
		}
		assign := strings.TrimSpace(strings.TrimPrefix(line, "export "))
		key, raw, ok := strings.Cut(assign, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		value := strings.TrimSpace(raw)
		value = strings.Trim(value, `"'`)
		value = os.Expand(value, func(name string) string {
			if expanded, ok := env[name]; ok {
				return expanded
			}
			return ""
		})
		env[key] = value
	}
	out := map[string]string{}
	for key, value := range env {
		if _, exists := base[key]; exists {
			out[key] = value
			continue
		}
		if strings.HasPrefix(key, "ANTHROPIC_") ||
			strings.HasPrefix(key, "CLAUDE_CODE_") ||
			strings.HasPrefix(key, "OPENAI_") ||
			strings.HasPrefix(key, "CODEX_") {
			out[key] = value
		}
	}
	return out
}

func AbsClean(path string) string {
	if path == "" {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}
