// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/telemetry"
)

// runHookBridge is a compatibility entrypoint for stale Claude Code
// PreToolUse hooks installed by older Pockly versions.
//
// claude spawns this as a short-lived process for configured tool use
// requests (Bash / Edit / Write / etc.). The contract:
//
//	stdin : JSON envelope from claude
//	  {session_id, transcript_path, hook_event_name, tool_name, tool_input}
//	stdout: JSON decision envelope read by claude
//	  {decision: "approve"|"block", reason: "<human-readable>"}
//	stderr: free-form logs (ignored by claude, surfaced to wrapper logs)
//
// Pockly no longer makes hook-level permission decisions. Claude Code's
// native permission model is authoritative; this command always returns an
// empty decision so Claude can continue its own permission flow.
//
// Design note: this command runs OUTSIDE the daemon process. It
// reaches the local daemon over loopback HTTP, never reaches Nexus
// directly. That way the daemon's existing identity/keys path
// owns the auth boundary.
func runHookBridge(args []string) error {
	fs := flag.NewFlagSet("hook-bridge", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	hookType := fs.String("type", "PreToolUse", "claude hook event name (PreToolUse / PostToolUse / Notification)")
	sessionID := fs.String("session", "", "claude session_id ($CLAUDE_SESSION_ID); used for optional diagnostics + decide routing")
	terminalSessionID := fs.String("terminal-session-id", "", "wrapper's terminal_session_id (optional; falls back to env $POCKLY_TERMINAL_SESSION_ID)")
	daemonURL := fs.String("daemon-url", "http://127.0.0.1:8947", "local pockly-daemon URL for optional diagnostics + permission API")
	timeout := fs.Duration("timeout", 60*time.Second, "max wait for web decision")
	relayURL := fs.String("relay-url", "", "Nexus URL for optional diagnostics; default reads $POCKLY_NEXUS_URL then $POCKLY_RELAY_URL")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon hook-bridge [flags]

Reads claude hook payload from stdin, writes decision envelope to
stdout. Not for direct use — claude code spawns this from
~/.claude/settings.json hooks config (set up by pockly-claude-wrapper
on startup).`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Fall back to env vars where flags weren't provided. claude only
	// passes session via stdin, but wrapper can pre-set
	// $POCKLY_TERMINAL_SESSION_ID at spawn time so per-session
	// routing has a stable hint without the wrapper having to
	// dynamically re-write settings.json per session.
	if *terminalSessionID == "" {
		*terminalSessionID = strings.TrimSpace(os.Getenv("POCKLY_TERMINAL_SESSION_ID"))
	}
	if *relayURL == "" {
		*relayURL = strings.TrimSpace(os.Getenv("POCKLY_NEXUS_URL"))
	}
	if *relayURL == "" {
		*relayURL = strings.TrimSpace(os.Getenv("POCKLY_RELAY_URL"))
	}

	// Read stdin payload. Bound it generously to avoid OOM on a
	// malformed pipe, but big enough for real tool_input bodies (file
	// edits with multi-MB diffs are real).
	bodyBytes, err := io.ReadAll(io.LimitReader(os.Stdin, 4*1024*1024))
	if err != nil {
		return fmt.Errorf("read stdin: %w", err)
	}
	payload, parseErr := parseHookPayload(bodyBytes)
	if parseErr != nil {
		// Don't fail the process — write an empty decision so claude
		// falls back to its terminal prompt (defensive degradation),
		// but log the reason so a wrapper observer sees it.
		fmt.Fprintf(os.Stderr, "pockly-daemon hook-bridge: parse stdin: %v\n", parseErr)
		emitTelemetry(*daemonURL, *relayURL, telemetry.Event{
			Name:      "hook_protocol_mismatch",
			Command:   *hookType,
			Status:    "error",
			ErrorCode: telemetry.SafeErrorCode(parseErr.Error()),
			SessionID: *sessionID,
		})
		return writeEmptyDecision(os.Stdout)
	}

	// Carry session_id from stdin if the flag wasn't set — claude
	// passes it in the payload too, and stdin-side is the most
	// authoritative source.
	resolvedSession := strings.TrimSpace(*sessionID)
	if resolvedSession == "" {
		resolvedSession = strings.TrimSpace(payload.SessionID)
	}

	// Emit optional diagnostics so self-hosted operators can see how
	// often the bridge fires + which tools. Best-effort: never block
	// the hot path.
	emitTelemetry(*daemonURL, *relayURL, telemetry.Event{
		Name:      "permission_bridge_started",
		Command:   payload.ToolName,
		SessionID: resolvedSession,
		Status:    "ok",
	})

	// Log to stderr (claude ignores stderr; wrapper picks it up if it
	// inherits the file descriptor — useful for live debugging).
	fmt.Fprintf(os.Stderr, "pockly-daemon hook-bridge: type=%s tool=%s session=%s ts=%s timeout=%s\n",
		*hookType, payload.ToolName, resolvedSession, *terminalSessionID, *timeout)

	emitTelemetry(*daemonURL, *relayURL, telemetry.Event{
		Name:      "permission_bridge_deferred",
		Command:   payload.ToolName,
		Status:    "deferred",
		SessionID: resolvedSession,
	})
	return writeEmptyDecision(os.Stdout)
}

// hookPayload mirrors the JSON claude writes to our stdin per
// hook spec. Unknown fields are ignored so a future claude version
// adding fields doesn't break us — only renamed/removed fields would.
type hookPayload struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath string          `json:"transcript_path"`
	HookEventName  string          `json:"hook_event_name"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
}

// parseHookPayload validates the minimum structure and returns a
// typed view. We accept an empty body as "no-op" (returns zero
// payload + nil error) so a bug in claude's hook spawn doesn't make
// us emit hook_protocol_mismatch noise on every blank invocation.
func parseHookPayload(body []byte) (hookPayload, error) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return hookPayload{}, nil
	}
	var p hookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return hookPayload{}, fmt.Errorf("invalid JSON: %w", err)
	}
	// Don't require any specific field — claude's spec lists hook
	// events without payload (Stop / SessionEnd). Only require valid
	// JSON. Stricter validation would be brittle as the spec grows.
	return p, nil
}

// writeEmptyDecision writes the literal `{}` so claude treats the
// hook as having returned no decision and falls through to its
// built-in permission flow. Returns wrap of the underlying writer error.
func writeEmptyDecision(w io.Writer) error {
	if _, err := io.WriteString(w, "{}\n"); err != nil {
		return fmt.Errorf("write stdout: %w", err)
	}
	return nil
}

// emitTelemetry sends one optional diagnostic event through Nexus.
// Best-effort: silently no-ops unless telemetry is explicitly enabled or
// the daemon/Nexus isn't reachable. Hook bridge has a hard SLO —
// every claude tool call goes through it, so any failure here MUST
// be invisible to the user.
//
// We read the daemon's Nexus URL via a quick /api/status probe;
// hook-bridge intentionally doesn't share daemon identity since it's
// out-of-process. Falls back to no-op if probe fails.
func emitTelemetry(daemonURL, explicitRelayURL string, evt telemetry.Event) {
	if !telemetry.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	relayURL := strings.TrimSpace(explicitRelayURL)
	identity := device.Identity{}
	if relayURL == "" {
		probedRelay, probedID, err := probeDaemonStatus(ctx, daemonURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "pockly-daemon hook-bridge: telemetry skipped: probe daemon: %v\n", err)
			return
		}
		relayURL = probedRelay
		identity = probedID
	}
	if relayURL == "" {
		return
	}
	telemetry.Send(ctx, relayURL, identity, evt)
}

// probeDaemonStatus hits /api/status to learn (relay_url, device_id)
// without needing the daemon's keyring. Returns the Nexus URL plus a
// best-effort device.Identity (device_id only; Nexus accepts
// telemetry with just install_id + device_id, no signing required).
func probeDaemonStatus(ctx context.Context, daemonURL string) (string, device.Identity, error) {
	if strings.TrimSpace(daemonURL) == "" {
		return "", device.Identity{}, errors.New("daemon URL empty")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(daemonURL, "/")+"/api/status", nil)
	if err != nil {
		return "", device.Identity{}, err
	}
	hc := &http.Client{Timeout: 1 * time.Second}
	resp, err := hc.Do(req)
	if err != nil {
		return "", device.Identity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", device.Identity{}, fmt.Errorf("daemon /api/status %d", resp.StatusCode)
	}
	var status struct {
		RelayURL string `json:"relay_url"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return "", device.Identity{}, err
	}
	return status.RelayURL, device.Identity{DeviceID: status.DeviceID}, nil
}
