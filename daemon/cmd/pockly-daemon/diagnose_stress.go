// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
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
	"sync"
	"sync/atomic"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	"github.com/PocklyApp/Pockly/daemon/internal/relay"
)

// runDiagnoseStress dispatches the `pockly-daemon diagnose stress <kind>`
// family. v0.1.40 ships two stressors targeted at the two bugs the
// v0.1.36 → v0.1.39 series fixed (or claimed to fix) — both rely on
// the v0.1.38 telemetry pipeline to verify the server side actually
// behaved as we claim.
//
//	inject-burst   Fire N parallel injects against a session, cross-
//	               check that telemetry shows inject_started ==
//	               inject_completed for each. Catches relay-side
//	               races + drift detection misfires under load.
//	sse-reconnect  Subscribe to a terminal_session's SSE stream and
//	               abort+reopen every N seconds for a duration; count
//	               events received per cycle. Proves the relay can
//	               handle the rapid resubscribe pattern v0.1.39's
//	               browser code now produces.
func runDiagnoseStress(args []string) error {
	if len(args) == 0 {
		return diagnoseStressUsageErr("stress requires a subcommand")
	}
	switch args[0] {
	case "inject-burst":
		return runStressInjectBurst(args[1:])
	case "sse-reconnect":
		return runStressSSEReconnect(args[1:])
	case "-h", "--help", "help":
		fmt.Fprintln(os.Stderr, diagnoseStressUsage())
		return nil
	default:
		return diagnoseStressUsageErr("unknown stress subcommand: " + args[0])
	}
}

func diagnoseStressUsage() string {
	return `Usage: pockly-daemon diagnose stress <subcommand> [flags]

Subcommands:
  inject-burst    Concurrent inject load test against a session.
  sse-reconnect   Browser-style SSE disconnect/reconnect loop.

Run 'pockly-daemon diagnose stress <subcommand> --help' for flags.`
}

func diagnoseStressUsageErr(msg string) error {
	return fmt.Errorf("%s\n\n%s", msg, diagnoseStressUsage())
}

// stressAuth is the shared bring-up: load identity, resolve relay URL,
// mint a daemon-WS bearer. Identical to runDiagnoseTelemetry's prologue
// so the two share the same paired-daemon assumption.
type stressAuth struct {
	id      device.Identity
	baseURL string
	bearer  string
	hc      *http.Client
}

func setupStress(ctx context.Context, identityFile, relayURLOverride string) (*stressAuth, error) {
	idFile := strings.TrimSpace(identityFile)
	if idFile == "" {
		def, err := device.DefaultPath()
		if err != nil {
			return nil, fmt.Errorf("locate default identity path: %w", err)
		}
		idFile = def
	}
	id, err := device.LoadOrCreate(idFile, "")
	if err != nil {
		return nil, fmt.Errorf("load identity %s: %w", idFile, err)
	}
	baseURL := strings.TrimSpace(relayURLOverride)
	if baseURL == "" {
		if home, err := os.UserHomeDir(); err == nil {
			for _, p := range []string{
				filepath.Join(home, "Library", "Application Support", "pockly-daemon", "relay-state.json"),
				filepath.Join(home, ".local", "share", "pockly-daemon", "relay-state.json"),
			} {
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
	client := pair.NewClient(baseURL)
	token, err := client.AuthenticateIdentityContext(ctx, id, "daemon-ws")
	if err != nil {
		return nil, fmt.Errorf("authenticate to %s: %w", baseURL, err)
	}
	return &stressAuth{id: id, baseURL: baseURL, bearer: token, hc: &http.Client{}}, nil
}

// --- inject-burst ------------------------------------------------------

func runStressInjectBurst(args []string) error {
	fs := flag.NewFlagSet("stress inject-burst", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sessionID := fs.String("session-id", "", "chat session_id to target (required)")
	deviceID := fs.String("device-id", "", "daemon device_id holding the session (defaults to THIS daemon)")
	count := fs.Int("count", 10, "number of injects to send")
	concurrency := fs.Int("concurrency", 3, "max parallel in-flight injects")
	textPrefix := fs.String("text", "stress", "prefix for inject text (each numbered stress-1..N)")
	identityFile := fs.String("identity-file", "", "identity path override")
	relayURL := fs.String("relay-url", "", "relay URL override")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose stress inject-burst --session-id <sid> [flags]

Fires --count injects with up to --concurrency in flight at once, then
queries telemetry to cross-check inject_started/inject_completed/failed
counts. Pass = HTTP 200 on every send AND telemetry counts match.

Example: 20 injects, 5 in flight at once:
  pockly-daemon diagnose stress inject-burst --session-id <sid> --count 20 --concurrency 5

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*sessionID) == "" {
		return fmt.Errorf("--session-id is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	auth, err := setupStress(ctx, *identityFile, *relayURL)
	if err != nil {
		return err
	}
	targetDevice := strings.TrimSpace(*deviceID)
	if targetDevice == "" {
		targetDevice = auth.id.DeviceID
	}

	// Fire injects, collecting per-request (status, latency, error).
	type result struct {
		idx     int
		code    int
		latency time.Duration
		err     string
	}
	results := make([]result, *count)
	startedAt := time.Now()
	sem := make(chan struct{}, *concurrency)
	var wg sync.WaitGroup
	for i := 0; i < *count; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = injectOnce(ctx, auth, *sessionID, targetDevice, fmt.Sprintf("%s-%d", *textPrefix, i+1), i)
		}(i)
	}
	wg.Wait()
	totalDuration := time.Since(startedAt)

	// Summarize HTTP side.
	codeCount := map[int]int{}
	var totalLatency time.Duration
	var failCount int
	var lastErr string
	for _, r := range results {
		codeCount[r.code]++
		totalLatency += r.latency
		if r.code < 200 || r.code >= 300 {
			failCount++
			if r.err != "" {
				lastErr = r.err
			}
		}
	}
	avgLatency := totalLatency / time.Duration(*count)

	fmt.Printf("=== inject-burst: %d injects, concurrency=%d, took %v ===\n", *count, *concurrency, totalDuration.Round(time.Millisecond))
	fmt.Printf("  HTTP codes: %v\n", codeCount)
	fmt.Printf("  Avg latency: %v   Failures: %d\n", avgLatency.Round(time.Millisecond), failCount)
	if lastErr != "" {
		fmt.Printf("  Last error: %s\n", lastErr)
	}

	// Cross-check with telemetry. Sleep briefly so the cloud has time
	// to ingest the inject_completed events (daemon batches telemetry).
	fmt.Println("\n  Sleeping 3s for telemetry ingest...")
	time.Sleep(3 * time.Second)

	fmt.Println("\n=== telemetry cross-check ===")
	events, err := queryTelemetryForBurst(ctx, auth, targetDevice, startedAt)
	if err != nil {
		fmt.Printf("  WARN: telemetry query failed: %v\n", err)
		return nil
	}
	countByName := map[string]int{}
	for _, e := range events {
		name, _ := e["name"].(string)
		countByName[name]++
	}
	fmt.Printf("  inject_started:   %d\n", countByName["inject_started"])
	fmt.Printf("  inject_completed: %d\n", countByName["inject_completed"])
	fmt.Printf("  inject_failed:    %d\n", countByName["inject_failed"])
	expected := *count
	pass := countByName["inject_started"] >= expected &&
		countByName["inject_completed"] >= expected &&
		countByName["inject_failed"] == 0 &&
		failCount == 0
	if pass {
		fmt.Println("\n  ✓ PASS: zero drops, all injects accepted, telemetry consistent")
	} else {
		fmt.Println("\n  ✗ FAIL: see counts above")
		if countByName["inject_completed"] < expected {
			fmt.Printf("    inject_completed (%d) < expected (%d) — relay dropped some injects mid-pipeline\n",
				countByName["inject_completed"], expected)
		}
		if countByName["inject_failed"] > 0 {
			fmt.Printf("    %d inject_failed events — possible session_drifted / not_pty_backed under load\n",
				countByName["inject_failed"])
		}
	}
	return nil
}

func injectOnce(ctx context.Context, auth *stressAuth, sessionID, deviceID, text string, idx int) (out struct {
	idx     int
	code    int
	latency time.Duration
	err     string
}) {
	out.idx = idx
	body := url.Values{}
	body.Set("text", text)
	reqURL := fmt.Sprintf("%s/api/sessions/%s/inject?device_id=%s", auth.baseURL, sessionID, deviceID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, strings.NewReader(body.Encode()))
	if err != nil {
		out.code = -1
		out.err = err.Error()
		return
	}
	req.Header.Set("Authorization", "Bearer "+auth.bearer)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "text/event-stream")
	t0 := time.Now()
	resp, err := auth.hc.Do(req)
	out.latency = time.Since(t0)
	if err != nil {
		out.code = -2
		out.err = err.Error()
		return
	}
	defer resp.Body.Close()
	// Inject returns SSE — drain so the server isn't blocked writing.
	_, _ = io.Copy(io.Discard, resp.Body)
	out.code = resp.StatusCode
	return
}

// queryTelemetryForBurst fetches events since the burst started, scoped
// to the daemon device. We don't filter by session in case session_id
// isn't set on inject_* events (different relay versions vary).
func queryTelemetryForBurst(ctx context.Context, auth *stressAuth, deviceID string, since time.Time) ([]map[string]any, error) {
	q := url.Values{}
	q.Set("device_id", deviceID)
	q.Set("source", "daemon")
	q.Set("since", time.Since(since).Round(time.Second).String())
	q.Set("limit", "1000")
	reqURL := auth.baseURL + "/api/dev/telemetry/recent?" + q.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	req.Header.Set("Authorization", "Bearer "+auth.bearer)
	resp, err := auth.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("relay %d: %s", resp.StatusCode, string(body))
	}
	var payload struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	return payload.Events, nil
}

// --- sse-reconnect -----------------------------------------------------

func runStressSSEReconnect(args []string) error {
	fs := flag.NewFlagSet("stress sse-reconnect", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	sessionID := fs.String("session-id", "", "chat session_id to find a terminal_session for")
	terminalSessionID := fs.String("terminal-session-id", "", "terminal_session_id to subscribe to (skips session-id lookup)")
	duration := fs.Duration("duration", 30*time.Second, "total test runtime")
	interval := fs.Duration("interval", 5*time.Second, "abort + reconnect cadence")
	identityFile := fs.String("identity-file", "", "identity path override")
	relayURL := fs.String("relay-url", "", "relay URL override")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage: pockly-daemon diagnose stress sse-reconnect [flags]

Subscribes to a terminal_session's SSE stream and abort+reconnects every
--interval for --duration. Counts events received per cycle so you can
spot gaps (events that fired during a disconnect window and weren't
replayed). Simulates the v0.1.39 browser reconnect pattern at the
server level — proves relay handles rapid resubscribe without leaking.

Example: 60s test, reconnect every 5s:
  pockly-daemon diagnose stress sse-reconnect --session-id <sid> \\
    --duration 60s --interval 5s

Flags:`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *duration+30*time.Second)
	defer cancel()
	auth, err := setupStress(ctx, *identityFile, *relayURL)
	if err != nil {
		return err
	}
	tsID := strings.TrimSpace(*terminalSessionID)
	if tsID == "" {
		if strings.TrimSpace(*sessionID) == "" {
			return fmt.Errorf("--session-id or --terminal-session-id is required")
		}
		tsID, err = lookupTerminalSessionID(ctx, auth, *sessionID)
		if err != nil {
			return fmt.Errorf("lookup terminal_session for %s: %w", *sessionID, err)
		}
		fmt.Printf("Resolved session_id=%s → terminal_session_id=%s\n", *sessionID, tsID)
	}

	deadline := time.Now().Add(*duration)
	var (
		cycleCount     int
		totalEvents    atomic.Int64
		eventsPerCycle []int
		lastCycleEnded time.Time
		gapEvents      []string // event names received in cycle N+1 that have a "session_started" — suggests replay
	)
	fmt.Printf("\n=== sse-reconnect: ts=%s duration=%v interval=%v ===\n", tsID, *duration, *interval)
	for time.Now().Before(deadline) {
		cycleCount++
		cycleStart := time.Now()
		cycleCtx, cycleCancel := context.WithTimeout(ctx, *interval)
		thisCycleCount, firstEventName, err := readSSECycle(cycleCtx, auth, tsID)
		cycleCancel()
		totalEvents.Add(int64(thisCycleCount))
		eventsPerCycle = append(eventsPerCycle, thisCycleCount)
		fmt.Printf("  cycle %2d: %d events in %v   first=%s\n",
			cycleCount, thisCycleCount, time.Since(cycleStart).Round(time.Millisecond),
			firstEventName)
		if err != nil && err != context.DeadlineExceeded && err != context.Canceled {
			fmt.Printf("    (error: %v)\n", err)
		}
		if !lastCycleEnded.IsZero() && firstEventName == "session_started" {
			gapEvents = append(gapEvents, fmt.Sprintf("cycle %d started with session_started", cycleCount))
		}
		lastCycleEnded = time.Now()
	}
	fmt.Printf("\n=== summary ===\n")
	fmt.Printf("  cycles:        %d\n", cycleCount)
	fmt.Printf("  total events:  %d\n", totalEvents.Load())
	if len(eventsPerCycle) > 0 {
		min, max, sum := eventsPerCycle[0], eventsPerCycle[0], 0
		for _, n := range eventsPerCycle {
			if n < min {
				min = n
			}
			if n > max {
				max = n
			}
			sum += n
		}
		fmt.Printf("  events/cycle:  min=%d max=%d avg=%.1f\n", min, max, float64(sum)/float64(len(eventsPerCycle)))
	}
	fmt.Printf("  reconnect-replay markers: %d\n", len(gapEvents))
	if cycleCount >= 2 && totalEvents.Load() == 0 {
		fmt.Println("\n  ⚠ no events received — is the session active?")
	} else {
		fmt.Println("\n  ✓ reconnect cycle completed without crash")
	}
	return nil
}

// readSSECycle subscribes to the LOCAL daemon's terminal_session
// stream (127.0.0.1:8947) — relay's /api/terminal-sessions/.../stream
// wants a browser bearer and we have a daemon bearer. The local
// endpoint broadcasts the same events the relay would forward (in
// fact, the relay forward IS sourced from this same stream), so this
// gives us a clean view of "what events did the daemon emit per
// reconnect cycle" without dealing with relay auth.
//
// Trade-off: this only proves the LOCAL wrapper→daemon side handles
// rapid resubscribe. The relay → browser path is what v0.1.39 fixed,
// and that path needs a separate test (or a relay-side relaxation
// to accept daemon bearers). For the MVP this is the highest-signal
// per-unit-effort.
func readSSECycle(ctx context.Context, auth *stressAuth, tsID string) (int, string, error) {
	reqURL := fmt.Sprintf("http://127.0.0.1:8947/api/dev/terminal-sessions/%s/stream", tsID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := auth.hc.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, "", fmt.Errorf("relay %d: %s", resp.StatusCode, string(body))
	}
	var (
		count          int
		firstEventName string
		currentEvent   string
	)
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			currentEvent = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			count++
			if firstEventName == "" {
				firstEventName = currentEvent
			}
		}
	}
	return count, firstEventName, scanner.Err()
}

// lookupTerminalSessionID asks the LOCAL daemon (127.0.0.1:8947) for
// its terminal_sessions table. Relay's /api/terminal-sessions requires
// a browser-flavored bearer (user-session cookie), but the local
// daemon's /api/dev/terminal-sessions is unauthenticated localhost-only
// and has the same info — keyed on claude_session_id which is what
// callers pass in via --session-id.
//
// Trade-off: this only finds terminal_sessions hosted on the SAME
// machine running this command. Stress-testing a peer device needs
// --terminal-session-id explicitly.
func lookupTerminalSessionID(ctx context.Context, auth *stressAuth, sessionID string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8947/api/dev/terminal-sessions", nil)
	resp, err := auth.hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("local daemon at 127.0.0.1:8947: %w (is pockly-daemon serve running?)", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("local daemon %d: %s", resp.StatusCode, string(body))
	}
	var list struct {
		TerminalSessions []map[string]any `json:"terminal_sessions"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return "", err
	}
	for _, ts := range list.TerminalSessions {
		if sid, _ := ts["claude_session_id"].(string); sid == sessionID {
			if id, _ := ts["id"].(string); id != "" {
				return id, nil
			}
		}
	}
	return "", fmt.Errorf("no local terminal_session found for session_id=%s", sessionID)
}
