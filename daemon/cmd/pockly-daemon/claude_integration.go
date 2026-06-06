// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	relay "github.com/PocklyApp/Pockly/daemon/internal/relay"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
)

const (
	claudeCommandName        = "pockly.md"
	pocklyExecutableFragment = "pockly-daemon"
	pocklyStatusLineFragment = "claude-status --statusline"
)

type claudeStatus struct {
	Linked             bool   `json:"linked"`
	RelayURL           string `json:"relay_url,omitempty"`
	DaemonDeviceID     string `json:"daemon_device_id,omitempty"`
	DaemonDeviceName   string `json:"daemon_device_name,omitempty"`
	UserEmail          string `json:"user_email,omitempty"`
	RemoteAccess       bool   `json:"remote_access_enabled"`
	BrowserDeviceCount *int   `json:"browser_device_count,omitempty"`
	Version            string `json:"version"`
}

type claudeIntegrationResult struct {
	CommandInstalled    bool
	StatusLineInstalled bool
	StatusLineSkipped   bool
	CommandPath         string
	SettingsPath        string
}

func runClaudeStatus(args []string) error {
	fs := flag.NewFlagSet("claude-status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	statusline := fs.Bool("statusline", false, "print one-line Claude Code status line")
	jsonOut := fs.Bool("json", false, "print sanitized JSON status")
	claudeCommand := fs.Bool("claude-command", false, "print Claude-safe /pockly command output")
	identityPath, err := device.DefaultPath()
	if err != nil {
		return err
	}
	identityFile := fs.String("identity-file", identityPath, "device identity file path")
	relayStatePath, err := relay.DefaultStatePath()
	if err != nil {
		return err
	}
	relayStateFile := fs.String("relay-state-file", relayStatePath, "relay state file path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	status := loadClaudeStatus(*identityFile, *relayStateFile)
	switch {
	case *jsonOut:
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(status)
	case *claudeCommand:
		fmt.Print(formatClaudeCommandStatus(status))
		return nil
	case *statusline:
		pty := livePocklyPTYCount()
		fmt.Println(decoratedClaudeStatusLine(status, pty))
		return nil
	default:
		fmt.Println(formatClaudeStatusLine(status))
		return nil
	}
}

// livePocklyPTYCount asks the local daemon how many Pockly-managed Claude
// PTYs are currently live. Used to render a PTY-attached badge in the
// Claude Code statusLine. Returns 0 on any failure so the statusLine never
// blocks Claude's UI on a slow or unreachable daemon.
func livePocklyPTYCount() int {
	url := strings.TrimRight(strings.TrimSpace(os.Getenv("POCKLY_DAEMON_URL")), "/")
	if url == "" {
		url = "http://127.0.0.1:8947"
	}
	client := &http.Client{Timeout: 250 * time.Millisecond}
	resp, err := client.Get(url + "/api/dev/terminal-sessions")
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0
	}
	var body struct {
		Sessions []struct {
			ID            string `json:"id"`
			SessionStatus string `json:"session_status"`
			Driver        string `json:"driver"`
		} `json:"terminal_sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return 0
	}
	count := 0
	for _, session := range body.Sessions {
		driver := strings.TrimSpace(session.Driver)
		if driver != "" && driver != "pty" {
			continue
		}
		switch session.SessionStatus {
		case "", string(liveterminal.SessionLive), string(liveterminal.SessionStarting):
			count++
		}
	}
	return count
}

// decoratedClaudeStatusLine renders an ANSI-coloured, icon-bearing one-liner
// for Claude Code's bottom-left statusLine slot. We only get the LEFT side;
// Claude Code paints its own right side ("◆ max · /effort" etc.) and we
// can't reliably right-align without breaking its layout.
//
// Output shape:
//
//	◇ Pockly daemon not linked                   (not paired)
//	◆ Pockly · ○ Read-only · 1 paired           (linked, no PTY)
//	◆ Pockly · ⚡ PTY duplex · 1 paired          (linked, ≥1 PTY)
func decoratedClaudeStatusLine(status claudeStatus, ptyCount int) string {
	const (
		reset     = "\x1b[0m"
		cyanBold  = "\x1b[1;36m"
		greenBold = "\x1b[1;32m"
		dim       = "\x1b[2m"
		dimGray   = "\x1b[90m"
	)
	if !status.Linked {
		return fmt.Sprintf("%s◇ Pockly daemon not linked%s", dim, reset)
	}

	var parts []string
	parts = append(parts, fmt.Sprintf("%s◆%s %sPockly%s", cyanBold, reset, cyanBold, reset))

	if ptyCount > 0 {
		label := "PTY duplex"
		if ptyCount > 1 {
			label = fmt.Sprintf("PTY duplex ×%d", ptyCount)
		}
		parts = append(parts, fmt.Sprintf("%s⚡ %s%s", greenBold, label, reset))
	} else {
		parts = append(parts, fmt.Sprintf("%s○ Read-only%s", dimGray, reset))
	}

	if status.BrowserDeviceCount != nil {
		parts = append(parts, fmt.Sprintf("%s%d paired%s", dimGray, *status.BrowserDeviceCount, reset))
	}

	sep := fmt.Sprintf(" %s·%s ", dimGray, reset)
	return strings.Join(parts, sep)
}

func runClaudeIntegrate(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: pockly-daemon claude-integrate install|uninstall|status")
	}
	switch args[0] {
	case "install":
		fs := flag.NewFlagSet("claude-integrate install", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		forceStatusLine := fs.Bool("force-statusline", false, "replace an existing non-Pockly Claude Code statusLine")
		claudeHomeFlag := fs.String("claude-home", "", "Claude Code config home; defaults to ~/.claude")
		exeFlag := fs.String("exe", "", "pockly-daemon executable path for generated commands")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		claudeHome, err := resolveClaudeHome(*claudeHomeFlag)
		if err != nil {
			return err
		}
		exe := strings.TrimSpace(*exeFlag)
		if exe == "" {
			exe, err = os.Executable()
			if err != nil {
				return fmt.Errorf("resolve executable path: %w", err)
			}
		}
		result, err := installClaudeIntegration(claudeHome, exe, *forceStatusLine)
		if err != nil {
			return err
		}
		printClaudeIntegrationResult(result)
		return nil
	case "uninstall":
		fs := flag.NewFlagSet("claude-integrate uninstall", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		claudeHomeFlag := fs.String("claude-home", "", "Claude Code config home; defaults to ~/.claude")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		claudeHome, err := resolveClaudeHome(*claudeHomeFlag)
		if err != nil {
			return err
		}
		if err := uninstallClaudeIntegration(claudeHome); err != nil {
			return err
		}
		fmt.Println("Claude Code Pockly integration removed.")
		return nil
	case "status":
		fs := flag.NewFlagSet("claude-integrate status", flag.ContinueOnError)
		fs.SetOutput(os.Stderr)
		claudeHomeFlag := fs.String("claude-home", "", "Claude Code config home; defaults to ~/.claude")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		claudeHome, err := resolveClaudeHome(*claudeHomeFlag)
		if err != nil {
			return err
		}
		status, err := claudeIntegrationStatus(claudeHome)
		if err != nil {
			return err
		}
		fmt.Println(status)
		return nil
	default:
		return errors.New("usage: pockly-daemon claude-integrate install|uninstall|status")
	}
}

func loadClaudeStatus(identityFile, relayStateFile string) claudeStatus {
	status := claudeStatus{Version: version.String()}
	if id, err := device.Load(identityFile); err == nil {
		status.DaemonDeviceID = id.DeviceID
		status.DaemonDeviceName = id.DeviceName
	}
	state, err := relay.LoadState(relayStateFile)
	if err != nil {
		return status
	}
	status.Linked = state.DaemonDeviceID != ""
	status.RelayURL = state.RelayURL
	status.UserEmail = state.UserEmail
	status.RemoteAccess = state.RemoteAccess
	status.BrowserDeviceCount = state.BrowserDeviceCount
	if state.DaemonDeviceID != "" {
		status.DaemonDeviceID = state.DaemonDeviceID
	}
	return status
}

func formatClaudeStatusLine(status claudeStatus) string {
	if !status.Linked {
		return "Pockly daemon not linked"
	}
	if status.BrowserDeviceCount == nil {
		return "Pockly daemon linked"
	}
	if *status.BrowserDeviceCount == 1 {
		return "Pockly daemon linked · 1 device paired last known"
	}
	return fmt.Sprintf("Pockly daemon linked · %d devices paired last known", *status.BrowserDeviceCount)
}

func formatClaudeCommandStatus(status claudeStatus) string {
	var b strings.Builder
	b.WriteString(formatClaudeStatusLine(status))
	b.WriteString("\n")
	if status.Linked {
		b.WriteString(fmt.Sprintf("Remote access: %s\n", enabledText(status.RemoteAccess)))
	}
	b.WriteString("Workspace: https://pocklyapp.com/workspace/sessions\n")
	b.WriteString("Connect or re-pair: https://pocklyapp.com/workspace/connect\n")
	return b.String()
}

func resolveClaudeHome(override string) (string, error) {
	if strings.TrimSpace(override) != "" {
		return override, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude"), nil
}

func installClaudeIntegration(claudeHome, exe string, forceStatusLine bool) (claudeIntegrationResult, error) {
	result := claudeIntegrationResult{
		CommandPath:  filepath.Join(claudeHome, "commands", claudeCommandName),
		SettingsPath: filepath.Join(claudeHome, "settings.json"),
	}
	if err := removePocklySlashCommandIfOwned(result.CommandPath); err != nil {
		return result, err
	}

	installed, skipped, err := installClaudeStatusLine(result.SettingsPath, exe, forceStatusLine)
	if err != nil {
		return result, err
	}
	result.StatusLineInstalled = installed
	result.StatusLineSkipped = skipped
	return result, nil
}

func removePocklySlashCommandIfOwned(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read Claude /pockly command: %w", err)
	}
	if !isPocklySlashCommand(raw) {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove Claude /pockly command: %w", err)
	}
	return nil
}

func isPocklySlashCommand(raw []byte) bool {
	text := string(raw)
	return strings.Contains(text, "claude-status --claude-command") &&
		strings.Contains(text, "pocklyapp.com/workspace")
}

func installClaudeStatusLine(settingsPath, exe string, force bool) (installed bool, skipped bool, err error) {
	settings, err := readClaudeSettings(settingsPath)
	if err != nil {
		return false, false, err
	}
	if raw, ok := settings["statusLine"]; ok && len(raw) > 0 && !isPocklyStatusLine(raw) && !force {
		return false, true, nil
	}
	statusLine := map[string]any{
		"type":    "command",
		"command": commandQuote(exe) + " claude-status --statusline",
		"padding": 0,
	}
	raw, err := json.Marshal(statusLine)
	if err != nil {
		return false, false, err
	}
	settings["statusLine"] = raw
	return true, false, writeClaudeSettings(settingsPath, settings)
}

func readClaudeSettings(settingsPath string) (map[string]json.RawMessage, error) {
	settings := map[string]json.RawMessage{}
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return settings, nil
		}
		return nil, fmt.Errorf("read Claude settings: %w", err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return settings, nil
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, fmt.Errorf("decode Claude settings: %w", err)
	}
	return settings, nil
}

func writeClaudeSettings(settingsPath string, settings map[string]json.RawMessage) error {
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o700); err != nil {
		return fmt.Errorf("mkdir Claude settings dir: %w", err)
	}
	raw, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Claude settings: %w", err)
	}
	raw = append(raw, '\n')
	if err := os.WriteFile(settingsPath, raw, 0o600); err != nil {
		return fmt.Errorf("write Claude settings: %w", err)
	}
	return nil
}

func isPocklyStatusLine(raw json.RawMessage) bool {
	var statusLine struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(raw, &statusLine); err != nil {
		return false
	}
	return strings.Contains(statusLine.Command, pocklyExecutableFragment) && strings.Contains(statusLine.Command, pocklyStatusLineFragment)
}

func uninstallClaudeIntegration(claudeHome string) error {
	commandPath := filepath.Join(claudeHome, "commands", claudeCommandName)
	if err := removePocklySlashCommandIfOwned(commandPath); err != nil {
		return err
	}
	settingsPath := filepath.Join(claudeHome, "settings.json")
	settings, err := readClaudeSettings(settingsPath)
	if err != nil {
		return err
	}
	if raw, ok := settings["statusLine"]; ok && isPocklyStatusLine(raw) {
		delete(settings, "statusLine")
		return writeClaudeSettings(settingsPath, settings)
	}
	return nil
}

func claudeIntegrationStatus(claudeHome string) (string, error) {
	commandPath := filepath.Join(claudeHome, "commands", claudeCommandName)
	settingsPath := filepath.Join(claudeHome, "settings.json")
	commandState := "missing"
	if _, err := os.Stat(commandPath); err == nil {
		raw, readErr := os.ReadFile(commandPath)
		if readErr != nil {
			return "", readErr
		}
		if isPocklySlashCommand(raw) {
			commandState = "legacy-installed"
		} else {
			commandState = "custom"
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	settings, err := readClaudeSettings(settingsPath)
	if err != nil {
		return "", err
	}
	statusLineState := "missing"
	if raw, ok := settings["statusLine"]; ok {
		if isPocklyStatusLine(raw) {
			statusLineState = "installed"
		} else {
			statusLineState = "custom"
		}
	}
	return fmt.Sprintf("Claude Code integration: command=%s statusLine=%s", commandState, statusLineState), nil
}

func commandQuote(s string) string {
	if runtime.GOOS == "windows" {
		return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
	}
	return shellQuote(s)
}

func printClaudeIntegrationResult(result claudeIntegrationResult) {
	if result.CommandInstalled {
		fmt.Printf("Claude Code /pockly command installed: %s\n", result.CommandPath)
	}
	switch {
	case result.StatusLineInstalled:
		fmt.Printf("Claude Code statusLine installed: %s\n", result.SettingsPath)
	case result.StatusLineSkipped:
		fmt.Println("Claude Code statusLine already exists; left it unchanged.")
		fmt.Println("Run `pockly-daemon claude-integrate install --force-statusline` to switch it to Pockly.")
	}
}

func installClaudeIntegrationBestEffort() {
	claudeHome, err := resolveClaudeHome("")
	if err != nil {
		fmt.Printf("Claude Code integration skipped: %v\n", err)
		return
	}
	exe, err := stablePocklyExecutablePath()
	if err != nil {
		fmt.Printf("Claude Code integration skipped: %v\n", err)
		return
	}
	result, err := installClaudeIntegration(claudeHome, exe, false)
	if err != nil {
		fmt.Printf("Claude Code integration skipped: %v\n", err)
		return
	}
	printClaudeIntegrationResult(result)
}

func stablePocklyExecutablePath() (string, error) {
	if path, err := exec.LookPath("pockly-daemon"); err == nil && strings.TrimSpace(path) != "" {
		return path, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}
	if looksTemporaryPath(exe) {
		return "", fmt.Errorf("stable pockly-daemon executable not found on PATH; run `pockly-daemon claude-integrate install` after installation")
	}
	return exe, nil
}

func looksTemporaryPath(path string) bool {
	clean := filepath.Clean(path)
	tempRoots := []string{os.TempDir(), "/var/folders"}
	for _, root := range tempRoots {
		root = filepath.Clean(root)
		if clean == root || strings.HasPrefix(clean, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
