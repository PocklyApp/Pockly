// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	relay "github.com/PocklyApp/Pockly/daemon/internal/relay"
)

func TestTerminalQRMode(t *testing.T) {
	t.Setenv("POCKLY_QR_MODE", "")
	if got := terminalQRMode(); got != "auto" {
		t.Fatalf("empty mode = %q, want auto", got)
	}

	tests := []struct {
		name string
		env  string
		want string
	}{
		{name: "explicit auto", env: "auto", want: "auto"},
		{name: "ansi", env: "ansi", want: "ansi"},
		{name: "half", env: "half", want: "half"},
		{name: "none", env: "none", want: "none"},
		{name: "trim uppercase", env: "  ANSI  ", want: "ansi"},
		{name: "unknown falls back", env: "png", want: "auto"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("POCKLY_QR_MODE", tt.env)
			if got := terminalQRMode(); got != tt.want {
				t.Fatalf("terminalQRMode() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestShouldOpenBrowser(t *testing.T) {
	tests := []struct {
		name          string
		openBrowser   bool
		noOpenBrowser bool
		want          bool
	}{
		{name: "qr first setup default", openBrowser: false, noOpenBrowser: false, want: false},
		{name: "explicit open browser", openBrowser: true, noOpenBrowser: false, want: true},
		{name: "no open wins", openBrowser: true, noOpenBrowser: true, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldOpenBrowser(tt.openBrowser, tt.noOpenBrowser); got != tt.want {
				t.Fatalf("shouldOpenBrowser() = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestDefaultNexusURLPrefersNexusEnvThenRelayFallback(t *testing.T) {
	t.Setenv("POCKLY_NEXUS_URL", "")
	t.Setenv("POCKLY_RELAY_URL", "")
	if got := defaultNexusURL(); got != "http://127.0.0.1:8787" {
		t.Fatalf("defaultNexusURL() = %q", got)
	}

	t.Setenv("POCKLY_RELAY_URL", "https://legacy-nexus.example")
	if got := defaultNexusURL(); got != "https://legacy-nexus.example" {
		t.Fatalf("defaultNexusURL() with relay env = %q", got)
	}

	t.Setenv("POCKLY_NEXUS_URL", "https://nexus.example")
	if got := defaultNexusURL(); got != "https://nexus.example" {
		t.Fatalf("defaultNexusURL() with nexus env = %q", got)
	}

	if got := resolveNexusURL("https://flag.example"); got != "https://flag.example" {
		t.Fatalf("resolveNexusURL(flag) = %q", got)
	}
}

func TestPathFlagHelpDefaultRedactsHomePath(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	t.Setenv("HOME", home)
	defaultPath := filepath.Join(home, ".config", "pockly-daemon", "device.json")

	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	var buf bytes.Buffer
	fs.SetOutput(&buf)
	value := pathFlag(fs, "identity-file", defaultPath, "daemon identity file path")

	if *value != defaultPath {
		t.Fatalf("pathFlag value = %q, want %q", *value, defaultPath)
	}
	defValue := fs.Lookup("identity-file").DefValue
	if strings.Contains(defValue, home) {
		t.Fatalf("flag default leaked home path: %q", defValue)
	}
	if !strings.HasPrefix(defValue, "~") {
		t.Fatalf("flag default = %q, want redacted home path", defValue)
	}
	fs.PrintDefaults()
	if strings.Contains(buf.String(), home) {
		t.Fatalf("flag help leaked home path: %s", buf.String())
	}
}

func TestShellQuote(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{in: "", want: "''"},
		{in: "/tmp/Pockly App/pockly-daemon", want: "'/tmp/Pockly App/pockly-daemon'"},
		{in: "it's-live", want: "'it'\\''s-live'"},
	}
	for _, tt := range tests {
		if got := shellQuote(tt.in); got != tt.want {
			t.Fatalf("shellQuote(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestLocalAttachURL(t *testing.T) {
	got, err := localAttachURL("http://127.0.0.1:8948/", "ts_demo")
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://127.0.0.1:8948/api/dev/terminal-sessions/ts_demo/attach" {
		t.Fatalf("localAttachURL = %q", got)
	}
}

func TestLiveAttachCommand(t *testing.T) {
	got := liveAttachCommand("/tmp/Pockly App/pockly-daemon", "http://127.0.0.1:8948", "ts_demo")
	want := "'/tmp/Pockly App/pockly-daemon' live-attach --daemon-url 'http://127.0.0.1:8948' --terminal-session-id 'ts_demo' --display transcript"
	if got != want {
		t.Fatalf("liveAttachCommand = %q, want %q", got, want)
	}
}

func TestCompactTranscriptText(t *testing.T) {
	input := "\x1b[2K❯ Reply only OK\r\n✻ Boogieing…\r\n✽ Actualizing…\r\n4ought for2s)\r\nescto\r\n10Ginterrupt\r\nesctointerrupt\r\n2\r\n⎿ Tip: Name your conversations\r\n⏺OK\r\n✻Brewedfor2s\r\n? for shortcuts · ← for agents\r\n"
	got := compactTranscriptText(input)
	if got != "⏺OK" {
		t.Fatalf("compactTranscriptText = %q", got)
	}
}

func TestFormatClaudeStatusLine(t *testing.T) {
	tests := []struct {
		name   string
		status claudeStatus
		want   string
	}{
		{name: "not linked", status: claudeStatus{}, want: "Pockly daemon not linked"},
		{name: "linked unknown devices", status: claudeStatus{Linked: true}, want: "Pockly daemon linked"},
		{name: "linked zero devices", status: claudeStatus{Linked: true, BrowserDeviceCount: intPtr(0)}, want: "Pockly daemon linked · 0 devices paired last known"},
		{name: "linked one device", status: claudeStatus{Linked: true, BrowserDeviceCount: intPtr(1)}, want: "Pockly daemon linked · 1 device paired last known"},
		{name: "linked many devices", status: claudeStatus{Linked: true, BrowserDeviceCount: intPtr(3)}, want: "Pockly daemon linked · 3 devices paired last known"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatClaudeStatusLine(tt.status); got != tt.want {
				t.Fatalf("formatClaudeStatusLine() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDecoratedClaudeStatusLine(t *testing.T) {
	// Strip ANSI escape sequences so the assertion focuses on textual content
	// rather than the exact escape codes.
	strip := func(s string) string {
		var b strings.Builder
		i := 0
		for i < len(s) {
			if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
				j := i + 2
				for j < len(s) && (s[j] < '@' || s[j] > '~') {
					j++
				}
				if j < len(s) {
					j++
				}
				i = j
				continue
			}
			b.WriteByte(s[i])
			i++
		}
		return b.String()
	}
	tests := []struct {
		name   string
		status claudeStatus
		pty    int
		want   string
	}{
		{"not linked", claudeStatus{}, 0, "◇ Pockly daemon not linked"},
		{"linked no pty no count", claudeStatus{Linked: true}, 0, "◆ Pockly · ○ Read-only"},
		{"linked pty no count", claudeStatus{Linked: true}, 1, "◆ Pockly · ⚡ PTY duplex"},
		{"linked pty single device", claudeStatus{Linked: true, BrowserDeviceCount: intPtr(1)}, 1, "◆ Pockly · ⚡ PTY duplex · 1 paired"},
		{"linked pty many", claudeStatus{Linked: true, BrowserDeviceCount: intPtr(3)}, 2, "◆ Pockly · ⚡ PTY duplex ×2 · 3 paired"},
		{"linked readonly devices", claudeStatus{Linked: true, BrowserDeviceCount: intPtr(2)}, 0, "◆ Pockly · ○ Read-only · 2 paired"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := strip(decoratedClaudeStatusLine(tt.status, tt.pty))
			if got != tt.want {
				t.Fatalf("decoratedClaudeStatusLine() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDecoratedClaudeStatusLineUsesANSI(t *testing.T) {
	// Sanity check that we actually emit ANSI when linked (otherwise the strip
	// helper above could pass trivially).
	out := decoratedClaudeStatusLine(claudeStatus{Linked: true}, 1)
	if !strings.Contains(out, "\x1b[") {
		t.Fatalf("expected ANSI escape in decorated output, got %q", out)
	}
}

func TestLivePocklyPTYCountIgnoresExitedAndSDKSessions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/dev/terminal-sessions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"terminal_sessions":[
			{"id":"ts_live_pty","session_status":"live","driver":"pty"},
			{"id":"ts_legacy_pty","session_status":"live"},
			{"id":"ts_starting_pty","session_status":"starting","driver":"pty"},
			{"id":"ts_exited_pty","session_status":"exited","driver":"pty"},
			{"id":"ts_live_sdk","session_status":"live","driver":"sdk"}
		]}`))
	}))
	defer srv.Close()
	t.Setenv("POCKLY_DAEMON_URL", srv.URL)

	if got := livePocklyPTYCount(); got != 3 {
		t.Fatalf("livePocklyPTYCount() = %d, want 3", got)
	}
}

func TestHistorySyncSignatureTracksTurnsWhenCatalogSignatureIsStable(t *testing.T) {
	catalog := pair.SyncSession{
		SessionID:         "sid_race",
		Agent:             "claude-code",
		RunnerAlias:       "claude",
		Cwd:               "25062215",
		LastTimestamp:     "2026-06-03T09:11:34Z",
		ChannelLastSeenAt: "2026-06-03T09:11:34Z",
	}
	first := pair.SyncRequest{
		Sessions: []pair.SyncSession{{
			SessionID:         catalog.SessionID,
			Agent:             catalog.Agent,
			RunnerAlias:       catalog.RunnerAlias,
			Cwd:               catalog.Cwd,
			LastTimestamp:     catalog.LastTimestamp,
			ChannelLastSeenAt: catalog.ChannelLastSeenAt,
			TurnCount:         6,
			MinSeq:            1,
			MaxSeq:            6,
		}},
		Turns: []pair.SyncTurn{{
			SessionID: catalog.SessionID,
			Seq:       6,
			Agent:     catalog.Agent,
			Kind:      "thinking",
			Timestamp: "2026-06-03T09:11:21Z",
			Payload:   json.RawMessage(`{"uuid":"think_1","text":"thinking"}`),
		}},
	}
	second := first
	second.Sessions = []pair.SyncSession{first.Sessions[0]}
	second.Sessions[0].TurnCount = 7
	second.Sessions[0].MaxSeq = 7
	second.Turns = append([]pair.SyncTurn{}, first.Turns...)
	second.Turns = append(second.Turns, pair.SyncTurn{
		SessionID: catalog.SessionID,
		Seq:       7,
		Agent:     catalog.Agent,
		Kind:      "assistant_text",
		Timestamp: "2026-06-03T09:11:21Z",
		Payload:   json.RawMessage(`{"uuid":"text_1","text":"final reply"}`),
	})

	catalogAfterText := catalog
	if nexusSessionSyncSignature(catalog) != nexusSessionSyncSignature(catalogAfterText) {
		t.Fatal("catalog signature should be stable for identical catalog metadata")
	}
	if historySyncSignature(first) == historySyncSignature(second) {
		t.Fatal("history signature did not change when final assistant_text arrived")
	}
}

func TestFormatClaudeCommandStatusAvoidsStableIdentifiers(t *testing.T) {
	status := claudeStatus{
		Linked:             true,
		RelayURL:           "https://nexus.example",
		DaemonDeviceID:     "dd_secret",
		DaemonDeviceName:   "Leo MacBook",
		UserEmail:          "leo@example.com",
		RemoteAccess:       true,
		BrowserDeviceCount: intPtr(1),
		Version:            "dev",
	}
	out := formatClaudeCommandStatus(status)
	for _, forbidden := range []string{"dd_secret", "Leo MacBook", "leo@example.com", "relay_url", "daemon_device_id"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("Claude command output leaked %q: %s", forbidden, out)
		}
	}
	for _, want := range []string{"Pockly daemon linked", "Remote access: enabled", "https://nexus.example/workspace/sessions"} {
		if !strings.Contains(out, want) {
			t.Fatalf("Claude command output missing %q: %s", want, out)
		}
	}
}

func TestClaudeStatusJSONRedactsTokens(t *testing.T) {
	dir := t.TempDir()
	identityFile := filepath.Join(dir, "device.json")
	relayStateFile := filepath.Join(dir, "relay-state.json")
	id := device.Identity{
		DeviceID:   "dd_test",
		DeviceName: "Leo MacBook",
		Hostname:   "host",
		OS:         "darwin",
		PublicKey:  "public",
		PrivateKey: "private-secret",
	}
	writeJSONFile(t, identityFile, id)
	if err := relay.SaveState(relayStateFile, relay.State{
		RelayURL:           "https://nexus.example",
		DaemonDeviceID:     "dd_test",
		UserEmail:          "leo@example.com",
		RemoteAccess:       true,
		DeviceAccessToken:  "access-secret",
		DeviceRefreshToken: "refresh-secret",
		BrowserDeviceCount: intPtr(1),
		LastLoginAt:        time.Now(),
		LastPairedAt:       time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	status := loadClaudeStatus(identityFile, relayStateFile)
	raw, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	out := string(raw)
	for _, secret := range []string{"access-secret", "refresh-secret", "private-secret"} {
		if strings.Contains(out, secret) {
			t.Fatalf("status JSON leaked %q: %s", secret, out)
		}
	}
	if !strings.Contains(out, "Leo MacBook") || !strings.Contains(out, "leo@example.com") {
		t.Fatalf("status JSON missing expected safe fields: %s", out)
	}
}

func TestInstallClaudeIntegrationMergesUnknownSettings(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installed, skipped, err := installClaudeStatusLine(settingsPath, "/tmp/pockly-daemon", false)
	if err != nil {
		t.Fatal(err)
	}
	if !installed || skipped {
		t.Fatalf("installed=%t skipped=%t", installed, skipped)
	}
	settings := readSettingsForTest(t, settingsPath)
	if string(settings["theme"]) != `"dark"` {
		t.Fatalf("theme not preserved: %s", string(settings["theme"]))
	}
	if !isPocklyStatusLine(settings["statusLine"]) {
		t.Fatalf("Pockly statusLine not installed: %s", string(settings["statusLine"]))
	}
}

func TestInstallClaudeIntegrationRemovesOwnedSlashCommand(t *testing.T) {
	dir := t.TempDir()
	commandPath := filepath.Join(dir, "commands", claudeCommandName)
	if err := os.MkdirAll(filepath.Dir(commandPath), 0o700); err != nil {
		t.Fatal(err)
	}
	ownedCommand := []byte("allowed-tools: Bash('/tmp/pockly-daemon claude-status --claude-command')\nWorkspace: https://nexus.example/workspace/sessions\n")
	if err := os.WriteFile(commandPath, ownedCommand, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := installClaudeIntegration(dir, "/tmp/pockly-daemon", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.CommandInstalled {
		t.Fatal("install should not expose /pockly as a Claude skill")
	}
	if _, err := os.Stat(commandPath); !os.IsNotExist(err) {
		t.Fatalf("owned slash command should be removed, got %v", err)
	}
}

func TestInstallClaudeIntegrationDoesNotOverwriteCustomStatusLine(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	custom := `{"type":"command","command":"echo custom"}`
	if err := os.WriteFile(settingsPath, []byte(`{"statusLine":`+custom+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installed, skipped, err := installClaudeStatusLine(settingsPath, "/tmp/pockly-daemon", false)
	if err != nil {
		t.Fatal(err)
	}
	if installed || !skipped {
		t.Fatalf("installed=%t skipped=%t", installed, skipped)
	}
	settings := readSettingsForTest(t, settingsPath)
	if compactJSONForTest(t, settings["statusLine"]) != custom {
		t.Fatalf("custom statusLine overwritten: %s", string(settings["statusLine"]))
	}
}

func TestInstallClaudeIntegrationForceStatusLine(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"statusLine":{"type":"command","command":"echo custom"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	installed, skipped, err := installClaudeStatusLine(settingsPath, "/tmp/pockly-daemon", true)
	if err != nil {
		t.Fatal(err)
	}
	if !installed || skipped {
		t.Fatalf("installed=%t skipped=%t", installed, skipped)
	}
	settings := readSettingsForTest(t, settingsPath)
	if !isPocklyStatusLine(settings["statusLine"]) {
		t.Fatalf("Pockly statusLine not installed: %s", string(settings["statusLine"]))
	}
}

func TestUninstallClaudeIntegrationOnlyRemovesPocklyOwnedStatusLine(t *testing.T) {
	dir := t.TempDir()
	result, err := installClaudeIntegration(dir, "/tmp/pockly-daemon", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(result.CommandPath); !os.IsNotExist(err) {
		t.Fatalf("install should not create /pockly command, got %v", err)
	}
	settings := readSettingsForTest(t, result.SettingsPath)
	settings["theme"] = json.RawMessage(`"dark"`)
	raw, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(result.SettingsPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := uninstallClaudeIntegration(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(result.CommandPath); !os.IsNotExist(err) {
		t.Fatalf("command file still exists or stat failed unexpectedly: %v", err)
	}
	settings = readSettingsForTest(t, result.SettingsPath)
	if _, ok := settings["statusLine"]; ok {
		t.Fatalf("Pockly statusLine not removed: %s", string(settings["statusLine"]))
	}
	if string(settings["theme"]) != `"dark"` {
		t.Fatalf("unknown setting not preserved: %s", string(settings["theme"]))
	}
}

func TestUninstallClaudeIntegrationKeepsCustomStatusLine(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	custom := `{"type":"command","command":"echo custom"}`
	if err := os.MkdirAll(filepath.Join(dir, "commands"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "commands", claudeCommandName), []byte("pockly"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, []byte(`{"statusLine":`+custom+`}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := uninstallClaudeIntegration(dir); err != nil {
		t.Fatal(err)
	}
	settings := readSettingsForTest(t, settingsPath)
	if compactJSONForTest(t, settings["statusLine"]) != custom {
		t.Fatalf("custom statusLine changed: %s", string(settings["statusLine"]))
	}
}

func TestLooksTemporaryPath(t *testing.T) {
	if !looksTemporaryPath(filepath.Join(os.TempDir(), "pockly-daemon")) {
		t.Fatalf("os temp path not detected as temporary")
	}
	if !looksTemporaryPath("/var/folders/example/pockly-daemon") {
		t.Fatalf("darwin temp path not detected as temporary")
	}
	if looksTemporaryPath("/usr/local/bin/pockly-daemon") {
		t.Fatalf("stable path detected as temporary")
	}
}

func TestAgentServicePathIncludesCommonCLIBins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin")

	path := agentServicePath()
	for _, want := range []string{
		"/usr/bin",
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".npm-global", "bin"),
	} {
		if !strings.Contains(path, want) {
			t.Fatalf("agentServicePath() = %q, missing %q", path, want)
		}
	}
}

func writeJSONFile(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readSettingsForTest(t *testing.T, path string) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	return settings
}

func compactJSONForTest(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}
