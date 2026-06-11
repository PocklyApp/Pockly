// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	relay "github.com/PocklyApp/Pockly/daemon/internal/relay"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
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

func TestCatalogSyncSignatureIgnoresHelloButTracksCatalogChanges(t *testing.T) {
	req := pair.SyncRequest{
		Hello:         pair.HelloMessage{DeviceID: "dd_test", Version: "v1"},
		FullReconcile: true,
		Sessions: []pair.SyncSession{{
			SessionID:         "sid_catalog",
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               "/work/app",
			Title:             "hello",
			Snippet:           "hello",
			FirstMessage:      "hello",
			LastSeq:           1,
			LastTimestamp:     "2026-06-03T09:11:34Z",
			ChannelLastSeenAt: "2026-06-03T09:11:34Z",
			SyncState:         "catalog_only",
			TurnCount:         3,
		}},
	}
	changedHello := req
	changedHello.Hello.Version = "v2"
	if catalogSyncSignature(req) != catalogSyncSignature(changedHello) {
		t.Fatal("catalog signature should ignore hello/version liveness fields")
	}
	changedCatalog := req
	changedCatalog.Sessions = append([]pair.SyncSession{}, req.Sessions...)
	changedCatalog.Sessions[0].LastSeq = 2
	if catalogSyncSignature(req) == catalogSyncSignature(changedCatalog) {
		t.Fatal("catalog signature must change when session metadata changes")
	}
	changedTitle := req
	changedTitle.Sessions = append([]pair.SyncSession{}, req.Sessions...)
	changedTitle.Sessions[0].Title = "renamed"
	if catalogSyncSignature(req) == catalogSyncSignature(changedTitle) {
		t.Fatal("catalog signature must change when session title changes")
	}
}

func TestCatalogSyncFullReconcileRequiresCompleteCatalog(t *testing.T) {
	complete := pair.SyncRequest{CatalogComplete: true}
	complete.FullReconcile = complete.CatalogComplete
	if !complete.FullReconcile {
		t.Fatal("complete catalog should enable full reconcile")
	}

	capped := pair.SyncRequest{CatalogComplete: false}
	capped.FullReconcile = capped.CatalogComplete
	if capped.FullReconcile {
		t.Fatal("capped catalog must not enable full reconcile")
	}
}

func TestDefaultNexusSyncPolicyUsesLowCostLazyDefaults(t *testing.T) {
	t.Setenv("POCKLY_SYNC_WINDOW_DAYS", "")
	t.Setenv("POCKLY_INITIAL_TURN_LIMIT", "")

	policy := defaultNexusSyncPolicy()
	if policy.SyncWindowDays != 7 {
		t.Fatalf("SyncWindowDays = %d, want 7", policy.SyncWindowDays)
	}
	if policy.InitialTurnLimit != 20 {
		t.Fatalf("InitialTurnLimit = %d, want 20", policy.InitialTurnLimit)
	}
}

func TestDefaultNexusSyncPolicyAllowsNeutralOverrides(t *testing.T) {
	t.Setenv("POCKLY_SYNC_WINDOW_DAYS", "14")
	t.Setenv("POCKLY_INITIAL_TURN_LIMIT", "40")

	policy := defaultNexusSyncPolicy()
	if policy.SyncWindowDays != 14 {
		t.Fatalf("SyncWindowDays = %d, want 14", policy.SyncWindowDays)
	}
	if policy.InitialTurnLimit != 40 {
		t.Fatalf("InitialTurnLimit = %d, want 40", policy.InitialTurnLimit)
	}
}

func TestSyncHintsPollIntervalDefaultsToLowFrequencyFallback(t *testing.T) {
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "")
	if got := syncHintsPollInterval(); got != 10*time.Minute {
		t.Fatalf("syncHintsPollInterval() = %v, want low-frequency fallback", got)
	}
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "10m")
	if got := syncHintsPollInterval(); got != 10*time.Minute {
		t.Fatalf("syncHintsPollInterval() = %v, want 10m", got)
	}
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "600")
	if got := syncHintsPollInterval(); got != 10*time.Minute {
		t.Fatalf("numeric syncHintsPollInterval() = %v, want 10m", got)
	}
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	if got := syncHintsPollInterval(); got != 0 {
		t.Fatalf("explicit zero syncHintsPollInterval() = %v, want disabled", got)
	}
}

func TestRecentNexusSessionsFiltersOutsideSyncWindow(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "recent", LastTimestamp: now.Add(-2 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "boundary", LastTimestamp: now.Add(-7 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "old", LastTimestamp: now.Add(-8 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "channel_recent", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{SessionID: "", LastTimestamp: now.Format(time.RFC3339)},
		{SessionID: "missing_time"},
	}

	got := recentNexusSessions(sessions, 0, nexusSyncPolicy{SyncWindowDays: 7, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
	ids := make([]string, 0, len(got))
	for _, session := range got {
		ids = append(ids, session.SessionID)
	}
	want := []string{"recent", "boundary", "channel_recent"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("recentNexusSessions ids = %v, want %v", ids, want)
	}
}

func TestRecentNexusSessionsCanDisableWindowForSelfHostedBackfill(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "old", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "recent", LastTimestamp: now.Add(-1 * time.Hour).Format(time.RFC3339)},
	}
	got := recentNexusSessions(sessions, 1, nexusSyncPolicy{SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
	if len(got) != 1 || got[0].SessionID != "recent" {
		t.Fatalf("recentNexusSessions max/sort = %+v, want only recent", got)
	}
}

func TestRecentNexusSessionsIncludesPriorityHintsOutsideWindow(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "recent", LastTimestamp: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{SessionID: "pinned_old", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "old", LastTimestamp: now.Add(-20 * 24 * time.Hour).Format(time.RFC3339)},
	}
	hints := map[string]syncHint{
		"pinned_old": {Reason: "pinned", PreferredMin: 100},
	}

	got := recentNexusSessions(sessions, 0, nexusSyncPolicy{SyncWindowDays: 7, InitialTurnLimit: 20, PriorityTurnLimit: 100}, hints, now)
	ids := make([]string, 0, len(got))
	for _, session := range got {
		ids = append(ids, session.SessionID)
	}
	want := []string{"pinned_old", "recent"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("recentNexusSessions ids = %v, want %v", ids, want)
	}
}

func TestHistorySyncCatalogSessionsUsesFullIndexWhenCatalogIsCapped(t *testing.T) {
	root := t.TempDir()
	claudeHome := filepath.Join(root, ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-work-app")
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	writeClaudeJSONLForCatalogTest(t, projectDir, "recent-session", "/work/app", now.Add(-1*time.Hour), "recent")
	writeClaudeJSONLForCatalogTest(t, projectDir, "old-session", "/work/app", now.Add(-30*24*time.Hour), "old")

	idx := index.New(index.Config{ClaudeHome: claudeHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	fullReq, err := relay.BuildCatalogSyncRequest(idx, "dd_test", runner.Profile{ClaudeAlias: runner.AliasClaude})
	if err != nil {
		t.Fatal(err)
	}
	if len(fullReq.Sessions) != 2 {
		t.Fatalf("fixture sessions = %d, want 2", len(fullReq.Sessions))
	}

	cappedReq := fullReq
	cappedReq.CatalogComplete = false
	cappedReq.Sessions = fullReq.Sessions[:1]
	got := historySyncCatalogSessions(idx, runner.Profile{ClaudeAlias: runner.AliasClaude}, cappedReq)
	ids := make([]string, 0, len(got))
	for _, session := range got {
		ids = append(ids, session.SessionID)
	}
	if strings.Join(ids, ",") != "recent-session,old-session" {
		t.Fatalf("historySyncCatalogSessions capped ids = %v, want full recency-sorted index", ids)
	}

	completeReq := fullReq
	completeReq.CatalogComplete = true
	completeReq.Sessions = fullReq.Sessions[:1]
	got = historySyncCatalogSessions(idx, runner.Profile{ClaudeAlias: runner.AliasClaude}, completeReq)
	if len(got) != 1 || got[0].SessionID != "recent-session" {
		t.Fatalf("historySyncCatalogSessions complete should reuse request sessions, got %+v", got)
	}
}

func TestSessionActiveWithinUsesRecentChannelActivity(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	if !sessionActiveWithin(pair.SyncSession{LastTimestamp: now.Add(-30 * time.Minute).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-2 * time.Minute).Format(time.RFC3339)}, now, 10*time.Minute) {
		t.Fatal("recent channel activity should count as active")
	}
	if sessionActiveWithin(pair.SyncSession{LastTimestamp: now.Add(-30 * time.Minute).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-20 * time.Minute).Format(time.RFC3339)}, now, 10*time.Minute) {
		t.Fatal("old channel activity should not count as active")
	}
}

func TestRecentNexusSessionsPrioritizesActiveSessionsUnderTickLimit(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "recent_newer", LastTimestamp: now.Add(-1 * time.Minute).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-30 * time.Minute).Format(time.RFC3339)},
		{SessionID: "active_older", LastTimestamp: now.Add(-2 * time.Minute).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-2 * time.Minute).Format(time.RFC3339)},
	}
	got := recentNexusSessions(sessions, 1, nexusSyncPolicy{SyncWindowDays: 7, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
	if len(got) != 1 || got[0].SessionID != "active_older" {
		t.Fatalf("recentNexusSessions = %+v, want active_older first under max limit", got)
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

func writeClaudeJSONLForCatalogTest(t *testing.T, dir, sessionID, cwd string, ts time.Time, text string) {
	t.Helper()
	line := `{"sessionId":"` + sessionID + `","cwd":"` + cwd + `","timestamp":"` + ts.UTC().Format(time.RFC3339Nano) + `","type":"user","message":{"role":"user","content":"` + text + `"}}` + "\n"
	path := filepath.Join(dir, sessionID+".jsonl")
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, ts, ts); err != nil {
		t.Fatal(err)
	}
}

func TestPushedHintStoreAddSnapshotAndTTL(t *testing.T) {
	store := newPushedHintStore()
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	store.Add("sess-a", syncHint{Reason: "recently_opened", PreferredMin: 100}, now)
	store.Add("", syncHint{Reason: "recently_opened", PreferredMin: 100}, now) // ignored

	hints := store.Snapshot(now)
	if len(hints) != 1 {
		t.Fatalf("snapshot len = %d, want 1", len(hints))
	}
	if hint := hints["sess-a"]; hint.Reason != "recently_opened" || hint.PreferredMin != 100 {
		t.Fatalf("hint = %+v, want recently_opened/100", hint)
	}
	if !store.PushedWithin("sess-a", now.Add(time.Minute), pushedHintFreshFor) {
		t.Fatal("hint pushed 1m ago should still count as fresh")
	}
	if store.PushedWithin("sess-a", now.Add(10*time.Minute), pushedHintFreshFor) {
		t.Fatal("hint pushed 10m ago must not count as fresh")
	}
	if got := store.Snapshot(now.Add(pushedHintTTL + time.Minute)); len(got) != 0 {
		t.Fatalf("expired snapshot len = %d, want 0", len(got))
	}
}

func TestPushedHintStoreEvictsOldestAtCapacity(t *testing.T) {
	store := newPushedHintStore()
	base := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	for i := 0; i < pushedHintMaxEntries; i++ {
		store.Add(fmt.Sprintf("sess-%03d", i), syncHint{Reason: "recently_opened", PreferredMin: 100}, base.Add(time.Duration(i)*time.Second))
	}
	store.Add("sess-new", syncHint{Reason: "recently_opened", PreferredMin: 100}, base.Add(time.Hour))
	hints := store.Snapshot(base.Add(time.Hour))
	if len(hints) != pushedHintMaxEntries {
		t.Fatalf("snapshot len = %d, want %d", len(hints), pushedHintMaxEntries)
	}
	if _, ok := hints["sess-000"]; ok {
		t.Fatal("oldest entry should be evicted at capacity")
	}
	if _, ok := hints["sess-new"]; !ok {
		t.Fatal("newest entry must be present")
	}
}

func TestPushedHintStoreTracksBackfillCursor(t *testing.T) {
	store := newPushedHintStore()
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	store.Add("sess-large", syncHint{
		Reason:          "recently_opened",
		PreferredMin:    100,
		SyncedTurnCount: 100,
		SyncedMinSeq:    141,
		SyncedMaxSeq:    240,
		NextBeforeSeq:   141,
		TotalTurnCount:  240,
		HasOlderTurns:   true,
	}, now)

	hint := store.Snapshot(now)["sess-large"]
	if before := beforeSeqForHint(hint); before != 141 {
		t.Fatalf("beforeSeqForHint = %d, want 141", before)
	}

	store.UpdateAfterSync("sess-large", pair.SyncSession{
		SessionID: "sess-large",
		MinSeq:    41,
		MaxSeq:    140,
		TurnCount: 240,
		HasOlder:  true,
	}, now.Add(time.Second))

	hint = store.Snapshot(now.Add(time.Second))["sess-large"]
	if hint.SyncedMinSeq != 41 || hint.SyncedMaxSeq != 240 || hint.SyncedTurnCount != 200 || hint.NextBeforeSeq != 41 || !hint.HasOlderTurns {
		t.Fatalf("hint after middle window = %+v, want 41..240/200/before=41/older", hint)
	}
	if before := beforeSeqForHint(hint); before != 41 {
		t.Fatalf("second beforeSeqForHint = %d, want 41", before)
	}

	store.UpdateAfterSync("sess-large", pair.SyncSession{
		SessionID: "sess-large",
		MinSeq:    1,
		MaxSeq:    40,
		TurnCount: 240,
		HasOlder:  false,
	}, now.Add(2*time.Second))
	if hints := store.Snapshot(now.Add(2 * time.Second)); len(hints) != 0 {
		t.Fatalf("completed hint should be removed, got %+v", hints)
	}
}

func TestPushedHintStoreDoesNotTreatNonContiguousMinMaxAsComplete(t *testing.T) {
	store := newPushedHintStore()
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	store.Add("sess-gap", syncHint{
		Reason:          "recently_opened",
		PreferredMin:    100,
		SyncedTurnCount: 140,
		SyncedMinSeq:    1,
		SyncedMaxSeq:    240,
		NextBeforeSeq:   141,
		TotalTurnCount:  240,
		HasOlderTurns:   true,
	}, now)

	store.UpdateAfterSync("sess-gap", pair.SyncSession{
		SessionID: "sess-gap",
		MinSeq:    41,
		MaxSeq:    140,
		TurnCount: 240,
		HasOlder:  true,
	}, now.Add(time.Second))

	if hints := store.Snapshot(now.Add(time.Second)); len(hints) != 0 {
		t.Fatalf("non-contiguous hint should complete after filling the middle gap, got %+v", hints)
	}
}

func TestShouldPushCatalogFloors(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	if !shouldPushCatalog(now, time.Time{}, time.Minute, false) {
		t.Fatal("first push must always be allowed")
	}
	if !shouldPushCatalog(now, now.Add(-10*time.Second), time.Minute, true) {
		t.Fatal("membership change must bypass the floor")
	}
	if shouldPushCatalog(now, now.Add(-10*time.Second), time.Minute, false) {
		t.Fatal("soft change inside the floor must be throttled")
	}
	if !shouldPushCatalog(now, now.Add(-2*time.Minute), time.Minute, false) {
		t.Fatal("soft change past the floor must push")
	}
	if !shouldPushCatalog(now, now.Add(-time.Second), 0, false) {
		t.Fatal("zero interval disables the floor")
	}
}

func TestShouldPushWindowFloors(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	if !shouldPushWindow(now, time.Time{}, 15*time.Second, false) {
		t.Fatal("first window push must always be allowed")
	}
	if shouldPushWindow(now, now.Add(-5*time.Second), 15*time.Second, false) {
		t.Fatal("window push inside the floor must be throttled")
	}
	if !shouldPushWindow(now, now.Add(-5*time.Second), 15*time.Second, true) {
		t.Fatal("a fresh hint must bypass the floor")
	}
	if !shouldPushWindow(now, now.Add(-20*time.Second), 15*time.Second, false) {
		t.Fatal("window push past the floor must be allowed")
	}
}

func TestCatalogMembershipSignatureIsOrderInsensitive(t *testing.T) {
	left := catalogMembershipSignature([]pair.SyncSession{{SessionID: "b"}, {SessionID: "a"}})
	right := catalogMembershipSignature([]pair.SyncSession{{SessionID: "a"}, {SessionID: "b"}})
	if left != right {
		t.Fatalf("membership signature must be order-insensitive: %q vs %q", left, right)
	}
	if left == catalogMembershipSignature([]pair.SyncSession{{SessionID: "a"}}) {
		t.Fatal("membership signature must change when a session is added/removed")
	}
}
