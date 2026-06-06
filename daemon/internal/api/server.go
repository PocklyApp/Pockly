// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/claude"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/codex"
	"github.com/PocklyApp/Pockly/daemon/internal/agentsettings"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
	"github.com/gorilla/websocket"
)

// Config controls the daemon's local debug/read API.
type Config struct {
	ClaudeHome        string
	CodexHome         string
	RefreshInterval   time.Duration
	TerminalManager   *liveterminal.Manager
	TerminalEventSink func(DevTerminalEvent)
	// RelayURL is the relay base URL the daemon is configured to talk to,
	// or "" if --connect-relay is off. Exposed via /api/status.
	RelayURL string
	// Profile is the detected Claude runner profile. Exposed via /api/status.
	Profile runner.Profile
	// UpdateStatus, when set, is consulted on every /api/status hit to
	// surface "an update is available" info to web clients. The hook
	// lets the daemon's background update-checker (cmd/pockly-daemon)
	// publish its result without making this package depend on the
	// updater. Returns zero value when there's nothing to report.
	UpdateStatus func() UpdateInfo
	// ReportTelemetry, when set, is called on certain ingest paths to
	// emit observability events to the relay. Kept as a function hook
	// (rather than a direct telemetry/device.Identity dependency) so
	// this package stays free of those imports. v0.1.37 wires it for
	// the wrapper-event ingest path; the hook is called on a goroutine
	// so it can't slow down the HTTP handler.
	//
	// v0.1.41 #4: sessionID added — was missing, so
	// `pockly-daemon diagnose telemetry --session-id X` matched
	// 0 daemon-source rows even when events were firing. Field is
	// optional (caller passes "" when source isn't a per-session
	// event).
	ReportTelemetry func(name, command, status, errorCode, sessionID string)
	// v0.2.0: PermissionStore is the in-memory broker between the
	// mcp-permission subprocess (parking on /await) and whoever
	// supplies the decision (web → relay → control WS → /decide).
	// Nil disables the new endpoints, falling back to v0.1.42 always-
	// allow semantics in the MCP server.
	PermissionStore *permission.Store
	// AgentSettings is the composer-pills surface (model / permission_mode
	// / effort). The local /api/dev/terminal-sessions/<id>/agent-settings
	// route reads from / writes to this store. Nil disables those routes.
	AgentSettings *agentsettings.Store
	// OnWrapperUnexpectedExit, when set, is invoked asynchronously when
	// the wrapper reports an UNCLEAN exit_intent (claude crashed or
	// terminated abnormally). The receiver should spawn an SDK driver
	// for (claudeSessionID, cwd, agent) so the session stays "live" at
	// relay level instead of flipping to disconnected and forcing the
	// next user inject to bootstrap from cold.
	//
	// Clean exits (user pressed Ctrl+C / claude exited code 0) do NOT
	// trigger this callback — the user signalled they're done.
	//
	// Loop control is the caller's responsibility (api package owns no
	// state). Today main.go threads through a per-session-id timestamp
	// tracker that caps respawns at 3 per hour.
	//
	// nil disables auto-recovery, falling back to the lazy-fallback
	// behavior in control.routeResume (SDK spawns on next inject).
	OnWrapperUnexpectedExit func(claudeSessionID, cwd, agent string)
}

// UpdateInfo is what /api/status reports about the daemon's update state.
// Web clients render an "upgrade available" banner when Available=true.
// CheckedAt is RFC3339 so JS Date() can parse it directly; empty when no
// check has fired yet.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`
	CheckedAt string `json:"checked_at,omitempty"`
	Error     string `json:"error,omitempty"`
}

type DevTerminalEvent struct {
	TerminalSessionID string
	Kind              liveterminal.EventKind
	SessionStatus     liveterminal.SessionStatus
	TurnStatus        liveterminal.TurnStatus
	Payload           string
	Error             string
	Timestamp         time.Time
	SessionID         string
	Agent             string
	Cwd               string
}

// NewHandler returns the daemon's local HTTP API.
//
// Endpoints:
//   - GET /healthz
//   - GET /api/projects
//   - GET /api/sessions/{id}/blocks
//   - GET /api/sessions/{id}/blocks/stream
func NewHandler(cfg Config) http.Handler {
	idx := index.New(index.Config{
		ClaudeHome:      cfg.ClaudeHome,
		CodexHome:       cfg.CodexHome,
		RefreshInterval: cfg.RefreshInterval,
	})
	_ = idx.Refresh()
	return NewHandlerWithIndex(cfg, idx)
}

// StartBackgroundRefresh keeps the index warm until ctx is cancelled.
func StartBackgroundRefresh(ctx context.Context, cfg Config) *index.Index {
	idx := index.New(index.Config{
		ClaudeHome:      cfg.ClaudeHome,
		CodexHome:       cfg.CodexHome,
		RefreshInterval: cfg.RefreshInterval,
	})
	_ = idx.Refresh()
	go idx.Start(ctx)
	return idx
}

// NewHandlerWithIndex wires the API to a caller-owned index.
func NewHandlerWithIndex(cfg Config, idx *index.Index) http.Handler {
	s := &server{cfg: cfg, index: idx}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealthz)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/projects", s.handleProjects)
	mux.HandleFunc("/api/sessions/", s.handleSessionBlocks)
	if cfg.TerminalManager != nil {
		mux.HandleFunc("/api/dev/terminal-sessions", s.handleDevTerminalSessionList)
		mux.HandleFunc("/api/dev/terminal-sessions/", s.handleDevTerminalSessions)
	}
	if cfg.PermissionStore != nil {
		mux.HandleFunc("/api/dev/permission-requests", s.handleDevPermissionRequestList)
		mux.HandleFunc("/api/dev/permission-requests/", s.handleDevPermissionRequest)
	}
	return loopbackGuard(mux)
}

// loopbackGuard restricts the local API to same-machine, non-browser callers
// (the wrapper, the CLI, curl). The API binds 127.0.0.1, but loopback binding
// alone does NOT stop a browser: any web page can fetch()
// http://127.0.0.1:8947/... — a text/plain POST is a CORS "simple request", so
// no preflight gates it — and the /api/dev endpoints (inject input into the
// live Claude PTY, decide permission prompts, synthesize events) are
// state-changing and fire-and-forget. Two checks close that hole:
//
//   - Host must be loopback. A DNS-rebinding attack (attacker.com re-resolved
//     to 127.0.0.1, so the browser treats it as same-origin and omits a
//     cross-origin Origin) still sends Host: attacker.com — rejected here.
//   - A present Origin must be loopback. No legitimate caller is a browser; the
//     wrapper/CLI/curl send no Origin. A cross-origin Origin (CSRF) is rejected.
//
// Same-machine non-browser processes stay trusted (a hostile local process can
// already scrape daemon state); the threat closed here is a remote web page
// driving the user's local Claude session. Mirrors internal/localsetup's
// origin-allowlist pattern.
func loopbackGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostIsLoopback(r.Host) {
			http.Error(w, "forbidden: non-loopback host", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !originIsLoopback(origin) {
			http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// hostIsLoopback reports whether an HTTP Host (or an Origin's host[:port]) names
// the local loopback interface — localhost, 127.0.0.0/8, or ::1, with or without
// a port and with or without IPv6 brackets.
func hostIsLoopback(host string) bool {
	if host == "" {
		return false
	}
	h := host
	if hostOnly, _, err := net.SplitHostPort(host); err == nil {
		h = hostOnly
	}
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	if strings.EqualFold(h, "localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// originIsLoopback reports whether an Origin header value points at loopback.
func originIsLoopback(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return hostIsLoopback(u.Host)
}

type server struct {
	cfg   Config
	index *index.Index
}

const projectsRefreshMaxAge = time.Second

// devTerminalAttachUpgrader gates the live-attach WebSocket. loopbackGuard
// already rejects cross-origin/non-loopback upgrade requests before they reach
// here; this is defense-in-depth (and drops the old CheckOrigin:return-true
// footgun). A no-Origin upgrade — the CLI live-attach client — is allowed.
var devTerminalAttachUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || originIsLoopback(origin)
	},
}

func (s *server) handleDevTerminalSessionList(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TerminalManager == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			TerminalSessionID string `json:"terminal_session_id"`
			ClaudePID         int    `json:"claude_pid"`
		}
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		id, ext, err := s.cfg.TerminalManager.RegisterExternal(strings.TrimSpace(req.TerminalSessionID))
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		// Stash the wrapper's claude child PID on the external session so
		// the inject gate-3 verification (re-scanning open fds) can target
		// the right process.
		if ext != nil && req.ClaudePID > 0 {
			ext.BindPID(req.ClaudePID)
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"terminal_session": map[string]string{"id": id}})
		return
	}
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"terminal_sessions": s.cfg.TerminalManager.List()})
}

func (s *server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "pockly-daemon",
		"version": version.String(),
	})
}

// handleStatus exposes the daemon's effective relay target and detected
// runner profile so operators can spot environment mismatches between web
// and daemon (e.g. local web pointing at a daemon connected to production).
func (s *server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	resp := map[string]any{
		"service":             "pockly-daemon",
		"version":             version.String(),
		"environment_label":   EnvironmentLabel(s.cfg.RelayURL),
		"effective_relay_url": s.cfg.RelayURL,
		"claude_runner_alias": s.cfg.Profile.AliasFor("claude-code"),
		"index":               s.index.Status(),
	}
	if s.cfg.UpdateStatus != nil {
		if info := s.cfg.UpdateStatus(); info.Current != "" || info.Latest != "" {
			resp["update"] = info
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// EnvironmentLabel classifies a relay URL into a coarse environment bucket.
// Used by /api/status so the web can flag mismatch with its own bundled env.
func EnvironmentLabel(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "disconnected"
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Hostname() == "" {
		return "unknown"
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case host == "pocklyapp.com" || strings.HasSuffix(host, ".pocklyapp.com"):
		return "production"
	case host == "127.0.0.1" || host == "localhost" || strings.HasSuffix(host, ".localhost"):
		return "local"
	default:
		return "custom"
	}
}

func (s *server) handleProjects(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	if err := s.index.RefreshIfStale(projectsRefreshMaxAge); err != nil {
		log.Printf("pockly-daemon index: refresh before /api/projects failed: %v", err)
	}
	writeJSON(w, http.StatusOK, s.index.Projects())
}

func (s *server) handleSessionBlocks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}

	sessionID, stream, ok := sessionBlocksRoute(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if stream {
		s.handleSessionBlocksStream(w, r, sessionID)
		return
	}

	data, status, errBody := s.loadSessionBlocks(sessionID)
	if status != http.StatusOK {
		writeJSON(w, status, errBody)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *server) loadSessionBlocks(sessionID string) (any, int, map[string]string) {
	ref, ok := s.index.FindSession(sessionID)
	if !ok {
		return nil, http.StatusNotFound, map[string]string{"error": "session not found"}
	}

	switch ref.Agent {
	case "claude-code":
		data, extractErr := claude.ExtractBlocks(ref.Path)
		if extractErr != nil {
			return nil, http.StatusInternalServerError, map[string]string{"error": extractErr.Error()}
		}
		return data, http.StatusOK, nil
	case "codex":
		data, extractErr := codex.ExtractBlocks(ref.Path)
		if extractErr != nil {
			return nil, http.StatusInternalServerError, map[string]string{"error": extractErr.Error()}
		}
		return data, http.StatusOK, nil
	default:
		return nil, http.StatusInternalServerError, map[string]string{"error": "unknown agent"}
	}
}

func (s *server) handleSessionBlocksStream(w http.ResponseWriter, r *http.Request, sessionID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	lastPayload := ""
	sendBlocks := func(force bool) bool {
		_ = s.index.Refresh()
		data, status, errBody := s.loadSessionBlocks(sessionID)
		if status != http.StatusOK {
			payload, _ := json.Marshal(errBody)
			_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", payload)
			flusher.Flush()
			return false
		}
		payload, err := json.Marshal(data)
		if err != nil {
			errPayload, _ := json.Marshal(map[string]string{"error": "encode json"})
			_, _ = fmt.Fprintf(w, "event: error\ndata: %s\n\n", errPayload)
			flusher.Flush()
			return false
		}
		if !force && string(payload) == lastPayload {
			return true
		}
		lastPayload = string(payload)
		_, _ = fmt.Fprintf(w, "event: blocks\ndata: %s\n\n", payload)
		flusher.Flush()
		return true
	}

	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()
	if !sendBlocks(true) {
		return
	}

	poll := time.NewTicker(750 * time.Millisecond)
	heartbeat := time.NewTicker(15 * time.Second)
	defer poll.Stop()
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.index.Changes():
			if !sendBlocks(false) {
				return
			}
		case <-poll.C:
			if !sendBlocks(false) {
				return
			}
		case <-heartbeat.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		}
	}
}

func (s *server) handleDevTerminalSessions(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TerminalManager == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	sessionID, action, ok := devTerminalRoute(r.URL.Path)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if action == "events" && r.Method == http.MethodPost {
		s.handleDevTerminalEvent(w, r, sessionID)
		return
	}
	if action == "keepalive" && r.Method == http.MethodPost {
		s.handleDevTerminalKeepalive(w, r, sessionID)
		return
	}
	if action == "exit-intent" && r.Method == http.MethodPost {
		s.handleDevTerminalExitIntent(w, r, sessionID)
		return
	}
	if action == "input-stream" && r.Method == http.MethodGet {
		s.handleDevTerminalInputStream(w, r, sessionID)
		return
	}
	if action == "agent-settings" {
		s.handleDevTerminalAgentSettings(w, r, sessionID)
		return
	}
	if action != "input" || r.Method != http.MethodPost {
		if action == "attach" && r.Method == http.MethodGet {
			s.handleDevTerminalAttach(w, r, sessionID)
			return
		}
		if action == "stream" && r.Method == http.MethodGet {
			s.handleDevTerminalStream(w, r, sessionID)
			return
		}
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	defer r.Body.Close()
	var req struct {
		Text string `json:"text"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text is required"})
		return
	}
	if err := s.cfg.TerminalManager.SendInput(sessionID, req.Text); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// handleDevTerminalKeepalive accepts an empty-body POST from a live
// wrapper and forwards it to the relay (via the TerminalEventSink) as a
// "keepalive" event so the relay's reaper can distinguish "wrapper is
// alive, just quiet" from "wrapper died". 404 if the wrapper is talking
// to a daemon that doesn't recognize its terminal_session_id (post
// daemon restart) — the wrapper handles that by re-registering and
// retrying.
func (s *server) handleDevTerminalKeepalive(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.GetExternal(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "external terminal session not found"})
		return
	}
	session.Touch()
	if s.cfg.TerminalEventSink != nil {
		s.cfg.TerminalEventSink(DevTerminalEvent{
			TerminalSessionID: sessionID,
			Kind:              "keepalive",
			Timestamp:         time.Now().UTC(),
		})
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// handleDevTerminalExitIntent receives the wrapper's classification of
// its own exit (clean vs unclean, with exit code + signal details).
// Stored on the ExternalSession so daemon's recovery logic (next PR)
// can ask "did this wrapper exit cleanly?" instead of guessing from
// 45 seconds of silence. Also forwarded to relay as a terminal event
// so the catalog reflects the same classification.
//
// Body is the JSON shape sent by wrapper's ReportExitIntent. Returns
// 404 when the daemon doesn't know the terminal_session (post-restart
// rebind dropped it) — fine, wrapper's not retrying anyway.
func (s *server) handleDevTerminalExitIntent(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.GetExternal(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "external terminal session not found"})
		return
	}
	defer r.Body.Close()
	var req struct {
		Clean           bool   `json:"clean"`
		UserInitiated   bool   `json:"user_initiated"`
		ExitCode        int    `json:"exit_code"`
		TerminatedBy    string `json:"terminated_by"`
		ReportedFromPID int    `json:"reported_from_pid"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	session.RecordExitIntent(liveterminal.ExitIntent{
		Clean:           req.Clean,
		UserInitiated:   req.UserInitiated,
		ExitCode:        req.ExitCode,
		TerminatedBy:    req.TerminatedBy,
		ReportedFromPID: req.ReportedFromPID,
		At:              time.Now().UTC(),
	})
	if s.cfg.TerminalEventSink != nil {
		// Forward to relay as a structured terminal event so the catalog
		// + sidebar can show "session ended" vs "agent crashed" without
		// any additional daemon ↔ relay handshake.
		payload, _ := json.Marshal(req)
		s.cfg.TerminalEventSink(DevTerminalEvent{
			TerminalSessionID: sessionID,
			Kind:              "exit_intent",
			Payload:           string(payload),
			Timestamp:         time.Now().UTC(),
		})
	}
	claudeSID := session.ClaudeSessionID()
	cwd := session.Cwd()
	// Telemetry: report wrapper exit classification so we can see crash
	// rates per daemon over time. Always sample (no rate limit) because
	// these are 1-per-session-lifetime events, not per-turn.
	if s.cfg.ReportTelemetry != nil {
		name := "wrapper_exit_clean"
		status := "ok"
		errorCode := ""
		if !req.Clean {
			name = "wrapper_exit_unclean"
			status = "error"
			errorCode = req.TerminatedBy
			if errorCode == "" {
				errorCode = fmt.Sprintf("exit_code=%d", req.ExitCode)
			}
		}
		go s.cfg.ReportTelemetry(name, "exit-intent", status, errorCode, sessionID)
	}
	// Auto-recovery: when the wrapper died unexpectedly (not user-
	// initiated Ctrl+C / clean exit), invite main.go's recovery hook to
	// spawn an SDK driver so the session stays "live" on the relay's
	// view. Without this, relay's reaper flips the session to
	// disconnected after 45s of silence, and the next user inject pays
	// the spawn cost from cold — visible as "session disconnected, send
	// to reconnect" UX flicker.
	//
	// Async-fire: this handler responds to the wrapper, which is about
	// to exit. Synchronous spawn would race the wrapper's process exit.
	if !req.Clean && s.cfg.OnWrapperUnexpectedExit != nil {
		if claudeSID != "" {
			go s.cfg.OnWrapperUnexpectedExit(claudeSID, cwd, "claude-code")
		}
	}
	if s.cfg.TerminalEventSink != nil {
		s.cfg.TerminalEventSink(DevTerminalEvent{
			TerminalSessionID: sessionID,
			Kind:              liveterminal.EventSessionExited,
			SessionStatus:     liveterminal.SessionExited,
			TurnStatus:        liveterminal.TurnIdle,
			SessionID:         claudeSID,
			Agent:             "claude-code",
			Cwd:               cwd,
			Timestamp:         time.Now().UTC(),
		})
	}
	_ = session.Stop()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "recorded"})
}

func (s *server) handleDevTerminalEvent(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.GetExternal(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "external terminal session not found"})
		return
	}
	defer r.Body.Close()
	var req struct {
		Kind          liveterminal.EventKind     `json:"kind"`
		SessionStatus liveterminal.SessionStatus `json:"session_status"`
		TurnStatus    liveterminal.TurnStatus    `json:"turn_status"`
		Payload       string                     `json:"payload"`
		Error         string                     `json:"error"`
		SessionID     string                     `json:"session_id"`
		Agent         string                     `json:"agent"`
		Cwd           string                     `json:"cwd"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if req.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind is required"})
		return
	}
	session.BindSessionMetadata(strings.TrimSpace(req.SessionID), strings.TrimSpace(req.Cwd))
	session.Emit(req.Kind, req.SessionStatus, req.TurnStatus, req.Payload, req.Error)
	if s.cfg.TerminalEventSink != nil {
		s.cfg.TerminalEventSink(DevTerminalEvent{
			TerminalSessionID: sessionID,
			Kind:              req.Kind,
			SessionStatus:     req.SessionStatus,
			TurnStatus:        req.TurnStatus,
			Payload:           req.Payload,
			Error:             req.Error,
			Timestamp:         time.Now().UTC(),
			SessionID:         strings.TrimSpace(req.SessionID),
			Agent:             strings.TrimSpace(req.Agent),
			Cwd:               strings.TrimSpace(req.Cwd),
		})
	}
	// v0.1.37: telemetry probe. Wrapper events come through this path at
	// turn-cadence (1-3 / minute typical, bursty up to ~10/sec during
	// streaming) so we sample successes 1/200 to keep cloud volume sane.
	// Error-kind events ALWAYS report so the cloud sees every wrapper-
	// reported failure. The reporter hook is async-fire-and-forget so a
	// flaky telemetry endpoint can't slow down the wrapper's HTTP POST.
	if s.cfg.ReportTelemetry != nil {
		isErr := req.Kind == "error" || req.Error != ""
		if isErr || sampleOne(200) {
			go s.cfg.ReportTelemetry(
				"stream_event_received",
				string(req.Kind),
				ternaryStr(isErr, "error", "ok"),
				safeErrorCode(req.Error),
				strings.TrimSpace(req.SessionID),
			)
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// sampleOne returns true approximately 1/n of the time. Uses a simple
// pseudo-random source seeded from time — good enough for sampling
// telemetry where we don't need cryptographic guarantees.
func sampleOne(n int) bool {
	if n <= 1 {
		return true
	}
	return time.Now().UnixNano()%int64(n) == 0
}

// ternaryStr is a tiny conditional-expression helper that keeps the
// telemetry call site compact.
func ternaryStr(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

// safeErrorCode caps the error string so we don't ship novella-length
// stack traces to the telemetry endpoint (which validates ≤80 chars).
func safeErrorCode(err string) string {
	err = strings.TrimSpace(err)
	if len(err) > 80 {
		err = err[:80]
	}
	return err
}

func (s *server) handleDevTerminalInputStream(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.GetExternal(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "external terminal session not found"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	inputs, unsubscribe := session.SubscribeInput(32)
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()
	for {
		select {
		case text, ok := <-inputs:
			if !ok {
				return
			}
			payload, err := json.Marshal(map[string]string{"text": text})
			if err != nil {
				return
			}
			_, _ = w.Write([]byte("event: input\n"))
			_, _ = w.Write([]byte("data: "))
			_, _ = w.Write(payload)
			_, _ = w.Write([]byte("\n\n"))
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *server) handleDevTerminalStream(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.Get(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "terminal session not found"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	events, unsubscribe := session.Subscribe(256)
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()

	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			payload, err := json.Marshal(event)
			if err != nil {
				return
			}
			_, _ = w.Write([]byte("event: terminal\n"))
			_, _ = w.Write([]byte("data: "))
			_, _ = w.Write(payload)
			_, _ = w.Write([]byte("\n\n"))
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *server) handleDevTerminalAttach(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, ok := s.cfg.TerminalManager.Get(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "terminal session not found"})
		return
	}
	conn, err := devTerminalAttachUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	events, unsubscribe := session.Subscribe(256)
	defer unsubscribe()

	type attachMessage struct {
		Op   string `json:"op"`
		Data string `json:"data,omitempty"`
		Cols uint16 `json:"cols,omitempty"`
		Rows uint16 `json:"rows,omitempty"`
	}
	type attachEnvelope struct {
		Type  string              `json:"type"`
		Event *liveterminal.Event `json:"event,omitempty"`
		Error string              `json:"error,omitempty"`
	}

	errCh := make(chan error, 2)
	go func() {
		for event := range events {
			eventCopy := event
			if err := conn.WriteJSON(attachEnvelope{Type: "event", Event: &eventCopy}); err != nil {
				errCh <- err
				return
			}
		}
		errCh <- nil
	}()
	go func() {
		for {
			var msg attachMessage
			if err := conn.ReadJSON(&msg); err != nil {
				errCh <- err
				return
			}
			switch msg.Op {
			case "input":
				if err := s.cfg.TerminalManager.SendRaw(sessionID, msg.Data); err != nil {
					_ = conn.WriteJSON(attachEnvelope{Type: "error", Error: err.Error()})
				}
			case "submit":
				if err := s.cfg.TerminalManager.SendInput(sessionID, msg.Data); err != nil {
					_ = conn.WriteJSON(attachEnvelope{Type: "error", Error: err.Error()})
				}
			case "resize":
				if err := s.cfg.TerminalManager.Resize(sessionID, msg.Cols, msg.Rows); err != nil {
					_ = conn.WriteJSON(attachEnvelope{Type: "error", Error: err.Error()})
				}
			case "stop":
				if err := s.cfg.TerminalManager.Stop(sessionID); err != nil {
					_ = conn.WriteJSON(attachEnvelope{Type: "error", Error: err.Error()})
				}
			}
		}
	}()
	select {
	case <-r.Context().Done():
	case <-errCh:
	}
}

func sessionBlocksRoute(path string) (sessionID string, stream bool, ok bool) {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return "", false, false
	}
	rest := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	if strings.HasSuffix(rest, "/blocks/stream") {
		id := strings.TrimSuffix(rest, "/blocks/stream")
		id = strings.Trim(id, "/")
		return id, true, id != ""
	}
	if strings.HasSuffix(rest, "/blocks") {
		id := strings.TrimSuffix(rest, "/blocks")
		id = strings.Trim(id, "/")
		return id, false, id != ""
	}
	return "", false, false
}

func devTerminalRoute(path string) (string, string, bool) {
	const prefix = "/api/dev/terminal-sessions/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.Trim(strings.TrimPrefix(path, prefix), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func writeMethodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
}

// handleDevPermissionRequestList answers GET /api/dev/permission-requests
// with the snapshot of currently-pending requests. Used by the web
// initial-fetch on subscribe (in case the SSE missed the "new request"
// event) + by diagnostics. Returns {permission_requests: [...]}.
func (s *server) handleDevPermissionRequestList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"permission_requests": s.cfg.PermissionStore.List(),
	})
}

// handleDevPermissionRequest dispatches on the action segment of
// /api/dev/permission-requests/<id>/<action>:
//
//   - POST   /permission-requests/<id>          → Register
//   - GET    /permission-requests/<id>/await    → Await (long-poll)
//   - POST   /permission-requests/<id>/decide   → Decide
//   - POST   /permission-requests/<id>/cancel   → Cancel
//
// Bare /permission-requests/<id> POST is for the mcp-permission
// server to register; the other three are for downstream consumers.
func (s *server) handleDevPermissionRequest(w http.ResponseWriter, r *http.Request) {
	const prefix = "/api/dev/permission-requests/"
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "request id required"})
		return
	}
	reqID := parts[0]
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}

	switch action {
	case "":
		// Bare /<id> — Register (POST).
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		s.handlePermissionRegister(w, r, reqID)
	case "await":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, http.MethodGet)
			return
		}
		s.handlePermissionAwait(w, r, reqID)
	case "decide":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		s.handlePermissionDecide(w, r, reqID)
	case "cancel":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, http.MethodPost)
			return
		}
		s.cfg.PermissionStore.Cancel(reqID)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "cancelled"})
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown action"})
	}
}

func (s *server) handlePermissionRegister(w http.ResponseWriter, r *http.Request, reqID string) {
	defer r.Body.Close()
	var body struct {
		TerminalSessionID string          `json:"terminal_session_id"`
		ClaudeSessionID   string          `json:"claude_session_id"`
		ToolName          string          `json:"tool_name"`
		Input             json.RawMessage `json:"input"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.ToolName) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "tool_name is required"})
		return
	}
	req := permission.Request{
		ID:                reqID,
		TerminalSessionID: strings.TrimSpace(body.TerminalSessionID),
		ClaudeSessionID:   strings.TrimSpace(body.ClaudeSessionID),
		ToolName:          strings.TrimSpace(body.ToolName),
		Input:             body.Input,
	}
	if err := s.cfg.PermissionStore.Register(req); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "registered"})
}

func (s *server) handlePermissionAwait(w http.ResponseWriter, r *http.Request, reqID string) {
	// Parse ?timeout=<seconds> — defaults to 30, capped at 120 to
	// prevent abuse holding a goroutine forever (the MCP server is
	// the only legit caller and it sets 30 explicitly).
	timeoutSec := 30
	if t := strings.TrimSpace(r.URL.Query().Get("timeout")); t != "" {
		if v, err := strconv.Atoi(t); err == nil && v > 0 && v <= 120 {
			timeoutSec = v
		}
	}
	// C2 instrumentation: the permission-approval "Allow didn't land"
	// reports come down to whether this Await is still parked when the
	// web decide arrives. Log start + return (reason + elapsed) so a
	// daemon log shows the exact lifecycle: an early return here (before
	// the user clicks) is the smoking gun.
	awaitStart := time.Now()
	log.Printf("permission await: reqID=%s start (timeout=%ds)", reqID, timeoutSec)
	out, err := s.cfg.PermissionStore.Await(r.Context(), reqID, time.Duration(timeoutSec)*time.Second)
	if err != nil {
		if errors.Is(err, permission.ErrNotFound) {
			log.Printf("permission await: reqID=%s → not_found after %s", reqID, time.Since(awaitStart).Truncate(time.Millisecond))
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "request not found"})
			return
		}
		if errors.Is(err, permission.ErrTimeout) {
			log.Printf("permission await: reqID=%s → timeout after %s", reqID, time.Since(awaitStart).Truncate(time.Millisecond))
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "request timed out"})
			return
		}
		// Context cancelled (client disconnect) — return 499-ish; the
		// MCP server retries on transport error so this is best-effort.
		log.Printf("permission await: reqID=%s → ctx/transport (%v) after %s", reqID, err, time.Since(awaitStart).Truncate(time.Millisecond))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("permission await: reqID=%s → decided=%s reason=%s after %s", reqID, out.Decision, out.Reason, time.Since(awaitStart).Truncate(time.Millisecond))
	writeJSON(w, http.StatusOK, out)
}

func (s *server) handlePermissionDecide(w http.ResponseWriter, r *http.Request, reqID string) {
	defer r.Body.Close()
	var body struct {
		Decision string `json:"decision"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	decision := permission.Decision(strings.TrimSpace(body.Decision))
	if decision != permission.DecisionAllow && decision != permission.DecisionDeny {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision must be allow or deny"})
		return
	}
	if err := s.cfg.PermissionStore.Decide(reqID, decision); err != nil {
		if errors.Is(err, permission.ErrNotFound) {
			log.Printf("permission decide (local): reqID=%s decision=%s → not_found", reqID, decision)
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "request not found"})
			return
		}
		log.Printf("permission decide (local): reqID=%s decision=%s → error %v", reqID, decision, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("permission decide (local): reqID=%s decision=%s → decided", reqID, decision)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "decided"})
}

// handleDevTerminalAgentSettings serves
// /api/dev/terminal-sessions/<id>/agent-settings:
//   - GET  → snapshot {current, available_models, available_permission_modes, available_efforts}
//   - POST → apply {model?, permission_mode?, effort?}; returns the
//     post-apply snapshot. Errors map to:
//   - 404 session_not_attached / unknown ts
//   - 409 session_drifted ({actual_sid: ...})
//   - 400 unknown_mode / bypass at runtime / unknown_effort
//
// This is the canonical home for composer-pills state. The relay's
// AGENT_SETTINGS_GET/SET control WS messages call into the same
// agentsettings.Store via the control-package handler interface — both
// paths share state.
func (s *server) handleDevTerminalAgentSettings(w http.ResponseWriter, r *http.Request, sessionID string) {
	if s.cfg.AgentSettings == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent settings disabled"})
		return
	}
	ext, ok := s.cfg.TerminalManager.GetExternal(sessionID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "external terminal session not found"})
		return
	}
	cwd := ext.Cwd()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.cfg.AgentSettings.SnapshotFor(sessionID, cwd))
		return
	case http.MethodPost:
		defer r.Body.Close()
		var req agentsettings.ApplyRequest
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil && !errors.Is(err, http.ErrBodyReadAfterClose) {
			// Empty body is fine — caller may just want the latest snapshot.
			if err.Error() != "EOF" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
				return
			}
		}
		claudeSID := ext.ClaudeSessionID()
		// Validate the model against the cwd-derived known set BEFORE
		// Apply — Store.Apply only validates permission_mode/effort, so
		// without this a local client could POST `/model <bogus>` and
		// have it pushed to the PTY + recorded, leaving the pill
		// disagreeing with the agent. Mirrors agentSettingsAdapter.Set
		// (the relay path). ReadModelOptions now includes ANTHROPIC_MODEL,
		// so an env-default model is accepted here too. (A model the user
		// switched to mid-session via their own terminal — observable only
		// from the jsonl, which this dev endpoint can't reach without the
		// index — would be rejected; the relay/web path handles that case.)
		if err := agentsettings.ValidateModelForCwd(ext.Cwd(), req.Model); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := s.cfg.AgentSettings.Apply(s.cfg.TerminalManager, sessionID, claudeSID, req); err != nil {
			status := http.StatusBadRequest
			msg := err.Error()
			switch {
			case strings.Contains(msg, "session_not_attached"):
				status = http.StatusNotFound
			case strings.HasPrefix(msg, "session_drifted"):
				status = http.StatusConflict
			}
			writeJSON(w, status, map[string]string{"error": msg})
			return
		}
		writeJSON(w, http.StatusOK, s.cfg.AgentSettings.SnapshotFor(sessionID, cwd))
		return
	default:
		writeMethodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		http.Error(w, errors.New("encode json").Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
