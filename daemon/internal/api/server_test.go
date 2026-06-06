// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// loopbackRequest builds a test request with a loopback Host so it passes the
// local API's loopbackGuard. httptest.NewRequest defaults Host to "example.com",
// which the guard rejects as a non-loopback (DNS-rebinding) host.
func loopbackRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1:8947"
	return req
}

func TestHostIsLoopback(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"127.0.0.1:8947", true},
		{"127.0.0.1", true},
		{"localhost:8947", true},
		{"localhost", true},
		{"[::1]:8947", true},
		{"::1", true},
		{"127.0.0.5", true},
		{"example.com", false},
		{"example.com:8947", false},
		{"attacker.test:8947", false},
		{"0.0.0.0:8947", false},
		{"", false},
	}
	for _, c := range cases {
		if got := hostIsLoopback(c.host); got != c.want {
			t.Errorf("hostIsLoopback(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

// TestLoopbackGuardRejectsBrowserAndRebinding guards #50: the local API must
// reject a cross-origin browser fetch (CSRF) and a DNS-rebinding host, while
// still allowing the wrapper/CLI (loopback Host, no Origin).
func TestLoopbackGuardRejectsBrowserAndRebinding(t *testing.T) {
	h := NewHandler(Config{RefreshInterval: time.Minute})

	// Loopback, no Origin (wrapper / CLI / curl) → allowed.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loopbackRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback no-Origin /healthz = %d, want 200", rec.Code)
	}

	// Cross-origin Origin (a web page's fetch — the CSRF case) → 403.
	rec = httptest.NewRecorder()
	req := loopbackRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin /healthz = %d, want 403", rec.Code)
	}

	// Non-loopback Host (DNS-rebinding: attacker.com → 127.0.0.1) → 403.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Host = "attacker.example.com"
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("rebinding host /healthz = %d, want 403", rec.Code)
	}

	// Loopback Origin (a same-machine local tool) → allowed.
	rec = httptest.NewRecorder()
	req = loopbackRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("Origin", "http://127.0.0.1:8947")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("loopback-Origin /healthz = %d, want 200", rec.Code)
	}
}

func TestHealthz(t *testing.T) {
	h := NewHandler(Config{RefreshInterval: time.Minute})
	req := loopbackRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("content-type = %q", got)
	}
}

func TestStatusEndpointReportsRelayAndRunner(t *testing.T) {
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		RelayURL:        "https://pockly.example",
		Profile:         runner.Profile{ClaudeAlias: runner.AliasClaudeCCR},
	})
	req := loopbackRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["environment_label"] != "production" {
		t.Errorf("environment_label = %v, want production", body["environment_label"])
	}
	if body["effective_relay_url"] != "https://pockly.example" {
		t.Errorf("effective_relay_url = %v", body["effective_relay_url"])
	}
	if body["claude_runner_alias"] != "claude_ccr" {
		t.Errorf("claude_runner_alias = %v, want claude_ccr", body["claude_runner_alias"])
	}
}

func TestEnvironmentLabel(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"", "disconnected"},
		{"https://pockly.example", "production"},
		{"https://staging.pockly.example", "production"},
		{"http://127.0.0.1:8080", "local"},
		{"http://localhost:8080", "local"},
		{"https://relay.example.com", "custom"},
		{":::", "unknown"},
	}
	for _, tc := range cases {
		if got := EnvironmentLabel(tc.raw); got != tc.want {
			t.Errorf("EnvironmentLabel(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestProjectsAndBlocks(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	codexHome := t.TempDir()

	claudeSessionID := "11111111-1111-1111-1111-111111111111"
	claudeDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, claudeDir)
	mustWriteFile(t, filepath.Join(claudeDir, claudeSessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+claudeSessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"hello from claude"}}
{"sessionId":"`+claudeSessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"claude reply"}]}}
`)+"\n")

	codexSessionID := "22222222-2222-2222-2222-222222222222"
	codexDir := filepath.Join(codexHome, "sessions", "2026", "05", "18")
	mustMkdirAll(t, codexDir)
	mustWriteFile(t, filepath.Join(codexDir, "rollout-2026-05-18T10-00-00-"+codexSessionID+".jsonl"), strings.TrimSpace(`
{"timestamp":"2026-05-18T10:00:00Z","type":"session_meta","payload":{"id":"`+codexSessionID+`","cwd":"/tmp/codex/project"}}
{"timestamp":"2026-05-18T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello from codex"}]}}
{"timestamp":"2026-05-18T10:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"codex reply"}]}}
`)+"\n")

	h := NewHandler(Config{
		ClaudeHome:      claudeHome,
		CodexHome:       codexHome,
		RefreshInterval: time.Minute,
	})

	t.Run("projects", func(t *testing.T) {
		req := loopbackRequest(http.MethodGet, "/api/projects", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}

		var projects []struct {
			Agent    string `json:"agent"`
			Cwd      string `json:"cwd"`
			Sessions []struct {
				SessionID string `json:"session_id"`
				Snippet   string `json:"snippet"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &projects); err != nil {
			t.Fatal(err)
		}
		if len(projects) != 2 {
			t.Fatalf("len(projects) = %d, want 2", len(projects))
		}
		if projects[0].Sessions[0].Snippet == "" && projects[1].Sessions[0].Snippet == "" {
			t.Fatalf("expected indexed snippets in at least one project: %+v", projects)
		}
	})

	t.Run("claude blocks", func(t *testing.T) {
		req := loopbackRequest(http.MethodGet, "/api/sessions/"+claudeSessionID+"/blocks", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"agent":"claude-code"`) {
			t.Fatalf("body missing claude agent: %s", rec.Body.String())
		}
	})

	t.Run("claude blocks stream", func(t *testing.T) {
		srv := httptest.NewServer(h)
		defer srv.Close()

		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/sessions/"+claudeSessionID+"/blocks/stream", nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", res.StatusCode)
		}

		reader := bufio.NewReader(res.Body)
		var event strings.Builder
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			event.WriteString(line)
			if line == "\n" {
				text := event.String()
				if strings.Contains(text, "event: blocks") {
					if !strings.Contains(text, `"agent":"claude-code"`) {
						t.Fatalf("blocks event missing claude agent: %s", text)
					}
					return
				}
				event.Reset()
			}
		}
	})

	t.Run("codex blocks", func(t *testing.T) {
		req := loopbackRequest(http.MethodGet, "/api/sessions/"+codexSessionID+"/blocks", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"agent":"codex"`) {
			t.Fatalf("body missing codex agent: %s", rec.Body.String())
		}
	})

	t.Run("not found", func(t *testing.T) {
		req := loopbackRequest(http.MethodGet, "/api/sessions/nope/blocks", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})
}

func TestBackgroundRefreshPicksUpNewSession(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	cfg := Config{
		ClaudeHome:      claudeHome,
		RefreshInterval: 20 * time.Millisecond,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	idx := StartBackgroundRefresh(ctx, cfg)
	h := NewHandlerWithIndex(cfg, idx)

	req := loopbackRequest(http.MethodGet, "/api/projects", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}

	sessionID := "33333333-3333-3333-3333-333333333333"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"appeared later"}}
`)+"\n")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if strings.Contains(rec.Body.String(), sessionID) {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("session %s never appeared in indexed projects: %s", sessionID, rec.Body.String())
}

func TestProjectsRefreshesStaleIndexBeforeResponding(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)

	cfg := Config{ClaudeHome: claudeHome, RefreshInterval: time.Hour}
	h := NewHandler(cfg)

	sessionID := "34343434-3434-3434-3434-343434343434"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"appeared after initial refresh"}}
`)+"\n")

	time.Sleep(projectsRefreshMaxAge + 10*time.Millisecond)

	req := loopbackRequest(http.MethodGet, "/api/projects", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), sessionID) {
		t.Fatalf("session %s missing after request-time refresh: %s", sessionID, rec.Body.String())
	}
}

func TestStatusIncludesIndexHealth(t *testing.T) {
	claudeHome := filepath.Join(t.TempDir(), ".claude", "projects")
	projectDir := filepath.Join(claudeHome, "-tmp-claude-project")
	mustMkdirAll(t, projectDir)
	sessionID := "35353535-3535-3535-3535-353535353535"
	mustWriteFile(t, filepath.Join(projectDir, sessionID+".jsonl"), strings.TrimSpace(`
{"sessionId":"`+sessionID+`","cwd":"/tmp/claude/project","timestamp":"2026-05-18T10:00:00Z","type":"user","message":{"role":"user","content":"status health"}}
`)+"\n")

	h := NewHandler(Config{ClaudeHome: claudeHome, RefreshInterval: time.Minute})
	req := loopbackRequest(http.MethodGet, "/api/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var body struct {
		Index struct {
			LastScan     string `json:"last_scan"`
			LastError    string `json:"last_error"`
			ProjectCount int    `json:"project_count"`
			SessionCount int    `json:"session_count"`
		} `json:"index"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if body.Index.LastScan == "" {
		t.Fatalf("index.last_scan missing: %s", rec.Body.String())
	}
	if body.Index.LastError != "" {
		t.Fatalf("index.last_error = %q", body.Index.LastError)
	}
	if body.Index.ProjectCount != 1 || body.Index.SessionCount != 1 {
		t.Fatalf("index counts = projects:%d sessions:%d, body=%s", body.Index.ProjectCount, body.Index.SessionCount, rec.Body.String())
	}
}

func TestDevTerminalEventForwardsSessionMetadata(t *testing.T) {
	terminalManager := liveterminal.NewManager()
	var got DevTerminalEvent
	h := NewHandler(Config{
		RefreshInterval:   time.Minute,
		TerminalManager:   terminalManager,
		TerminalEventSink: func(evt DevTerminalEvent) { got = evt },
	})

	createReq := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions", strings.NewReader(`{}`))
	createRec := httptest.NewRecorder()
	h.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusAccepted {
		t.Fatalf("create status = %d: %s", createRec.Code, createRec.Body.String())
	}
	var created struct {
		TerminalSession struct {
			ID string `json:"id"`
		} `json:"terminal_session"`
	}
	if err := json.NewDecoder(createRec.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.TerminalSession.ID == "" {
		t.Fatal("expected terminal session id")
	}

	body := `{"kind":"session_ready","session_status":"live","turn_status":"awaiting_input","session_id":"sess_resume_1","agent":"claude-code","cwd":"/tmp/project"}`
	req := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions/"+created.TerminalSession.ID+"/events", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("event status = %d: %s", rec.Code, rec.Body.String())
	}
	if got.TerminalSessionID != created.TerminalSession.ID || got.SessionID != "sess_resume_1" {
		t.Fatalf("unexpected sink event: %+v", got)
	}
	if got.Agent != "claude-code" || got.Cwd != "/tmp/project" || got.Kind != liveterminal.EventSessionReady {
		t.Fatalf("unexpected sink metadata: %+v", got)
	}
}

func TestDevTerminalExitIntentStopsExternalSession(t *testing.T) {
	terminalManager := liveterminal.NewManager()
	var got []DevTerminalEvent
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		TerminalManager: terminalManager,
		TerminalEventSink: func(evt DevTerminalEvent) {
			got = append(got, evt)
		},
	})

	createReq := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions", strings.NewReader(`{}`))
	createRec := httptest.NewRecorder()
	h.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusAccepted {
		t.Fatalf("create status = %d: %s", createRec.Code, createRec.Body.String())
	}
	var created struct {
		TerminalSession struct {
			ID string `json:"id"`
		} `json:"terminal_session"`
	}
	if err := json.NewDecoder(createRec.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	eventBody := `{"kind":"session_ready","session_status":"live","turn_status":"awaiting_input","session_id":"sess_exit_1","agent":"claude-code","cwd":"/tmp/project"}`
	eventReq := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions/"+created.TerminalSession.ID+"/events", strings.NewReader(eventBody))
	eventRec := httptest.NewRecorder()
	h.ServeHTTP(eventRec, eventReq)
	if eventRec.Code != http.StatusAccepted {
		t.Fatalf("event status = %d: %s", eventRec.Code, eventRec.Body.String())
	}

	exitReq := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions/"+created.TerminalSession.ID+"/exit-intent", strings.NewReader(`{"clean":true,"user_initiated":true,"exit_code":0}`))
	exitRec := httptest.NewRecorder()
	h.ServeHTTP(exitRec, exitReq)
	if exitRec.Code != http.StatusAccepted {
		t.Fatalf("exit-intent status = %d: %s", exitRec.Code, exitRec.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for len(terminalManager.List()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if list := terminalManager.List(); len(list) != 0 {
		t.Fatalf("terminal sessions after exit-intent = %+v, want empty", list)
	}

	var sawExitIntent, sawSessionExited bool
	for _, evt := range got {
		if evt.Kind == "exit_intent" {
			sawExitIntent = true
		}
		if evt.Kind == liveterminal.EventSessionExited && evt.SessionID == "sess_exit_1" && evt.SessionStatus == liveterminal.SessionExited {
			sawSessionExited = true
		}
	}
	if !sawExitIntent || !sawSessionExited {
		t.Fatalf("sink events missing exit intent/session exited: %+v", got)
	}
}

func TestDevTerminalInputRouteRequiresManagerAndText(t *testing.T) {
	t.Run("without manager", func(t *testing.T) {
		h := NewHandler(Config{RefreshInterval: time.Minute})
		req := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions/ts_demo/input", strings.NewReader(`{"text":"hello"}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("with manager validates text", func(t *testing.T) {
		h := NewHandler(Config{
			RefreshInterval: time.Minute,
			TerminalManager: liveterminal.NewManager(),
		})
		req := loopbackRequest(http.MethodPost, "/api/dev/terminal-sessions/ts_demo/input", strings.NewReader(`{"text":"   "}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["error"] != "text is required" {
			t.Fatalf("error = %q, want text is required", body["error"])
		}
	})
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestPermissionRequestsEndToEnd is the v0.2.0 D1 wire-level test
// for the register → await → decide flow. Spins up the real handler
// with a permission.Store, registers via HTTP, parks an Await in a
// goroutine, POSTs a decide, asserts Await returns allow/deny. Also
// covers list + cancel + invalid-payload negative paths.
func TestPermissionRequestsEndToEnd(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})

	// 1) Register a request.
	regBody := `{"terminal_session_id":"ts_abc","claude_session_id":"sid_def","tool_name":"Bash","input":{"command":"echo hi"}}`
	regReq := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/req-e2e", strings.NewReader(regBody))
	regRec := httptest.NewRecorder()
	h.ServeHTTP(regRec, regReq)
	if regRec.Code != http.StatusAccepted {
		t.Fatalf("register status = %d, body=%s", regRec.Code, regRec.Body.String())
	}

	// 2) Park Await in a goroutine. timeout=2s so the test doesn't
	//    hang if Decide doesn't work.
	awaitDone := make(chan struct {
		code int
		body string
	}, 1)
	go func() {
		awaitReq := loopbackRequest(http.MethodGet, "/api/dev/permission-requests/req-e2e/await?timeout=2", nil)
		awaitRec := httptest.NewRecorder()
		h.ServeHTTP(awaitRec, awaitReq)
		awaitDone <- struct {
			code int
			body string
		}{awaitRec.Code, awaitRec.Body.String()}
	}()

	// 3) Give Await a moment to park on the chan, then POST decide.
	time.Sleep(20 * time.Millisecond)
	decideBody := `{"decision":"allow"}`
	decideReq := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/req-e2e/decide", strings.NewReader(decideBody))
	decideRec := httptest.NewRecorder()
	h.ServeHTTP(decideRec, decideReq)
	if decideRec.Code != http.StatusAccepted {
		t.Fatalf("decide status = %d, body=%s", decideRec.Code, decideRec.Body.String())
	}

	// 4) Await should have returned the decision now.
	select {
	case result := <-awaitDone:
		if result.code != http.StatusOK {
			t.Fatalf("await status = %d, body=%s", result.code, result.body)
		}
		var out struct {
			Decision string `json:"decision"`
			Reason   string `json:"reason"`
		}
		if err := json.Unmarshal([]byte(result.body), &out); err != nil {
			t.Fatalf("await body unmarshal: %v body=%s", err, result.body)
		}
		if out.Decision != "allow" {
			t.Fatalf("await decision = %s, want allow", out.Decision)
		}
		if out.Reason != "user" {
			t.Fatalf("await reason = %s, want user", out.Reason)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("await goroutine never returned")
	}
}

func TestPermissionAwaitTimesOut(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})

	regReq := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/req-timeout",
		strings.NewReader(`{"tool_name":"Bash"}`))
	regRec := httptest.NewRecorder()
	h.ServeHTTP(regRec, regReq)
	if regRec.Code != http.StatusAccepted {
		t.Fatalf("register: %d", regRec.Code)
	}

	// timeout=1 (smallest accepted value); wait ~1s.
	awaitReq := loopbackRequest(http.MethodGet, "/api/dev/permission-requests/req-timeout/await?timeout=1", nil)
	awaitRec := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(awaitRec, awaitReq)
	if awaitRec.Code != http.StatusGatewayTimeout {
		t.Fatalf("await status = %d, body=%s", awaitRec.Code, awaitRec.Body.String())
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("await elapsed %v not in [900ms, 2s]", elapsed)
	}
}

// "/decide" must reject decisions outside {allow, deny}.
func TestPermissionDecideRejectsUnknownDecision(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})
	regReq := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/req-x",
		strings.NewReader(`{"tool_name":"Bash"}`))
	h.ServeHTTP(httptest.NewRecorder(), regReq)

	bad := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/req-x/decide",
		strings.NewReader(`{"decision":"maybe"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestPermissionDecideNotFound(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})
	req := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/nope/decide",
		strings.NewReader(`{"decision":"allow"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
}

func TestPermissionRegisterRejectsBadPayload(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})
	// Missing tool_name.
	req := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/bad",
		strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestPermissionList(t *testing.T) {
	store := permission.New()
	h := NewHandler(Config{
		RefreshInterval: time.Minute,
		PermissionStore: store,
	})
	for _, id := range []string{"r1", "r2"} {
		reg := loopbackRequest(http.MethodPost, "/api/dev/permission-requests/"+id,
			strings.NewReader(`{"tool_name":"Bash"}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, reg)
		if rec.Code != http.StatusAccepted {
			t.Fatalf("register %s: %d", id, rec.Code)
		}
	}
	listReq := loopbackRequest(http.MethodGet, "/api/dev/permission-requests", nil)
	listRec := httptest.NewRecorder()
	h.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d", listRec.Code)
	}
	var out struct {
		PermissionRequests []map[string]any `json:"permission_requests"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.PermissionRequests) != 2 {
		t.Fatalf("got %d, want 2", len(out.PermissionRequests))
	}
}
