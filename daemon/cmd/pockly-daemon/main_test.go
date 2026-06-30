// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
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

func TestSyncTelemetryMetricsCarriesLowCardinalityCounters(t *testing.T) {
	got := syncTelemetryMetrics(pair.SyncResponse{
		SessionCount:         344,
		SessionUpsertCount:   1,
		SessionFastPathCount: 343,
		SessionDeleteCount:   2,
		TurnCount:            20,
		TimingsMS:            map[string]float64{"total": 49.6},
	})
	want := map[string]int64{
		"session_count":           344,
		"session_upsert_count":    1,
		"session_fast_path_count": 343,
		"session_delete_count":    2,
		"turn_count":              20,
		"total_ms":                50,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("syncTelemetryMetrics() = %#v, want %#v", got, want)
	}
}

func TestSyncRequestSerializesEmptyKnownWindowSessionIDs(t *testing.T) {
	ids := []string{}
	raw, err := json.Marshal(pair.SyncRequest{
		Hello:                 pair.HelloMessage{DeviceID: "dd_test"},
		Sessions:              []pair.SyncSession{},
		KnownWindowSessionIDs: &ids,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"known_window_session_ids":[]`) {
		t.Fatalf("known_window_session_ids empty slice was not serialized: %s", raw)
	}
}

func TestShouldProbeKnownWindowsOnlyWhenProbeCanAvoidUpload(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	ids := []string{"active", "hinted"}
	lastHistory := map[string]string{"active": "sig"}
	hints := map[string]syncHint{"hinted": {Reason: "recently_opened"}}

	if !shouldProbeKnownWindows(ids, hints, lastHistory, map[string]time.Time{}, now, time.Minute) {
		t.Fatal("expected probe when a hinted session has no server hash and no local signature")
	}
	if !shouldProbeKnownWindows([]string{"active"}, nil, map[string]string{}, map[string]time.Time{}, now, time.Minute) {
		t.Fatal("expected probe after daemon restart when local lastHistorySync is empty")
	}
	if shouldProbeKnownWindows([]string{"active"}, nil, lastHistory, map[string]time.Time{}, now, time.Minute) {
		t.Fatal("did not expect probe when local signature already proves the window was uploaded")
	}
	if shouldProbeKnownWindows([]string{"active"}, nil, map[string]string{}, map[string]time.Time{"active": now.Add(-10 * time.Second)}, now, time.Minute) {
		t.Fatal("did not expect probe inside the known-window probe floor")
	}
}

func TestProbeKnownWindowsSendsMetadataOnlySync(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "probe")
	if err != nil {
		t.Fatal(err)
	}
	var seen pair.SyncRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_probe",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			if err := json.NewDecoder(r.Body).Decode(&seen); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{
				OK: true,
				KnownWindows: []pair.SyncKnownWindow{{
					SessionID:       "sess_probe",
					SyncedMinSeq:    41,
					SyncedMaxSeq:    60,
					SyncedTurnCount: 20,
					WindowHash:      "sha256:probe",
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got := probeKnownWindows(context.Background(), pair.NewClient(srv.URL), identity, []string{"sess_probe"})
	if len(seen.Sessions) != 0 || len(seen.Turns) != 0 || seen.KnownWindowSessionIDs == nil || strings.Join(*seen.KnownWindowSessionIDs, ",") != "sess_probe" {
		t.Fatalf("probe request = %+v, want metadata-only known-window sync", seen)
	}
	if got["sess_probe"].WindowHash != "sha256:probe" || got["sess_probe"].SyncedMinSeq != 41 || got["sess_probe"].SyncedMaxSeq != 60 {
		t.Fatalf("probeKnownWindows = %+v", got)
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

func TestHintMatchesWindowHashRequiresRangeAndHash(t *testing.T) {
	req := pair.SyncRequest{
		Sessions: []pair.SyncSession{{
			SessionID:  "sid_hash",
			MinSeq:     41,
			MaxSeq:     60,
			WindowHash: "sha256:abc",
		}},
	}
	if !hintMatchesWindowHash(syncHint{SyncedMinSeq: 41, SyncedMaxSeq: 60, WindowHash: "sha256:abc"}, req) {
		t.Fatal("matching range/hash should skip upload")
	}
	if hintMatchesWindowHash(syncHint{SyncedMinSeq: 40, SyncedMaxSeq: 60, WindowHash: "sha256:abc"}, req) {
		t.Fatal("different min seq must not skip upload")
	}
	if hintMatchesWindowHash(syncHint{SyncedMinSeq: 41, SyncedMaxSeq: 60, WindowHash: "sha256:other"}, req) {
		t.Fatal("different hash must not skip upload")
	}
	if hintMatchesWindowHash(syncHint{SyncedMinSeq: 41, SyncedMaxSeq: 60}, req) {
		t.Fatal("missing hash must not skip upload")
	}
}

func TestShouldSkipWindowUploadUsesLocalSignatureForRepeatedHintedWindow(t *testing.T) {
	req := pair.SyncRequest{
		Sessions: []pair.SyncSession{{
			SessionID:     "sid_hint",
			LastTimestamp: "2026-06-12T09:59:00Z",
			TurnCount:     60,
			MinSeq:        41,
			MaxSeq:        60,
			WindowHash:    "sha256:current",
		}},
		Turns: []pair.SyncTurn{{
			SessionID: "sid_hint",
			Seq:       60,
			Agent:     "claude-code",
			Kind:      "assistant_text",
			Timestamp: "2026-06-12T10:00:00Z",
			Payload:   json.RawMessage(`{"text":"current"}`),
		}},
	}
	lastSignature := historySyncSignature(req)
	if !shouldSkipWindowUpload(false, syncHint{}, nil, "sid_hint", req, lastSignature) {
		t.Fatal("unhinted matching local signature should skip upload")
	}
	if shouldSkipWindowUpload(true, syncHint{Reason: "recently_opened"}, nil, "sid_hint", req, lastSignature) {
		t.Fatal("recently-opened session must not trust local signature alone; web is actively waiting for the hot tail")
	}
	metadataOnlyChange := req
	metadataOnlyChange.Sessions = []pair.SyncSession{req.Sessions[0]}
	metadataOnlyChange.Sessions[0].LastTimestamp = "2026-06-12T10:01:00Z"
	metadataOnlyChange.Sessions[0].ChannelLastSeenAt = "2026-06-12T10:01:00Z"
	metadataOnlyChange.Sessions[0].TurnCount = 61
	metadataOnlyChange.Sessions[0].LastSeq = 61
	if historySyncSignature(metadataOnlyChange) != lastSignature {
		t.Fatal("window signature should ignore catalog-only metadata changes")
	}
	if shouldSkipWindowUpload(true, syncHint{Reason: "recently_opened"}, nil, "sid_hint", metadataOnlyChange, lastSignature) {
		t.Fatal("recently-opened metadata-only change still needs server proof before skipping")
	}
	if shouldSkipWindowUpload(true, syncHint{Reason: "recently_opened"}, nil, "sid_hint", req, "") {
		t.Fatal("hinted session without local signature should upload the first window")
	}
	if !shouldSkipWindowUpload(true, syncHint{SyncedMinSeq: 41, SyncedMaxSeq: 60, WindowHash: "sha256:current"}, nil, "sid_hint", req, lastSignature) {
		t.Fatal("hinted matching server hash should skip upload")
	}
	if !shouldSkipWindowUpload(true, syncHint{Reason: "recently_opened"}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 41, SyncedMaxSeq: 60, WindowHash: "sha256:current"},
	}, "sid_hint", req, lastSignature) {
		t.Fatal("known window matching server hash should skip upload")
	}
	if shouldSkipWindowUpload(false, syncHint{}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 41, SyncedMaxSeq: 60, WindowHash: "sha256:stale"},
	}, "sid_hint", req, lastSignature) {
		t.Fatal("mismatched known server window must force upload even when local signature matches")
	}
	if !shouldSkipWindowUpload(false, syncHint{}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 40, SyncedMaxSeq: 60, WindowHash: "sha256:current"},
	}, "sid_hint", req, lastSignature) {
		t.Fatal("known server tail that covers the local hot window should skip upload")
	}
	if !shouldSkipWindowUpload(false, syncHint{}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 21, SyncedMaxSeq: 60, WindowHash: "sha256:larger-tail"},
	}, "sid_hint", req, "") {
		t.Fatal("known server window covering local hot window should skip upload without local signature")
	}
	if shouldSkipWindowUpload(false, syncHint{}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 21, SyncedMaxSeq: 59, WindowHash: "sha256:partial-tail"},
	}, "sid_hint", req, lastSignature) {
		t.Fatal("known server window that does not cover local max seq must force upload")
	}
	if shouldSkipWindowUpload(true, syncHint{Reason: "recently_opened"}, map[string]syncHint{
		"sid_hint": {SyncedMinSeq: 21, SyncedMaxSeq: 60, WindowHash: "sha256:larger-tail"},
	}, "sid_hint", req, lastSignature) {
		t.Fatal("recently-opened session must not let a larger stale server tail suppress a web-requested refresh")
	}
}

func TestTrimKnownUploadedTurnsKeepsOnlyNewTail(t *testing.T) {
	req := pair.SyncRequest{
		Sessions: []pair.SyncSession{{
			SessionID:  "sid_tail",
			MinSeq:     81,
			MaxSeq:     100,
			WindowHash: "sha256:local",
		}},
	}
	for seq := 81; seq <= 100; seq++ {
		req.Turns = append(req.Turns, pair.SyncTurn{
			SessionID: "sid_tail",
			Seq:       seq,
			Agent:     "claude-code",
			Kind:      "assistant_text",
			Payload:   json.RawMessage(fmt.Sprintf(`{"seq":%d}`, seq)),
		})
	}

	trimmed := trimKnownUploadedTurns(req, syncHint{SyncedMinSeq: 1, SyncedMaxSeq: 97, SyncedTurnCount: 97})
	if len(trimmed.Turns) != 3 {
		t.Fatalf("trimmed turns = %d, want 3", len(trimmed.Turns))
	}
	if trimmed.Turns[0].Seq != 98 || trimmed.Turns[2].Seq != 100 {
		t.Fatalf("trimmed seq range = %d..%d, want 98..100", trimmed.Turns[0].Seq, trimmed.Turns[2].Seq)
	}
	if len(trimmed.Sessions) != 1 || trimmed.Sessions[0].MinSeq != 98 || trimmed.Sessions[0].MaxSeq != 100 {
		t.Fatalf("trimmed session range = %+v, want 98..100", trimmed.Sessions)
	}
	if trimmed.Sessions[0].WindowHash == "" || trimmed.Sessions[0].WindowHash == "sha256:local" {
		t.Fatalf("trimmed session window hash = %q, want recomputed hash", trimmed.Sessions[0].WindowHash)
	}
	if !trimmed.Sessions[0].HasOlder {
		t.Fatalf("trimmed incremental tail must keep has_older=true")
	}
}

func TestTrimKnownUploadedTurnsKeepsDisjointOrCompleteWindow(t *testing.T) {
	req := pair.SyncRequest{
		Sessions: []pair.SyncSession{{
			SessionID: "sid_tail",
			MinSeq:    81,
			MaxSeq:    100,
		}},
		Turns: []pair.SyncTurn{
			{SessionID: "sid_tail", Seq: 81},
			{SessionID: "sid_tail", Seq: 100},
		},
	}
	if got := trimKnownUploadedTurns(req, syncHint{SyncedMaxSeq: 60}); len(got.Turns) != len(req.Turns) {
		t.Fatalf("disjoint known window should not trim: %+v", got.Turns)
	}
	if got := trimKnownUploadedTurns(req, syncHint{SyncedMaxSeq: 100}); len(got.Turns) != len(req.Turns) {
		t.Fatalf("complete known window should be handled by skip path, not trim: %+v", got.Turns)
	}
}

func TestSyncChangedNexusSessionsSkipsUploadWhenHintWindowHashMatches(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_hash_skip",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 100},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 || windowReq.Sessions[0].WindowHash == "" {
		t.Fatalf("fixture did not produce window hash: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "hash skip")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_hash_skip",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	hints := newPushedHintStore()
	now := time.Now()
	hints.Add(sessionID, syncHint{
		Reason:          "recently_opened",
		PreferredMin:    100,
		SyncedTurnCount: meta.TurnCount,
		SyncedMinSeq:    meta.MinSeq,
		SyncedMaxSeq:    meta.MaxSeq,
		NextBeforeSeq:   0,
		TotalTurnCount:  meta.TurnCount,
		HasOlderTurns:   meta.HasOlder,
		WindowHash:      meta.WindowHash,
	}, now)

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     time.Now().UTC().Format(time.RFC3339),
			ChannelLastSeenAt: time.Now().UTC().Format(time.RFC3339),
			TurnCount:         meta.TurnCount,
		}},
		map[string]string{},
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		hints.Snapshot(now),
		hints,
		nil,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 0 || result.Turns != 0 {
		t.Fatalf("synced sessions/turns = %d/%d, want 0/0", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 0 {
		t.Fatalf("sync POST count = %d, want 0", got)
	}
}

func TestSyncChangedNexusSessionsSkipsUploadWhenKnownWindowHashMatches(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_known_skip",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 20},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 || windowReq.Sessions[0].WindowHash == "" {
		t.Fatalf("fixture did not produce window hash: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "known skip")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_known_skip",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     time.Now().UTC().Format(time.RFC3339),
			ChannelLastSeenAt: time.Now().UTC().Format(time.RFC3339),
			TurnCount:         meta.TurnCount,
		}},
		map[string]string{},
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		nil,
		newPushedHintStore(),
		map[string]syncHint{
			sessionID: {
				SyncedTurnCount: meta.TurnCount,
				SyncedMinSeq:    meta.MinSeq,
				SyncedMaxSeq:    meta.MaxSeq,
				WindowHash:      meta.WindowHash,
			},
		},
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 0 || result.Turns != 0 {
		t.Fatalf("synced sessions/turns = %d/%d, want 0/0", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 0 {
		t.Fatalf("sync POST count = %d, want 0", got)
	}
}

func TestSyncChangedNexusSessionsSkipsUploadWhenKnownServerTailCoversLocalWindow(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_known_cover",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 20},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 || windowReq.Sessions[0].WindowHash == "" {
		t.Fatalf("fixture did not produce window hash: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "known cover")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_known_cover",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     time.Now().UTC().Format(time.RFC3339),
			ChannelLastSeenAt: time.Now().UTC().Format(time.RFC3339),
			TurnCount:         meta.TurnCount,
		}},
		map[string]string{},
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		nil,
		newPushedHintStore(),
		map[string]syncHint{
			sessionID: {
				SyncedTurnCount: meta.MaxSeq,
				SyncedMinSeq:    maxInt(1, meta.MinSeq-20),
				SyncedMaxSeq:    meta.MaxSeq,
				WindowHash:      "sha256:larger-contiguous-tail",
			},
		},
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 0 || result.Turns != 0 {
		t.Fatalf("synced sessions/turns = %d/%d, want 0/0", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 0 {
		t.Fatalf("sync POST count = %d, want 0", got)
	}
}

func TestDaemonRestartKnownWindowProbeAvoidsWindowReupload(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_probe_restart",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 20},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 || windowReq.Sessions[0].WindowHash == "" {
		t.Fatalf("fixture did not produce window hash: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "known probe restart")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	var windowUploads atomic.Int64
	var probeRequests atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_probe_restart",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			var req pair.SyncRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode sync request: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if len(req.Turns) > 0 {
				windowUploads.Add(1)
			}
			if req.KnownWindowSessionIDs != nil && len(req.Sessions) == 0 && len(req.Turns) == 0 {
				probeRequests.Add(1)
				_ = json.NewEncoder(w).Encode(pair.SyncResponse{
					OK: true,
					KnownWindows: []pair.SyncKnownWindow{{
						SessionID:       sessionID,
						SyncedTurnCount: meta.TurnCount,
						SyncedMinSeq:    meta.MinSeq,
						SyncedMaxSeq:    meta.MaxSeq,
						WindowHash:      meta.WindowHash,
					}},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: len(req.Sessions), TurnCount: len(req.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 6, 12, 12, 0, 0, 0, time.UTC)
	lastHistorySync := map[string]string{}
	lastProbeAt := map[string]time.Time{}
	candidates := []pair.SyncSession{{
		SessionID:         sessionID,
		Agent:             "claude-code",
		RunnerAlias:       "claude",
		Cwd:               meta.Cwd,
		LastTimestamp:     now.Format(time.RFC3339),
		ChannelLastSeenAt: now.Format(time.RFC3339),
		TurnCount:         meta.TurnCount,
	}}
	hints := map[string]syncHint{}
	knownWindowSessionIDs := knownWindowSessionIDsForCatalog(
		candidates,
		nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100},
		hints,
		now,
	)
	if !shouldProbeKnownWindows(knownWindowSessionIDs, hints, lastHistorySync, lastProbeAt, now, time.Minute) {
		t.Fatal("daemon restart with empty lastHistorySync should probe known windows before uploading")
	}
	knownWindows := probeKnownWindows(context.Background(), pair.NewClient(srv.URL), identity, knownWindowSessionIDs)
	if got := probeRequests.Load(); got != 1 {
		t.Fatalf("known-window probe requests = %d, want 1", got)
	}
	if knownWindows[sessionID].WindowHash != meta.WindowHash {
		t.Fatalf("known window hash = %q, want %q", knownWindows[sessionID].WindowHash, meta.WindowHash)
	}
	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		candidates,
		lastHistorySync,
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		hints,
		newPushedHintStore(),
		knownWindows,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 0 || result.Turns != 0 {
		t.Fatalf("synced sessions/turns = %d/%d, want 0/0", result.Sessions, result.Turns)
	}
	if got := windowUploads.Load(); got != 0 {
		t.Fatalf("window upload requests = %d, want 0", got)
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("total sync POSTs = %d, want only the metadata probe", got)
	}
}

func TestSyncChangedNexusSessionsUploadsRecentlyOpenedWindowUntilServerProof(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_hint_resync",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: defaultPriorityTurnLimit},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 {
		t.Fatalf("fixture did not produce session metadata: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "hint skip repeated")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_hint_resync",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: 1, TurnCount: len(windowReq.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	lastHistorySync := map[string]string{sessionID: historySyncSignature(windowReq)}
	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     meta.LastTimestamp,
			ChannelLastSeenAt: meta.ChannelLastSeenAt,
			TurnCount:         meta.TurnCount,
		}},
		lastHistorySync,
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		map[string]syncHint{
			sessionID: {Reason: "recently_opened", PreferredMin: 20},
		},
		newPushedHintStore(),
		nil,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 1 || result.Turns != len(windowReq.Turns) {
		t.Fatalf("synced sessions/turns = %d/%d, want 1/%d", result.Sessions, result.Turns, len(windowReq.Turns))
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("sync POST count = %d, want 1", got)
	}
}

func TestSyncChangedNexusSessionsUploadsFirstHintedWindowWithoutLocalSignature(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_hint_first",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: defaultPriorityTurnLimit},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(windowReq.Sessions) != 1 {
		t.Fatalf("fixture did not produce session metadata: %+v", windowReq.Sessions)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "hint first upload")
	if err != nil {
		t.Fatal(err)
	}

	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_hint_first",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			var req pair.SyncRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode sync request: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if len(req.Turns) != len(windowReq.Turns) {
				t.Errorf("turns uploaded = %d, want %d", len(req.Turns), len(windowReq.Turns))
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: 1, TurnCount: len(req.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	lastHistorySync := map[string]string{}
	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     meta.LastTimestamp,
			ChannelLastSeenAt: meta.ChannelLastSeenAt,
			TurnCount:         meta.TurnCount,
		}},
		lastHistorySync,
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		map[string]syncHint{
			sessionID: {Reason: "recently_opened", PreferredMin: 20},
		},
		newPushedHintStore(),
		nil,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 1 || result.Turns != len(windowReq.Turns) {
		t.Fatalf("synced sessions/turns = %d/%d, want 1/%d", result.Sessions, result.Turns, len(windowReq.Turns))
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("sync POST count = %d, want 1", got)
	}
	if lastHistorySync[sessionID] == "" {
		t.Fatal("first hinted upload should seed local history signature")
	}
}

func TestSyncChangedNexusSessionsSkipsWindowBuildWhenBackgroundCandidateMetadataUnchanged(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_PROACTIVE_HISTORY_SYNC", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "metadata skip")
	if err != nil {
		t.Fatal(err)
	}
	idx := index.New(index.Config{})
	now := time.Now().Add(-2 * activeSessionWindow).UTC().Format(time.RFC3339)
	candidate := pair.SyncSession{
		SessionID:         "sess_meta_skip",
		Agent:             "claude-code",
		RunnerAlias:       "claude",
		Cwd:               "work",
		LastTimestamp:     now,
		ChannelLastSeenAt: now,
		TurnCount:         20,
	}
	lastHistorySync := map[string]string{candidate.SessionID: "already-confirmed"}
	lastWindowMeta := map[string]string{
		candidate.SessionID: historyCandidateMetaSignature(candidate, defaultInitialTurnLimit, 0),
	}
	lastWindowPushAt := map[string]time.Time{}

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient("http://127.0.0.1:1"),
		identity,
		idx,
		[]pair.SyncSession{candidate},
		lastHistorySync,
		lastWindowMeta,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		nil,
		newPushedHintStore(),
		nil,
		lastWindowPushAt,
		0,
	)
	if result.Sessions != 0 || result.Turns != 0 || result.ReceivedTurns != 0 {
		t.Fatalf("synced = %+v, want zero", result)
	}
	if lastWindowPushAt[candidate.SessionID].IsZero() {
		t.Fatal("metadata skip should update the window floor without building the session window")
	}
}

func TestSyncChangedNexusSessionsUploadsActiveWindowWhenCandidateMetadataUnchanged(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 62)
	initialReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_active_metadata",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 20},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "active metadata")
	if err != nil {
		t.Fatal(err)
	}

	activeAt := time.Now().UTC().Format(time.RFC3339)
	candidate := pair.SyncSession{
		SessionID:         sessionID,
		Agent:             "claude-code",
		RunnerAlias:       "claude",
		Cwd:               initialReq.Sessions[0].Cwd,
		LastTimestamp:     activeAt,
		ChannelLastSeenAt: activeAt,
		TurnCount:         60,
	}
	lastHistorySync := map[string]string{sessionID: "stale-window"}
	lastWindowMeta := map[string]string{
		sessionID: historyCandidateMetaSignature(candidate, defaultInitialTurnLimit, 0),
	}

	var uploadedSeqs []int
	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_active_metadata",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			var req pair.SyncRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode sync request: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			for _, turn := range req.Turns {
				uploadedSeqs = append(uploadedSeqs, turn.Seq)
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: 1, TurnCount: len(req.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{candidate},
		lastHistorySync,
		lastWindowMeta,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		nil,
		newPushedHintStore(),
		nil,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 1 || result.Turns != 20 {
		t.Fatalf("synced sessions/turns = %d/%d, want 1/20", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("sync POST count = %d, want 1", got)
	}
	if len(uploadedSeqs) != 20 || uploadedSeqs[0] != 43 || uploadedSeqs[len(uploadedSeqs)-1] != 62 {
		t.Fatalf("uploaded seqs = %v, want tail 43..62", uploadedSeqs)
	}
}

func TestSyncChangedNexusSessionsUploadsOnlyNewTailWhenServerWindowOverlaps(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 60)
	windowReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_tail_delta",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 20},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	meta := windowReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "tail delta")
	if err != nil {
		t.Fatal(err)
	}

	var uploadedSeqs []int
	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_tail_delta",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			var req pair.SyncRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode sync request: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			for _, turn := range req.Turns {
				uploadedSeqs = append(uploadedSeqs, turn.Seq)
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: 1, TurnCount: len(req.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     time.Now().UTC().Format(time.RFC3339),
			ChannelLastSeenAt: time.Now().UTC().Format(time.RFC3339),
			TurnCount:         meta.TurnCount,
		}},
		map[string]string{},
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		nil,
		newPushedHintStore(),
		map[string]syncHint{
			sessionID: {SyncedMinSeq: 1, SyncedMaxSeq: 57, SyncedTurnCount: 57, WindowHash: "sha256:older"},
		},
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 1 || result.Turns != 3 {
		t.Fatalf("synced sessions/turns = %d/%d, want 1/3", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("sync POST count = %d, want 1", got)
	}
	if strings.Trim(strings.Join(intsToStrings(uploadedSeqs), ","), ",") != "58,59,60" {
		t.Fatalf("uploaded seqs = %v, want [58 59 60]", uploadedSeqs)
	}
}

func TestSyncChangedNexusSessionsIgnoresBackfillCursorForAutomaticHotSync(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "0")
	idx, sessionID := relayFixtureIndexWithTurns(t, 240)
	tailReq, err := relay.BuildSingleSessionWindowSyncRequestContext(
		context.Background(),
		idx,
		"dd_hot_tail_only",
		sessionID,
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		relay.SessionWindow{Limit: 100},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	meta := tailReq.Sessions[0]
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "hot tail only")
	if err != nil {
		t.Fatal(err)
	}

	var uploadedSeqs []int
	var syncPosts atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_hot_tail_only",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync":
			syncPosts.Add(1)
			var req pair.SyncRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Errorf("decode sync request: %v", err)
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			for _, turn := range req.Turns {
				uploadedSeqs = append(uploadedSeqs, turn.Seq)
			}
			_ = json.NewEncoder(w).Encode(pair.SyncResponse{OK: true, SessionCount: 1, TurnCount: len(req.Turns)})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	result := syncChangedNexusSessions(
		context.Background(),
		pair.NewClient(srv.URL),
		identity,
		idx,
		[]pair.SyncSession{{
			SessionID:         sessionID,
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               meta.Cwd,
			LastTimestamp:     time.Now().UTC().Format(time.RFC3339),
			ChannelLastSeenAt: time.Now().UTC().Format(time.RFC3339),
			TurnCount:         meta.TurnCount,
		}},
		map[string]string{},
		map[string]string{},
		runner.Profile{ClaudeAlias: runner.AliasClaude},
		map[string]syncHint{
			sessionID: {
				Reason:          "recently_opened",
				PreferredMin:    100,
				SyncedTurnCount: 100,
				SyncedMinSeq:    141,
				SyncedMaxSeq:    240,
				NextBeforeSeq:   141,
				TotalTurnCount:  240,
				HasOlderTurns:   true,
			},
		},
		newPushedHintStore(),
		nil,
		map[string]time.Time{},
		0,
	)
	if result.Sessions != 1 || result.Turns != 100 {
		t.Fatalf("synced sessions/turns = %d/%d, want 1/100", result.Sessions, result.Turns)
	}
	if got := syncPosts.Load(); got != 1 {
		t.Fatalf("sync POST count = %d, want 1", got)
	}
	if len(uploadedSeqs) != 100 || uploadedSeqs[0] != 141 || uploadedSeqs[len(uploadedSeqs)-1] != 240 {
		t.Fatalf("uploaded seqs = %v..%v len=%d, want tail 141..240", uploadedSeqs[0], uploadedSeqs[len(uploadedSeqs)-1], len(uploadedSeqs))
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
	changedCatalog.Sessions[0].Cwd = "/work/renamed"
	if catalogSyncSignature(req) == catalogSyncSignature(changedCatalog) {
		t.Fatal("catalog signature must change when stable session metadata changes")
	}
	changedTitle := req
	changedTitle.Sessions = append([]pair.SyncSession{}, req.Sessions...)
	changedTitle.Sessions[0].Title = "renamed"
	if catalogSyncSignature(req) == catalogSyncSignature(changedTitle) {
		t.Fatal("catalog signature must change when session title changes")
	}
	if catalogDisplayMetadataSignature(req) == catalogDisplayMetadataSignature(changedTitle) {
		t.Fatal("display metadata signature must change when session title changes")
	}
	changedDeleted := req
	changedDeleted.DeletedSessions = []string{"sid_archived"}
	if catalogSyncSignature(req) == catalogSyncSignature(changedDeleted) {
		t.Fatal("catalog signature must change when explicit deleted_sessions changes")
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
	t.Setenv("POCKLY_PROACTIVE_HISTORY_SYNC", "")
	t.Setenv("POCKLY_SYNC_WINDOW_DAYS", "")
	t.Setenv("POCKLY_INITIAL_TURN_LIMIT", "")

	policy := defaultNexusSyncPolicy()
	if policy.ProactiveHistorySync {
		t.Fatal("ProactiveHistorySync = true, want false by default")
	}
	if policy.SyncWindowDays != 0 {
		t.Fatalf("SyncWindowDays = %d, want 0 when proactive history sync is disabled", policy.SyncWindowDays)
	}
	if policy.InitialTurnLimit != 20 {
		t.Fatalf("InitialTurnLimit = %d, want 20", policy.InitialTurnLimit)
	}
}

func TestDefaultNexusSyncPolicyAllowsNeutralOverrides(t *testing.T) {
	t.Setenv("POCKLY_PROACTIVE_HISTORY_SYNC", "1")
	t.Setenv("POCKLY_SYNC_WINDOW_DAYS", "14")
	t.Setenv("POCKLY_INITIAL_TURN_LIMIT", "40")

	policy := defaultNexusSyncPolicy()
	if !policy.ProactiveHistorySync {
		t.Fatal("ProactiveHistorySync = false, want true")
	}
	if policy.SyncWindowDays != 14 {
		t.Fatalf("SyncWindowDays = %d, want 14", policy.SyncWindowDays)
	}
	if policy.InitialTurnLimit != 40 {
		t.Fatalf("InitialTurnLimit = %d, want 40", policy.InitialTurnLimit)
	}
}

func TestSyncHintsPollIntervalDefaultsToDisabledFallback(t *testing.T) {
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "")
	if got := syncHintsPollInterval(); got != 0 {
		t.Fatalf("syncHintsPollInterval() = %v, want disabled by default", got)
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

func TestNexusSyncHintsDoesNotPollByDefault(t *testing.T) {
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "")
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "sync hints default")
	if err != nil {
		t.Fatal(err)
	}

	var syncHintsCalls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/daemon/sync-hints":
			syncHintsCalls.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncHintsResponse{
				Sessions: []pair.SyncSessionHint{{SessionID: "polled", Reason: "opened"}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got := nexusSyncHints(context.Background(), pair.NewClient(srv.URL), identity, &syncHintCache{}, nil)
	if len(got) != 0 {
		t.Fatalf("nexusSyncHints() = %+v, want no hints when polling is disabled by default", got)
	}
	if calls := syncHintsCalls.Load(); calls != 0 {
		t.Fatalf("sync-hints calls = %d, want 0 by default", calls)
	}
}

func TestNexusSyncHintsPollsWhenExplicitlyEnabled(t *testing.T) {
	t.Setenv("POCKLY_SYNC_HINTS_POLL_INTERVAL", "10m")
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	identity, err := device.LoadOrCreate(filepath.Join(t.TempDir(), "device.json"), "sync hints opt in")
	if err != nil {
		t.Fatal(err)
	}

	var syncHintsCalls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/device-challenge":
			_ = json.NewEncoder(w).Encode(pair.ChallengeResponse{
				ChallengeID: "challenge_sync_hints",
				DeviceID:    identity.DeviceID,
				Audience:    "daemon-ws",
				Nonce:       "nonce",
				ExpiresAt:   time.Now().Add(time.Minute),
			})
		case "/api/device-challenge/verify":
			_ = json.NewEncoder(w).Encode(pair.VerifyChallengeResponse{
				Verified:          true,
				DeviceAccessToken: "test-token",
			})
		case "/api/daemon/sync-hints":
			syncHintsCalls.Add(1)
			_ = json.NewEncoder(w).Encode(pair.SyncHintsResponse{
				Sessions: []pair.SyncSessionHint{{
					SessionID:       "polled",
					Reason:          "recently_opened",
					PreferredMin:    100,
					SyncedTurnCount: 20,
					SyncedMinSeq:    41,
					SyncedMaxSeq:    60,
					NextBeforeSeq:   41,
					TotalTurnCount:  60,
					HasOlderTurns:   true,
					WindowHash:      "sha256:polled",
				}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	got := nexusSyncHints(context.Background(), pair.NewClient(srv.URL), identity, &syncHintCache{}, nil)
	if calls := syncHintsCalls.Load(); calls != 1 {
		t.Fatalf("sync-hints calls = %d, want 1 when explicitly enabled", calls)
	}
	hint, ok := got["polled"]
	if !ok {
		t.Fatalf("nexusSyncHints() = %+v, want polled hint", got)
	}
	if hint.Reason != "recently_opened" || hint.PreferredMin != 100 || hint.SyncedMinSeq != 41 || hint.SyncedMaxSeq != 60 || hint.NextBeforeSeq != 41 || !hint.HasOlderTurns || hint.WindowHash != "sha256:polled" {
		t.Fatalf("polled hint = %+v, want response fields preserved", hint)
	}
}

func TestWindowSyncMinIntervalDefaultsToLowCostCadence(t *testing.T) {
	t.Setenv("POCKLY_WINDOW_SYNC_MIN_INTERVAL", "")
	if got := windowSyncMinInterval(); got != time.Minute {
		t.Fatalf("windowSyncMinInterval() = %v, want 1m", got)
	}
	t.Setenv("POCKLY_WINDOW_SYNC_MIN_INTERVAL", "15s")
	if got := windowSyncMinInterval(); got != 15*time.Second {
		t.Fatalf("windowSyncMinInterval() override = %v, want 15s", got)
	}
}

func TestServePollingDefaultsUseLowCostCadence(t *testing.T) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	refreshInterval := fs.Duration("refresh-interval", defaultIndexRefreshInterval, "session index fallback refresh interval")
	syncInterval := fs.Duration("sync-interval", defaultNexusSyncInterval, "Nexus sync heartbeat interval")

	if *refreshInterval != 30*time.Second {
		t.Fatalf("refresh interval default = %v, want 30s", *refreshInterval)
	}
	if *syncInterval != 15*time.Second {
		t.Fatalf("sync interval default = %v, want 15s", *syncInterval)
	}
}

func TestCatalogSyncSignatureIgnoresVolatileTurnFields(t *testing.T) {
	base := pair.SyncRequest{
		FullReconcile: true,
		Sessions: []pair.SyncSession{{
			SessionID:         "sid-1",
			Agent:             "claude-code",
			RunnerAlias:       "claude",
			Cwd:               "/repo",
			Title:             "First prompt",
			Snippet:           "First prompt",
			FirstMessage:      "First prompt",
			LastSeq:           10,
			LastTimestamp:     "2026-06-16T07:00:00Z",
			ChannelLastSeenAt: "2026-06-16T07:00:00Z",
			TurnCount:         10,
			SyncState:         "catalog_only",
		}},
	}
	changedTurns := base
	changedTurns.Sessions = append([]pair.SyncSession(nil), base.Sessions...)
	changedTurns.Sessions[0].LastSeq = 45
	changedTurns.Sessions[0].TurnCount = 45
	changedTurns.Sessions[0].LastTimestamp = "2026-06-16T07:05:00Z"
	changedTurns.Sessions[0].ChannelLastSeenAt = "2026-06-16T07:05:00Z"
	if got, want := catalogSyncSignature(changedTurns), catalogSyncSignature(base); got != want {
		t.Fatalf("catalogSyncSignature changed for volatile turn fields\n got: %q\nwant: %q", got, want)
	}

	changedTitle := base
	changedTitle.Sessions = append([]pair.SyncSession(nil), base.Sessions...)
	changedTitle.Sessions[0].Title = "Renamed"
	if got, want := catalogSyncSignature(changedTitle), catalogSyncSignature(base); got == want {
		t.Fatalf("catalogSyncSignature did not change for title update: %q", got)
	}
	if got, want := catalogDisplayMetadataSignature(changedTitle), catalogDisplayMetadataSignature(base); got == want {
		t.Fatalf("catalogDisplayMetadataSignature did not change for title update: %q", got)
	}

	changedSyncState := base
	changedSyncState.Sessions = append([]pair.SyncSession(nil), base.Sessions...)
	changedSyncState.Sessions[0].SyncState = "window_synced"
	if got, want := catalogSyncSignature(changedSyncState), catalogSyncSignature(base); got == want {
		t.Fatalf("catalogSyncSignature did not change for sync_state update: %q", got)
	}
	if got, want := catalogDisplayMetadataSignature(changedSyncState), catalogDisplayMetadataSignature(base); got != want {
		t.Fatalf("display metadata signature changed for sync_state update\n got: %q\nwant: %q", got, want)
	}
}

func TestRecentNexusSessionsSkipsPassiveHistoryByDefault(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "recent", LastTimestamp: now.Add(-2 * time.Hour).Format(time.RFC3339)},
		{SessionID: "channel_recent", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{SessionID: "active", LastTimestamp: now.Add(-2 * time.Minute).Format(time.RFC3339)},
	}

	got := recentNexusSessions(sessions, 0, nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
	if len(got) != 1 || got[0].SessionID != "active" {
		t.Fatalf("recentNexusSessions = %+v, want only active session when proactive history sync is disabled", got)
	}
}

func TestRecentNexusSessionsDoesNotCapPrioritySessions(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := make([]pair.SyncSession, 0, maxNexusHistorySessionsPerTick+3)
	for i := 0; i < maxNexusHistorySessionsPerTick+3; i++ {
		sessions = append(sessions, pair.SyncSession{
			SessionID:     fmt.Sprintf("active-%02d", i),
			LastTimestamp: now.Add(-time.Duration(i) * time.Minute).Format(time.RFC3339),
		})
	}

	got := recentNexusSessions(sessions, maxNexusHistorySessionsPerTick, nexusSyncPolicy{
		ProactiveHistorySync: false,
		SyncWindowDays:       0,
		InitialTurnLimit:     20,
		PriorityTurnLimit:    100,
	}, nil, now)
	if len(got) != len(sessions) {
		t.Fatalf("recentNexusSessions capped priority sessions: got %d, want %d", len(got), len(sessions))
	}
}

func TestRecentNexusSessionsFiltersOutsideSyncWindowWhenProactiveEnabled(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "recent", LastTimestamp: now.Add(-2 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "boundary", LastTimestamp: now.Add(-7 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "old", LastTimestamp: now.Add(-8 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "channel_recent", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339), ChannelLastSeenAt: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{SessionID: "", LastTimestamp: now.Format(time.RFC3339)},
		{SessionID: "missing_time"},
	}

	got := recentNexusSessions(sessions, 0, nexusSyncPolicy{ProactiveHistorySync: true, SyncWindowDays: 7, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
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
	got := recentNexusSessions(sessions, 1, nexusSyncPolicy{ProactiveHistorySync: true, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
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

	got := recentNexusSessions(sessions, 0, nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100}, hints, now)
	ids := make([]string, 0, len(got))
	for _, session := range got {
		ids = append(ids, session.SessionID)
	}
	want := []string{"pinned_old"}
	if strings.Join(ids, ",") != strings.Join(want, ",") {
		t.Fatalf("recentNexusSessions ids = %v, want %v", ids, want)
	}
}

func TestKnownWindowSessionIDsForCatalogOnlyRequestsUploadCandidates(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := []pair.SyncSession{
		{SessionID: "active", LastTimestamp: now.Add(-2 * time.Minute).Format(time.RFC3339)},
		{SessionID: "old_hint", LastTimestamp: now.Add(-30 * 24 * time.Hour).Format(time.RFC3339)},
		{SessionID: "old_no_hint", LastTimestamp: now.Add(-31 * 24 * time.Hour).Format(time.RFC3339)},
	}
	got := knownWindowSessionIDsForCatalog(
		sessions,
		nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100},
		map[string]syncHint{"old_hint": {Reason: "recently_opened"}},
		now,
	)
	want := []string{"active", "old_hint"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("knownWindowSessionIDsForCatalog = %v, want %v", got, want)
	}
}

func TestKnownWindowSessionIDsForCatalogCapsLargeCandidateSets(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	sessions := make([]pair.SyncSession, 0, maxNexusHistorySessionsPerTick+4)
	for i := 0; i < maxNexusHistorySessionsPerTick+4; i++ {
		sessions = append(sessions, pair.SyncSession{
			SessionID:     fmt.Sprintf("active_%02d", i),
			LastTimestamp: now.Add(-time.Duration(i) * time.Minute).Format(time.RFC3339),
		})
	}
	got := knownWindowSessionIDsForCatalog(
		sessions,
		nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100},
		nil,
		now,
	)
	if len(got) != maxNexusHistorySessionsPerTick {
		t.Fatalf("knownWindowSessionIDsForCatalog len = %d, want %d: %v", len(got), maxNexusHistorySessionsPerTick, got)
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
	got := recentNexusSessions(sessions, 1, nexusSyncPolicy{ProactiveHistorySync: false, SyncWindowDays: 0, InitialTurnLimit: 20, PriorityTurnLimit: 100}, nil, now)
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

func relayFixtureIndexWithTurns(t *testing.T, count int) (*index.Index, string) {
	t.Helper()
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-hash-skip")
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sessionID := "77777777-7777-7777-7777-777777777777"
	base := time.Date(2026, 6, 12, 10, 0, 0, 0, time.UTC)
	lines := make([]string, 0, count)
	for seq := 1; seq <= count; seq++ {
		ts := base.Add(time.Duration(seq) * time.Second).Format(time.RFC3339)
		if seq%2 == 1 {
			lines = append(lines, fmt.Sprintf(`{"sessionId":%q,"cwd":"/tmp/hash-skip","timestamp":%q,"type":"user","message":{"role":"user","content":%q}}`, sessionID, ts, fmt.Sprintf("user %02d", seq)))
			continue
		}
		lines = append(lines, fmt.Sprintf(`{"sessionId":%q,"cwd":"/tmp/hash-skip","timestamp":%q,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":%q}]}}`, sessionID, ts, fmt.Sprintf("assistant %02d", seq)))
	}
	if err := os.WriteFile(filepath.Join(projectDir, sessionID+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	idx := index.New(index.Config{ClaudeHome: claudeHome, RefreshInterval: time.Minute})
	if err := idx.Refresh(); err != nil {
		t.Fatal(err)
	}
	return idx, sessionID
}

func intsToStrings(values []int) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, strconv.Itoa(value))
	}
	return out
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

func TestPushedHintStoreKeepsRecentlyOpenedFreshAfterOneWindow(t *testing.T) {
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
		t.Fatalf("beforeSeqForHint = %d, want explicit backfill cursor 141", before)
	}

	store.UpdateAfterSync("sess-large", pair.SyncSession{
		SessionID: "sess-large",
		MinSeq:    141,
		MaxSeq:    240,
		TurnCount: 240,
		HasOlder:  true,
	}, now.Add(time.Second))

	updated := store.Snapshot(now.Add(time.Second))["sess-large"]
	if updated.Reason != "recently_opened" {
		t.Fatalf("recently opened hint should stay while the reader is fresh, got %+v", updated)
	}
	if !store.PushedWithin("sess-large", now.Add(time.Minute), pushedHintFreshFor) {
		t.Fatal("recently opened hint should keep bypassing the window floor inside the fresh window")
	}
	if store.PushedWithin("sess-large", now.Add(10*time.Minute), pushedHintFreshFor) {
		t.Fatal("recently opened hint must stop bypassing the window floor after the fresh window")
	}
}

func TestPushedHintStoreTracksPinnedBackfillCursor(t *testing.T) {
	store := newPushedHintStore()
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	store.Add("sess-large", syncHint{
		Reason:          "pinned",
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
		t.Fatalf("beforeSeqForHint = %d, want explicit backfill cursor 141", before)
	}

	store.UpdateAfterSync("sess-large", pair.SyncSession{
		SessionID: "sess-large",
		MinSeq:    141,
		MaxSeq:    240,
		TurnCount: 240,
		HasOlder:  true,
	}, now.Add(time.Second))

	if hints := store.Snapshot(now.Add(time.Second)); len(hints) != 0 {
		t.Fatalf("pinned hint should be consumed after the durable tail window, got %+v", hints)
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

func TestShouldPushCatalogChangeAllowsMetadataFloorOnlyForDisplayChanges(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	lastCatalog := now.Add(-10 * time.Second)
	lastMetadata := now.Add(-3 * time.Second)
	if !shouldPushCatalogChange(true, false, true, now, lastCatalog, lastMetadata, time.Minute, 2*time.Second) {
		t.Fatal("display metadata change past metadata floor must bypass catalog floor")
	}
	if shouldPushCatalogChange(true, false, true, now, lastCatalog, now.Add(-time.Second), time.Minute, 2*time.Second) {
		t.Fatal("display metadata change inside metadata floor must be debounced")
	}
	if shouldPushCatalogChange(true, false, false, now, lastCatalog, lastMetadata, time.Minute, 2*time.Second) {
		t.Fatal("non-display catalog change inside catalog floor must be throttled")
	}
	if !shouldPushCatalogChange(true, false, false, now, now.Add(-2*time.Minute), lastMetadata, time.Minute, 2*time.Second) {
		t.Fatal("non-display catalog change past catalog floor must push")
	}
	if shouldPushCatalogChange(false, true, true, now, lastCatalog, lastMetadata, time.Minute, 2*time.Second) {
		t.Fatal("unchanged catalog must never push")
	}
	if !shouldPushCatalogChange(true, true, false, now, lastCatalog, lastMetadata, time.Minute, 2*time.Second) {
		t.Fatal("membership change must bypass all floors")
	}
}

func TestCatalogMetadataRetryDelayOnlyWhenMetadataDebounced(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	lastMetadata := now.Add(-500 * time.Millisecond)
	if got, want := catalogMetadataRetryDelay(true, false, true, now, lastMetadata, 2*time.Second), 1500*time.Millisecond; got != want {
		t.Fatalf("metadata retry delay = %v, want %v", got, want)
	}
	if got := catalogMetadataRetryDelay(true, false, true, now, now.Add(-3*time.Second), 2*time.Second); got != 0 {
		t.Fatalf("metadata retry delay past floor = %v, want 0", got)
	}
	if got := catalogMetadataRetryDelay(false, false, true, now, lastMetadata, 2*time.Second); got != 0 {
		t.Fatalf("metadata retry delay for unchanged catalog = %v, want 0", got)
	}
	if got := catalogMetadataRetryDelay(true, true, true, now, lastMetadata, 2*time.Second); got != 0 {
		t.Fatalf("metadata retry delay for membership change = %v, want 0", got)
	}
	if got := catalogMetadataRetryDelay(true, false, false, now, lastMetadata, 2*time.Second); got != 0 {
		t.Fatalf("metadata retry delay for non-display change = %v, want 0", got)
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
	left := catalogMembershipSignature(pair.SyncRequest{Sessions: []pair.SyncSession{{SessionID: "b"}, {SessionID: "a"}}})
	right := catalogMembershipSignature(pair.SyncRequest{Sessions: []pair.SyncSession{{SessionID: "a"}, {SessionID: "b"}}})
	if left != right {
		t.Fatalf("membership signature must be order-insensitive: %q vs %q", left, right)
	}
	if left == catalogMembershipSignature(pair.SyncRequest{Sessions: []pair.SyncSession{{SessionID: "a"}}}) {
		t.Fatal("membership signature must change when a session is added/removed")
	}
	if left == catalogMembershipSignature(pair.SyncRequest{
		Sessions:        []pair.SyncSession{{SessionID: "a"}, {SessionID: "b"}},
		DeletedSessions: []string{"archived"},
	}) {
		t.Fatal("membership signature must change when explicit tombstones are present")
	}
}

func TestCatalogDisplayMetadataSignatureIsOrderInsensitive(t *testing.T) {
	left := pair.SyncRequest{FullReconcile: true, Sessions: []pair.SyncSession{
		{SessionID: "b", Agent: "codex", Cwd: "/repo", Title: "B"},
		{SessionID: "a", Agent: "codex", Cwd: "/repo", Title: "A"},
	}}
	right := pair.SyncRequest{FullReconcile: true, Sessions: []pair.SyncSession{
		{SessionID: "a", Agent: "codex", Cwd: "/repo", Title: "A"},
		{SessionID: "b", Agent: "codex", Cwd: "/repo", Title: "B"},
	}}
	if got, want := catalogDisplayMetadataSignature(left), catalogDisplayMetadataSignature(right); got != want {
		t.Fatalf("display metadata signature must be order-insensitive\n got: %q\nwant: %q", got, want)
	}
	right.Sessions[1].Title = "B renamed"
	if got, want := catalogDisplayMetadataSignature(left), catalogDisplayMetadataSignature(right); got == want {
		t.Fatalf("display metadata signature must change when a title changes: %q", got)
	}
}

func TestCatalogDisplayMetadataSignatureIgnoresFullReconcile(t *testing.T) {
	left := pair.SyncRequest{FullReconcile: true, Sessions: []pair.SyncSession{
		{SessionID: "a", Agent: "codex", Cwd: "/repo", Title: "A"},
	}}
	right := left
	right.FullReconcile = false
	if got, want := catalogDisplayMetadataSignature(left), catalogDisplayMetadataSignature(right); got != want {
		t.Fatalf("display metadata signature must ignore full reconcile\n got: %q\nwant: %q", got, want)
	}
}
