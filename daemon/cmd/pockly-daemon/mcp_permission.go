// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// cryptoRandRead is a tiny indirection over crypto/rand.Read so the
// newRequestID helper can be unit-tested with a deterministic
// substitute (not used yet, but the boundary is cheap).
var cryptoRandRead = rand.Read

// runMCPPermission is the MCP permission-prompt-tool bridge.
// Claude code spawns this process as a stdio MCP server (configured
// via the --mcp-config the wrapper writes before exec). When claude
// is about to call a tool (Bash / Write / Edit / etc.), it routes
// the "may I?" question through this server instead of the TUI 1/2
// prompt — which is what makes the prompt VISIBLE to the web tab.
//
// Pockly does not decide permissions. It only forwards Claude Code's
// permission prompt to the Web UI and returns the user's allow/deny
// answer back to Claude.
//
// Protocol: MCP is JSON-RPC 2.0 over stdio, one JSON object per line.
// We implement the absolute minimum to satisfy claude code's caller:
//
//	initialize           → return serverInfo + capabilities
//	notifications/*      → ignore (no response, per spec)
//	tools/list           → return [request_permission]
//	tools/call           → POST to daemon /events + wait for user decision
//
// Anything else gets a method-not-found error so claude logs +
// continues. We log diagnostic chatter to STDERR — stdout is the
// protocol channel, polluting it would corrupt every reply.
func runMCPPermission(args []string) error {
	fs := flag.NewFlagSet("mcp-permission", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	tsID := fs.String("terminal-session-id", "", "wrapper's terminal_session_id, used to route events back through the daemon")
	sessionID := fs.String("session-id", "", "claude chat session_id for telemetry correlation")
	daemonURL := fs.String("daemon-url", "http://127.0.0.1:8947", "local pockly-daemon URL for posting permission events")
	interactive := fs.Bool("interactive", false, "wait for web user's allow/deny decision")
	timeout := fs.Duration("timeout", 30*time.Second, "interactive mode: deadline for web decision")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon mcp-permission [flags]

Speaks MCP JSON-RPC 2.0 over stdin/stdout. Not for direct use — claude
code spawns this via the --mcp-config the wrapper writes.`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	srv := &mcpPermServer{
		terminalSessionID: strings.TrimSpace(*tsID),
		sessionID:         strings.TrimSpace(*sessionID),
		daemonURL:         strings.TrimRight(strings.TrimSpace(*daemonURL), "/"),
		interactive:       *interactive,
		decideTimeout:     *timeout,
		// HTTP client timeout MUST be >= decideTimeout when interactive
		// (otherwise the await long-poll fails before its deadline).
		// Bump to timeout + 10s slack for the round-trip headers.
		hc: &http.Client{Timeout: *timeout + 10*time.Second},
	}
	return srv.serve(context.Background(), os.Stdin, os.Stdout)
}

type mcpPermServer struct {
	terminalSessionID string
	sessionID         string
	daemonURL         string
	interactive       bool
	decideTimeout     time.Duration
	hc                *http.Client
}

// JSON-RPC 2.0 envelope shapes. We keep RawMessage for the
// method-specific bits so unknown fields pass through and we don't
// have to model every spec object (which evolves more than we
// want to chase).
type jrpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // null for notifications
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jrpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *jrpcErr        `json:"error,omitempty"`
}

type jrpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *mcpPermServer) serve(ctx context.Context, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	// MCP messages can be larger than the default 64KB; tool inputs
	// (file edits, big bash output) push it. 4MB is plenty.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	writer := bufio.NewWriter(out)
	defer writer.Flush()
	enc := json.NewEncoder(writer)
	enc.SetEscapeHTML(false)

	fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] starting (ts=%s sid=%s daemon=%s)\n",
		s.terminalSessionID, s.sessionID, s.daemonURL)
	defer fmt.Fprintln(os.Stderr, "[pockly-mcp-permission] stdin closed, exiting")

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var req jrpcReq
		if err := json.Unmarshal(line, &req); err != nil {
			fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] bad json: %v\n", err)
			continue
		}
		resp := s.dispatch(ctx, req)
		if resp == nil {
			// Notification — no response per JSON-RPC 2.0.
			continue
		}
		if err := enc.Encode(resp); err != nil {
			fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] write: %v\n", err)
			return err
		}
		if err := writer.Flush(); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// dispatch routes one inbound request. Returns nil for notifications
// (per JSON-RPC 2.0, notifications have no id and get no reply).
func (s *mcpPermServer) dispatch(ctx context.Context, req jrpcReq) *jrpcResp {
	if req.ID == nil || string(req.ID) == "null" {
		// Notification. We currently care about none of them, but
		// we MUST NOT respond.
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] notification: %s\n", req.Method)
		return nil
	}
	resp := &jrpcResp{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		resp.Result = map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "pockly-permission",
				"version": "0.1.42",
			},
		}
	case "tools/list":
		resp.Result = map[string]any{
			"tools": []any{
				map[string]any{
					"name":        "request_permission",
					"description": "Forward Claude Code permission prompts to the Pockly web UI and return the user's allow/deny decision.",
					// Schema mirrors what claude code passes via the
					// permission-prompt-tool contract.
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"tool_name": map[string]any{"type": "string"},
							"input":     map[string]any{"type": "object"},
						},
						"required": []string{"tool_name"},
					},
				},
			},
		}
	case "tools/call":
		result, callErr := s.handleToolCall(ctx, req.Params)
		if callErr != nil {
			resp.Error = callErr
		} else {
			resp.Result = result
		}
	default:
		resp.Error = &jrpcErr{Code: -32601, Message: "method not found: " + req.Method}
	}
	return resp
}

// handleToolCall is the meat. Claude passes the tool name + input it's
// ABOUT to invoke; we POST it to the daemon for the web to render,
// then return the "permission decision" payload claude expects.
//
// The expected decision shape (per claude code's permission-prompt-tool
// contract):
//
//	{"behavior":"allow","updatedInput":{...echoed input...}}
//	{"behavior":"deny","message":"..."}
//
// Interactive mode registers the request with the daemon, emits the event
// (decision=pending + request_id so the web shows Allow/Deny), blocks on
// /await up to decideTimeout, then returns the exact allow/deny choice.
func (s *mcpPermServer) handleToolCall(ctx context.Context, raw json.RawMessage) (any, *jrpcErr) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	_ = json.Unmarshal(raw, &params)

	// Best-effort parse of the inner permission-prompt arguments so we
	// can ship structured data to the daemon. Schema unspecified, so
	// we use a permissive shape.
	var probe struct {
		ToolName string          `json:"tool_name"`
		Input    json.RawMessage `json:"input"`
	}
	_ = json.Unmarshal(params.Arguments, &probe)

	if !s.interactive {
		return nil, &jrpcErr{Code: -32000, Message: "Pockly permission bridge is not interactive"}
	}

	// Interactive path: mint a request_id, register, emit the event for
	// the web to render, block on /await, then translate the outcome
	// into the MCP envelope.
	reqID := newRequestID()
	if err := s.registerPermissionRequest(reqID, probe.ToolName, probe.Input); err != nil {
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] register failed (%v)\n", err)
		return nil, &jrpcErr{Code: -32000, Message: "Pockly permission bridge unavailable"}
	}
	// Emit the visible event AFTER register but BEFORE await so the
	// web sees the card while we're waiting.
	go s.postPermissionEvent(probe.ToolName, probe.Input, reqID, "pending")

	outcome, err := s.awaitPermissionDecision(ctx, reqID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] await failed (%v)\n", err)
		return nil, &jrpcErr{Code: -32000, Message: "Pockly permission bridge did not receive a decision"}
	}
	// Echo the resolved decision as data-only state sync. Web must not
	// render this as a historical approval card.
	go s.postPermissionEvent(probe.ToolName, probe.Input, reqID, outcome.Decision)

	return s.wrapDecision(outcome.Decision, probe.Input, outcome.Reason), nil
}

// wrapDecision returns the MCP tool-call content envelope claude
// expects, wrapping the {behavior, updatedInput, message?} payload as
// JSON inside a single text block.
func (s *mcpPermServer) wrapDecision(decision string, input json.RawMessage, reason string) any {
	out := map[string]any{
		"behavior":     decision,
		"updatedInput": rawOrEmpty(input),
	}
	if decision == "deny" && reason != "" {
		out["message"] = reason
	}
	dj, _ := json.Marshal(out)
	return map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": string(dj)},
		},
	}
}

// awaitOutcome is the parsed /await response shape.
type awaitOutcome struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

// registerPermissionRequest POSTs the request_id + tool metadata to the
// daemon so /await has something to park on. Returns error on non-2xx; the
// caller reports a JSON-RPC error and lets Claude own the resulting behavior.
func (s *mcpPermServer) registerPermissionRequest(reqID, toolName string, input json.RawMessage) error {
	body, _ := json.Marshal(map[string]any{
		"terminal_session_id": s.terminalSessionID,
		"claude_session_id":   s.sessionID,
		"tool_name":           toolName,
		"input":               rawOrEmpty(input),
	})
	url := s.daemonURL + "/api/dev/permission-requests/" + reqID
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		buf, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("daemon %d: %s", resp.StatusCode, truncateString(string(buf), 120))
	}
	return nil
}

// awaitPermissionDecision long-polls /await. Timeout is returned as an
// error rather than a synthetic Pockly deny decision.
func (s *mcpPermServer) awaitPermissionDecision(ctx context.Context, reqID string) (awaitOutcome, error) {
	timeoutSec := int(s.decideTimeout / time.Second)
	if timeoutSec <= 0 {
		timeoutSec = 30
	}
	url := fmt.Sprintf("%s/api/dev/permission-requests/%s/await?timeout=%d", s.daemonURL, reqID, timeoutSec)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return awaitOutcome{}, err
	}
	resp, err := s.hc.Do(req)
	if err != nil {
		return awaitOutcome{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		buf, _ := io.ReadAll(resp.Body)
		return awaitOutcome{}, fmt.Errorf("daemon %d: %s", resp.StatusCode, truncateString(string(buf), 120))
	}
	var out awaitOutcome
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return awaitOutcome{}, err
	}
	if out.Decision != "allow" && out.Decision != "deny" {
		return awaitOutcome{}, fmt.Errorf("unexpected decision: %q", out.Decision)
	}
	return out, nil
}

// newRequestID mints a UUIDv4-ish hex string. We don't pull in a uuid
// dep for this — the daemon's only contract is "globally unique
// enough" and 128 bits of crypto/rand do that.
func newRequestID() string {
	var b [16]byte
	if _, err := cryptoRandRead(b[:]); err != nil {
		// Fall back to monotonic-time + pid as a last resort so we
		// never block on entropy. Practically unreachable on macOS /
		// Linux.
		return fmt.Sprintf("req-fallback-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("req-%x", b)
}

// truncateString is a tiny helper for error message bodies so a
// chatty daemon doesn't produce log lines hundreds of KB long.
func truncateString(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// postPermissionEvent ships one request to the daemon's existing
// terminal-session event channel using the same kind+payload contract
// the wrapper uses for message_added etc. The web's handleLiveSessionEvent
// will dispatch on kind=permission_request.
//
// Lookup strategy: we get terminal_session_id from the wrapper's
// invocation arg if provided, OR resolve at runtime by asking the
// local daemon which ts_id matches our session_id. The runtime path
// handles the startup race where the wrapper hasn't finished
// registering yet — we retry briefly then drop.
func (s *mcpPermServer) postPermissionEvent(toolName string, input json.RawMessage, requestID, decision string) {
	tsID := s.terminalSessionID
	if tsID == "" {
		tsID = s.resolveTerminalSessionID()
	}
	if tsID == "" {
		fmt.Fprintln(os.Stderr, "[pockly-mcp-permission] no ts_id resolvable; dropping event")
		return
	}
	reason := "Pockly forwarding Claude permission prompt"
	if s.interactive {
		switch decision {
		case "pending":
			reason = "awaiting web decision"
		case "allow":
			reason = "user approved"
		case "deny":
			reason = "user denied"
		}
	}
	payload := map[string]any{
		"tool_name":  toolName,
		"input":      rawOrEmpty(input),
		"decision":   decision,
		"reason":     reason,
		"ts":         time.Now().UTC().Format(time.RFC3339),
		"request_id": requestID, // empty in legacy mode; web uses this for /decide
	}
	payloadJSON, _ := json.Marshal(payload)
	body, _ := json.Marshal(map[string]any{
		"kind":           "permission_request",
		"session_status": "live",
		"turn_status":    "streaming",
		"payload":        string(payloadJSON),
		"session_id":     s.sessionID,
	})
	url := s.daemonURL + "/api/dev/terminal-sessions/" + tsID + "/events"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] build req: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.hc.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] POST: %v\n", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		buf, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(os.Stderr, "[pockly-mcp-permission] daemon %d: %s\n", resp.StatusCode, string(buf))
	}
}

// resolveTerminalSessionID queries the local daemon's terminal_sessions
// list and returns the one matching our claude session_id. Retries a
// few times to handle the startup window where the wrapper hasn't
// finished registering yet (claude calls its first tool ~2s after
// spawn; wrapper register takes <100ms but the race is real).
func (s *mcpPermServer) resolveTerminalSessionID() string {
	if s.sessionID == "" {
		return ""
	}
	for attempt := 0; attempt < 5; attempt++ {
		req, _ := http.NewRequest(http.MethodGet, s.daemonURL+"/api/dev/terminal-sessions", nil)
		resp, err := s.hc.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			var list struct {
				TerminalSessions []map[string]any `json:"terminal_sessions"`
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if json.Unmarshal(body, &list) == nil {
				for _, ts := range list.TerminalSessions {
					if sid, _ := ts["claude_session_id"].(string); sid == s.sessionID {
						if id, _ := ts["id"].(string); id != "" {
							return id
						}
					}
				}
			}
		} else if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(time.Duration(100*(1<<attempt)) * time.Millisecond)
	}
	return ""
}

// rawOrEmpty returns the raw JSON if non-empty, else an empty object —
// the permission-prompt response shape requires updatedInput to be a
// JSON OBJECT, never null/undefined.
func rawOrEmpty(raw json.RawMessage) any {
	if len(bytes.TrimSpace(raw)) == 0 {
		return map[string]any{}
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return map[string]any{}
	}
	return v
}
