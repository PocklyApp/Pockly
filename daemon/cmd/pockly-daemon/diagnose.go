// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/claude"
	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	"github.com/PocklyApp/Pockly/daemon/internal/relay"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
)

// runDiagnose dispatches the `pockly-daemon diagnose <subcommand>`
// subcommand family. v0.1.38 ships one subcommand:
//
//	pockly-daemon diagnose telemetry [--device-id X] [--session-id Y]
//	                                 [--source daemon|web] [--since 10m]
//	                                 [--limit 200] [--json]
//
// Self-authenticates via the daemon's device identity (the same
// keypair used for catalog sync) so no browser bearer is needed —
// just run it on any paired daemon. Hits the relay's
// /api/dev/telemetry/recent endpoint (v0.1.38) which only returns
// rows for devices the caller's user account owns.
func runDiagnose(args []string) error {
	if len(args) == 0 {
		return diagnoseUsageErr("diagnose requires a subcommand")
	}
	switch args[0] {
	case "telemetry":
		return runDiagnoseTelemetry(args[1:])
	case "sync-session":
		return runDiagnoseSyncSession(args[1:])
	case "stress":
		// v0.1.40: load tests that auto-cross-check with telemetry.
		return runDiagnoseStress(args[1:])
	case "-h", "--help", "help":
		fmt.Fprintln(os.Stderr, diagnoseUsage())
		return nil
	default:
		return diagnoseUsageErr("unknown diagnose subcommand: " + args[0])
	}
}

func diagnoseUsage() string {
	return `Usage: pockly-daemon diagnose <subcommand> [flags]

Subcommands:
  telemetry      Fetch recent observability events for a device.
  sync-session   Force-upload one local session's plaintext turns to relay.
  stress         Concurrency stress tests (inject-burst, sse-reconnect).

Run 'pockly-daemon diagnose <subcommand> --help' for subcommand flags.`
}

func diagnoseUsageErr(msg string) error {
	return fmt.Errorf("%s\n\n%s", msg, diagnoseUsage())
}

func runDiagnoseSyncSession(args []string) error {
	defaultClaudeHome, err := claude.DefaultHome()
	if err != nil {
		return err
	}
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	defaultRelayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}

	fs := flag.NewFlagSet("diagnose sync-session", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sessionID := fs.String("session-id", "", "Claude Code session id to upload")
	claudeHome := fs.String("claude-home", defaultClaudeHome, "Claude Code session home")
	identityFile := fs.String("identity-file", identityPath, "path to device.json")
	relayStateFile := fs.String("relay-state-file", defaultRelayStatePath, "relay pairing state file path")
	relayURL := fs.String("relay-url", "", "override relay URL (default: read from relay-state.json)")
	limit := fs.Int("limit", 100, "max recent turns to upload (1-100)")
	jsonOut := fs.Bool("json", false, "emit machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose sync-session --session-id <sid> [flags]

Builds the same plaintext session history payload used by relay sync,
uploads it once with this daemon's identity, and prints a sanitized summary.

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	sid := strings.TrimSpace(*sessionID)
	if sid == "" {
		return fmt.Errorf("--session-id is required")
	}
	if *limit < 1 {
		*limit = 1
	}
	if *limit > 100 {
		*limit = 100
	}

	id, err := device.LoadOrCreate(*identityFile, "")
	if err != nil {
		return fmt.Errorf("load identity %s: %w", *identityFile, err)
	}
	baseURL := strings.TrimSpace(*relayURL)
	if baseURL == "" {
		if st, err := relay.LoadState(*relayStateFile); err == nil {
			baseURL = strings.TrimSpace(st.RelayURL)
		}
	}
	if baseURL == "" {
		baseURL = "https://pockly.example"
	}
	baseURL = strings.TrimRight(baseURL, "/")

	idx := index.New(index.Config{ClaudeHome: *claudeHome})
	if err := idx.Refresh(); err != nil {
		return fmt.Errorf("refresh index: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	profile := runner.Detect()
	req, err := relay.BuildSingleSessionWindowSyncRequestContext(ctx, idx, id.DeviceID, sid, profile, relay.SessionWindow{Limit: *limit}, nil)
	if err != nil {
		return fmt.Errorf("build session sync request: %w", err)
	}
	client := pair.NewClient(baseURL)
	res, err := client.SyncHistoryContext(ctx, id, req)
	if err != nil {
		return fmt.Errorf("upload session sync: %w", err)
	}

	summary := summarizeSyncSessionResult(sid, req, res)
	if *jsonOut {
		out, _ := json.MarshalIndent(summary, "", "  ")
		fmt.Println(string(out))
		return nil
	}
	fmt.Printf("Synced session %s to %s\n", sid, baseURL)
	fmt.Printf("  daemon_device: %s\n", summary.DaemonDevice)
	fmt.Printf("  request_turns: %d\n", summary.RequestTurns)
	fmt.Printf("  relay_turns:   %d\n", summary.RelayTurns)
	fmt.Printf("  assistant_text_turns: %d (chars=%d)\n", summary.AssistantTextTurns, summary.AssistantTextChars)
	fmt.Printf("  last_turn: seq=%d kind=%s text_chars=%d timestamp=%s\n",
		summary.LastTurn.Seq, summary.LastTurn.Kind, summary.LastTurn.TextChars, summary.LastTurn.Timestamp)
	return nil
}

type syncSessionSummary struct {
	SessionID          string          `json:"session_id"`
	DaemonDevice       string          `json:"daemon_device"`
	RequestTurns       int             `json:"request_turns"`
	RelayTurns         int             `json:"relay_turns"`
	RelaySessions      int             `json:"relay_sessions"`
	AssistantTextTurns int             `json:"assistant_text_turns"`
	AssistantTextChars int             `json:"assistant_text_chars"`
	LastTurn           syncTurnSummary `json:"last_turn"`
}

type syncTurnSummary struct {
	Seq       int    `json:"seq"`
	Kind      string `json:"kind"`
	Timestamp string `json:"timestamp,omitempty"`
	TextChars int    `json:"text_chars"`
}

func summarizeSyncSessionResult(sessionID string, req pair.SyncRequest, res pair.SyncResponse) syncSessionSummary {
	summary := syncSessionSummary{
		SessionID:     sessionID,
		DaemonDevice:  res.DaemonDevice,
		RequestTurns:  len(req.Turns),
		RelayTurns:    res.TurnCount,
		RelaySessions: res.SessionCount,
	}
	for _, turn := range req.Turns {
		textLen := syncTurnTextLen(turn.Payload)
		if turn.Kind == "assistant_text" {
			summary.AssistantTextTurns++
			summary.AssistantTextChars += textLen
		}
		summary.LastTurn = syncTurnSummary{
			Seq:       turn.Seq,
			Kind:      turn.Kind,
			Timestamp: turn.Timestamp,
			TextChars: textLen,
		}
	}
	return summary
}

func syncTurnTextLen(raw json.RawMessage) int {
	var p struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0
	}
	return len([]rune(p.Text))
}

func runDiagnoseTelemetry(args []string) error {
	fs := flag.NewFlagSet("diagnose telemetry", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	deviceID := fs.String("device-id", "", "device_id to query (defaults to THIS daemon's device_id)")
	sessionID := fs.String("session-id", "", "narrow to one chat session's events (optional)")
	source := fs.String("source", "", "filter to 'daemon' or 'web' events (default: both)")
	since := fs.String("since", "30m", "lookback window, e.g. 10m, 1h, 24h")
	limit := fs.Int("limit", 200, "max rows (server caps at 1000)")
	jsonOut := fs.Bool("json", false, "emit raw JSON response instead of the pretty table")
	identityFile := fs.String("identity-file", "", "path to device.json (default: standard location)")
	relayURL := fs.String("relay-url", "", "override relay URL (default: read from relay-state.json)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose telemetry [flags]

Fetches recent observability events from the relay's telemetry store
(v0.1.38). Self-authenticates as this daemon — works for any device
your account owns.

Examples:
  pockly-daemon diagnose telemetry                          # this daemon, last 30m
  pockly-daemon diagnose telemetry --since 2h               # last 2h
  pockly-daemon diagnose telemetry --session-id <chat-uuid> # one chat
  pockly-daemon diagnose telemetry --device-id dd_OTHER     # another daemon (must be yours)
  pockly-daemon diagnose telemetry --source web --since 1h  # web errors only

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Locate identity file (matches the convention runServe uses —
	// macOS: ~/Library/Application Support/pockly-daemon/device.json,
	// Linux: ~/.config/pockly-daemon/device.json). device.DefaultPath()
	// owns the per-platform pick so we don't drift from runServe.
	idFile := strings.TrimSpace(*identityFile)
	if idFile == "" {
		def, err := device.DefaultPath()
		if err != nil {
			return fmt.Errorf("locate default identity path: %w", err)
		}
		idFile = def
	}
	id, err := device.LoadOrCreate(idFile, "")
	if err != nil {
		return fmt.Errorf("load identity %s: %w", idFile, err)
	}

	// Resolve relay URL: CLI override → relay-state.json → default.
	baseURL := strings.TrimSpace(*relayURL)
	if baseURL == "" {
		// relay-state.json lives next to device.json by convention.
		statePath := filepath.Join(filepath.Dir(idFile), "..", "Application Support", "pockly-daemon", "relay-state.json")
		// macOS variant: ~/Library/Application Support/pockly-daemon/relay-state.json
		if home, err := os.UserHomeDir(); err == nil {
			candidates := []string{
				filepath.Join(home, "Library", "Application Support", "pockly-daemon", "relay-state.json"),
				filepath.Join(home, ".local", "share", "pockly-daemon", "relay-state.json"),
				statePath,
			}
			for _, p := range candidates {
				if st, err := relay.LoadState(p); err == nil && strings.TrimSpace(st.RelayURL) != "" {
					baseURL = st.RelayURL
					break
				}
			}
		}
	}
	if baseURL == "" {
		baseURL = "https://pockly.example"
	}
	baseURL = strings.TrimRight(baseURL, "/")

	// Default device-id = THIS daemon's id. The endpoint's ownership
	// check enforces same-user; querying a peer device requires
	// explicitly passing its device_id.
	target := strings.TrimSpace(*deviceID)
	if target == "" {
		target = id.DeviceID
	}

	// Mint a bearer via challenge/response using this daemon's keypair.
	// audience=daemonWS — what relay's accepted-audience list expects
	// for daemon-flavored requests (matches the catalog sync path).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client := pair.NewClient(baseURL)
	token, err := client.AuthenticateIdentityContext(ctx, id, "daemon-ws")
	if err != nil {
		return fmt.Errorf("authenticate to %s: %w", baseURL, err)
	}

	// Compose query.
	q := url.Values{}
	q.Set("device_id", target)
	if s := strings.TrimSpace(*sessionID); s != "" {
		q.Set("session_id", s)
	}
	if s := strings.TrimSpace(*source); s != "" {
		q.Set("source", s)
	}
	if s := strings.TrimSpace(*since); s != "" {
		q.Set("since", s)
	}
	q.Set("limit", fmt.Sprintf("%d", *limit))

	reqURL := baseURL + "/api/dev/telemetry/recent?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	hc := &http.Client{Timeout: 15 * time.Second}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", reqURL, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("relay returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	if *jsonOut {
		// Pretty-print for jq pipelines.
		var pretty any
		if err := json.Unmarshal(body, &pretty); err == nil {
			out, _ := json.MarshalIndent(pretty, "", "  ")
			fmt.Println(string(out))
			return nil
		}
		// Fallback: raw body if JSON parse failed.
		fmt.Println(string(body))
		return nil
	}

	// Default: human-readable table.
	var payload struct {
		Events []map[string]any `json:"events"`
		Count  int              `json:"count"`
		Query  map[string]any   `json:"query"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return fmt.Errorf("parse response: %w", err)
	}
	return renderTelemetryTable(payload.Events, payload.Count, payload.Query, target)
}

// renderTelemetryTable prints events newest-first as time | source |
// name | status | details. Lower-tech than a real ASCII table package
// — we keep external deps light. Width is heuristic; long error_codes
// wrap to the next column rather than truncating (the whole point of
// this tool is to SEE the error).
func renderTelemetryTable(events []map[string]any, count int, query map[string]any, target string) error {
	fmt.Printf("Telemetry for device=%s  query=%v\n", target, query)
	fmt.Printf("Returned %d events (newest first):\n\n", count)
	if len(events) == 0 {
		fmt.Println("  (no events in this window)")
		fmt.Println("\nIf you expected events:")
		fmt.Println("  - confirm the daemon is on v0.1.37+ (telemetry events added then)")
		fmt.Println("  - try a wider --since window (default 30m)")
		fmt.Println("  - check the device_id is correct and yours")
		return nil
	}
	for _, e := range events {
		tsMS, _ := e["ts"].(float64)
		ts := time.UnixMilli(int64(tsMS)).Local().Format("15:04:05.000")
		source, _ := e["source"].(string)
		name, _ := e["name"].(string)
		status, _ := e["status"].(string)
		statusTag := ""
		switch status {
		case "ok":
			statusTag = "✓"
		case "error":
			statusTag = "✗"
		default:
			statusTag = "·"
		}
		details := []string{}
		for _, k := range []string{"command", "error_code", "session_id", "page_path", "duration_ms"} {
			if v, ok := e[k]; ok {
				switch x := v.(type) {
				case string:
					if x != "" {
						details = append(details, k+"="+x)
					}
				case float64:
					if x != 0 {
						details = append(details, fmt.Sprintf("%s=%.0f", k, x))
					}
				}
			}
		}
		fmt.Printf("  %s  %-6s  %s %-26s %s\n", ts, source, statusTag, name, strings.Join(details, "  "))
	}
	return nil
}
