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
// subcommand family:
//
//	pockly-daemon diagnose telemetry [--device-id X] [--session-id Y]
//	                                 [--source daemon|web] [--since 10m]
//	                                 [--limit 200] [--json]
//
// Self-authenticates via the daemon's device identity (the same
// keypair used for catalog sync) so no browser bearer is needed.
// Open-source Nexus does not include a diagnostics store; the
// telemetry command requires a provider-specific query URL.
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
		// Load tests; optional diagnostics cross-checks require a provider.
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
  telemetry      Fetch recent diagnostics events from a configured provider.
  sync-session   Force-upload one local session's turns to Nexus.
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
	claudeHome := pathFlag(fs, "claude-home", defaultClaudeHome, "Claude Code session home")
	identityFile := pathFlag(fs, "identity-file", identityPath, "path to device.json")
	relayStateFile := pathFlag(fs, "relay-state-file", defaultRelayStatePath, "legacy Nexus pairing state file path")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	nexusURL := fs.String("nexus-url", "", "override Nexus URL (default: read from pairing state)")
	limit := fs.Int("limit", 100, "max recent turns to upload (1-100)")
	jsonOut := fs.Bool("json", false, "emit machine-readable JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose sync-session --session-id <sid> [flags]

Builds the same session history payload used by Nexus sync,
uploads it once with this daemon's identity, and prints a sanitized summary.

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	*relayURL = firstNonEmptyString(*nexusURL, *relayURL)
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
		baseURL = defaultNexusURL()
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
	fmt.Printf("  nexus_turns:   %d\n", summary.NexusTurns)
	fmt.Printf("  assistant_text_turns: %d (chars=%d)\n", summary.AssistantTextTurns, summary.AssistantTextChars)
	fmt.Printf("  last_turn: seq=%d kind=%s text_chars=%d timestamp=%s\n",
		summary.LastTurn.Seq, summary.LastTurn.Kind, summary.LastTurn.TextChars, summary.LastTurn.Timestamp)
	return nil
}

type syncSessionSummary struct {
	SessionID          string          `json:"session_id"`
	DaemonDevice       string          `json:"daemon_device"`
	RequestTurns       int             `json:"request_turns"`
	NexusTurns         int             `json:"nexus_turns"`
	NexusSessions      int             `json:"nexus_sessions"`
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
		NexusTurns:    res.TurnCount,
		NexusSessions: res.SessionCount,
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
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	nexusURL := fs.String("nexus-url", "", "override Nexus URL (default: read from pairing state)")
	queryURL := fs.String("query-url", os.Getenv("POCKLY_DIAGNOSTICS_QUERY_URL"), "self-hosted diagnostics query endpoint; required because open-source Nexus has no diagnostics store")
	displayEnvBackedDefault(fs, "query-url", "POCKLY_DIAGNOSTICS_QUERY_URL")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose telemetry [flags]

Fetches recent diagnostics events from a self-hosted provider query endpoint.
Open-source Nexus accepts optional diagnostics writes but does not store or
serve telemetry by default, so --query-url or POCKLY_DIAGNOSTICS_QUERY_URL is
required. Self-authenticates as this daemon when querying through Nexus.

Examples:
  POCKLY_DIAGNOSTICS_QUERY_URL=https://your-diagnostics.example/recent \
    pockly-daemon diagnose telemetry --since 2h
  pockly-daemon diagnose telemetry --query-url https://your-diagnostics.example/recent --session-id <chat-uuid>

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	diagnosticsURL := strings.TrimSpace(*queryURL)
	if diagnosticsURL == "" {
		return fmt.Errorf("diagnostics query is not configured; open-source Nexus does not store diagnostics by default, set --query-url or POCKLY_DIAGNOSTICS_QUERY_URL for your self-hosted provider")
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

	// Resolve Nexus URL: CLI override → legacy relay-state.json → default.
	baseURL := strings.TrimSpace(firstNonEmptyString(*nexusURL, *relayURL))
	if baseURL == "" {
		// relay-state.json is the legacy state filename next to device.json.
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
		baseURL = defaultNexusURL()
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
	// audience=daemonWS — what Nexus's accepted-audience list expects
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

	reqURL := appendQuery(diagnosticsURL, q)
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
		return fmt.Errorf("diagnostics provider returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
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
		fmt.Println("  - confirm optional diagnostics are explicitly enabled on this daemon")
		fmt.Println("  - confirm your self-hosted diagnostics provider stores and serves events")
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

func appendQuery(rawURL string, q url.Values) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		sep := "?"
		if strings.Contains(rawURL, "?") {
			sep = "&"
		}
		return rawURL + sep + q.Encode()
	}
	existing := u.Query()
	for key, values := range q {
		for _, value := range values {
			existing.Set(key, value)
		}
	}
	u.RawQuery = existing.Encode()
	return u.String()
}
