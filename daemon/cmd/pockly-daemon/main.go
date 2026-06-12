// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package main is the entry point for the pockly-daemon binary.
//
// pockly-daemon runs on the user's dev machine. It watches Claude Code and
// Codex session jsonl files, exposes them via a local HTTP API, and connects
// outbound to Pockly Nexus over WSS so the user's browser can read history and
// inject prompts back into running agents.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/claude"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/codex"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/codexapp"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/sdkdriver"
	"github.com/PocklyApp/Pockly/daemon/internal/agentexec"
	"github.com/PocklyApp/Pockly/daemon/internal/agentsettings"
	"github.com/PocklyApp/Pockly/daemon/internal/api"
	"github.com/PocklyApp/Pockly/daemon/internal/control"
	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/localsetup"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	relay "github.com/PocklyApp/Pockly/daemon/internal/relay"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
	"github.com/PocklyApp/Pockly/daemon/internal/telemetry"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
	"github.com/gorilla/websocket"
	qrterminal "github.com/mdp/qrterminal/v3"
	"golang.org/x/term"
)

const (
	defaultPocklyNexusURL       = "http://127.0.0.1:8787"
	defaultIndexRefreshInterval = 30 * time.Second
	defaultNexusSyncInterval    = 15 * time.Second
)

func defaultNexusURL() string {
	if v := envNexusURL(); v != "" {
		return v
	}
	return defaultPocklyNexusURL
}

func envNexusURL() string {
	if v := strings.TrimSpace(os.Getenv("POCKLY_NEXUS_URL")); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("POCKLY_RELAY_URL"))
}

func resolveNexusURL(value string) string {
	if v := strings.TrimSpace(value); v != "" {
		return v
	}
	if v := envNexusURL(); v != "" {
		return v
	}
	return defaultPocklyNexusURL
}

func selectedNexusURL(nexusURL, legacyRelayURL string) string {
	return resolveNexusURL(firstNonEmptyString(nexusURL, legacyRelayURL))
}

func optionalNexusURL(nexusURL, legacyRelayURL string) string {
	if v := strings.TrimSpace(firstNonEmptyString(nexusURL, legacyRelayURL)); v != "" {
		return v
	}
	return envNexusURL()
}

func pathFlag(fs *flag.FlagSet, name, defaultPath, usage string) *string {
	value := defaultPath
	pathFlagVar(fs, &value, name, defaultPath, usage)
	return &value
}

func pathFlagVar(fs *flag.FlagSet, target *string, name, defaultPath, usage string) {
	fs.StringVar(target, name, defaultPath, usage)
	if f := fs.Lookup(name); f != nil {
		f.DefValue = displayPathDefault(defaultPath)
	}
}

func displayEnvBackedDefault(fs *flag.FlagSet, name, envName string) {
	if f := fs.Lookup(name); f != nil && strings.TrimSpace(f.DefValue) != "" {
		f.DefValue = "$" + envName
	}
}

func nexusStateFileFlag(fs *flag.FlagSet, defaultPath, usage string) *string {
	value := defaultPath
	pathFlagVar(fs, &value, "nexus-state-file", defaultPath, usage)
	pathFlagVar(fs, &value, "relay-state-file", defaultPath, "legacy alias for --nexus-state-file")
	return &value
}

func displayPathDefault(value string) string {
	if strings.TrimSpace(value) == "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return value
	}
	cleanValue := filepath.Clean(value)
	cleanHome := filepath.Clean(home)
	if samePath(cleanValue, cleanHome) {
		return "~"
	}
	homePrefix := cleanHome + string(filepath.Separator)
	if hasPathPrefix(cleanValue, homePrefix) {
		return "~" + cleanValue[len(cleanHome):]
	}
	return value
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func hasPathPrefix(value, prefix string) bool {
	if runtime.GOOS == "windows" {
		return strings.HasPrefix(strings.ToLower(value), strings.ToLower(prefix))
	}
	return strings.HasPrefix(value, prefix)
}

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `pockly-daemon — Pockly's local agent for your dev machine.

Usage:
    pockly-daemon [flags] <command>

Commands:
    setup       connect this computer to Nexus and install the background service
    serve       run the daemon (watch sessions, connect to Nexus)
    login       log this daemon into a Pockly account
    remote      enable or disable Remote Access for same-account browser access
    pair        create a pairing grant and confirm browser access
    claude-status print local Pockly status for Claude Code
    claude-integrate install, remove, or inspect Claude Code integration
    enable-remote-control  wrap your shell's claude command via the Pockly daemon (opt-in)
    disable-remote-control undo enable-remote-control
    remote-control         inspect remote-control state (subcommands: status)
    debug-pty   run a local attached terminal prototype
    live-attach attach a local terminal to a daemon-owned live Claude session
    live-open-terminal open macOS Terminal.app attached to a live Claude session
    update      check for and install a newer pockly-daemon (alias: upgrade)
    status      print daemon health
    hook-bridge claude PreToolUse hook target (not for direct use; wrapper installs)

Flags:
    --version   print version
`)
	}
	flag.Parse()

	if *showVersion {
		fmt.Println(version.String())
		return
	}

	if flag.NArg() > 0 {
		switch flag.Arg(0) {
		case "setup":
			if err := runSetup(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "serve":
			if err := runServe(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "login":
			if err := runLogin(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "remote":
			if err := runRemote(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "pair":
			if err := runPair(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "claude-status":
			if err := runClaudeStatus(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "claude-integrate":
			if err := runClaudeIntegrate(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "enable-remote-control":
			if err := runEnableRemoteControl(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "disable-remote-control":
			if err := runDisableRemoteControl(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "remote-control":
			if err := runRemoteControl(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "debug-pty":
			if err := runDebugPTY(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "live-attach":
			if err := runLiveAttach(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "live-open-terminal":
			if err := runLiveOpenTerminal(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "update", "upgrade":
			if err := runUpdate(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "diagnose", "debug":
			if err := runDiagnose(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "mcp-permission":
			// Claude permission-prompt-tool server (stdio JSON-RPC).
			// Spawned by Claude Code via --mcp-config; not for direct
			// interactive use.
			if err := runMCPPermission(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "test-scenario":
			// End-to-end scenario runner. Spawns fake-claude
			// under wrapper, drives a specific test pattern, asserts
			// pass/fail via telemetry queries.
			if err := runTestScenario(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		case "hook-bridge":
			// Claude PreToolUse compatibility hook entrypoint. Spawned
			// by Claude as a short-lived process when the wrapper has
			// installed Pockly-owned hook config.
			if err := runHookBridge(flag.Args()[1:]); err != nil {
				exitOnCommandError(err)
			}
			return
		}
	}

	flag.Usage()
	os.Exit(2)
}

func exitOnCommandError(err error) {
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	log.Fatal(err)
}

func runDebugPTY(args []string) error {
	fs := flag.NewFlagSet("debug-pty", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	cwdFlag := fs.String("cwd", "", "working directory for the PTY process")
	commandFlag := fs.String("command", "claude", "command to run inside the PTY")
	promptFlag := fs.String("prompt", "", "optional prompt to submit after startup")
	timeoutFlag := fs.Duration("timeout", 30*time.Second, "maximum time to keep the prototype running")
	readyDelayFlag := fs.Duration("ready-delay", 750*time.Millisecond, "idle delay before considering startup ready")
	promptDelayFlag := fs.Duration("prompt-delay", 1500*time.Millisecond, "idle delay before considering a prompt complete")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cwd := strings.TrimSpace(*cwdFlag)
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	command := strings.TrimSpace(*commandFlag)
	if command == "" {
		return errors.New("command is required")
	}
	if !strings.Contains(command, string(filepath.Separator)) {
		resolved, err := exec.LookPath(command)
		if err != nil {
			return err
		}
		command = resolved
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeoutFlag)
	defer cancel()
	session, err := liveterminal.Start(ctx, liveterminal.LaunchConfig{
		Command:     command,
		Args:        fs.Args(),
		Cwd:         cwd,
		ReadyDelay:  *readyDelayFlag,
		PromptDelay: *promptDelayFlag,
	})
	if err != nil {
		return err
	}
	defer session.Stop()
	promptSent := false
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				return nil
			}
			raw, _ := json.Marshal(event)
			fmt.Println(string(raw))
			if !promptSent && strings.TrimSpace(*promptFlag) != "" && event.Kind == liveterminal.EventSessionReady {
				promptSent = true
				if err := session.SendInput(*promptFlag); err != nil {
					return err
				}
			}
		case <-ctx.Done():
			_ = session.Stop()
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil
			}
			return ctx.Err()
		}
	}
}

func runLiveAttach(args []string) error {
	fs := flag.NewFlagSet("live-attach", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	daemonURL := fs.String("daemon-url", "http://127.0.0.1:8947", "base URL for the local daemon API")
	terminalSessionID := fs.String("terminal-session-id", "", "live terminal session id to attach to")
	latest := fs.Bool("latest", false, "attach to the newest locally managed live terminal session")
	displayMode := fs.String("display", "raw", "attach display mode: raw or transcript")
	if err := fs.Parse(args); err != nil {
		return err
	}
	baseURL := strings.TrimRight(strings.TrimSpace(*daemonURL), "/")
	if *latest {
		resolved, err := latestLocalTerminalSession(baseURL)
		if err != nil {
			return err
		}
		*terminalSessionID = resolved
	}
	if strings.TrimSpace(*terminalSessionID) == "" {
		return errors.New("terminal-session-id is required")
	}
	display := strings.TrimSpace(*displayMode)
	if display == "" {
		display = "raw"
	}
	if display != "raw" && display != "transcript" {
		return errors.New("display must be raw or transcript")
	}
	attachURL, err := localAttachURL(baseURL, *terminalSessionID)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, attachURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	var restore func() error
	if display == "raw" && term.IsTerminal(int(os.Stdin.Fd())) {
		oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
		if err != nil {
			return err
		}
		restore = func() error { return term.Restore(int(os.Stdin.Fd()), oldState) }
		defer restore()
	}

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
	writeMu := sync.Mutex{}
	writeJSON := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(v)
	}
	go func() {
		for {
			var msg attachEnvelope
			if err := conn.ReadJSON(&msg); err != nil {
				errCh <- err
				return
			}
			if msg.Type == "error" {
				errCh <- fmt.Errorf("live attach error: %s", msg.Error)
				return
			}
			if msg.Event == nil {
				continue
			}
			switch msg.Event.Kind {
			case liveterminal.EventUserInput:
				if display == "transcript" {
					fmt.Printf("\nYou> %s\n", strings.TrimSpace(msg.Event.Payload))
				}
			case liveterminal.EventTextDelta:
				if display == "transcript" {
					printTranscriptDelta(msg.Event.Payload)
				} else {
					fmt.Print(msg.Event.Payload)
				}
			case liveterminal.EventPromptReady:
				if display == "transcript" {
					fmt.Print("\n> ")
				}
			case liveterminal.EventError:
				errCh <- fmt.Errorf("live session error: %s", msg.Event.Error)
				return
			case liveterminal.EventSessionExited:
				fmt.Fprintln(os.Stderr, "\r\n[live session exited]")
				errCh <- nil
				return
			}
		}
	}()

	if display == "raw" && term.IsTerminal(int(os.Stdout.Fd())) {
		go watchTerminalResize(ctx, func(cols, rows uint16) {
			_ = writeJSON(attachMessage{Op: "resize", Cols: cols, Rows: rows})
		})
	}

	go func() {
		if display == "transcript" {
			scanner := bufio.NewScanner(os.Stdin)
			fmt.Print("> ")
			for scanner.Scan() {
				text := strings.TrimSpace(scanner.Text())
				if text == "" {
					fmt.Print("> ")
					continue
				}
				if err := writeJSON(attachMessage{Op: "submit", Data: text}); err != nil {
					errCh <- err
					return
				}
			}
			if err := scanner.Err(); err != nil {
				errCh <- err
			} else {
				errCh <- nil
			}
			return
		}
		buf := make([]byte, 1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if err := writeJSON(attachMessage{Op: "input", Data: string(buf[:n])}); err != nil {
					errCh <- err
					return
				}
			}
			if err != nil {
				if errors.Is(err, os.ErrClosed) {
					errCh <- nil
				} else {
					errCh <- err
				}
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		return err
	}
}

func printTranscriptDelta(payload string) {
	cleaned := compactTranscriptText(payload)
	if strings.TrimSpace(cleaned) == "" {
		return
	}
	fmt.Print(cleaned)
	if !strings.HasSuffix(cleaned, "\n") {
		fmt.Println()
	}
}

func compactTranscriptText(payload string) string {
	text := liveterminal.CleanOutput(payload)
	lines := strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || isTransientTUILine(line) {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func isTransientTUILine(line string) bool {
	if strings.Trim(line, "─━═-_*·. │┃┄┅┈┉✻✽✶✳✢") == "" {
		return true
	}
	if strings.HasPrefix(line, "✻") || strings.HasPrefix(line, "✽") || strings.HasPrefix(line, "✶") || strings.HasPrefix(line, "✳") || strings.HasPrefix(line, "✢") {
		return true
	}
	if _, err := strconv.Atoi(line); err == nil {
		return true
	}
	transientMarkers := []string{
		"esctointerrupt",
		"escto",
		"interrupt",
		"esc to interrupt",
		"?forshortcuts",
		"? for shortcuts",
		"←foragents",
		"← for agents",
		"thinking",
		"tokens",
		"thought for",
		"ought for",
		"cogitated",
		"cgitated",
		"drizzling",
		"hashing",
		"bewed",
		"sautéed",
		"boogieing",
		"actualizing",
		"brewed",
		"tip:",
	}
	lower := strings.ReplaceAll(strings.ToLower(line), " ", "")
	for _, marker := range transientMarkers {
		if strings.Contains(lower, strings.ReplaceAll(marker, " ", "")) {
			return true
		}
	}
	if strings.HasPrefix(line, "❯") || strings.HasPrefix(line, "⎿") {
		return true
	}
	return false
}

func localAttachURL(baseURL, terminalSessionID string) (string, error) {
	u, err := url.Parse(strings.TrimRight(baseURL, "/") + "/api/dev/terminal-sessions/" + terminalSessionID + "/attach")
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported daemon scheme %q", u.Scheme)
	}
	return u.String(), nil
}

func latestLocalTerminalSession(baseURL string) (string, error) {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "http://127.0.0.1:8947"
	}
	u := strings.TrimRight(baseURL, "/") + "/api/dev/terminal-sessions"
	resp, err := http.Get(u)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("list terminal sessions failed: %s", resp.Status)
	}
	var payload struct {
		TerminalSessions []struct {
			ID            string    `json:"id"`
			SessionStatus string    `json:"session_status"`
			CreatedAt     time.Time `json:"created_at"`
		} `json:"terminal_sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	sort.Slice(payload.TerminalSessions, func(i, j int) bool {
		return payload.TerminalSessions[i].CreatedAt.After(payload.TerminalSessions[j].CreatedAt)
	})
	for _, session := range payload.TerminalSessions {
		if session.ID == "" {
			continue
		}
		if session.SessionStatus == "" || session.SessionStatus == string(liveterminal.SessionLive) || session.SessionStatus == string(liveterminal.SessionStarting) {
			return session.ID, nil
		}
	}
	return "", errors.New("no live terminal session found")
}

func runLiveOpenTerminal(args []string) error {
	fs := flag.NewFlagSet("live-open-terminal", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	daemonURL := fs.String("daemon-url", "http://127.0.0.1:8947", "base URL for the local daemon API")
	terminalSessionID := fs.String("terminal-session-id", "", "live terminal session id to attach to")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*terminalSessionID) == "" {
		return errors.New("terminal-session-id is required")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("live-open-terminal is only supported on macOS")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := liveAttachCommand(exe, strings.TrimSpace(*daemonURL), strings.TrimSpace(*terminalSessionID))
	return openMacTerminal(command)
}

func openMacTerminal(command string) error {
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

func liveAttachCommand(exe, daemonURL, terminalSessionID string) string {
	return strings.Join([]string{
		shellQuote(exe),
		"live-attach",
		"--daemon-url", shellQuote(daemonURL),
		"--terminal-session-id", shellQuote(terminalSessionID),
		"--display", "transcript",
	}, " ")
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func watchTerminalResize(ctx context.Context, send func(cols, rows uint16)) {
	sendSize := func() {
		cols, rows, err := term.GetSize(int(os.Stdout.Fd()))
		if err != nil || cols <= 0 || rows <= 0 {
			return
		}
		send(uint16(cols), uint16(rows))
	}
	sendSize()
	sigCh := make(chan os.Signal, 1)
	resizeSignals := terminalResizeSignals()
	if len(resizeSignals) == 0 {
		<-ctx.Done()
		return
	}
	signal.Notify(sigCh, resizeSignals...)
	defer signal.Stop(sigCh)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sigCh:
			sendSize()
		}
	}
}

// wrapperRespawnTracker enforces a "max 3 respawns / hour per session
// id" budget for the wrapper-unclean-exit recovery path. Without this,
// a claude binary that crashes on startup (bad config, OOM, etc.)
// would respawn → crash → respawn forever, burning the user's tokens
// and stuffing Nexus logs.
//
// Sliding window: keep last-hour timestamps per sid; Allow drops
// expired ones and either appends + returns true (proceed) or returns
// false (skip, fire wrapper_recovery_skipped telemetry).
type wrapperRespawnTracker struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newWrapperRespawnTracker() *wrapperRespawnTracker {
	return &wrapperRespawnTracker{attempts: map[string][]time.Time{}}
}

func (t *wrapperRespawnTracker) Allow(sid string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-1 * time.Hour)
	fresh := t.attempts[sid][:0]
	for _, ts := range t.attempts[sid] {
		if ts.After(cutoff) {
			fresh = append(fresh, ts)
		}
	}
	if len(fresh) >= 3 {
		t.attempts[sid] = fresh
		return false
	}
	fresh = append(fresh, now)
	t.attempts[sid] = fresh
	return true
}

func runServe(args []string) (err error) {
	started := time.Now()
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	listen := fs.String("listen", "127.0.0.1:8947", "listen address for the local HTTP API")

	defaultClaudeHome, err := claude.DefaultHome()
	if err != nil {
		return err
	}
	defaultCodexHome, err := codex.DefaultHome()
	if err != nil {
		return err
	}

	claudeHome := pathFlag(fs, "claude-home", defaultClaudeHome, "Claude Code session home")
	codexHome := pathFlag(fs, "codex-home", defaultCodexHome, "Codex session home")
	refreshInterval := fs.Duration("refresh-interval", defaultIndexRefreshInterval, "session index fallback refresh interval")
	var connectNexus bool
	fs.BoolVar(&connectNexus, "connect-nexus", false, "sync indexed history to the paired Nexus")
	fs.BoolVar(&connectNexus, "connect-relay", false, "legacy alias for --connect-nexus")
	nexusURL := fs.String("nexus-url", "", "override Nexus base URL for history sync")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := pathFlag(fs, "identity-file", identityPath, "daemon identity file path")
	defaultRelayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := nexusStateFileFlag(fs, defaultRelayStatePath, "Nexus pairing state file path")
	syncInterval := fs.Duration("sync-interval", defaultNexusSyncInterval, "Nexus sync heartbeat interval")

	if err := fs.Parse(args); err != nil {
		return err
	}
	defer func() {
		baseURL := selectedNexusURL(*nexusURL, *relayURL)
		telemetry.Send(context.Background(), baseURL, device.Identity{}, telemetry.CommandFinished("serve", started, err))
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	profile := runner.Detect()
	effectiveNexusURL := optionalNexusURL(*nexusURL, *relayURL)
	if effectiveNexusURL == "" && connectNexus {
		// Fall back to the URL recorded in the pairing state file so /api/status
		// reports the same target the sync loop will eventually use.
		if data, err := os.ReadFile(*relayStateFile); err == nil {
			var st struct {
				RelayURL string `json:"relay_url"`
			}
			if json.Unmarshal(data, &st) == nil {
				effectiveNexusURL = strings.TrimSpace(st.RelayURL)
			}
		}
	}
	log.Printf("daemon environment: nexus=%s label=%s claude_runner=%s",
		effectiveNexusURL, api.EnvironmentLabel(effectiveNexusURL), profile.ClaudeAlias)

	// Start the update-availability checker. Background goroutine polls the
	// configured release source every 24h; /api/status reads from its snapshot.
	// Never installs anything — that's the `pockly-daemon update` subcommand's
	// job. If no release source is configured, the checker stays silent.
	checker := newUpdateChecker(24 * time.Hour)
	go checker.Run(ctx)

	// Only load an identity for optional diagnostics when telemetry is
	// explicitly enabled. Open-source installs default to local logs only,
	// so serve must not create identity state just for telemetry.
	telemetryID := device.Identity{}
	if telemetry.Enabled() {
		var identityErr error
		telemetryID, identityErr = device.LoadOrCreate(*identityFile, "")
		if identityErr != nil {
			log.Printf("identity load failed (diagnostics will be anonymous): %v", identityErr)
		}
	}

	// wrapperRecoveryRef is the late-binding plumbing that lets the api
	// handler trigger an SDK driver respawn after the wrapper reports an
	// unclean exit. The actual closure (using sdkManager) is set further
	// down inside the Nexus-control block where sdkManager exists.
	// Until then, the hook is a no-op so api.Config can be constructed
	// independent of the Nexus-control branch.
	var (
		wrapperRecoveryMu sync.Mutex
		wrapperRecoveryFn func(claudeSID, cwd, agent string)
	)
	wrapperRespawnTracker := newWrapperRespawnTracker()

	cfg := api.Config{
		ClaudeHome:      *claudeHome,
		CodexHome:       *codexHome,
		RefreshInterval: *refreshInterval,
		RelayURL:        effectiveNexusURL,
		Profile:         profile,
		UpdateStatus:    checker.Snapshot,
		// Optional diagnostic hook. telemetry.Send no-ops unless the
		// operator explicitly enabled network telemetry, so open-source
		// installs remain local-log-only by default.
		ReportTelemetry: func(name, command, status, errorCode, sessionID string) {
			telemetry.Send(context.Background(), effectiveNexusURL, telemetryID, telemetry.Event{
				Name: name, Command: command, Status: status, ErrorCode: errorCode, SessionID: sessionID,
			})
		},
		// Wrapper-unclean-exit recovery: api handler invokes this, we
		// dispatch to wrapperRecoveryFn under a mutex (the fn itself is
		// late-bound when sdkManager comes up below). Loop guard +
		// SDK spawn live in the late-bound closure.
		OnWrapperUnexpectedExit: func(claudeSID, cwd, agent string) {
			wrapperRecoveryMu.Lock()
			fn := wrapperRecoveryFn
			wrapperRecoveryMu.Unlock()
			if fn == nil {
				return
			}
			if !wrapperRespawnTracker.Allow(claudeSID) {
				log.Printf("wrapper-recovery skipped sid=%s: loop guard (>3 attempts in last hour)", claudeSID)
				telemetry.Send(context.Background(), effectiveNexusURL, telemetryID, telemetry.Event{
					Name: "wrapper_recovery_skipped", Command: "exit-intent", Status: "ok",
					ErrorCode: "loop_guard", SessionID: claudeSID,
				})
				return
			}
			fn(claudeSID, cwd, agent)
		},
	}
	terminalManager := liveterminal.NewManager()
	cfg.TerminalManager = terminalManager
	// In-memory permission-request broker for the Claude permission
	// bridge. Pockly does not persist allow rules or make policy
	// decisions; it only forwards a live Claude prompt to the Web and
	// returns the user's allow/deny choice.
	permissionStore := permission.New()
	cfg.PermissionStore = permissionStore
	// agentsettings.Store tracks the composer-pills surface (model /
	// permission_mode / effort) per terminal_session_id. The store is
	// updated from two directions: the wrapper's permission-mode meta
	// events feed Observe (so the pill reflects /permission-mode or
	// Shift+Tab pressed in the user's own terminal), and explicit web
	// "set" requests feed Apply via the control WS handler below.
	agentSettingsStore := agentsettings.New()
	cfg.AgentSettings = agentSettingsStore
	externalTerminalEvents := make(chan control.TerminalEvent, 256)
	cfg.TerminalEventSink = func(evt api.DevTerminalEvent) {
		// Latch the wrapper's discovered Claude session_id + cwd onto the
		// in-memory ExternalSession so the control loop can reverse-lookup
		// it for inject (PTY fast-path).
		if evt.SessionID != "" || evt.Cwd != "" {
			if ext, ok := terminalManager.GetExternal(evt.TerminalSessionID); ok {
				ext.BindSessionMetadata(evt.SessionID, evt.Cwd)
			}
		}
		// Feed permission-mode meta events into the agent-settings
		// store so the pill stays in sync when the user changes mode
		// from their own terminal (Shift+Tab in TUI). The store only
		// trusts payloads matching the known mode set, so non-mode
		// meta events (queue-operation etc.) are filtered out inside.
		agentSettingsStore.Observe(evt.TerminalSessionID, string(evt.Kind), evt.Payload)
		select {
		case externalTerminalEvents <- control.TerminalEvent{
			TerminalSessionID: evt.TerminalSessionID,
			Kind:              string(evt.Kind),
			SessionStatus:     string(evt.SessionStatus),
			TurnStatus:        string(evt.TurnStatus),
			Payload:           evt.Payload,
			Error:             evt.Error,
			Timestamp:         evt.Timestamp,
			SessionID:         evt.SessionID,
			Agent:             defaultAgent(evt.Agent),
			Cwd:               evt.Cwd,
		}:
		default:
		}
	}
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				for _, stale := range terminalManager.ReapStalePTYExternal(35*time.Second, now.UTC()) {
					log.Printf("terminal session stale; marking exited: terminal_session_id=%s session_id=%s last_activity=%s",
						stale.ID, stale.ClaudeSessionID, stale.LastActivity.Format(time.RFC3339))
					select {
					case externalTerminalEvents <- control.TerminalEvent{
						TerminalSessionID: stale.ID,
						Kind:              string(liveterminal.EventSessionExited),
						SessionStatus:     string(liveterminal.SessionExited),
						TurnStatus:        string(liveterminal.TurnIdle),
						SessionID:         stale.ClaudeSessionID,
						Agent:             "claude-code",
						Cwd:               stale.Cwd,
						Timestamp:         now.UTC(),
						Driver:            "pty",
					}:
					default:
					}
				}
			}
		}
	}()
	idx := api.StartBackgroundRefresh(ctx, cfg)
	handler := api.NewHandlerWithIndex(cfg, idx)
	srv := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("pockly-daemon local API listening on http://%s", *listen)
	log.Printf("claude home: %s", *claudeHome)
	log.Printf("codex home:  %s", *codexHome)
	log.Printf("refresh interval: %s", refreshInterval.String())
	if connectNexus {
		log.Printf("Nexus sync enabled; state file: %s", *relayStateFile)
		id, err := device.LoadOrCreate(*identityFile, "")
		if err != nil {
			return err
		}
		state, err := relay.LoadState(*relayStateFile)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				log.Printf("Nexus sync skipped: no pairing state at %s", *relayStateFile)
			} else {
				return err
			}
		} else {
			baseURL := optionalNexusURL(*nexusURL, *relayURL)
			if baseURL == "" {
				baseURL = state.RelayURL
			}
			if baseURL == "" {
				log.Printf("Nexus sync skipped: Nexus URL missing")
			} else if state.DaemonDeviceID != "" && state.DaemonDeviceID != id.DeviceID {
				log.Printf("Nexus sync skipped: pairing state device_id %s does not match local identity %s", state.DaemonDeviceID, id.DeviceID)
			} else {
				if state.RemoteAccess {
					if _, err := pair.NewClient(baseURL).SetRemoteAccess(id, true); err != nil {
						log.Printf("remote access heartbeat failed: %v", err)
					}
				}
				pushedHints := newPushedHintStore()
				go startNexusSyncLoop(ctx, pair.NewClient(baseURL), id, idx, *syncInterval, profile, pushedHints)
				// updateHandler bridges incoming control-WS update_request
				// messages from Nexus to the local PerformUpdate
				// function. We define it here so main has cmd-package
				// access; control.go gets a clean callback that doesn't
				// know about CLI layout details.
				updateHandler := func(req control.UpdateRequest) control.UpdateEvent {
					log.Printf("remote update_request request_id=%s to_version=%s", req.RequestID, req.ToVersion)
					result, err := PerformUpdate(PerformUpdateOptions{
						TargetVersion: req.ToVersion,
						Restart:       true,
					})
					evt := control.UpdateEvent{
						RequestID:       req.RequestID,
						PreviousVersion: result.PreviousVersion,
						NewVersion:      result.NewVersion,
					}
					switch {
					case err != nil:
						evt.Status = "failed"
						evt.Error = err.Error()
						log.Printf("remote update failed request_id=%s: %v", req.RequestID, err)
					case result.Skipped:
						evt.Status = "skipped"
						log.Printf("remote update skipped request_id=%s (already on %s)", req.RequestID, result.NewVersion)
					default:
						evt.Status = "completed"
						log.Printf("remote update completed request_id=%s %s → %s (restarted=%v)", req.RequestID, result.PreviousVersion, result.NewVersion, result.Restarted)
					}
					return evt
				}
				// Construct the SDK headless driver manager. Spawns
				// `claude --resume <sid>` subprocesses lazily when an
				// inject targets a sid without a live PTY wrapper. The
				// driver writes its events into the SAME terminal.Manager
				// the PTY wrapper uses, so the inject lookup path doesn't
				// care which driver answered. Permission-required tools
				// route through the same mcp-permission MCP server the
				// wrapper spawns; canUseTool is wired via
				// --permission-prompt-tool mcp__pockly__request_permission
				// inside sdkdriver.Driver.buildArgs.
				daemonExe, _ := os.Executable()
				// Let the model pill ask the INSTALLED claude CLI for its
				// live /model picker list (agentsettings/cli_models.go),
				// resolved the same wrapper-skipping way SDK spawns are.
				agentsettings.SetClaudeBinaryResolver(func() (string, error) {
					return sdkdriver.ResolveExecutable("claude")
				})
				sdkManager := sdkdriver.NewManager(sdkdriver.ManagerConfig{
					Terminal:          terminalManager,
					Logger:            log.Printf,
					Context:           ctx,
					DaemonBinaryPath:  daemonExe,
					DaemonLocalAPIURL: "http://" + *listen,
					Settings:          sdkSettingsReader{store: agentSettingsStore},
					Sessions:          sdkSessionResolver{index: idx},
					EventSink:         sdkTerminalEventForwarder{out: externalTerminalEvents},
					PermissionStore:   permissionStore,
				})
				defer sdkManager.StopAll()
				// Late-bind the wrapper-unclean-exit recovery hook now
				// that sdkManager exists. The api handler picked up the
				// outer closure when cfg was built, so this assignment
				// activates auto-recovery for all subsequent wrapper
				// exit_intent reports. Loop guard + telemetry are
				// already handled in the outer closure; this inner fn
				// only needs to do the actual EnsureDriver call.
				wrapperRecoveryMu.Lock()
				wrapperRecoveryFn = func(claudeSID, cwd, agentStr string) {
					agent := sdkdriver.AgentClaude
					if agentStr == string(sdkdriver.AgentCodex) {
						agent = sdkdriver.AgentCodex
					}
					if _, err := sdkManager.EnsureDriver(ctx, claudeSID, cwd, agent); err != nil {
						log.Printf("wrapper-recovery failed sid=%s: %v", claudeSID, err)
						telemetry.Send(context.Background(), effectiveNexusURL, telemetryID, telemetry.Event{
							Name: "wrapper_recovery_failed", Command: "exit-intent", Status: "error",
							ErrorCode: err.Error(), SessionID: claudeSID,
						})
						return
					}
					log.Printf("wrapper-recovery spawned SDK driver sid=%s cwd=%s", claudeSID, cwd)
					telemetry.Send(context.Background(), effectiveNexusURL, telemetryID, telemetry.Event{
						Name: "wrapper_recovery_succeeded", Command: "exit-intent", Status: "ok",
						SessionID: claudeSID,
					})
				}
				wrapperRecoveryMu.Unlock()
				go func() {
					if err := control.Run(ctx, control.Client{
						RelayURL:               baseURL,
						LocalAPIURL:            "http://" + *listen,
						Identity:               id,
						Index:                  idx,
						Terminal:               terminalManager,
						Profile:                profile,
						ExternalTerminalEvents: externalTerminalEvents,
						UpdateHandler:          updateHandler,
						// Forward Nexus-issued permission
						// decisions into the local permission.Store
						// (which unblocks the MCP server's /await).
						PermissionDecider: permissionDeciderAdapter{store: permissionStore},
						AgentSettings:     agentSettingsAdapter{store: agentSettingsStore, terminal: terminalManager, index: idx},
						AgentDefaults:     agentSettingsAdapter{store: agentSettingsStore, terminal: terminalManager, index: idx},
						GitDiff:           agentSettingsAdapter{store: agentSettingsStore, terminal: terminalManager, index: idx},
						SyncHint: func(hint control.SyncHintPush) {
							pushedHints.Add(hint.SessionID, syncHint{
								Reason:          hint.Reason,
								PreferredMin:    hint.PreferredMin,
								SyncedTurnCount: hint.SyncedTurnCount,
								SyncedMinSeq:    hint.SyncedMinSeq,
								SyncedMaxSeq:    hint.SyncedMaxSeq,
								NextBeforeSeq:   hint.NextBeforeSeq,
								TotalTurnCount:  hint.TotalTurnCount,
								HasOlderTurns:   hint.HasOlderTurns,
							}, time.Now())
						},
						SessionDelete: agentSettingsAdapter{store: agentSettingsStore, terminal: terminalManager, index: idx},
						Reveal:        agentSettingsAdapter{store: agentSettingsStore, terminal: terminalManager, index: idx},
						SDKDriver:     sdkDriverAdapter{manager: sdkManager, settings: agentSettingsStore},
					}); err != nil {
						log.Printf("Nexus control stopped: %v", err)
					}
				}()
				log.Printf("Nexus sync target: %s", baseURL)
			}
		}
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
	case err := <-errCh:
		if err != nil {
			return err
		}
		return nil
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func runSetup(args []string) (err error) {
	started := time.Now()
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	nexusURL := fs.String("nexus-url", "", "Nexus base URL")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	deviceName := fs.String("device-name", "", "connected computer display name")
	installService := fs.Bool("install-service", true, "install a user-level background service after connecting this computer")
	startService := fs.Bool("start", true, "start the background service after installing it")
	openBrowser := fs.Bool("open-browser", false, "open the browser for Pockly computer authorization instead of using QR-first setup")
	noOpenBrowser := fs.Bool("no-open-browser", false, "do not open a browser automatically")
	timeout := fs.Duration("timeout", 10*time.Minute, "computer authorization wait timeout")
	pollInterval := fs.Duration("poll-interval", 2*time.Second, "computer authorization poll interval")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := pathFlag(fs, "identity-file", identityPath, "daemon identity file path")
	relayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := nexusStateFileFlag(fs, relayStatePath, "Nexus state file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	baseURL := selectedNexusURL(*nexusURL, *relayURL)
	defer func() {
		telemetry.Send(context.Background(), baseURL, device.Identity{}, telemetry.CommandFinished("setup", started, err))
	}()

	id, err := device.LoadOrCreate(*identityFile, *deviceName)
	if err != nil {
		return err
	}
	client := pair.NewClient(baseURL)
	fmt.Println("Pockly daemon installed.")
	local := isLocalInstall()

	var state relay.State
	if local {
		// Local install: run the loopback handshake. The web's /local-setup
		// page mints tokens via /api/daemon/local-claim and POSTs them back
		// to our 127.0.0.1 server. No y/N prompt, no device-authorization
		// polling.
		fmt.Println("Detected local install — opening the Pockly setup page in your browser.")
		s, err := runLocalSetupHandshake(client, id, baseURL, *timeout, *pollInterval, !*noOpenBrowser)
		if err != nil {
			return err
		}
		state = relay.State{
			RelayURL:           baseURL,
			DaemonDeviceID:     s.DaemonDeviceID,
			UserEmail:          s.UserEmail,
			RemoteAccess:       s.RemoteAccessEnabled,
			DeviceAccessToken:  s.DeviceAccessToken,
			DeviceRefreshToken: s.DeviceRefreshToken,
			BrowserDeviceCount: intPtr(1),
			LastLoginAt:        time.Now().UTC(),
			LastPairedAt:       time.Now().UTC(),
		}
		if err := relay.SaveState(*relayStateFile, state); err != nil {
			return err
		}
		fmt.Printf("Connected as %s.\n", s.UserEmail)
		fmt.Printf("Remote Access enabled: %t\n", s.RemoteAccessEnabled)
		fmt.Printf("Saved Nexus pairing state to %s\n", *relayStateFile)
	} else {
		// Remote install: keep the QR / device-authorization flow with the
		// y/N prompt on this terminal — the user is on a different machine.
		fmt.Println("Detected remote install — you'll be asked to confirm pairing on this terminal.")
		auth, err := authorizeDaemonDevice(client, id, shouldOpenBrowser(*openBrowser, *noOpenBrowser), *timeout, *pollInterval, false)
		if err != nil {
			return err
		}
		state = relay.State{
			RelayURL:           baseURL,
			DaemonDeviceID:     auth.DaemonDeviceID,
			UserEmail:          auth.User.Email,
			RemoteAccess:       auth.RemoteAccessEnabled,
			DeviceAccessToken:  auth.DeviceAccessToken,
			DeviceRefreshToken: auth.DeviceRefreshToken,
			BrowserDeviceCount: intPtr(1),
			LastLoginAt:        time.Now().UTC(),
			LastPairedAt:       time.Now().UTC(),
		}
		if err := relay.SaveState(*relayStateFile, state); err != nil {
			return err
		}
		fmt.Printf("Connected as %s.\n", auth.User.Email)
		fmt.Printf("Remote Access enabled: %t\n", auth.RemoteAccessEnabled)
		fmt.Printf("Saved Nexus pairing state to %s\n", *relayStateFile)
		printMobileJoinGrantBestEffort(client, id)
	}
	if *installService {
		if err := installUserService(baseURL, *identityFile, *relayStateFile, *startService); err != nil {
			return err
		}
		fmt.Printf("Open %s/workspace/sessions on your phone to view and control sessions.\n", strings.TrimRight(baseURL, "/"))
	} else {
		fmt.Printf("Start daemon manually with: pockly-daemon serve --connect-nexus --nexus-url %s\n", baseURL)
	}
	installClaudeIntegrationBestEffort()
	installRemoteControlBestEffort()
	return nil
}

func runLogin(args []string) (err error) {
	started := time.Now()
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	nexusURL := fs.String("nexus-url", "", "Nexus base URL")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	loginCode := fs.String("login-code", "", "legacy one-time daemon login code from the Pockly web app")
	deviceName := fs.String("device-name", "", "connected computer display name")
	openBrowser := fs.Bool("open-browser", true, "open the browser for Pockly computer authorization")
	noOpenBrowser := fs.Bool("no-open-browser", false, "do not open a browser automatically")
	timeout := fs.Duration("timeout", 10*time.Minute, "computer authorization wait timeout")
	pollInterval := fs.Duration("poll-interval", 2*time.Second, "computer authorization poll interval")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := pathFlag(fs, "identity-file", identityPath, "daemon identity file path")
	relayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := nexusStateFileFlag(fs, relayStatePath, "Nexus state file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	baseURL := selectedNexusURL(*nexusURL, *relayURL)
	defer func() {
		telemetry.Send(context.Background(), baseURL, device.Identity{}, telemetry.CommandFinished("login", started, err))
	}()
	id, err := device.LoadOrCreate(*identityFile, *deviceName)
	if err != nil {
		return err
	}
	client := pair.NewClient(baseURL)
	local := isLocalInstall()
	var state relay.State
	var userEmail string
	var daemonDeviceID string
	var remoteAccess bool
	if strings.TrimSpace(*loginCode) != "" {
		fmt.Println("Warning: --login-code is deprecated; use `pockly-daemon setup` or browser authorization for new installs.")
		res, err := client.DaemonLogin(id, *loginCode, version.String())
		if err != nil {
			return err
		}
		state = relay.State{
			RelayURL:           baseURL,
			DaemonDeviceID:     res.DaemonDeviceID,
			UserEmail:          res.User.Email,
			RemoteAccess:       res.RemoteAccessEnabled,
			DeviceAccessToken:  res.DeviceAccessToken,
			DeviceRefreshToken: res.DeviceRefreshToken,
			BrowserDeviceCount: intPtr(0),
			LastLoginAt:        time.Now().UTC(),
		}
		userEmail = res.User.Email
		daemonDeviceID = res.DaemonDeviceID
		remoteAccess = res.RemoteAccessEnabled
	} else {
		auth, err := authorizeDaemonDevice(client, id, shouldOpenBrowser(*openBrowser, *noOpenBrowser), *timeout, *pollInterval, local)
		if err != nil {
			return err
		}
		state = relay.State{
			RelayURL:           baseURL,
			DaemonDeviceID:     auth.DaemonDeviceID,
			UserEmail:          auth.User.Email,
			RemoteAccess:       auth.RemoteAccessEnabled,
			DeviceAccessToken:  auth.DeviceAccessToken,
			DeviceRefreshToken: auth.DeviceRefreshToken,
			BrowserDeviceCount: intPtr(1),
			LastLoginAt:        time.Now().UTC(),
		}
		userEmail = auth.User.Email
		daemonDeviceID = auth.DaemonDeviceID
		remoteAccess = auth.RemoteAccessEnabled
	}
	if err := relay.SaveState(*relayStateFile, state); err != nil {
		return err
	}
	fmt.Printf("Logged in as %s.\n", userEmail)
	fmt.Printf("Daemon device: %s (%s)\n", id.DeviceName, daemonDeviceID)
	fmt.Printf("Remote Access: %t\n", remoteAccess)
	fmt.Printf("Saved Nexus pairing state to %s\n", *relayStateFile)
	if !local {
		printMobileJoinGrantBestEffort(client, id)
	}
	return nil
}

// runLocalSetupHandshake performs the loopback handshake for local installs:
//
//  1. Pre-register the daemon with Nexus via /api/daemon/setup-grants —
//     this gives us a grant_id the web can claim.
//  2. Start a single-shot 127.0.0.1 HTTP server with a fresh nonce, allowing
//     POSTs only from the Nexus origin.
//  3. Open https://<nexus>/local-setup#grant=&nonce=&cb= in the user's
//     browser. The web mints device tokens via /api/daemon/local-claim and
//     POSTs them back to our loopback callback.
//  4. Return the claim. Caller writes it to pairing state.
//
// We never poll /api/daemon/setup-grants/{id}/result in this path — the web
// hands us tokens directly via the loopback. The grant entry stays in the
// Nexus stores the grant as an audit record.
func runLocalSetupHandshake(client *pair.Client, id device.Identity, relayURL string, deadline, fallbackPollInterval time.Duration, shouldOpenBrowser bool) (localsetup.Claim, error) {
	grant, err := client.CreateSetupGrant(id, version.String())
	if err != nil {
		return localsetup.Claim{}, fmt.Errorf("create setup grant: %w", err)
	}
	auth, err := client.CreateDeviceAuthorization(id, version.String())
	if err != nil {
		return localsetup.Claim{}, fmt.Errorf("create device authorization: %w", err)
	}

	allowed := relayOriginForLocalSetup(relayURL)
	srv := &localsetup.Server{
		AllowedOrigins: []string{allowed},
		Deadline:       deadline,
	}
	if err := srv.Start(); err != nil {
		return localsetup.Claim{}, err
	}
	defer srv.Close()

	setupURL, err := buildLocalSetupURL(relayURL, grant.SetupGrant, srv.Nonce(), srv.CallbackURL())
	if err != nil {
		return localsetup.Claim{}, err
	}
	if shouldOpenBrowser {
		fmt.Println("Opening Pockly setup in your browser...")
		if err := openURL(setupURL); err != nil {
			fmt.Printf("Could not open browser automatically: %v\n", err)
		}
	} else {
		fmt.Println("Browser auto-open disabled.")
	}
	fmt.Println()
	fmt.Println("You can also scan or open this pairing link from any device:")
	printDeviceAuthorization(auth)
	fmt.Println("Waiting for browser sign-in or pairing authorization...")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type setupResult struct {
		claim localsetup.Claim
		err   error
	}
	results := make(chan setupResult, 2)
	go func() {
		c, err := srv.Wait(ctx)
		if err != nil {
			results <- setupResult{err: err}
			return
		}
		if c == nil {
			results <- setupResult{err: fmt.Errorf("local setup returned no claim")}
			return
		}
		results <- setupResult{claim: *c}
	}()
	go func() {
		res, err := waitForDeviceAuthorization(ctx, client, auth, deadline, fallbackPollInterval, true)
		if err != nil {
			results <- setupResult{err: err}
			return
		}
		results <- setupResult{claim: localsetup.Claim{
			DaemonDeviceID:      res.DaemonDeviceID,
			UserEmail:           res.User.Email,
			UserID:              res.User.UserID,
			DeviceAccessToken:   res.DeviceAccessToken,
			DeviceRefreshToken:  res.DeviceRefreshToken,
			RemoteAccessEnabled: res.RemoteAccessEnabled,
		}}
	}()

	var lastErr error
	for i := 0; i < 2; i++ {
		result := <-results
		if result.err == nil {
			cancel()
			return result.claim, nil
		}
		lastErr = result.err
	}
	return localsetup.Claim{}, lastErr
}

// buildLocalSetupURL composes the URL the daemon opens. It mirrors
// localsetup.Server.SetupURL but adds the setup-grant id so the web can
// resolve the daemon to claim.
func buildLocalSetupURL(relayBaseURL, grantID, nonce, callback string) (string, error) {
	u, err := url.Parse(relayBaseURL)
	if err != nil {
		return "", fmt.Errorf("parse Nexus URL: %w", err)
	}
	u.Path = "/local-setup"
	u.RawQuery = ""
	u.Fragment = ""
	frag := "grant=" + url.QueryEscape(grantID) + "&nonce=" + url.QueryEscape(nonce) + "&cb=" + url.QueryEscape(callback)
	return u.String() + "#" + frag, nil
}

// relayOriginForLocalSetup returns the scheme+host part of the Nexus URL,
// for use as the CORS Origin check on the loopback server.
func relayOriginForLocalSetup(relayURL string) string {
	u, err := url.Parse(relayURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return defaultNexusURL()
	}
	return u.Scheme + "://" + u.Host
}

func printDeviceAuthorization(auth pair.DeviceAuthorizationResponse) {
	fmt.Println("Scan with your phone to connect this computer:")
	fmt.Println(auth.VerificationURIComplete)
	fmt.Printf("Code: %s\n", auth.UserCode)
	fmt.Printf("Expires at: %s\n", auth.ExpiresAt.Local().Format(time.RFC1123))
	fmt.Println()
	printTerminalQRCode(auth.VerificationURIComplete)
	fmt.Println()
}

// authorizeDaemonDevice runs the QR / device-authorization handshake with the
// Nexus. When autoConfirm is true, the daemon answers any awaiting_daemon_confirm
// poll with allow=true without ever showing the y/N prompt. autoConfirm is the
// right choice for local installs (the user is at the keyboard, so the prompt
// has no shoulder-surf-defense value) and the wrong choice for remote installs
// (the user is on a different machine, so the prompt is the only thing
// stopping a hijacked terminal session from silently binding the daemon to
// someone else's account).
func authorizeDaemonDevice(client *pair.Client, id device.Identity, shouldOpenBrowser bool, timeout, fallbackPollInterval time.Duration, autoConfirm bool) (pair.DeviceAuthorizationTokenResponse, error) {
	auth, err := client.CreateDeviceAuthorization(id, version.String())
	if err != nil {
		return pair.DeviceAuthorizationTokenResponse{}, err
	}
	fmt.Println()
	printDeviceAuthorization(auth)
	if shouldOpenBrowser {
		if err := openURL(auth.VerificationURIComplete); err != nil {
			fmt.Printf("Could not open browser automatically: %v\n", err)
		}
	}
	fmt.Println("Waiting for mobile authorization...")
	return waitForDeviceAuthorization(context.Background(), client, auth, timeout, fallbackPollInterval, autoConfirm)
}

func waitForDeviceAuthorization(ctx context.Context, client *pair.Client, auth pair.DeviceAuthorizationResponse, timeout, fallbackPollInterval time.Duration, autoConfirm bool) (pair.DeviceAuthorizationTokenResponse, error) {
	pollEvery := fallbackPollInterval
	if auth.PollInterval > 0 {
		pollEvery = time.Duration(auth.PollInterval) * time.Second
	}
	deadline := time.Now().Add(timeout)
	if auth.ExpiresAt.Before(deadline) {
		deadline = auth.ExpiresAt
	}
	promptedFor := ""
	for {
		if err := ctx.Err(); err != nil {
			return pair.DeviceAuthorizationTokenResponse{}, err
		}
		if time.Now().After(deadline) {
			return pair.DeviceAuthorizationTokenResponse{}, fmt.Errorf("device authorization expired; rerun `pockly-daemon setup` or `pockly-daemon login`")
		}
		res, err := client.DeviceAuthorizationToken(auth.DeviceCode, auth.PollSecret)
		if err != nil {
			if isRetryableAuthorizationPollError(err) {
				fmt.Printf("Authorization poll temporarily failed: %v. Retrying...\n", err)
				if !sleepWithContext(ctx, pollEvery) {
					return pair.DeviceAuthorizationTokenResponse{}, ctx.Err()
				}
				continue
			}
			return pair.DeviceAuthorizationTokenResponse{}, err
		}
		switch res.Status {
		case "authorized":
			return res, nil
		case "awaiting_daemon_confirm":
			// Only prompt once per device_code; subsequent polls with the
			// same status mean the user hasn't decided yet (we keep waiting
			// while the prompt is open, but a re-prompt loop on poll would
			// be hostile).
			if promptedFor == auth.DeviceCode {
				if !sleepWithContext(ctx, pollEvery) {
					return pair.DeviceAuthorizationTokenResponse{}, ctx.Err()
				}
				continue
			}
			promptedFor = auth.DeviceCode
			var (
				allow bool
				perr  error
			)
			if autoConfirm || autoConfirmPairFromEnv() {
				// Local install: the user just typed `pockly-daemon setup`
				// on this exact machine. Skip the y/N prompt and confirm
				// silently. Nexus still records this as a confirmation
				// event for audit. The env-var path is for headless
				// containers / CI runners where there's no TTY for y/N
				// but the operator has fully controlled the environment.
				if res.Claim != nil && res.Claim.UserEmail != "" {
					fmt.Printf("Confirmed pairing for %s on this computer.\n", res.Claim.UserEmail)
				} else {
					fmt.Println("Confirmed pairing on this computer.")
				}
				allow = true
			} else {
				allow, perr = promptDaemonAuthClaim(res, deadline)
			}
			if perr != nil {
				return pair.DeviceAuthorizationTokenResponse{}, perr
			}
			if _, cerr := client.ConfirmDeviceAuthorization(auth.DeviceCode, auth.PollSecret, allow); cerr != nil {
				return pair.DeviceAuthorizationTokenResponse{}, fmt.Errorf("send pair confirmation: %w", cerr)
			}
			if !allow {
				return pair.DeviceAuthorizationTokenResponse{}, fmt.Errorf("pair request denied on this computer")
			}
			fmt.Println("Confirmed. Finalizing connection...")
			// Loop again; next poll should return 'authorized'.
		case "denied":
			return pair.DeviceAuthorizationTokenResponse{}, fmt.Errorf("pair request denied from the mobile device")
		case "denied_by_daemon", "expired", "consumed":
			return pair.DeviceAuthorizationTokenResponse{}, fmt.Errorf("device authorization %s", res.Status)
		case "pending", "":
			// Keep waiting.
		default:
			fmt.Printf("Authorization is waiting in Nexus pairing state %q. Update pockly-daemon if this does not progress.\n", res.Status)
		}
		if !sleepWithContext(ctx, pollEvery) {
			return pair.DeviceAuthorizationTokenResponse{}, ctx.Err()
		}
	}
}

func sleepWithContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// promptDaemonAuthClaim displays the mobile-side claim metadata and asks
// the local user to allow or deny. Defaults to deny on EOF, timeout, or
// any unrecognized input.
func promptDaemonAuthClaim(res pair.DeviceAuthorizationTokenResponse, deadline time.Time) (bool, error) {
	input, closeInput, inputErr := daemonPromptInput()
	fmt.Println()
	fmt.Println("================ Pair request ================")
	if res.Claim != nil {
		c := res.Claim
		if c.UserEmail != "" {
			fmt.Printf("  Account:      %s\n", c.UserEmail)
		}
		if c.UserName != "" {
			fmt.Printf("  User name:    %s\n", c.UserName)
		}
		if c.BrowserDeviceName != "" {
			fmt.Printf("  Mobile device: %s\n", c.BrowserDeviceName)
		}
		if c.UserAgent != "" {
			fmt.Printf("  User agent:   %s\n", truncate(c.UserAgent, 90))
		}
		if c.ClientIP != "" {
			fmt.Printf("  Client IP:    %s\n", c.ClientIP)
		}
		fmt.Printf("  Bind browser: %t\n", c.BindBrowser)
	}
	if res.ClaimRequestedAt != nil {
		fmt.Printf("  Requested at: %s\n", res.ClaimRequestedAt.Local().Format(time.RFC1123))
	}
	remaining := time.Until(deadline)
	if remaining > 0 {
		fmt.Printf("  Expires in:   %s\n", remaining.Round(time.Second))
	}
	fmt.Println("==============================================")
	fmt.Println("If this is not you, deny immediately. The mobile claim will be voided.")
	if inputErr != nil {
		fmt.Printf("Cannot read local confirmation: %v\n", inputErr)
		fmt.Println("Denying pair request. Run `pockly-daemon setup` from an interactive terminal and try again.")
		return false, nil
	}
	defer closeInput()
	fmt.Print("Allow this pairing on this computer? [y/N]: ")

	type result struct {
		input string
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		line, err := bufio.NewReader(input).ReadString('\n')
		ch <- result{input: line, err: err}
	}()
	// Allow up to 60s for the user to decide, but never past the grant deadline.
	timeoutWindow := 60 * time.Second
	if d := time.Until(deadline); d > 0 && d < timeoutWindow {
		timeoutWindow = d
	}
	select {
	case r := <-ch:
		if r.err != nil && strings.TrimSpace(r.input) == "" {
			fmt.Printf("\nCould not read confirmation (%v); denying pair request.\n", r.err)
			return false, nil
		}
		ans := strings.TrimSpace(strings.ToLower(r.input))
		return ans == "y" || ans == "yes", nil
	case <-time.After(timeoutWindow):
		fmt.Println("\nNo response within the time window; denying pair request.")
		return false, nil
	}
}

func daemonPromptInput() (*os.File, func(), error) {
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return os.Stdin, func() {}, nil
	}
	if runtime.GOOS != "windows" {
		tty, err := os.OpenFile("/dev/tty", os.O_RDONLY, 0)
		if err == nil {
			return tty, func() { _ = tty.Close() }, nil
		}
	}
	return nil, func() {}, fmt.Errorf("daemon is not attached to an interactive terminal")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func shouldOpenBrowser(openBrowser, noOpenBrowser bool) bool {
	return openBrowser && !noOpenBrowser
}

// isLocalInstall heuristically decides whether the daemon is running on the
// same machine as the user's web browser.
//
// We only need to be conservatively correct: a false negative is harmless
// (user just sees the existing y/N prompt); a false positive would let a
// remote terminal silently bind the daemon to a claim it should have
// shoulder-surf-rejected. So we treat SSH and headless environments as
// remote, and only call something local when we have positive evidence of
// a graphical session.
// autoConfirmPairFromEnv lets headless container / CI environments accept
// the on-device pair-request confirmation automatically. Set
// POCKLY_AUTO_CONFIRM_PAIR=1 in your Dockerfile / shell to enable.
//
// SECURITY: this bypasses the y/N prompt that protects against
// device-code phishing — only set in environments you fully control
// (your own test container, your own CI runner). Never set on a shared
// or production machine.
func autoConfirmPairFromEnv() bool {
	return os.Getenv("POCKLY_AUTO_CONFIRM_PAIR") == "1"
}

func isLocalInstall() bool {
	if os.Getenv("POCKLY_FORCE_REMOTE_INSTALL") != "" {
		return false
	}
	if os.Getenv("POCKLY_FORCE_LOCAL_INSTALL") != "" {
		return true
	}
	// SSH always wins — even if $DISPLAY happens to be forwarded.
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_CLIENT") != "" || os.Getenv("SSH_TTY") != "" {
		return false
	}
	switch runtime.GOOS {
	case "darwin", "windows":
		// Desktop OSes: assume local unless SSH said otherwise above.
		return true
	case "linux":
		// Linux: only treat as local if there's a graphical session.
		if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
			return true
		}
		return false
	default:
		return false
	}
}

func isRetryableAuthorizationPollError(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded)
}

func openURL(rawURL string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", rawURL).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL).Start()
	default:
		return exec.Command("xdg-open", rawURL).Start()
	}
}

func runRemote(args []string) error {
	fs := flag.NewFlagSet("remote", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	nexusURL := fs.String("nexus-url", "", "override Nexus base URL")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	enabled := fs.Bool("enabled", true, "enable Remote Access")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := pathFlag(fs, "identity-file", identityPath, "device identity file path")
	relayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := nexusStateFileFlag(fs, relayStatePath, "Nexus state file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	id, err := device.LoadOrCreate(*identityFile, "")
	if err != nil {
		return err
	}
	state, err := relay.LoadState(*relayStateFile)
	if err != nil {
		return err
	}
	baseURL := optionalNexusURL(*nexusURL, *relayURL)
	if baseURL == "" {
		baseURL = state.RelayURL
	}
	if baseURL == "" {
		return fmt.Errorf("Nexus URL missing; run login first or pass --nexus-url")
	}
	res, err := pair.NewClient(baseURL).SetRemoteAccess(id, *enabled)
	if err != nil {
		return err
	}
	state.RelayURL = baseURL
	state.DaemonDeviceID = res.DaemonDeviceID
	state.RemoteAccess = res.RemoteAccessEnabled
	if err := relay.SaveState(*relayStateFile, state); err != nil {
		return err
	}
	fmt.Printf("Remote Access %s for %s.\n", enabledText(res.RemoteAccessEnabled), state.UserEmail)
	fmt.Printf("Daemon device: %s\n", res.DaemonDeviceID)
	return nil
}

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	nexusURL := fs.String("nexus-url", "", "Nexus base URL")
	relayURL := fs.String("relay-url", "", "legacy alias for --nexus-url")
	deviceName := fs.String("device-name", "", "connected computer display name")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := pathFlag(fs, "identity-file", identityPath, "daemon identity file path")
	relayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := nexusStateFileFlag(fs, relayStatePath, "Nexus pairing state file path")
	pollInterval := fs.Duration("poll-interval", 2*time.Second, "poll interval for pending confirmation requests")
	if err := fs.Parse(args); err != nil {
		return err
	}

	id, err := device.LoadOrCreate(*identityFile, *deviceName)
	if err != nil {
		return err
	}

	baseURL := selectedNexusURL(*nexusURL, *relayURL)
	client := pair.NewClient(baseURL)
	grant, err := client.CreatePairingGrant(id)
	if err != nil {
		return err
	}

	qrPayload, _ := jsonMarshalIndent(grant.QRPayload)
	fmt.Printf("Pairing grant created.\n")
	fmt.Printf("Device: %s (%s)\n", id.DeviceName, id.DeviceID)
	fmt.Printf("Short code: %s\n", grant.ShortCode)
	fmt.Printf("Expires at: %s\n", grant.ExpiresAt.Format(time.RFC3339))
	fmt.Printf("QR payload:\n%s\n\n", qrPayload)
	fmt.Printf("Open your Pockly web app, log in, and paste or scan the payload above.\n")

	for {
		pending, err := client.PendingRequests(id)
		if err != nil {
			return err
		}
		for _, req := range pending.Requests {
			allow, err := promptAllow(req)
			if err != nil {
				return err
			}
			res, err := client.ConfirmPairing(id, req.PairingGrant, allow)
			if err != nil {
				return err
			}
			fmt.Printf("Pairing %s: %s\n", req.PairingGrant, res.Status)
			if allow {
				fmt.Printf("Bound browser access %s to daemon %s\n", res.BrowserDeviceID, res.DaemonDeviceID)
				if err := relay.SaveState(*relayStateFile, relay.State{
					RelayURL:           baseURL,
					DaemonDeviceID:     res.DaemonDeviceID,
					DeviceAccessToken:  res.DeviceAccessToken,
					DeviceRefreshToken: res.DeviceRefreshToken,
					BrowserDeviceCount: intPtr(1),
					LastPairedAt:       time.Now().UTC(),
				}); err != nil {
					return err
				}
				fmt.Printf("Saved Nexus pairing state to %s\n", *relayStateFile)
			}
			return nil
		}
		time.Sleep(*pollInterval)
	}
}

func installUserService(nexusURL, identityFile, relayStateFile string, start bool) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable path: %w", err)
	}
	switch runtime.GOOS {
	case "darwin":
		return installLaunchAgent(exe, nexusURL, identityFile, relayStateFile, start)
	case "linux":
		return installSystemdUserService(exe, nexusURL, identityFile, relayStateFile, start)
	case "windows":
		return installWindowsScheduledTask(exe, nexusURL, identityFile, relayStateFile, start)
	default:
		fmt.Printf("Background service install is not supported on %s.\n", runtime.GOOS)
		fmt.Printf("Start daemon manually with: %s serve --connect-nexus --nexus-url %s\n", exe, nexusURL)
		return nil
	}
}

func agentServicePath() string {
	return agentexec.SearchPath(os.Getenv("PATH"), os.Getenv)
}

func installLaunchAgent(exe, nexusURL, identityFile, relayStateFile string, start bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	logDir := filepath.Join(home, "Library", "Logs")
	plistPath := filepath.Join(home, "Library", "LaunchAgents", "com.pockly.daemon.plist")
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return err
	}
	args := []string{
		exe, "serve", "--connect-nexus", "--nexus-url", nexusURL,
		"--identity-file", identityFile, "--nexus-state-file", relayStateFile,
	}
	var argXML strings.Builder
	for _, arg := range args {
		argXML.WriteString("\n        <string>")
		argXML.WriteString(xmlEscape(arg))
		argXML.WriteString("</string>")
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pockly.daemon</string>
  <key>ProgramArguments</key>
  <array>%s
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>%s</string>
  </dict>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`, argXML.String(), xmlEscape(agentServicePath()), xmlEscape(filepath.Join(logDir, "pockly-daemon.log")), xmlEscape(filepath.Join(logDir, "pockly-daemon.err.log")))
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return err
	}
	if start {
		uid := fmt.Sprint(os.Getuid())
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
		if err := enableLaunchAgent(uid); err != nil {
			return err
		}
		if err := exec.Command("launchctl", "bootstrap", "gui/"+uid, plistPath).Run(); err != nil {
			return fmt.Errorf("start launch agent: %w", err)
		}
	}
	fmt.Printf("Background daemon installed: %s\n", plistPath)
	fmt.Printf("Logs: %s\n", filepath.Join(logDir, "pockly-daemon.log"))
	return nil
}

func installSystemdUserService(exe, nexusURL, identityFile, relayStateFile string, start bool) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	stateDir := filepath.Join(home, ".local", "state", "pockly-daemon")
	unitDir := filepath.Join(home, ".config", "systemd", "user")
	unitPath := filepath.Join(unitDir, "pockly-daemon.service")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		return err
	}
	unit := fmt.Sprintf(`[Unit]
Description=Pockly daemon
After=network-online.target

[Service]
ExecStart=%s serve --connect-nexus --nexus-url %s --identity-file %s --nexus-state-file %s
Environment=PATH=%s
Restart=always
RestartSec=5
StandardOutput=append:%s
StandardError=append:%s

[Install]
WantedBy=default.target
`, systemdQuote(exe), systemdQuote(nexusURL), systemdQuote(identityFile), systemdQuote(relayStateFile), systemdQuote(agentServicePath()), filepath.Join(stateDir, "daemon.log"), filepath.Join(stateDir, "daemon.err.log"))
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return err
	}
	if start {
		if err := exec.Command("systemctl", "--user", "daemon-reload").Run(); err != nil {
			return fmt.Errorf("systemctl daemon-reload: %w", err)
		}
		if err := exec.Command("systemctl", "--user", "enable", "--now", "pockly-daemon.service").Run(); err != nil {
			return fmt.Errorf("start systemd user service: %w", err)
		}
	}
	fmt.Printf("Background daemon installed: %s\n", unitPath)
	fmt.Printf("Logs: %s\n", filepath.Join(stateDir, "daemon.log"))
	return nil
}

const windowsTaskName = "PocklyDaemon"

func installWindowsScheduledTask(exe, nexusURL, identityFile, relayStateFile string, start bool) error {
	// Register the task from a well-formed XML rather than `/SC ONLOGON /TR`.
	// The /TR string has to carry the quoted exe plus four quoted flags, and
	// schtasks' /TR parser mangles those nested quotes — it was failing on
	// Windows with exit 0x80004005 ("create_scheduled_task_..."), so the
	// scheduled task was never created and `serve` never ran (perpetual yellow
	// "connecting" dot). An XML action puts the program and arguments in
	// separate <Command>/<Arguments> elements, sidestepping the quoting, and
	// lets us set daemon-appropriate settings the /TR form can't: no execution
	// time limit (default tasks are killed after 72h) and no battery/idle stop.
	xmlBody := windowsTaskXML(exe, nexusURL, identityFile, relayStateFile)
	f, err := os.CreateTemp("", "pockly-daemon-task-*.xml")
	if err != nil {
		return fmt.Errorf("create task xml temp file: %w", err)
	}
	xmlPath := f.Name()
	defer os.Remove(xmlPath)
	// schtasks /Create /XML reliably reads UTF-16LE with a BOM (what Task
	// Scheduler itself exports); a UTF-8 file with an encoding="UTF-16"
	// declaration is rejected on some Windows builds.
	if _, err := f.Write(utf16LEWithBOM(xmlBody)); err != nil {
		f.Close()
		return fmt.Errorf("write task xml: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close task xml: %w", err)
	}
	// CombinedOutput (not Run) so a failure carries schtasks' actual message,
	// not just the bare HRESULT — the old code swallowed it.
	if out, err := exec.Command("schtasks", "/Create", "/F", "/TN", windowsTaskName, "/XML", xmlPath).CombinedOutput(); err != nil {
		return fmt.Errorf("create scheduled task: %w (schtasks: %s)", err, strings.TrimSpace(string(out)))
	}
	if start {
		if out, err := exec.Command("schtasks", "/Run", "/TN", windowsTaskName).CombinedOutput(); err != nil {
			return fmt.Errorf("start scheduled task: %w (schtasks: %s)", err, strings.TrimSpace(string(out)))
		}
	}
	fmt.Printf("Background daemon installed as Windows Scheduled Task: %s\n", windowsTaskName)
	return nil
}

// windowsTaskXML builds a Task Scheduler v1.2 definition that runs the daemon
// at user logon. The exe goes in <Command> and the flags in <Arguments> (both
// XML-escaped), so the quoted Nexus URL / file paths survive without the /TR
// nested-quote mangling. Settings are tuned for a long-lived daemon: it must
// not be killed after the default 72h limit, must not be blocked or stopped on
// battery, and must auto-restart if it crashes.
func windowsTaskXML(exe, nexusURL, identityFile, relayStateFile string) string {
	args := fmt.Sprintf(`serve --connect-nexus --nexus-url "%s" --identity-file "%s" --nexus-state-file "%s"`, nexusURL, identityFile, relayStateFile)
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Pockly daemon - keeps your local agent sessions reachable through Pockly Nexus.</Description>
    <URI>\` + windowsTaskName + `</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>` + xmlEscape(exe) + `</Command>
      <Arguments>` + xmlEscape(args) + `</Arguments>
    </Exec>
  </Actions>
</Task>`
}

// utf16LEWithBOM encodes s as UTF-16 little-endian prefixed with the
// 0xFF 0xFE BOM — the encoding schtasks /Create /XML expects.
func utf16LEWithBOM(s string) []byte {
	units := utf16.Encode([]rune(s))
	buf := make([]byte, 0, 2+len(units)*2)
	buf = append(buf, 0xFF, 0xFE)
	for _, u := range units {
		buf = append(buf, byte(u), byte(u>>8))
	}
	return buf
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;")
	return replacer.Replace(value)
}

func systemdQuote(value string) string {
	if !strings.ContainsAny(value, " \t\n\"'\\") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func printTerminalQRCode(text string) {
	switch terminalQRMode() {
	case "none":
		return
	case "ansi":
		printANSIQRCode(text)
	case "half":
		qrterminal.GenerateHalfBlock(text, qrterminal.L, os.Stdout)
	default:
		qrterminal.GenerateHalfBlock(text, qrterminal.L, os.Stdout)
	}
}

func printMobileJoinGrantBestEffort(client *pair.Client, id device.Identity) {
	grant, err := client.CreateMobileJoinGrant(id)
	if err != nil {
		fmt.Printf("Could not create mobile join QR: %v\n", err)
		return
	}
	if strings.TrimSpace(grant.QRPayload) == "" {
		return
	}
	fmt.Println()
	fmt.Println("================ Open on phone ================")
	fmt.Println("Scan this QR with your phone to open the same Pockly workspace.")
	fmt.Println("Anyone with this QR can open your Pockly workspace for the next 5 minutes. Share only with your own phone.")
	fmt.Printf("Expires at: %s\n", grant.ExpiresAt.Local().Format(time.RFC1123))
	fmt.Println("================================================")
	printTerminalQRCode(grant.QRPayload)
	fmt.Println(grant.QRPayload)
	fmt.Println()
}

func printANSIQRCode(text string) {
	qrterminal.GenerateWithConfig(text, qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: qrterminal.QUIET_ZONE,
	})
}

func terminalQRMode() string {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("POCKLY_QR_MODE")))
	switch mode {
	case "", "auto":
		return "auto"
	case "ansi", "half", "none":
		return mode
	default:
		return "auto"
	}
}

func startNexusSyncLoop(ctx context.Context, client *pair.Client, id device.Identity, idx *index.Index, syncInterval time.Duration, profile runner.Profile, pushedHints *pushedHintStore) {
	var lastSyncSuccessTelemetry time.Time
	var lastLoggedAt time.Time
	lastLoggedSessions := -1 // sentinel: first sync always logs
	lastCatalogSyncSignature := ""
	lastHistorySync := map[string]string{}
	hintCache := &syncHintCache{}
	catalogMinInterval := catalogSyncMinInterval()
	windowMinInterval := windowSyncMinInterval()
	var lastCatalogPushAt time.Time
	lastCatalogMembership := ""
	lastWindowPushAt := map[string]time.Time{}
	runSync := func() {
		if !idx.FirstScanComplete() {
			return
		}
		if err := idx.RefreshForNexusSync(10 * time.Minute); err != nil {
			log.Printf("Nexus sync refresh stale index: %v", err)
			telemetry.Send(context.Background(), client.BaseURL, id, telemetry.Event{Name: "sync_failed", Command: "serve", Status: "error", ErrorCode: "index_refresh_failed"})
			return
		}
		// Catalog sync carries session metadata and first-message snippets.
		req, err := relay.BuildCatalogSyncRequest(idx, id.DeviceID, profile)
		if err != nil {
			log.Printf("Nexus sync snapshot: %v", err)
			telemetry.Send(context.Background(), client.BaseURL, id, telemetry.Event{Name: "sync_failed", Command: "serve", Status: "error", ErrorCode: "snapshot_failed"})
			return
		}
		// When the catalog fits the sync body budget, it is the complete,
		// authoritative list of sessions this daemon knows about. This loop skips
		// until the first background index scan is complete, so FullReconcile never
		// publishes the boot-time empty snapshot. FullReconcile lets Nexus GC
		// sessions the user has deleted on disk.
		//
		// If the catalog is byte-capped, it is only the newest subset. Do not set
		// FullReconcile in that case or Nexus would delete the older sessions from
		// the web catalog instead of keeping their metadata-only entries.
		//
		// Per-session syncs (syncChangedNexusSessions below) MUST
		// NOT set this flag — they intentionally carry one session + its
		// turns, not the catalog.
		req.FullReconcile = req.CatalogComplete
		signature := catalogSyncSignature(req)
		membership := catalogMembershipSignature(req.Sessions)
		now := time.Now()
		var syncMetrics map[string]int64
		if (signature == "" || signature != lastCatalogSyncSignature) &&
			shouldPushCatalog(now, lastCatalogPushAt, catalogMinInterval, membership != lastCatalogMembership) {
			res, err := client.SyncHistory(id, req)
			if err != nil {
				log.Printf("Nexus sync push: %v", err)
				telemetry.Send(context.Background(), client.BaseURL, id, telemetry.Event{Name: "sync_failed", Command: "serve", Status: "error", ErrorCode: "push_failed"})
				return
			}
			lastCatalogSyncSignature = signature
			lastCatalogMembership = membership
			lastCatalogPushAt = now
			// Dedup the success line. The heartbeat ticker fires constantly;
			// logging every tick buries real signal. Only log when something
			// changed (new turns pushed or session count differs from the
			// previous push), or once every 5 minutes as a still-alive line.
			if res.TurnCount > 0 || res.SessionCount != lastLoggedSessions || res.SessionUpsertCount > 0 || res.SessionDeleteCount > 0 || time.Since(lastLoggedAt) > 5*time.Minute {
				log.Printf(
					"Nexus sync ok: sessions=%d upserts=%d fast_path=%d deletes=%d turns=%d device=%s timings=%s",
					res.SessionCount,
					res.SessionUpsertCount,
					res.SessionFastPathCount,
					res.SessionDeleteCount,
					res.TurnCount,
					res.DaemonDevice,
					formatSyncTimings(res.TimingsMS),
				)
				lastLoggedSessions = res.SessionCount
				lastLoggedAt = time.Now()
			}
			syncMetrics = syncTelemetryMetrics(res)
		}
		// Push the default lazy window for changed recent sessions. The
		// catalog above carries metadata + snippets for every session; this
		// only uploads the bounded turn window the web reader needs by
		// default. Older windows are pulled through explicit lazy backfill.
		historyCandidates := historySyncCatalogSessions(idx, profile, req)
		if syncedSessions, syncedTurns := syncChangedNexusSessions(ctx, client, id, idx, historyCandidates, lastHistorySync, profile, hintCache, pushedHints, lastWindowPushAt, windowMinInterval); syncedSessions > 0 || syncedTurns > 0 {
			log.Printf("Nexus history sync ok: sessions=%d turns=%d device=%s", syncedSessions, syncedTurns, id.DeviceID)
		}
		// Success telemetry is a liveness signal, not metrics: every 30 minutes
		// keeps a day of fleet data at 48 events/daemon instead of 144.
		if time.Since(lastSyncSuccessTelemetry) > 30*time.Minute {
			lastSyncSuccessTelemetry = time.Now()
			telemetry.Send(context.Background(), client.BaseURL, id, telemetry.Event{
				Name:    "sync_completed",
				Command: "serve",
				Status:  "ok",
				Metrics: syncMetrics,
			})
		}
	}

	if syncInterval <= 0 {
		syncInterval = 15 * time.Second
	}
	runSync()

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-idx.Changes():
			runSync()
		case <-ticker.C:
			runSync()
		}
	}
}

func historySyncCatalogSessions(idx *index.Index, profile runner.Profile, catalogReq pair.SyncRequest) []pair.SyncSession {
	if catalogReq.CatalogComplete {
		return catalogReq.Sessions
	}
	return relay.BuildCatalogSyncSessions(idx, profile)
}

func syncTelemetryMetrics(res pair.SyncResponse) map[string]int64 {
	metrics := map[string]int64{
		"session_count":           int64(res.SessionCount),
		"session_upsert_count":    int64(res.SessionUpsertCount),
		"session_fast_path_count": int64(res.SessionFastPathCount),
		"session_delete_count":    int64(res.SessionDeleteCount),
		"turn_count":              int64(res.TurnCount),
	}
	if total, ok := res.TimingsMS["total"]; ok {
		metrics["total_ms"] = int64(total + 0.5)
	}
	return metrics
}

func formatSyncTimings(timings map[string]float64) string {
	if len(timings) == 0 {
		return "-"
	}
	keys := []string{
		"total",
		"auth",
		"read_json",
		"touch_device",
		"upsert_turns",
		"reconcile",
		"load_existing_sessions",
		"build_session_records",
		"filter_unchanged_sessions",
		"upsert_sessions",
	}
	parts := make([]string, 0, len(timings))
	seen := map[string]struct{}{}
	for _, key := range keys {
		if value, ok := timings[key]; ok {
			parts = append(parts, fmt.Sprintf("%s=%.1fms", key, value))
			seen[key] = struct{}{}
		}
	}
	extra := make([]string, 0, len(timings))
	for key := range timings {
		if _, ok := seen[key]; !ok {
			extra = append(extra, key)
		}
	}
	sort.Strings(extra)
	for _, key := range extra {
		parts = append(parts, fmt.Sprintf("%s=%.1fms", key, timings[key]))
	}
	return strings.Join(parts, ",")
}

const (
	defaultSyncWindowDays          = 7
	defaultInitialTurnLimit        = 20
	defaultPriorityTurnLimit       = 100
	activeSessionWindow            = 10 * time.Minute
	maxNexusHistorySessionsPerTick = 8
)

type nexusSyncPolicy struct {
	ProactiveHistorySync bool
	SyncWindowDays       int
	InitialTurnLimit     int
	PriorityTurnLimit    int
}

func defaultNexusSyncPolicy() nexusSyncPolicy {
	proactive := envBoolDefault("POCKLY_PROACTIVE_HISTORY_SYNC", false)
	return nexusSyncPolicy{
		ProactiveHistorySync: proactive,
		SyncWindowDays:       proactiveHistorySyncWindowDays(proactive),
		InitialTurnLimit:     envInt("POCKLY_INITIAL_TURN_LIMIT", defaultInitialTurnLimit, 1, 100),
		PriorityTurnLimit:    envInt("POCKLY_PRIORITY_TURN_LIMIT", defaultPriorityTurnLimit, 1, 100),
	}
}

func proactiveHistorySyncWindowDays(enabled bool) int {
	if !enabled {
		return 0
	}
	return envInt("POCKLY_SYNC_WINDOW_DAYS", defaultSyncWindowDays, 0, 3650)
}

type syncHint struct {
	Reason          string
	PreferredMin    int
	SyncedTurnCount int
	SyncedMinSeq    int
	SyncedMaxSeq    int
	NextBeforeSeq   int
	TotalTurnCount  int
	HasOlderTurns   bool
}

type syncHintCache struct {
	updatedAt time.Time
	hints     map[string]syncHint
}

const (
	// pushedHintTTL mirrors the server's recently-opened window: a pushed
	// hint keeps its session in the priority set for as long as the server
	// would have reported it via the (optional) hint poll.
	pushedHintTTL = 24 * time.Hour
	// pushedHintFreshFor is how long after a push the hinted session may
	// bypass the window-sync floor, so an opened session backfills
	// immediately instead of waiting out the rate limit.
	pushedHintFreshFor   = 2 * time.Minute
	pushedHintMaxEntries = 50
)

// pushedHintStore holds Nexus-pushed SYNC_HINT notices delivered over the
// control WS. Pushing replaces hint polling as the default transport: the
// hint arrives the moment the web opens a session, at zero request cost.
// Written from the control read loop, read from the sync loop.
type pushedHintStore struct {
	mu      sync.Mutex
	entries map[string]pushedHintEntry
}

type pushedHintEntry struct {
	hint     syncHint
	pushedAt time.Time
}

func newPushedHintStore() *pushedHintStore {
	return &pushedHintStore{entries: map[string]pushedHintEntry{}}
}

func (s *pushedHintStore) Add(sessionID string, hint syncHint, now time.Time) {
	if s == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	if _, exists := s.entries[sessionID]; !exists && len(s.entries) >= pushedHintMaxEntries {
		oldestID := ""
		var oldestAt time.Time
		for id, entry := range s.entries {
			if oldestID == "" || entry.pushedAt.Before(oldestAt) {
				oldestID = id
				oldestAt = entry.pushedAt
			}
		}
		delete(s.entries, oldestID)
	}
	s.entries[sessionID] = pushedHintEntry{
		hint:     hint,
		pushedAt: now,
	}
}

func (s *pushedHintStore) UpdateAfterSync(sessionID string, meta pair.SyncSession, now time.Time) {
	if s == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[sessionID]
	if !ok {
		return
	}
	if entry.hint.Reason == "recently_opened" {
		delete(s.entries, sessionID)
		return
	}
	entry.hint = mergeSyncHintAfterWindow(entry.hint, meta)
	if syncHintBackfillComplete(entry.hint) {
		delete(s.entries, sessionID)
		return
	}
	entry.pushedAt = now
	s.entries[sessionID] = entry
}

func (s *pushedHintStore) Snapshot(now time.Time) map[string]syncHint {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	if len(s.entries) == 0 {
		return nil
	}
	out := make(map[string]syncHint, len(s.entries))
	for id, entry := range s.entries {
		out[id] = entry.hint
	}
	return out
}

func (s *pushedHintStore) PushedWithin(sessionID string, now time.Time, window time.Duration) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[sessionID]
	return ok && now.Sub(entry.pushedAt) <= window
}

func (s *pushedHintStore) pruneLocked(now time.Time) {
	for id, entry := range s.entries {
		if now.Sub(entry.pushedAt) > pushedHintTTL {
			delete(s.entries, id)
		}
	}
}

// shouldPushCatalog rate-limits catalog pushes. During an active turn the
// catalog signature changes on every new agent block, but the web only
// refreshes its catalog every ~60s — pushing more often is pure request
// spend. Membership changes (session added/deleted) push immediately so the
// sidebar and Nexus GC stay correct.
func shouldPushCatalog(now, lastPush time.Time, minInterval time.Duration, membershipChanged bool) bool {
	if membershipChanged || lastPush.IsZero() || minInterval <= 0 {
		return true
	}
	return now.Sub(lastPush) >= minInterval
}

// shouldPushWindow rate-limits per-session window builds and pushes. A fresh
// Nexus hint (the user just opened the session) bypasses the floor so the
// backfill lands immediately; live-reader updates flow through the control
// event stream, not this durable path.
func shouldPushWindow(now, lastPush time.Time, minInterval time.Duration, freshlyHinted bool) bool {
	if freshlyHinted || lastPush.IsZero() || minInterval <= 0 {
		return true
	}
	return now.Sub(lastPush) >= minInterval
}

func catalogMembershipSignature(sessions []pair.SyncSession) string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, session.SessionID)
	}
	sort.Strings(ids)
	return strings.Join(ids, "\x00")
}

func catalogSyncMinInterval() time.Duration {
	return envDuration("POCKLY_CATALOG_SYNC_MIN_INTERVAL", 60*time.Second, 0, 24*time.Hour)
}

func windowSyncMinInterval() time.Duration {
	return envDuration("POCKLY_WINDOW_SYNC_MIN_INTERVAL", 60*time.Second, 0, time.Hour)
}

func syncChangedNexusSessions(ctx context.Context, client *pair.Client, id device.Identity, idx *index.Index, sessions []pair.SyncSession, lastHistorySync map[string]string, profile runner.Profile, hintCache *syncHintCache, pushedHints *pushedHintStore, lastWindowPushAt map[string]time.Time, windowMinInterval time.Duration) (int, int) {
	policy := defaultNexusSyncPolicy()
	hints := nexusSyncHints(ctx, client, id, hintCache, pushedHints)
	now := time.Now()
	candidates := recentNexusSessions(sessions, maxNexusHistorySessionsPerTick, policy, hints, now)
	if len(candidates) == 0 {
		return 0, 0
	}

	syncedSessions := 0
	syncedTurns := 0
	for _, session := range candidates {
		if err := ctx.Err(); err != nil {
			return syncedSessions, syncedTurns
		}
		if !shouldPushWindow(now, lastWindowPushAt[session.SessionID], windowMinInterval, pushedHints.PushedWithin(session.SessionID, now, pushedHintFreshFor)) {
			continue
		}
		limit := policy.InitialTurnLimit
		beforeSeq := 0
		if hint, ok := hints[session.SessionID]; ok {
			limit = maxInt(limit, policy.PriorityTurnLimit, hint.PreferredMin)
			beforeSeq = beforeSeqForHint(hint)
		}
		req, err := relay.BuildSingleSessionWindowSyncRequestContext(ctx, idx, id.DeviceID, session.SessionID, profile, relay.SessionWindow{Limit: limit, BeforeSeq: beforeSeq}, nil)
		if err != nil {
			log.Printf("Nexus history sync snapshot session=%s: %v", session.SessionID, err)
			continue
		}
		if len(req.Turns) == 0 {
			lastHistorySync[session.SessionID] = historySyncSignature(req)
			lastWindowPushAt[session.SessionID] = now
			continue
		}
		signature := historySyncSignature(req)
		if signature == "" || lastHistorySync[session.SessionID] == signature {
			lastWindowPushAt[session.SessionID] = now
			continue
		}
		res, err := client.SyncHistoryContext(ctx, id, req)
		if err != nil {
			log.Printf("Nexus history sync push session=%s: %v", session.SessionID, err)
			continue
		}
		lastHistorySync[session.SessionID] = signature
		lastWindowPushAt[session.SessionID] = now
		if len(req.Sessions) > 0 {
			pushedHints.UpdateAfterSync(session.SessionID, req.Sessions[0], now)
		}
		syncedSessions += res.SessionCount
		syncedTurns += res.TurnCount
	}
	return syncedSessions, syncedTurns
}

func beforeSeqForHint(hint syncHint) int {
	if hint.NextBeforeSeq > 1 && (hint.HasOlderTurns || hint.TotalTurnCount <= 0 || hint.SyncedTurnCount < hint.TotalTurnCount) {
		return hint.NextBeforeSeq
	}
	if hint.SyncedMinSeq > 1 && (hint.HasOlderTurns || hint.TotalTurnCount <= 0 || hint.SyncedTurnCount < hint.TotalTurnCount) {
		return hint.SyncedMinSeq
	}
	return 0
}

func syncHintBackfillComplete(hint syncHint) bool {
	return hint.TotalTurnCount > 0 &&
		hint.SyncedTurnCount >= hint.TotalTurnCount &&
		hint.SyncedMaxSeq >= hint.TotalTurnCount &&
		hint.NextBeforeSeq <= 1 &&
		!hint.HasOlderTurns
}

func mergeSyncHintAfterWindow(hint syncHint, meta pair.SyncSession) syncHint {
	if meta.SessionID == "" {
		return hint
	}
	if hint.TotalTurnCount <= 0 {
		hint.TotalTurnCount = meta.TurnCount
	} else if meta.TurnCount > hint.TotalTurnCount {
		hint.TotalTurnCount = meta.TurnCount
	}
	if meta.MinSeq > 0 {
		if hint.SyncedMinSeq <= 0 || meta.MinSeq < hint.SyncedMinSeq {
			hint.SyncedMinSeq = meta.MinSeq
		}
	}
	if meta.MaxSeq > hint.SyncedMaxSeq {
		hint.SyncedMaxSeq = meta.MaxSeq
	}
	if meta.MinSeq > 0 && meta.MaxSeq >= meta.MinSeq {
		hint.SyncedTurnCount += meta.MaxSeq - meta.MinSeq + 1
		if hint.TotalTurnCount > 0 && hint.SyncedTurnCount > hint.TotalTurnCount {
			hint.SyncedTurnCount = hint.TotalTurnCount
		}
	}
	if hint.TotalTurnCount > 0 && hint.SyncedTurnCount >= hint.TotalTurnCount && hint.SyncedMinSeq <= 1 && hint.SyncedMaxSeq >= hint.TotalTurnCount {
		hint.NextBeforeSeq = 0
		hint.HasOlderTurns = false
		return hint
	}
	if meta.MinSeq > 1 && (meta.HasOlder || hint.TotalTurnCount <= 0 || hint.SyncedTurnCount < hint.TotalTurnCount) {
		hint.NextBeforeSeq = meta.MinSeq
	} else {
		hint.NextBeforeSeq = 0
	}
	if hint.TotalTurnCount > 0 && hint.SyncedTurnCount >= hint.TotalTurnCount && hint.SyncedMaxSeq >= hint.TotalTurnCount && hint.NextBeforeSeq <= 1 {
		hint.HasOlderTurns = false
	} else {
		hint.HasOlderTurns = meta.HasOlder || hint.SyncedMinSeq > 1 || (hint.TotalTurnCount > 0 && hint.SyncedTurnCount < hint.TotalTurnCount)
	}
	return hint
}

func nexusSyncHints(ctx context.Context, client *pair.Client, id device.Identity, cache *syncHintCache, pushed *pushedHintStore) map[string]syncHint {
	pushedHints := pushed.Snapshot(time.Now())
	polled := polledNexusSyncHints(ctx, client, id, cache)
	if len(pushedHints) == 0 {
		return polled
	}
	merged := make(map[string]syncHint, len(polled)+len(pushedHints))
	for sessionID, hint := range polled {
		merged[sessionID] = hint
	}
	// Pushed hints win: they are fresher than any poll snapshot.
	for sessionID, hint := range pushedHints {
		merged[sessionID] = hint
	}
	return merged
}

func polledNexusSyncHints(ctx context.Context, client *pair.Client, id device.Identity, cache *syncHintCache) map[string]syncHint {
	interval := syncHintsPollInterval()
	if interval <= 0 {
		return nil
	}
	if cache != nil && cache.hints != nil && time.Since(cache.updatedAt) < interval {
		return cache.hints
	}
	res, err := client.SyncHintsContext(ctx, id)
	if err != nil {
		log.Printf("Nexus sync hints skipped: %v", err)
		if cache != nil && cache.hints != nil {
			return cache.hints
		}
		if cache != nil {
			cache.updatedAt = time.Now()
			cache.hints = map[string]syncHint{}
		}
		return nil
	}
	hints := make(map[string]syncHint, len(res.Sessions))
	for _, entry := range res.Sessions {
		sessionID := strings.TrimSpace(entry.SessionID)
		if sessionID == "" {
			continue
		}
		hints[sessionID] = syncHint{
			Reason:          entry.Reason,
			PreferredMin:    entry.PreferredMin,
			SyncedTurnCount: entry.SyncedTurnCount,
			SyncedMinSeq:    entry.SyncedMinSeq,
			SyncedMaxSeq:    entry.SyncedMaxSeq,
			NextBeforeSeq:   entry.NextBeforeSeq,
			TotalTurnCount:  entry.TotalTurnCount,
			HasOlderTurns:   entry.HasOlderTurns,
		}
	}
	if cache != nil {
		cache.updatedAt = time.Now()
		cache.hints = hints
	}
	return hints
}

func syncHintsPollInterval() time.Duration {
	return envDuration("POCKLY_SYNC_HINTS_POLL_INTERVAL", 10*time.Minute, 0, 24*time.Hour)
}

func recentNexusSessions(sessions []pair.SyncSession, max int, policy nexusSyncPolicy, hints map[string]syncHint, now time.Time) []pair.SyncSession {
	candidates := make([]pair.SyncSession, 0, len(sessions))
	cutoff := syncWindowCutoff(now, policy.SyncWindowDays)
	for _, session := range sessions {
		if session.SessionID == "" {
			continue
		}
		priority := sessionSyncPriority(session, hints, now)
		if !priority && (!policy.ProactiveHistorySync || !sessionWithinSyncWindow(session, cutoff)) {
			continue
		}
		candidates = append(candidates, session)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		priorityI := sessionSyncPriority(candidates[i], hints, now)
		priorityJ := sessionSyncPriority(candidates[j], hints, now)
		if priorityI != priorityJ {
			return priorityI
		}
		if candidates[i].LastTimestamp == candidates[j].LastTimestamp {
			return candidates[i].SessionID > candidates[j].SessionID
		}
		return candidates[i].LastTimestamp > candidates[j].LastTimestamp
	})
	if max > 0 && len(candidates) > max {
		return candidates[:max]
	}
	return candidates
}

func sessionSyncPriority(session pair.SyncSession, hints map[string]syncHint, now time.Time) bool {
	if _, ok := hints[session.SessionID]; ok {
		return true
	}
	return sessionActiveWithin(session, now, activeSessionWindow)
}

func maxInt(values ...int) int {
	out := 0
	for _, value := range values {
		if value > out {
			out = value
		}
	}
	return out
}

func syncWindowCutoff(now time.Time, days int) time.Time {
	if days <= 0 {
		return time.Time{}
	}
	return now.UTC().Add(-time.Duration(days) * 24 * time.Hour)
}

func sessionWithinSyncWindow(session pair.SyncSession, cutoff time.Time) bool {
	if cutoff.IsZero() {
		return true
	}
	ts := strings.TrimSpace(firstNonEmptyString(session.ChannelLastSeenAt, session.LastTimestamp))
	if ts == "" {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		if fallback, fallbackErr := time.Parse(time.RFC3339, ts); fallbackErr == nil {
			parsed = fallback
		} else {
			return false
		}
	}
	return !parsed.UTC().Before(cutoff)
}

func sessionActiveWithin(session pair.SyncSession, now time.Time, window time.Duration) bool {
	if window <= 0 {
		return false
	}
	ts := strings.TrimSpace(firstNonEmptyString(session.ChannelLastSeenAt, session.LastTimestamp))
	if ts == "" {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		if fallback, fallbackErr := time.Parse(time.RFC3339, ts); fallbackErr == nil {
			parsed = fallback
		} else {
			return false
		}
	}
	return !parsed.UTC().Before(now.UTC().Add(-window))
}

func envInt(name string, fallback, min, max int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if value < min {
		return fallback
	}
	if max > 0 && value > max {
		return max
	}
	return value
}

func envDuration(name string, fallback, min, max time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		seconds, convErr := strconv.Atoi(raw)
		if convErr != nil {
			return fallback
		}
		value = time.Duration(seconds) * time.Second
	}
	if value < min {
		return fallback
	}
	if max > 0 && value > max {
		return max
	}
	return value
}

// defaultAgent supplies the conventional agent string for external terminal
// events that did not carry an explicit agent label.
func defaultAgent(v string) string {
	if strings.TrimSpace(v) == "" {
		return "claude-code"
	}
	return v
}

func nexusSessionSyncSignature(session pair.SyncSession) string {
	if session.LastTimestamp == "" {
		return ""
	}
	return strings.Join([]string{
		session.Agent,
		session.RunnerAlias,
		session.Cwd,
		session.LastTimestamp,
		session.ChannelLastSeenAt,
	}, "\x00")
}

func catalogSyncSignature(req pair.SyncRequest) string {
	if len(req.Sessions) == 0 {
		return fmt.Sprintf("full=%t", req.FullReconcile)
	}
	parts := []string{
		fmt.Sprintf("full=%t", req.FullReconcile),
		strconv.Itoa(len(req.Sessions)),
	}
	for _, session := range req.Sessions {
		parts = append(parts,
			session.SessionID,
			nexusSessionSyncSignature(session),
			session.Title,
			session.Snippet,
			session.FirstMessage,
			strconv.Itoa(session.LastSeq),
			strconv.Itoa(session.TurnCount),
			session.SyncState,
		)
	}
	return strings.Join(parts, "\x00")
}

func historySyncSignature(req pair.SyncRequest) string {
	if len(req.Sessions) == 0 {
		return ""
	}
	session := req.Sessions[0]
	parts := []string{
		session.SessionID,
		session.Agent,
		session.RunnerAlias,
		session.Cwd,
		session.LastTimestamp,
		session.ChannelLastSeenAt,
		strconv.Itoa(session.TurnCount),
		strconv.Itoa(session.MinSeq),
		strconv.Itoa(session.MaxSeq),
		strconv.FormatBool(session.HasOlder),
		strconv.Itoa(len(req.Turns)),
	}
	if len(req.Turns) > 0 {
		last := req.Turns[len(req.Turns)-1]
		parts = append(parts,
			strconv.Itoa(last.Seq),
			last.Kind,
			last.Timestamp,
			string(last.Payload),
		)
	}
	return strings.Join(parts, "\x00")
}

func promptAllow(req pair.PendingRequest) (bool, error) {
	fmt.Printf("\nNew browser wants to pair:\n")
	fmt.Printf("  User: %s\n", req.UserDisplay)
	fmt.Printf("  Browser device: %s\n", req.BrowserDeviceName)
	fmt.Printf("  Short code: %s\n", req.ShortCode)
	fmt.Printf("Allow? [y/N]: ")
	var input string
	if _, err := fmt.Fscanln(os.Stdin, &input); err != nil && err.Error() != "unexpected newline" {
		return false, err
	}
	input = strings.TrimSpace(strings.ToLower(input))
	return input == "y" || input == "yes", nil
}

func jsonMarshalIndent(v any) (string, error) {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func envBoolDefault(name string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func enabledText(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

func intPtr(v int) *int {
	return &v
}

// permissionDeciderAdapter implements control.PermissionDecider on
// top of the internal/permission.Store, translating the string
// "allow"/"deny" Nexus sends into the package's typed Decision
// + remapping ErrNotFound into a sentinel error string Nexus can
// surface to the browser (so a double-click after timeout shows the
// right "already decided" toast instead of a generic error).
type permissionDeciderAdapter struct {
	store *permission.Store
}

func (a permissionDeciderAdapter) Decide(requestID, decision string) error {
	return a.store.Decide(requestID, permission.Decision(decision))
}

// sdkDriverAdapter implements control.SDKDriverEnsurer by delegating to
// the sdkdriver.Manager. The narrow interface keeps control free of any
// dependency on sdkdriver (and thus avoids any import cycle if
// sdkdriver later needs control types — e.g. for emitting structured
// inject errors).
type sdkDriverAdapter struct {
	manager  *sdkdriver.Manager
	settings *agentsettings.Store
}

// sdkSettingsReader implements sdkdriver.SettingsReader on top of the
// agent-settings store. The store keys SDK sessions as "sdk:<sid>"
// (see sdkSettingsKey); this adapter does the prefix translation so the
// sdkdriver package doesn't need to know about that convention.
type sdkSettingsReader struct {
	store *agentsettings.Store
}

func (r sdkSettingsReader) ModelForSDKSession(sid string) string {
	return r.store.Get(sdkSettingsKey(sid)).Model
}

func (r sdkSettingsReader) PermissionModeForSDKSession(sid string) string {
	return r.store.Get(sdkSettingsKey(sid)).PermissionMode
}

func (r sdkSettingsReader) EffortForSDKSession(sid string) string {
	return r.store.Get(sdkSettingsKey(sid)).Effort
}

// sdkSessionResolver implements sdkdriver.SessionResolver by looking up
// sid → cwd in the daemon's local session index. Backstop for inject
// requests that arrive with Cwd="" (older Nexus versions, or any other
// path where the cwd metadata didn't make it across the wire).
type sdkSessionResolver struct {
	index *index.Index
}

func (r sdkSessionResolver) CwdForSession(sid string) string {
	if r.index == nil {
		return ""
	}
	ref, ok := r.index.FindSession(sid)
	if !ok {
		return ""
	}
	return ref.Cwd
}

func (r sdkSessionResolver) PathForSession(sid string) string {
	if r.index == nil {
		return ""
	}
	ref, ok := r.index.FindSession(sid)
	if !ok {
		return ""
	}
	return ref.Path
}

// sdkTerminalEventForwarder pipes SDK driver terminal events into the
// daemon's existing externalTerminalEvents channel (the same one the
// PTY wrapper feeds via the HTTP TerminalEventSink). Nexus
// publishTerminal uses Driver="sdk" to bucket these rows correctly in
// terminal_sessions, so deriveSessionConnectionMode can report
// sdk_running for live SDK turns instead of pty_backed_duplex.
type sdkTerminalEventForwarder struct {
	out chan<- control.TerminalEvent
}

func (f sdkTerminalEventForwarder) ForwardSDKTerminalEvent(evt sdkdriver.SDKTerminalEvent) {
	select {
	case f.out <- control.TerminalEvent{
		TerminalSessionID: evt.TerminalSessionID,
		SessionID:         evt.SessionID,
		Agent:             evt.Agent,
		Cwd:               evt.Cwd,
		Kind:              evt.Kind,
		SessionStatus:     evt.SessionStatus,
		TurnStatus:        evt.TurnStatus,
		Payload:           evt.Payload,
		Error:             evt.Error,
		Seq:               evt.Seq,
		Timestamp:         evt.Timestamp,
		Driver:            "sdk",
	}:
	default:
		// Channel full; drop event. Mirrors the wrapper-side sink's
		// default — under sustained overload we'd rather drop a
		// streaming token than block the SDK subprocess's stdout
		// reader.
	}
}

func (a sdkDriverAdapter) EnsureDriver(ctx context.Context, sid, cwd string, agent string) (*liveterminal.ExternalSession, error) {
	// Map the wire-level agent string to the typed Agent enum. Unknown
	// agents return ErrUnsupportedAgent → routeInject translates to
	// sdk_unsupported_agent which web maps to a clear error.
	a2 := sdkdriver.Agent(agent)
	if a2 == "" {
		// Empty agent on inject is legacy data (some catalog rows pre-
		// agent tag). Default to claude-code since that's the only
		// MVP-supported agent anyway.
		a2 = sdkdriver.AgentClaude
	}
	return a.manager.EnsureDriver(ctx, sid, cwd, a2)
}

func (a sdkDriverAdapter) EnsureNewDriver(ctx context.Context, sid, cwd string, agent string, opts control.StartTaskAgentOptions) (*liveterminal.ExternalSession, error) {
	a2 := sdkdriver.Agent(agent)
	if a2 == "" {
		a2 = sdkdriver.AgentClaude
	}
	if a.settings != nil {
		if a2 == sdkdriver.AgentCodex {
			_, _, _, modelOptions := codexModelOptions()
			if model := strings.TrimSpace(opts.Model); model != "" && !codexModelAllowed(model, modelOptions) {
				return nil, fmt.Errorf("unknown_model: %s", model)
			}
			if !isCodexPermissionMode(opts.PermissionMode) {
				return nil, fmt.Errorf("unknown permission_mode: %s", strings.TrimSpace(opts.PermissionMode))
			}
			if !isCodexEffortLevel(opts.Effort) {
				return nil, fmt.Errorf("unknown effort: %s", strings.TrimSpace(opts.Effort))
			}
		} else {
			if err := agentsettings.ValidateApplyRequest(agentsettings.ApplyRequest{
				Model:          opts.Model,
				PermissionMode: opts.PermissionMode,
				Effort:         opts.Effort,
			}); err != nil {
				return nil, err
			}
			// Draft → SDK spawn: reject an unconfigured model before it
			// reaches `claude --model X` so the recorded settings can't
			// diverge from the agent the user actually gets.
			if err := agentsettings.ValidateModelForCwd(cwd, opts.Model); err != nil {
				return nil, err
			}
		}
		key := sdkSettingsKey(sid)
		if model := strings.TrimSpace(opts.Model); model != "" {
			a.settings.SetModel(key, model)
		}
		if mode := strings.TrimSpace(opts.PermissionMode); mode != "" {
			a.settings.SetPermissionMode(key, mode)
		}
		if effort := strings.TrimSpace(opts.Effort); effort != "" {
			a.settings.SetEffort(key, effort)
		}
	}
	return a.manager.EnsureNewDriver(ctx, sid, cwd, a2)
}

// agentSettingsAdapter bridges Nexus-side AGENT_SETTINGS_GET / SET
// control WS messages into the in-memory agentsettings.Store and the
// live terminal manager. It is the daemon-side analogue of
// permissionDeciderAdapter: the control package can't import either
// package without creating a cycle, so main.go assembles the bridge.
//
// Lookup strategy (dual-driver aware, 2026-05-25):
//  1. If terminal_session_id is non-empty AND known, use it (PTY mode).
//  2. Otherwise reverse-lookup a live wrapper by Claude session_id via
//     terminalManager.LookupExternalForInject — drift/attached
//     semantics match the inject path exactly.
//  3. Otherwise (sdk_headless mode): resolve cwd from the daemon's
//     local session index and synthesize ts_id = "sdk:<sid>" so the
//     store can keep separate state per Claude sid. Get returns
//     stored defaults; Set updates the store but does NOT push to a
//     PTY (there isn't one) — sdkdriver.Manager reads the latest
//     stored values when it spawns the next `claude --resume`.
//
// The store's keys are terminal_session_id (string); making them sdk:<sid>
// for SDK mode means PTY and SDK history never collide even if the same
// sid is bound by both drivers (which shouldn't happen — the sid mutex
// prevents it — but defense in depth costs nothing).
type agentSettingsAdapter struct {
	store    *agentsettings.Store
	terminal *liveterminal.Manager
	index    *index.Index
}

// sdkTSPrefix marks synthetic terminal_session_ids used for sdk_headless
// settings. Kept here (not exported via control) because sdkdriver.Manager
// also needs to compute it when reading settings at spawn time — see
// sdkSettingsKey in this file.
const sdkTSPrefix = "sdk:"

func sdkSettingsKey(sid string) string { return sdkTSPrefix + sid }

// resolveResult is what resolve() returns. driver distinguishes the
// two writable modes so Set can branch on push-to-PTY vs store-only.
type agentSettingsResolveResult struct {
	terminalSessionID string
	claudeSessionID   string
	cwd               string
	driver            string // "pty" | "sdk" | ""
	errStr            string
}

// adapterDriverFor returns "pty" or "sdk" for an ExternalSession,
// defaulting empty (legacy wrapper-style register) to "pty". Centralised
// so resolve() can't accidentally treat an SDK-owned session as PTY
// just because the explicit branch was missed — sending /model opus as
// a Claude user prompt is a worse failure than refusing the change.
func adapterDriverFor(ext *liveterminal.ExternalSession) string {
	if ext == nil {
		return ""
	}
	if d := ext.Driver(); d != "" {
		return d
	}
	return "pty"
}

func (a agentSettingsAdapter) resolve(ts, sid string) agentSettingsResolveResult {
	if ts != "" {
		if ext, found := a.terminal.GetExternal(ts); found {
			driver := adapterDriverFor(ext)
			// SDK external sessions are keyed in the agent-settings
			// store by sdkSettingsKey(sid), not by ts — keep the
			// store key consistent with the sdkdriver SettingsReader
			// so changes flow into the next claude --resume spawn.
			storeKey := ts
			if driver == "sdk" {
				if claudeSID := ext.ClaudeSessionID(); claudeSID != "" {
					storeKey = sdkSettingsKey(claudeSID)
				}
			}
			return agentSettingsResolveResult{terminalSessionID: storeKey, claudeSessionID: ext.ClaudeSessionID(), cwd: ext.Cwd(), driver: driver}
		}
	}
	if sid == "" {
		return agentSettingsResolveResult{errStr: "session_not_attached"}
	}
	lookup := a.terminal.LookupExternalForInject(sid)
	if lookup.Ext != nil {
		if lookup.Drifted {
			return agentSettingsResolveResult{errStr: "session_drifted current=" + lookup.CurrentSID}
		}
		driver := adapterDriverFor(lookup.Ext)
		for _, s := range a.terminal.List() {
			if s.ClaudeSessionID == sid {
				if driver == "sdk" {
					// Apply() is a no-op (Shift+Tab / /model) for SDK
					// sessions — the subprocess doesn't speak TUI keys.
					// Key off sdkSettingsKey(sid) instead of the raw ts
					// so the SettingsReader sdkdriver consumes finds
					// the value on next spawn.
					return agentSettingsResolveResult{terminalSessionID: sdkSettingsKey(sid), claudeSessionID: sid, cwd: s.Cwd, driver: "sdk"}
				}
				return agentSettingsResolveResult{terminalSessionID: s.ID, claudeSessionID: s.ClaudeSessionID, cwd: s.Cwd, driver: "pty"}
			}
		}
	}
	// No live wrapper. Under the dual-driver model this is sdk_headless
	// mode (NOT an error) as long as we know about the session — meaning
	// the jsonl is on this machine. Resolve cwd from the local index;
	// if even that doesn't know the sid, fall through to the legacy
	// error so the web shows the dead-session UI.
	if a.index != nil {
		if ref, ok := a.index.FindSession(sid); ok {
			return agentSettingsResolveResult{terminalSessionID: sdkSettingsKey(sid), claudeSessionID: sid, cwd: ref.Cwd, driver: "sdk"}
		}
	}
	return agentSettingsResolveResult{errStr: "session_not_attached"}
}

// availablePermissionModesFor returns the permission-mode list the web
// pill should expose for a given driver. A live PTY can only Shift+Tab
// through the runtime cycle (default/acceptEdits/plan), which is what
// SnapshotFor reports. But an SDK/headless session applies the mode at
// the next `claude --resume --permission-mode ...` spawn — it accepts
// all of Claude's native launch modes (incl. auto/bypassPermissions),
// so the pill must offer them or the user can't reach those modes from
// the UI even though a direct POST is accepted. Mirrors the draft
// composer's Defaults(), which already returns the native launch list.
func availablePermissionModesFor(driver string, runtimeModes []string) []string {
	if driver == "sdk" {
		return agentsettings.NativePermissionModes()
	}
	return runtimeModes
}

// maxGitDiffBytes caps the unified diff returned to the web. base64 over the
// WS + a phone-sized drawer make a huge diff pointless; truncate past this.
const maxGitDiffBytes = 256 << 10

// Diff answers GIT_DIFF_GET: the real `git diff` for the session's working tree
// (uncommitted changes vs HEAD + untracked files). Because it's a live git
// diff, a `git commit` naturally clears it — exactly the "reset on commit"
// behavior we want, mirroring Codex's /diff.
func (a agentSettingsAdapter) Diff(req control.GitDiffGet) control.GitDiffResult {
	// Nexus session cwd is the project *basename* ("demo"), not a usable
	// filesystem path — it's only used for grouping. Resolve the real absolute
	// working-tree cwd from the live terminal session / index instead. Fall
	// back to req.Cwd only if Nexus happened to send an absolute path.
	cwd := strings.TrimSpace(a.resolve(req.TerminalSessionID, req.SessionID).cwd)
	if cwd == "" {
		if c := strings.TrimSpace(req.Cwd); filepath.IsAbs(c) {
			cwd = c
		}
	}
	if cwd == "" {
		return control.GitDiffResult{RequestID: req.RequestID, Status: "error", Error: "session_not_attached"}
	}
	diff, truncated, status := computeGitDiff(cwd)
	return control.GitDiffResult{RequestID: req.RequestID, Status: status, Diff: diff, Truncated: truncated}
}

// runGit runs git in cwd with locks/pager/prompts disabled. Returns stdout even
// on a non-zero exit (e.g. `git diff --no-index` returns 1 when files differ).
func runGit(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	return string(out), err
}

// computeGitDiff builds the working-tree diff: tracked changes vs HEAD (or vs
// the empty tree when there are no commits yet), plus each untracked file as an
// all-added diff. Returns ("", false, "not_a_repo") for non-git directories.
func computeGitDiff(cwd string) (diff string, truncated bool, status string) {
	if out, err := runGit(cwd, "rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(out) != "true" {
		return "", false, "not_a_repo"
	}
	var b strings.Builder
	if _, err := runGit(cwd, "rev-parse", "--verify", "--quiet", "HEAD"); err == nil {
		out, _ := runGit(cwd, "-c", "core.quotepath=false", "diff", "--no-color", "HEAD")
		b.WriteString(out)
	} else {
		// Fresh repo with no commits: diff the (empty) index instead.
		out, _ := runGit(cwd, "-c", "core.quotepath=false", "diff", "--no-color")
		b.WriteString(out)
	}
	// Untracked files → render each as an all-added diff (non-mutating; never
	// touches the index). os.DevNull keeps it cross-platform.
	if others, err := runGit(cwd, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"); err == nil {
		for _, f := range strings.Split(strings.TrimSpace(others), "\n") {
			f = strings.TrimSpace(f)
			if f == "" {
				continue
			}
			out, _ := runGit(cwd, "-c", "core.quotepath=false", "diff", "--no-color", "--no-index", os.DevNull, f)
			b.WriteString(out)
		}
	}
	out := b.String()
	if len(out) > maxGitDiffBytes {
		return out[:maxGitDiffBytes], true, "ok"
	}
	return out, false, "ok"
}

func (a agentSettingsAdapter) Get(req control.AgentSettingsGet) control.AgentSettingsResult {
	res := a.resolve(req.TerminalSessionID, req.SessionID)
	if res.driver == "" {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: res.errStr}
	}
	if isCodexAgentName(req.Agent) {
		return a.codexSettingsSnapshot(req.RequestID, res)
	}
	cwd := firstNonEmptyString(req.Cwd, res.cwd)
	observeSID := firstNonEmptyString(res.claudeSessionID, req.SessionID)
	snap := a.store.SnapshotFor(res.terminalSessionID, cwd)
	displayModel := a.resolveDisplayModel(snap.Current.Model, observeSID, cwd)
	resolvedModel := a.resolveCurrentModel(displayModel, observeSID, cwd)
	return control.AgentSettingsResult{
		RequestID:      req.RequestID,
		Status:         "ok",
		Model:          displayModel,
		ResolvedModel:  resolvedModel,
		PermissionMode: snap.Current.PermissionMode,
		Effort:         snap.Current.Effort,
		// The running model must appear in its own menu — otherwise the
		// pill shows "anthropic-compatible-fast" while the dropdown only lists
		// the config aliases, and the active option has nothing to
		// highlight. The Set path accepts this same augmented set.
		AvailableModels:          ensureModelsPresent(snap.AvailableModels, displayModel, resolvedModel),
		AvailableModelOptions:    convertModelOptions(ensureModelOptionsPresent(snap.AvailableModelOptions, displayModel, resolvedModel)),
		AvailablePermissionModes: availablePermissionModesFor(res.driver, snap.AvailablePermissionModes),
		AvailableEfforts:         snap.AvailableEfforts,
	}
}

// currentRunningModel returns the model claude is actually on for this
// session, ignoring any Pockly-stored override:
//  1. observed — the latest model-bearing jsonl event: assistant
//     message.model after a completed turn, or /model stdout after a
//     confirmed runtime switch but before the next assistant turn.
//  2. effective default — the "model" field in project/user config,
//     for sessions that haven't produced an assistant turn yet.
//
// Returns "" when unknowable (claude on its unnamed built-in default).
func (a agentSettingsAdapter) currentRunningModel(sid, cwd string) string {
	if observed := a.latestObservedCurrentModel(sid); observed != "" {
		return observed
	}
	return agentsettings.EffectiveDefaultModel(cwd)
}

func (a agentSettingsAdapter) latestObservedCurrentModel(sid string) string {
	if ref, ok := a.findClaudeSessionRef(sid); ok {
		if observed := claude.LatestCurrentModel(ref.Path); observed != "" {
			return observed
		}
	}
	return ""
}

// resolveDisplayModel picks the concrete model name for the web's pill:
// the user's explicit pick when set, else whatever claude is actually
// running (currentRunningModel). Empty only when nothing resolves.
func (a agentSettingsAdapter) resolveDisplayModel(stored, sid, cwd string) string {
	if strings.TrimSpace(stored) != "" {
		return stored
	}
	return a.currentRunningModel(sid, cwd)
}

func (a agentSettingsAdapter) resolveCurrentModel(display, sid, cwd string) string {
	if observed := a.latestObservedCurrentModel(sid); strings.TrimSpace(observed) != "" {
		return observed
	}
	if resolved := agentsettings.ResolveModelAlias(display, cwd); strings.TrimSpace(resolved) != "" {
		return resolved
	}
	return a.currentRunningModel(sid, cwd)
}

// ensureModelsPresent returns base with each non-empty model guaranteed
// to appear, prepending any that are missing so the active/current model
// sorts to the front of the pill menu. Used so the running model
// (observed from jsonl or env-derived) is always selectable even when
// ReadModelOptions — which only reads config files — wouldn't list it.
// The menu (offer-set) thus equals what the Set path accepts.
func ensureModelsPresent(base []string, models ...string) []string {
	out := append([]string(nil), base...)
	has := func(m string) bool {
		for _, x := range out {
			if x == m {
				return true
			}
		}
		return false
	}
	// Prepend in reverse so the first model arg ends up first overall.
	for i := len(models) - 1; i >= 0; i-- {
		m := strings.TrimSpace(models[i])
		if m != "" && !has(m) {
			out = append([]string{m}, out...)
		}
	}
	return out
}

func ensureModelOptionsPresent(base []agentsettings.ModelOption, models ...string) []agentsettings.ModelOption {
	out := append([]agentsettings.ModelOption(nil), base...)
	has := func(m string) bool {
		for _, x := range out {
			if x.Value == m || strings.TrimSpace(x.ResolvedModel) == m {
				return true
			}
		}
		return false
	}
	for i := len(models) - 1; i >= 0; i-- {
		m := strings.TrimSpace(models[i])
		if m != "" && !has(m) {
			out = append([]agentsettings.ModelOption{{
				Value:         m,
				Label:         m,
				ResolvedModel: m,
				Source:        "observed",
			}}, out...)
		}
	}
	return out
}

func convertModelOptions(opts []agentsettings.ModelOption) []control.AgentModelOption {
	out := make([]control.AgentModelOption, 0, len(opts))
	for _, opt := range opts {
		out = append(out, control.AgentModelOption{
			Value:         opt.Value,
			Label:         opt.Label,
			ResolvedModel: opt.ResolvedModel,
			Source:        opt.Source,
		})
	}
	return out
}

// RecordInitial persists the model + permission_mode the wrapper was
// just launched with for terminalSessionID, without driving any PTY
// input (the wrapper already received them via CLI flags). Required
// so the first /agent-settings GET against the promoted real session
// reflects the actually-running configuration instead of empty
// defaults that would snap the composer pills back to "sonnet".
func (a agentSettingsAdapter) RecordInitial(terminalSessionID, model, permissionMode, effort string) {
	if terminalSessionID == "" {
		return
	}
	if model = strings.TrimSpace(model); model != "" {
		a.store.SetModel(terminalSessionID, model)
	}
	if mode := strings.TrimSpace(permissionMode); mode != "" {
		a.store.SetPermissionMode(terminalSessionID, mode)
	}
	if eff := strings.TrimSpace(effort); eff != "" {
		a.store.SetEffort(terminalSessionID, eff)
	}
}

func isCodexAgentName(agent string) bool {
	return strings.TrimSpace(agent) == "codex"
}

// codexEffortLevels are the reasoning levels the codex run-config pill offers
// (low/medium/high/xhigh — no claude-only none/minimal/max). Source of truth
// is sdkdriver so the UI list and the per-turn mapping never drift.
var codexEffortLevels = sdkdriver.CodexEffortLevels()

func isCodexEffortLevel(effort string) bool {
	effort = strings.TrimSpace(effort)
	if effort == "" {
		return true
	}
	for _, candidate := range codexEffortLevels {
		if effort == candidate {
			return true
		}
	}
	return false
}

// codexPermissionModes are codex's three approval presets (mapped to
// approvalPolicy + sandbox by sdkdriver.codexApprovalPolicy/codexSandbox).
func codexPermissionModes() []string {
	return sdkdriver.CodexPermissionModes()
}

func isCodexPermissionMode(mode string) bool {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		return true
	}
	for _, candidate := range codexPermissionModes() {
		if mode == candidate {
			return true
		}
	}
	return false
}

// codexDefaultPermissionMode resolves the preset a fresh codex session should
// show when the user hasn't picked one yet, mirroring codex's own config.toml
// (approval_policy + sandbox_mode). Falls back to the cautious request-approval
// preset when codex has no config.
func codexDefaultPermissionMode() string {
	cfg := readCodexConfigModel()
	ap := strings.TrimSpace(cfg.approvalPolicy)
	sb := strings.TrimSpace(cfg.sandboxMode)
	if sb == "danger-full-access" || ap == "never" {
		return sdkdriver.CodexModeFullAccess
	}
	if ap == "on-failure" {
		return sdkdriver.CodexModeApproveForMe
	}
	return sdkdriver.CodexModeRequestApproval
}

// codexDefaultEffort mirrors codex's model_reasoning_effort config, clamped to
// the four levels the pill offers. Codex's effective default is medium.
func codexDefaultEffort() string {
	switch strings.TrimSpace(readCodexConfigModel().reasoningEffort) {
	case "low", "medium", "high", "xhigh":
		return strings.TrimSpace(readCodexConfigModel().reasoningEffort)
	case "minimal":
		return "low"
	default:
		return "medium"
	}
}

func (a agentSettingsAdapter) codexSettingsSnapshot(requestID string, res agentSettingsResolveResult) control.AgentSettingsResult {
	snap := a.store.Get(res.terminalSessionID)
	defaultModel, resolvedDefault, models, modelOptions := codexModelOptions()
	model := strings.TrimSpace(snap.Model)
	if model == "" {
		model = defaultModel
	}
	resolved := codexResolvedModel(model, modelOptions)
	if resolved == "" && model == defaultModel {
		resolved = resolvedDefault
	}
	if resolved == "" {
		resolved = model
	}
	mode := strings.TrimSpace(snap.PermissionMode)
	if mode == "" {
		mode = codexDefaultPermissionMode()
	}
	effort := strings.TrimSpace(snap.Effort)
	if effort == "" {
		effort = codexDefaultEffort()
	}
	return control.AgentSettingsResult{
		RequestID:                requestID,
		Status:                   "ok",
		Model:                    model,
		ResolvedModel:            resolved,
		PermissionMode:           mode,
		Effort:                   effort,
		AvailableModels:          ensureModelsPresent(models, model),
		AvailableModelOptions:    ensureControlModelOptionsPresent(modelOptions, model),
		AvailablePermissionModes: codexPermissionModes(),
		AvailableEfforts:         codexEffortLevels,
	}
}

func (a agentSettingsAdapter) codexDefaults(requestID string) control.AgentDefaultsResult {
	defaultModel, resolvedDefault, models, modelOptions := codexModelOptions()
	return control.AgentDefaultsResult{
		RequestID:                requestID,
		Status:                   "ok",
		DefaultModel:             defaultModel,
		ResolvedModel:            resolvedDefault,
		AvailableModels:          models,
		AvailableModelOptions:    modelOptions,
		AvailablePermissionModes: codexPermissionModes(),
		AvailableEfforts:         codexEffortLevels,
	}
}

func (a agentSettingsAdapter) setCodexSettings(req control.AgentSettingsSet, res agentSettingsResolveResult) control.AgentSettingsResult {
	defaultModel, _, models, modelOptions := codexModelOptions()
	if model := strings.TrimSpace(req.Model); model != "" && !codexModelAllowed(model, modelOptions) {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: "unknown_model: " + model}
	}
	if !isCodexPermissionMode(req.PermissionMode) {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: "unknown permission_mode: " + strings.TrimSpace(req.PermissionMode)}
	}
	if !isCodexEffortLevel(req.Effort) {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: "unknown effort: " + strings.TrimSpace(req.Effort)}
	}
	if model := strings.TrimSpace(req.Model); model != "" {
		a.store.SetModel(res.terminalSessionID, model)
	}
	if mode := strings.TrimSpace(req.PermissionMode); mode != "" {
		a.store.SetPermissionMode(res.terminalSessionID, mode)
	}
	if effort := strings.TrimSpace(req.Effort); effort != "" {
		a.store.SetEffort(res.terminalSessionID, effort)
	}
	snap := a.store.Get(res.terminalSessionID)
	model := strings.TrimSpace(snap.Model)
	if model == "" {
		model = defaultModel
	}
	resolved := codexResolvedModel(model, modelOptions)
	if resolved == "" {
		resolved = model
	}
	mode := strings.TrimSpace(snap.PermissionMode)
	if mode == "" {
		mode = codexDefaultPermissionMode()
	}
	effort := strings.TrimSpace(snap.Effort)
	if effort == "" {
		effort = codexDefaultEffort()
	}
	return control.AgentSettingsResult{
		RequestID:                req.RequestID,
		Status:                   "ok",
		Model:                    model,
		ResolvedModel:            resolved,
		PermissionMode:           mode,
		Effort:                   effort,
		AvailableModels:          ensureModelsPresent(models, model),
		AvailableModelOptions:    ensureControlModelOptionsPresent(modelOptions, model),
		AvailablePermissionModes: codexPermissionModes(),
		AvailableEfforts:         codexEffortLevels,
	}
}

func codexModelOptions() (defaultModel string, resolvedDefault string, models []string, options []control.AgentModelOption) {
	cfg := readCodexConfigModel()
	bin, err := exec.LookPath("codex")
	if err != nil {
		return cfg.model, cfg.model, codexConfigModels(cfg), codexConfigModelOptions(cfg)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	app, err := codexapp.Start(ctx, codexapp.Config{BinaryPath: bin, Logger: log.Printf})
	if err != nil {
		return cfg.model, cfg.model, codexConfigModels(cfg), codexConfigModelOptions(cfg)
	}
	defer app.Close()
	list, err := app.ModelList(ctx)
	if err != nil {
		return cfg.model, cfg.model, codexConfigModels(cfg), codexConfigModelOptions(cfg)
	}
	seen := map[string]bool{}
	for _, model := range list {
		if model.Hidden {
			continue
		}
		value := firstNonEmptyString(model.ID, model.Model)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		resolved := firstNonEmptyString(model.Model, model.ID)
		label := firstNonEmptyString(model.DisplayName, value)
		models = append(models, value)
		options = append(options, control.AgentModelOption{
			Value:         value,
			Label:         label,
			ResolvedModel: resolved,
			Source:        "codex_app_server",
		})
		if model.IsDefault && defaultModel == "" {
			defaultModel = value
			resolvedDefault = resolved
		}
	}
	if cfg.model != "" && !seen[cfg.model] {
		seen[cfg.model] = true
		models = append([]string{cfg.model}, models...)
		options = append([]control.AgentModelOption{codexConfigModelOption(cfg)}, options...)
	}
	if cfg.model != "" {
		defaultModel = cfg.model
		resolvedDefault = cfg.model
	}
	if defaultModel == "" && len(models) > 0 {
		defaultModel = models[0]
		resolvedDefault = options[0].ResolvedModel
	}
	return defaultModel, resolvedDefault, models, options
}

type codexConfigModel struct {
	model         string
	modelProvider string
	// approvalPolicy / sandboxMode / reasoningEffort mirror codex's own
	// config.toml so a fresh codex session in Pockly defaults to whatever
	// the user already runs codex as (see codexDefaultPermissionMode /
	// codexDefaultEffort). Empty when the key is absent.
	approvalPolicy  string
	sandboxMode     string
	reasoningEffort string
}

func readCodexConfigModel() codexConfigModel {
	path := codexConfigPath()
	if path == "" {
		return codexConfigModel{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return codexConfigModel{}
	}
	return parseCodexConfigModel(string(raw))
}

func codexConfigPath() string {
	if home := strings.TrimSpace(os.Getenv("CODEX_HOME")); home != "" {
		return filepath.Join(home, "config.toml")
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "config.toml")
}

func parseCodexConfigModel(raw string) codexConfigModel {
	var out codexConfigModel
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(stripTOMLLineComment(line))
		if line == "" || strings.HasPrefix(line, "[") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = parseTOMLStringValue(strings.TrimSpace(value))
		switch key {
		case "model":
			out.model = value
		case "model_provider":
			out.modelProvider = value
		case "approval_policy":
			out.approvalPolicy = value
		case "sandbox_mode":
			out.sandboxMode = value
		case "model_reasoning_effort":
			out.reasoningEffort = value
		}
	}
	return out
}

func stripTOMLLineComment(line string) string {
	inQuote := false
	escaped := false
	for i, r := range line {
		if escaped {
			escaped = false
			continue
		}
		if r == '\\' && inQuote {
			escaped = true
			continue
		}
		if r == '"' {
			inQuote = !inQuote
			continue
		}
		if r == '#' && !inQuote {
			return line[:i]
		}
	}
	return line
}

func parseTOMLStringValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		if decoded, err := strconv.Unquote(value); err == nil {
			return strings.TrimSpace(decoded)
		}
		return strings.TrimSpace(value[1 : len(value)-1])
	}
	return strings.TrimSpace(value)
}

func codexConfigModels(cfg codexConfigModel) []string {
	if cfg.model == "" {
		return []string{}
	}
	return []string{cfg.model}
}

func codexConfigModelOptions(cfg codexConfigModel) []control.AgentModelOption {
	if cfg.model == "" {
		return []control.AgentModelOption{}
	}
	return []control.AgentModelOption{codexConfigModelOption(cfg)}
}

func codexConfigModelOption(cfg codexConfigModel) control.AgentModelOption {
	label := cfg.model
	if cfg.modelProvider != "" {
		label = cfg.model + " (" + cfg.modelProvider + ")"
	}
	return control.AgentModelOption{
		Value:         cfg.model,
		Label:         label,
		ResolvedModel: cfg.model,
		Source:        "codex_config",
	}
}

func codexModelAllowed(model string, options []control.AgentModelOption) bool {
	model = strings.TrimSpace(model)
	if model == "" {
		return true
	}
	if len(options) == 0 {
		// If model/list is unavailable, do not brick Codex. Codex itself
		// remains the source of truth and will reject unsupported models.
		return true
	}
	for _, opt := range options {
		if opt.Value == model || strings.TrimSpace(opt.ResolvedModel) == model {
			return true
		}
	}
	return false
}

func codexResolvedModel(model string, options []control.AgentModelOption) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return ""
	}
	for _, opt := range options {
		if opt.Value == model || strings.TrimSpace(opt.ResolvedModel) == model {
			if resolved := strings.TrimSpace(opt.ResolvedModel); resolved != "" {
				return resolved
			}
			return opt.Value
		}
	}
	return model
}

func ensureControlModelOptionsPresent(base []control.AgentModelOption, models ...string) []control.AgentModelOption {
	out := append([]control.AgentModelOption(nil), base...)
	has := func(m string) bool {
		for _, x := range out {
			if x.Value == m || strings.TrimSpace(x.ResolvedModel) == m {
				return true
			}
		}
		return false
	}
	for i := len(models) - 1; i >= 0; i-- {
		m := strings.TrimSpace(models[i])
		if m != "" && !has(m) {
			out = append([]control.AgentModelOption{{
				Value:         m,
				Label:         m,
				ResolvedModel: m,
				Source:        "current",
			}}, out...)
		}
	}
	return out
}

// Defaults answers a session-less AGENT_DEFAULTS_GET — the web's
// draft composer needs the available model / permission_mode / effort
// lists before any session exists. We reuse agentsettings.SnapshotFor
// with an empty terminal_session_id; the resulting "current" values
// are zero-valued (which is correct — there's no chosen state yet),
// and the "available" lists pick up project / user .claude.json
// model aliases via ReadModelOptions(cwd).
func (a agentSettingsAdapter) Defaults(req control.AgentDefaultsGet) control.AgentDefaultsResult {
	if isCodexAgentName(req.Agent) {
		return a.codexDefaults(req.RequestID)
	}
	cwd := strings.TrimSpace(req.Cwd)
	snap := a.store.SnapshotFor("", cwd)
	defaultModel := agentsettings.EffectiveDefaultModel(cwd)
	resolvedDefaultModel := agentsettings.ResolveModelAlias(defaultModel, cwd)
	return control.AgentDefaultsResult{
		RequestID:                req.RequestID,
		Status:                   "ok",
		DefaultModel:             defaultModel,
		ResolvedModel:            resolvedDefaultModel,
		AvailableModels:          snap.AvailableModels,
		AvailableModelOptions:    convertModelOptions(snap.AvailableModelOptions),
		AvailablePermissionModes: agentsettings.NativePermissionModes(),
		AvailableEfforts:         snap.AvailableEfforts,
	}
}

func (a agentSettingsAdapter) Set(req control.AgentSettingsSet) control.AgentSettingsResult {
	res := a.resolve(req.TerminalSessionID, req.SessionID)
	if res.driver == "" {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: res.errStr}
	}
	if isCodexAgentName(req.Agent) {
		return a.setCodexSettings(req, res)
	}
	apply := agentsettings.ApplyRequest{
		Model:          req.Model,
		PermissionMode: req.PermissionMode,
		Effort:         req.Effort,
	}
	// Validate the requested model against the cwd-derived known set
	// before either driver acts on it. Done here (not inside Store.Apply)
	// because cwd lives on the resolve result, and it must guard the SDK
	// branch too — both paths otherwise record a model the agent may
	// never have accepted. Mirrors how the runtime-permission-mode guard
	// rejects unsupported modes up front.
	//
	// The currently-running model is always accepted even when it's not
	// in ReadModelOptions (e.g. a mid-session /model the user ran in
	// their own terminal, observed from the jsonl) — it's in the pill
	// menu (see ensureModelsPresent in Get), so re-selecting it must not
	// be rejected. Passing it as extraAllowed keeps offer-set == accept-set.
	observeSID := firstNonEmptyString(res.claudeSessionID, req.SessionID)
	running := a.currentRunningModel(observeSID, res.cwd)
	if err := agentsettings.ValidateModelForCwd(res.cwd, req.Model, running); err != nil {
		return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
	}
	model := strings.TrimSpace(req.Model)
	modelTarget := agentsettings.ResolveModelAlias(model, res.cwd)
	if modelTarget == "" {
		modelTarget = model
	}
	if res.driver == "pty" {
		// Apply runtime mode / effort separately from /model. Claude's
		// TUI can swallow a slash command while it is repainting after a
		// turn, so model switching needs confirmation + retry without
		// repeating Shift+Tab permission-mode cycles.
		nonModelApply := apply
		nonModelApply.Model = ""
		if nonModelApply.PermissionMode != "" || nonModelApply.Effort != "" {
			if err := a.store.Apply(a.terminal, res.terminalSessionID, observeSID, nonModelApply); err != nil {
				return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
			}
		}
		if model != "" {
			if err := a.applyPTYModelWithConfirmation(res.terminalSessionID, observeSID, model, modelTarget); err != nil {
				return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
			}
			a.store.SetModel(res.terminalSessionID, model)
		}
	} else {
		// sdk_headless: no PTY to drive, so we skip the Shift+Tab /
		// /model dance and persist values directly. The shared
		// validator accepts Claude's native launch-time permission modes
		// (including auto/bypassPermissions) while still rejecting unknown
		// modes / effort. Without it, web could send any string and get
		// "ok" back even though the SDK spawn would ignore or reject it
		// later (e.g. effort=high has no claude flag or web keyword).
		if err := agentsettings.ValidateApplyRequest(apply); err != nil {
			return control.AgentSettingsResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
		}
		if model := strings.TrimSpace(req.Model); model != "" {
			a.store.SetModel(res.terminalSessionID, model)
		}
		if mode := strings.TrimSpace(req.PermissionMode); mode != "" {
			a.store.SetPermissionMode(res.terminalSessionID, mode)
		}
		if effort := strings.TrimSpace(req.Effort); effort != "" {
			a.store.SetEffort(res.terminalSessionID, effort)
		}
	}
	snap := a.store.SnapshotFor(res.terminalSessionID, res.cwd)
	displayModel := a.resolveDisplayModel(snap.Current.Model, observeSID, res.cwd)
	resolvedModel := a.resolveCurrentModel(displayModel, observeSID, res.cwd)
	return control.AgentSettingsResult{
		RequestID:                req.RequestID,
		Status:                   "ok",
		Model:                    displayModel,
		ResolvedModel:            resolvedModel,
		PermissionMode:           snap.Current.PermissionMode,
		Effort:                   snap.Current.Effort,
		AvailableModels:          ensureModelsPresent(snap.AvailableModels, displayModel, resolvedModel, running),
		AvailableModelOptions:    convertModelOptions(ensureModelOptionsPresent(snap.AvailableModelOptions, displayModel, resolvedModel, running)),
		AvailablePermissionModes: availablePermissionModesFor(res.driver, snap.AvailablePermissionModes),
		AvailableEfforts:         snap.AvailableEfforts,
	}
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (a agentSettingsAdapter) countModelCommandTargetForSession(sid, target string) (int, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return 0, nil
	}
	ref, ok := a.findClaudeSessionRef(sid)
	if !ok {
		return 0, fmt.Errorf("model_switch_confirmation_session_missing: %s", sid)
	}
	return claude.CountModelCommandTarget(ref.Path, target), nil
}

func (a agentSettingsAdapter) applyPTYModelWithConfirmation(terminalSessionID, claudeSessionID, model, expectedTarget string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		before, err := a.countModelCommandTargetForSession(claudeSessionID, expectedTarget)
		if err != nil {
			return err
		}
		if err := a.store.Apply(a.terminal, terminalSessionID, claudeSessionID, agentsettings.ApplyRequest{Model: model}); err != nil {
			return err
		}
		if err := a.waitForModelCommandConfirmation(claudeSessionID, expectedTarget, before, 20*time.Second); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("model_switch_not_confirmed: expected=%s", expectedTarget)
}

// DeleteSession PERMANENTLY removes a session's local transcript file (the
// claude jsonl or codex rollout) resolved via the session index. Irreversible —
// the web gates it behind an explicit confirm dialog, and Nexus deletes its
// own copy of the session only after this succeeds.
func (a agentSettingsAdapter) DeleteSession(req control.SessionDeleteRequest) control.SessionDeleteResult {
	sid := strings.TrimSpace(req.SessionID)
	if sid == "" {
		return control.SessionDeleteResult{RequestID: req.RequestID, Status: "error", Error: "session_id_required"}
	}
	if a.index == nil {
		return control.SessionDeleteResult{RequestID: req.RequestID, Status: "error", Error: "index_unavailable"}
	}
	ref, ok := a.index.FindSession(sid)
	if (!ok || ref.Path == "") && a.index.Refresh() == nil {
		ref, ok = a.index.FindSession(sid)
	}
	if !ok || strings.TrimSpace(ref.Path) == "" {
		return control.SessionDeleteResult{RequestID: req.RequestID, Status: "error", Error: "session_not_found"}
	}
	if err := os.Remove(ref.Path); err != nil {
		if os.IsNotExist(err) {
			// Already gone — treat as deleted so the web/Nexus cleanup proceeds.
			return control.SessionDeleteResult{RequestID: req.RequestID, Status: "ok", Deleted: []string{ref.Path}}
		}
		return control.SessionDeleteResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
	}
	log.Printf("session delete: removed %s (sid=%s agent=%s)", ref.Path, sid, ref.Agent)
	// Refresh so the next catalog sync stops announcing the deleted session.
	_ = a.index.Refresh()
	return control.SessionDeleteResult{RequestID: req.RequestID, Status: "ok", Deleted: []string{ref.Path}}
}

// Reveal opens a local path in the OS file browser — Finder on macOS, File
// Explorer on Windows, the xdg default on Linux. The path must exist so a
// stale/garbage request can't probe the filesystem beyond an existence check.
// The opener is spawned without waiting on its exit status: explorer.exe
// famously exits non-zero even on success, and a hung opener must not stall
// the control loop.
func (a agentSettingsAdapter) Reveal(req control.RevealRequest) control.RevealResult {
	path := strings.TrimSpace(req.Path)
	if path == "" {
		return control.RevealResult{RequestID: req.RequestID, Status: "error", Error: "path_required"}
	}
	if _, err := os.Stat(path); err != nil {
		return control.RevealResult{RequestID: req.RequestID, Status: "error", Error: "path_not_found"}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return control.RevealResult{RequestID: req.RequestID, Status: "error", Error: err.Error()}
	}
	go func() { _ = cmd.Wait() }()
	return control.RevealResult{RequestID: req.RequestID, Status: "ok"}
}

func (a agentSettingsAdapter) findClaudeSessionRef(sid string) (index.SessionRef, bool) {
	if a.index == nil || strings.TrimSpace(sid) == "" {
		return index.SessionRef{}, false
	}
	ref, ok := a.index.FindSession(sid)
	if (!ok || ref.Path == "") && a.index.Refresh() == nil {
		ref, ok = a.index.FindSession(sid)
	}
	if !ok || ref.Agent != "claude-code" || ref.Path == "" {
		return index.SessionRef{}, false
	}
	return ref, true
}

func (a agentSettingsAdapter) waitForModelCommandConfirmation(sid, expectedTarget string, beforeCount int, timeout time.Duration) error {
	expectedTarget = strings.TrimSpace(expectedTarget)
	if expectedTarget == "" {
		return nil
	}
	// Real Claude TUI can take several seconds to accept a slash command
	// when it has just completed a turn or is repainting. Keep this long
	// enough to avoid returning a false negative while the command is still
	// in flight, but bounded so a swallowed command does not hang the UI.
	deadline := time.Now().Add(timeout)
	for {
		count, err := a.countModelCommandTargetForSession(sid, expectedTarget)
		if err != nil {
			return err
		}
		if count > beforeCount {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("model_switch_not_confirmed: expected=%s", expectedTarget)
		}
		time.Sleep(200 * time.Millisecond)
	}
}
