// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// setTestClaudeHome points os.UserHomeDir() at dir on every platform.
// os.UserHomeDir() reads $HOME on Unix but %USERPROFILE% on Windows, so
// setting only HOME left the Windows CI job resolving the real profile
// directory and never seeing the test's .claude/sessions fixture (the
// long-standing test-windows red). Setting both keeps these tests
// platform-agnostic without forking on runtime.GOOS.
func setTestClaudeHome(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
}

func TestParseClaudeInvocationResume(t *testing.T) {
	// Verifies parseClaudeInvocation extracts the sessionID the user
	// supplied via --resume / -r. With v0.1.36 the function ALSO
	// generates a fresh UUID when no session flag is present (see
	// TestParseClaudeInvocationGeneratesUUID for that case); these
	// table entries only cover the "user-supplied sid is honored" path.
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "plain resume", args: []string{"--resume", "sess_123"}, want: "sess_123"},
		{name: "equals resume", args: []string{"--resume=sess_456"}, want: "sess_456"},
		{name: "later arg wins", args: []string{"--resume", "sess_old", "--resume=sess_new"}, want: "sess_new"},
		{name: "short -r flag", args: []string{"-r", "sess_short"}, want: "sess_short"},
		{name: "session-id flag", args: []string{"--session-id", "user-uuid"}, want: "user-uuid"},
		{name: "session-id equals", args: []string{"--session-id=user-uuid"}, want: "user-uuid"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseClaudeInvocation(tt.args).sessionID; got != tt.want {
				t.Fatalf("parseClaudeInvocation(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestEncodeClaudeProjectDirNameWindowsPath(t *testing.T) {
	got := encodeClaudeProjectDirName(`C:\Users\Administrator\pockly-e2e-test`)
	if got != "C--Users-Administrator-pockly-e2e-test" {
		t.Fatalf("encoded Windows cwd = %q, want C--Users-Administrator-pockly-e2e-test", got)
	}
}

func TestEncodeClaudeProjectDirNameUnixPath(t *testing.T) {
	got := encodeClaudeProjectDirName("/Users/administrator/pockly-e2e-test")
	if got != "-Users-administrator-pockly-e2e-test" {
		t.Fatalf("encoded Unix cwd = %q, want -Users-administrator-pockly-e2e-test", got)
	}
}

// TestParseClaudeInvocationGeneratesUUID covers the v0.1.36 happy path:
// bare `claude` (no session flag) gets a wrapper-generated UUIDv4 that
// will be injected via --session-id <uuid> before exec. The UUID is the
// authoritative binding — it determines the jsonl path, appears in the
// jsonl content, and identifies the wrapper to the daemon.
func TestParseClaudeInvocationGeneratesUUID(t *testing.T) {
	cases := [][]string{
		nil,               // bare `claude`
		{"--print", "hi"}, // non-session flag
	}
	for _, args := range cases {
		inv := parseClaudeInvocation(args)
		if inv.sessionID == "" {
			t.Fatalf("expected generated sid for %v, got empty", args)
		}
		if !inv.lockable {
			t.Fatalf("bare args must be lockable so wrapper can inject --session-id; got lockable=false")
		}
		if !inv.injectFlag {
			t.Fatalf("bare args require injectFlag=true so resolveLockedSessionID prepends --session-id; got false")
		}
		// Sanity: UUIDv4 is 36 chars (8-4-4-4-12 + four dashes) with
		// version nibble '4' at index 14.
		if len(inv.sessionID) != 36 || inv.sessionID[14] != '4' {
			t.Fatalf("sid %q is not a v4 UUID (expect 36 chars, '4' at index 14)", inv.sessionID)
		}
	}
}

// TestParseClaudeInvocationForkSession verifies the --fork-session
// escape hatch: claude generates the sid internally, so the wrapper
// can't lock it. The watcher falls back to fd-based discovery instead.
func TestParseClaudeInvocationForkSession(t *testing.T) {
	inv := parseClaudeInvocation([]string{"--fork-session", "--resume", "x"})
	if inv.lockable {
		t.Fatalf("--fork-session must mark invocation as not lockable")
	}
	if inv.sessionID != "" {
		t.Fatalf("--fork-session: sessionID should be empty (claude will pick), got %q", inv.sessionID)
	}
}

// TestResolveLockedSessionIDInjects covers the rewriter: bare args get
// `--session-id <uuid>` prepended; --continue gets pre-resolved into
// `--resume <sid>`; user-supplied sids pass through unchanged.
func TestResolveLockedSessionIDInjects(t *testing.T) {
	dir := t.TempDir()
	// Pre-populate one CLI jsonl so --continue has something to pick.
	existing := filepath.Join(dir, "pre-existing-sid.jsonl")
	if err := os.WriteFile(existing,
		[]byte(`{"type":"user","entrypoint":"cli","cwd":"/x","sessionId":"pre-existing-sid"}`+"\n"),
		0o644); err != nil {
		t.Fatal(err)
	}
	// Reset entrypoint cache for hermeticity.
	entrypointCacheMu.Lock()
	entrypointCache = map[string]entrypointCacheEntry{}
	entrypointCacheMu.Unlock()

	t.Run("bare prepends --session-id", func(t *testing.T) {
		args, inv := resolveLockedSessionID(nil, dir)
		if len(args) < 2 || args[0] != "--session-id" {
			t.Fatalf("expected --session-id prepended, got %v", args)
		}
		if args[1] != inv.sessionID {
			t.Fatalf("flag value %q ≠ invocation sid %q", args[1], inv.sessionID)
		}
		if !inv.lockable {
			t.Fatalf("bare must be lockable post-resolve")
		}
	})

	t.Run("--resume pass-through (no rewrite)", func(t *testing.T) {
		args, inv := resolveLockedSessionID([]string{"--resume", "user-sid"}, dir)
		if len(args) != 2 || args[0] != "--resume" || args[1] != "user-sid" {
			t.Fatalf("--resume user-sid should pass through, got %v", args)
		}
		if inv.sessionID != "user-sid" || !inv.lockable {
			t.Fatalf("invocation should be locked to user's sid, got %+v", inv)
		}
	})

	t.Run("--continue rewrites to --resume <pre-resolved-sid>", func(t *testing.T) {
		args, inv := resolveLockedSessionID([]string{"--continue"}, dir)
		// Must NOT contain --continue / -c anymore; must contain --resume pre-existing-sid.
		for _, a := range args {
			if a == "--continue" || a == "-c" {
				t.Fatalf("--continue should be stripped, got %v", args)
			}
		}
		var foundResume bool
		for i, a := range args {
			if a == "--resume" && i+1 < len(args) && args[i+1] == "pre-existing-sid" {
				foundResume = true
				break
			}
		}
		if !foundResume {
			t.Fatalf("expected --resume pre-existing-sid in rewritten args, got %v", args)
		}
		if inv.sessionID != "pre-existing-sid" || !inv.lockable {
			t.Fatalf("invocation should be locked to pre-resolved sid, got %+v", inv)
		}
	})

	t.Run("--fork-session passes through, not lockable", func(t *testing.T) {
		args, inv := resolveLockedSessionID([]string{"--fork-session", "--resume", "x"}, dir)
		if len(args) != 3 {
			t.Fatalf("--fork-session args should not be rewritten, got %v", args)
		}
		if inv.lockable {
			t.Fatalf("--fork-session must not be lockable")
		}
	})
}

// TestNewestJSONLAfter exercises the mtime-based fallback used when
// fd-based discovery can't run (no PID, lsof missing, /proc unreadable).
// Same `mtime >= startedAt` contract as the v1.5.3 pickActiveSessionJSONL
// — see git history for why earlier `mtime > snapshot` semantics broke
// fast-write claudes.
func TestNewestJSONLAfter(t *testing.T) {
	mustTouch := func(t *testing.T, dir, name string, mtime time.Time) string {
		t.Helper()
		path := filepath.Join(dir, name)
		f, err := os.Create(path)
		if err != nil {
			t.Fatalf("create %s: %v", path, err)
		}
		_ = f.Close()
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatalf("chtimes %s: %v", path, err)
		}
		return path
	}

	t.Run("brand new file after startup", func(t *testing.T) {
		dir := t.TempDir()
		startedAt := time.Now()
		mustTouch(t, dir, "new-sess-aaaa.jsonl", startedAt.Add(2*time.Second))
		sid, _, ok := newestJSONLAfter(dir, startedAt)
		if !ok || sid != "new-sess-aaaa" {
			t.Fatalf("got (%q, %v), want (\"new-sess-aaaa\", true)", sid, ok)
		}
	})

	t.Run("resumed file with bumped mtime", func(t *testing.T) {
		dir := t.TempDir()
		mustTouch(t, dir, "resumed-bbbb.jsonl", time.Now().Add(-30*time.Minute))
		startedAt := time.Now()
		newMtime := startedAt.Add(1 * time.Second)
		if err := os.Chtimes(filepath.Join(dir, "resumed-bbbb.jsonl"), newMtime, newMtime); err != nil {
			t.Fatalf("chtimes: %v", err)
		}
		sid, _, ok := newestJSONLAfter(dir, startedAt)
		if !ok || sid != "resumed-bbbb" {
			t.Fatalf("got (%q, %v), want (\"resumed-bbbb\", true)", sid, ok)
		}
	})

	t.Run("untouched pre-existing file ignored", func(t *testing.T) {
		dir := t.TempDir()
		mustTouch(t, dir, "stale-cccc.jsonl", time.Now().Add(-2*time.Hour))
		startedAt := time.Now()
		if _, _, ok := newestJSONLAfter(dir, startedAt); ok {
			t.Fatalf("expected no match for stale file")
		}
	})

	t.Run("non-jsonl files ignored", func(t *testing.T) {
		dir := t.TempDir()
		startedAt := time.Now()
		mustTouch(t, dir, "ignore-me.txt", startedAt.Add(1*time.Second))
		if _, _, ok := newestJSONLAfter(dir, startedAt); ok {
			t.Fatalf("expected no match for non-jsonl")
		}
	})

	t.Run("missing dir returns empty", func(t *testing.T) {
		if _, _, ok := newestJSONLAfter("/nonexistent/path/that/does/not/exist", time.Now()); ok {
			t.Fatalf("expected empty for missing dir")
		}
	})

	// REGRESSION (carried from pickActiveSessionJSONL): fake-claude writes
	// its single jsonl event during startup (~5-15ms). The newest-mtime
	// rule must accept a file whose mtime is at-or-after startedAt, not
	// strictly after.
	t.Run("fast-write session whose mtime equals startedAt is matched", func(t *testing.T) {
		dir := t.TempDir()
		startedAt := time.Now()
		mustTouch(t, dir, "fast-dddd.jsonl", startedAt.Add(5*time.Millisecond))
		sid, _, ok := newestJSONLAfter(dir, startedAt)
		if !ok || sid != "fast-dddd" {
			t.Fatalf("fast-write file SHOULD match (mtime >= startedAt), got (%q, %v)", sid, ok)
		}
	})

	t.Run("multiple candidates returns newest", func(t *testing.T) {
		dir := t.TempDir()
		startedAt := time.Now()
		mustTouch(t, dir, "old-ffff.jsonl", startedAt.Add(1*time.Second))
		mustTouch(t, dir, "new-gggg.jsonl", startedAt.Add(3*time.Second))
		sid, _, ok := newestJSONLAfter(dir, startedAt)
		if !ok || sid != "new-gggg" {
			t.Fatalf("expected newest mtime to win, got (%q, %v)", sid, ok)
		}
	})
}

// TestUpdateClaudeSessionIDDetectsRotation guards the rotation-detection
// semantics in the legacy --fork-session path: the watcher must register
// a session_rebound (changed=true, prev=old_sid) when it observes the
// discovered sid changing mid-flight, NOT silently latch onto the first
// pick. Pre-rewrite the wrapper latched once and ignored subsequent
// changes — claude would route inject text into a stale jsonl after any
// in-app /resume.
//
// Note: v0.1.36 removed the mtime fallback in resolveActiveSession, so
// we exercise updateClaudeSessionID directly rather than driving it
// through the discovery loop (which now requires real lsof / proc-fd
// access we can't fake in a unit test). The rotation invariant is
// preserved either way — discovery is just the source of sids.
func TestUpdateClaudeSessionIDDetectsRotation(t *testing.T) {
	bridge := &daemonBridge{cwd: "/tmp", done: make(chan struct{})}

	changed, prev := bridge.updateClaudeSessionID("sess-aaa")
	if !changed || prev != "" {
		t.Fatalf("first bind should be changed=true prev=\"\", got changed=%v prev=%q", changed, prev)
	}
	if got := bridge.ClaudeSessionID(); got != "sess-aaa" {
		t.Fatalf("after first bind: ClaudeSessionID=%q, want sess-aaa", got)
	}

	changed, prev = bridge.updateClaudeSessionID("sess-aaa")
	if changed {
		t.Fatalf("re-asserting same sid should not register as change; got changed=true")
	}

	changed, prev = bridge.updateClaudeSessionID("sess-bbb")
	if !changed || prev != "sess-aaa" {
		t.Fatalf("rotation should register as changed=true prev=sess-aaa, got changed=%v prev=%q", changed, prev)
	}
	if got := bridge.ClaudeSessionID(); got != "sess-bbb" {
		t.Fatalf("post-rotation: ClaudeSessionID=%q, want sess-bbb", got)
	}
}

// TestEmitReRegistersOnDaemon404 is the regression test for v0.1.25's main
// fix: when the daemon is restarted (launchctl bootout/bootstrap, crash,
// upgrade), its in-memory terminal_sessions map is empty. The wrapper's
// next Emit hits a 404 on its old id. Before this fix, the response was
// silently discarded and every subsequent event also 404'd — the wrapper
// looked attached but was sending into a void. Now the bridge auto
// re-registers on 404 and replays the event with the new id.
func TestEmitReRegistersOnDaemon404(t *testing.T) {
	var (
		mu          sync.Mutex
		liveIDs     = map[string]bool{"ts_initial": true}
		mintedIDs   []string
		eventCount  atomic.Int32
		statusFlips []bool
	)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/dev/terminal-sessions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		// Mint a fresh id for each (re-)register call.
		mu.Lock()
		id := fmt.Sprintf("ts_mint_%d", len(mintedIDs)+1)
		mintedIDs = append(mintedIDs, id)
		liveIDs[id] = true
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"terminal_session": map[string]string{"id": id},
		})
	})
	mux.HandleFunc("/api/dev/terminal-sessions/", func(w http.ResponseWriter, r *http.Request) {
		// Path: /api/dev/terminal-sessions/<id>/events
		path := r.URL.Path
		// Crude parse: pull <id> between the prefix and the next slash.
		prefix := "/api/dev/terminal-sessions/"
		rest := path[len(prefix):]
		var id string
		for i := 0; i < len(rest); i++ {
			if rest[i] == '/' {
				id = rest[:i]
				break
			}
		}
		mu.Lock()
		live := liveIDs[id]
		mu.Unlock()
		if !live {
			http.NotFound(w, r)
			return
		}
		eventCount.Add(1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	bridge := &daemonBridge{
		client: srv.Client(),
		base:   srv.URL,
		cwd:    "/tmp/test",
		done:   make(chan struct{}),
		id:     "ts_initial",
	}
	bridge.SetStatusCallback(func(attached bool) {
		mu.Lock()
		statusFlips = append(statusFlips, attached)
		mu.Unlock()
	})

	// First Emit on the initial id — should succeed without re-register.
	bridge.Emit("text_delta", "live", "streaming", "hi", "")
	if got := eventCount.Load(); got != 1 {
		t.Fatalf("expected 1 event accepted on initial id, got %d", got)
	}

	// Simulate daemon restart: the daemon no longer knows ts_initial.
	mu.Lock()
	delete(liveIDs, "ts_initial")
	mu.Unlock()

	// Next Emit must 404 → re-register → retry. After reregister:
	//   1. the initial text_delta on the old id 404s (not counted)
	//   2. reregister itself fires session_started on the new id (+1)
	//   3. the retried text_delta on the new id is accepted (+1)
	// So eventCount goes 1 → 3.
	bridge.Emit("text_delta", "live", "streaming", "after-restart", "")
	if got := eventCount.Load(); got != 3 {
		t.Fatalf("expected 3 events accepted (initial + reregister session_started + retry), got %d", got)
	}
	mu.Lock()
	mintedCount := len(mintedIDs)
	newID := bridge.currentID()
	mu.Unlock()
	if mintedCount != 1 {
		t.Fatalf("expected exactly 1 re-register, got %d minted ids", mintedCount)
	}
	if newID != mintedIDs[0] {
		t.Fatalf("bridge id = %q, want minted %q", newID, mintedIDs[0])
	}

	// Status callback should have fired at least once with attached=true
	// after the successful re-register.
	mu.Lock()
	sawAttached := false
	for _, attached := range statusFlips {
		if attached {
			sawAttached = true
			break
		}
	}
	mu.Unlock()
	if !sawAttached {
		t.Fatalf("expected status callback to fire with attached=true after reconnect, got %v", statusFlips)
	}
}

// TestEmitNetworkErrorMarksDetached verifies that when the daemon is fully
// down (TCP refused), we don't retry indefinitely; we just mark the
// indicator detached and return so the calling goroutine doesn't block.
func TestEmitNetworkErrorMarksDetached(t *testing.T) {
	bridge := &daemonBridge{
		client: &http.Client{Timeout: 100 * time.Millisecond},
		base:   "http://127.0.0.1:1", // guaranteed-refused port
		cwd:    "/tmp/test",
		done:   make(chan struct{}),
		id:     "ts_initial",
	}
	var (
		mu          sync.Mutex
		statusFlips []bool
	)
	bridge.SetStatusCallback(func(attached bool) {
		mu.Lock()
		statusFlips = append(statusFlips, attached)
		mu.Unlock()
	})
	done := make(chan struct{})
	go func() {
		bridge.Emit("text_delta", "live", "streaming", "x", "")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Emit blocked on a refused-connection daemon")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(statusFlips) == 0 || statusFlips[len(statusFlips)-1] != false {
		t.Fatalf("expected detached status flip, got %v", statusFlips)
	}
}

// TestSetupPermissionMCPWiring is the v0.1.44 S3 regression test for
// the wrapper's PTY-mode MCP injection. The wiring (3 layers: temp
// config file shape + child argv + tool name string) is fragile — a
// typo anywhere silently disables the 🛡️ permission cards on web
// without crashing the wrapper. Lock the contract in a unit test so
// the next refactor breaks the test instead of the user-facing UX.
//
// We can't easily fake `os.Executable()` to control where setupPermission
// MCP looks for the daemon binary, so the test runs in two modes:
//
//   - If the daemon binary IS resolvable (typical when running `go test`
//     after `make build`), assert the full shape: config file written,
//     flags returned, JSON parses, server "pockly" registers the
//     daemon binary with `mcp-permission --session-id <sid>`.
//   - If it ISN'T (clean checkout, no ./bin/ yet), assert that the
//     graceful-degradation path returns ("", nil, nil) — the wrapper
//     must not crash when MCP wiring is unavailable.
func TestSetupPermissionMCPWiring(t *testing.T) {
	const sid = "test-session-id-v0144"
	path, cleanup, args := setupPermissionMCP(sid)
	if cleanup != nil {
		defer cleanup()
	}

	if path == "" {
		// Graceful-degradation case: daemon binary not on PATH and not
		// next to the test binary. Verify the contract:
		if args != nil {
			t.Fatalf("path empty but args non-nil: %v", args)
		}
		if cleanup != nil {
			t.Fatalf("path empty but cleanup non-nil")
		}
		t.Skip("pockly-daemon binary not resolvable from test context; full-shape assertions skipped (graceful-degradation path verified)")
		return
	}

	// Full shape: assert the flags claude code expects.
	if len(args) != 4 {
		t.Fatalf("expected 4 args, got %d: %v", len(args), args)
	}
	if args[0] != "--mcp-config" || args[1] != path {
		t.Fatalf("expected --mcp-config %s, got %v", path, args[:2])
	}
	if args[2] != "--permission-prompt-tool" {
		t.Fatalf("expected --permission-prompt-tool, got %q", args[2])
	}
	// claude's contract: the tool ref MUST be `mcp__<server>__<tool>`.
	// Server is "pockly", tool is "request_permission". Drift here
	// breaks the dispatcher with a confusing "tool not found" error.
	if args[3] != "mcp__pockly__request_permission" {
		t.Fatalf("expected mcp__pockly__request_permission, got %q", args[3])
	}

	// Config file shape: claude code parses this and spawns the server.
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(body, &cfg); err != nil {
		t.Fatalf("parse config %q: %v", string(body), err)
	}
	pockly, ok := cfg.MCPServers["pockly"]
	if !ok {
		t.Fatalf("config missing mcpServers.pockly: %s", string(body))
	}
	if pockly.Command == "" {
		t.Fatalf("config has empty command: %s", string(body))
	}
	if filepath.Base(pockly.Command) != "pockly-daemon" {
		t.Fatalf("command should be pockly-daemon, got %q", pockly.Command)
	}
	// Args must include the subcommand + sid + v0.2.0 --interactive
	// flag so the spawned MCP server knows which terminal_session to
	// POST events against AND blocks for the user's allow/deny.
	wantArgs := []string{"mcp-permission", "--session-id", sid, "--interactive"}
	if fmt.Sprintf("%v", pockly.Args) != fmt.Sprintf("%v", wantArgs) {
		t.Fatalf("expected args %v, got %v", wantArgs, pockly.Args)
	}
}

func TestDetectClaudeTUIApprovalWritePrompt(t *testing.T) {
	screen := "\x1b[2J● Write(pockly-permission-e2e.txt)\n\n" +
		" Do you want to create pockly-permission-e2e.txt?\n" +
		" ❯ 1. Yes\n" +
		"   2. Yes, allow all edits during this session (shift+tab)\n" +
		"   3. No\n"

	got, ok := detectClaudeTUIApproval(string(stripANSI([]byte(screen))))
	if !ok {
		t.Fatal("expected approval prompt to be detected")
	}
	if got.ToolName != "Write" {
		t.Fatalf("ToolName = %q, want Write", got.ToolName)
	}
	if got.Input["target"] != "pockly-permission-e2e.txt" {
		t.Fatalf("target = %#v, want pockly-permission-e2e.txt", got.Input["target"])
	}
	if got.Sig == "" {
		t.Fatal("expected non-empty signature")
	}
	if got.Sig != permissionPromptSig("Write", "pockly-permission-e2e.txt", "") {
		t.Fatalf("Sig = %q, want normalized Write target signature", got.Sig)
	}
}

func TestDetectClaudeTUIApprovalBashPrompt(t *testing.T) {
	screen := "\x1b[2J● Bash(rm /home/tester/code/demo/pockly-real-web-permission-1779978473666.txt)\n" +
		"  ⎿  Waiting…\n\n" +
		"────────────────────────────────────────────────────────────────\n" +
		" Bash command\n\n" +
		"   rm /home/tester/code/demo/pockly-real-web-permission-1779978473666.txt\n" +
		"   Delete the file\n\n" +
		" Do you want to proceed?\n" +
		" ❯ 1. Yes\n" +
		"   2. Yes, and always allow access to demo/ from this project\n" +
		"   3. No\n" +
		"\n" +
		" Esc to cancel · Tab to amend · ctrl+e to explain\n"

	got, ok := detectClaudeTUIApproval(string(stripANSI([]byte(screen))))
	if !ok {
		t.Fatal("expected Bash approval prompt to be detected")
	}
	if got.ToolName != "Bash" {
		t.Fatalf("ToolName = %q, want Bash", got.ToolName)
	}
	command, _ := got.Input["command"].(string)
	if command != "rm /home/tester/code/demo/pockly-real-web-permission-1779978473666.txt" {
		t.Fatalf("command = %#v, want rm command", got.Input["command"])
	}
	if got.Input["description"] != "Delete the file" {
		t.Fatalf("description = %#v, want Delete the file", got.Input["description"])
	}
	if got.Input["target"] != command {
		t.Fatalf("target = %#v, want command", got.Input["target"])
	}
	if got.Sig != permissionPromptSig("Bash", command, "") {
		t.Fatalf("Sig = %q, want normalized Bash command signature", got.Sig)
	}
}

func TestDetectClaudeTUIApprovalIgnoresOrdinaryOutput(t *testing.T) {
	screen := "● Write(file.txt)\nCreated file.txt successfully\n"
	if _, ok := detectClaudeTUIApproval(screen); ok {
		t.Fatal("ordinary output should not be detected as an approval prompt")
	}
}

// TestShouldHoldPromptReady covers C8: the idle-timer prompt_ready is held off
// ONLY by a fresh, explicitly non-idle Claude status. Unknown / idle / stale
// status must NOT hold (so a missing or stale status can never wedge
// prompt_ready permanently off).
func TestShouldHoldPromptReady(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	fresh := 10 * time.Second
	cases := []struct {
		name      string
		status    string
		updatedAt int64
		hold      bool
	}{
		{"fresh running → hold", "running", now.Add(-2 * time.Second).UnixMilli(), true},
		{"fresh busy (mixed case) → hold", "Busy", now.Add(-1 * time.Second).UnixMilli(), true},
		{"fresh waiting-permission → hold", "waiting", now.Add(-500 * time.Millisecond).UnixMilli(), true},
		{"idle → no hold", "idle", now.Add(-1 * time.Second).UnixMilli(), false},
		{"unknown/empty → no hold", "", now.Add(-1 * time.Second).UnixMilli(), false},
		{"stale running → no hold (can't wedge)", "running", now.Add(-30 * time.Second).UnixMilli(), false},
		{"non-idle but no updatedAt → no hold", "running", 0, false},
	}
	for _, c := range cases {
		if got := shouldHoldPromptReady(c.status, c.updatedAt, now, fresh); got != c.hold {
			t.Errorf("%s: shouldHoldPromptReady(%q,%d) = %v, want %v", c.name, c.status, c.updatedAt, got, c.hold)
		}
	}
}

// TestParseTUIYesNoOptions covers B5/B7: keys are derived from the actual
// numbered options (not assumed 1/3), the persistent "always allow" yes is
// skipped, and detection needs both a one-time Yes and a No.
func TestParseTUIYesNoOptions(t *testing.T) {
	cases := []struct {
		name        string
		screen      string
		allow, deny string
		ok          bool
	}{
		{"standard 1/3", " ❯ 1. Yes\n   2. Yes, and always allow\n   3. No", "1", "3", true},
		{"allow-all variant skipped", "1. Yes\n2. Yes, allow all edits during this session\n3. No", "1", "3", true},
		{"renumbered 2/4", "   2. Yes\n   3. Yes, and always allow access\n   4. No", "2", "4", true},
		{"only persistent yes → not ok", "1. Yes, and always allow\n2. No", "", "2", false},
		{"no No option → not ok", "1. Yes\n2. Maybe", "1", "", false},
		{"no options → not ok", "just some text", "", "", false},
	}
	for _, c := range cases {
		allow, deny, ok := parseTUIYesNoOptions(c.screen)
		if ok != c.ok || allow != c.allow || deny != c.deny {
			t.Errorf("%s: parseTUIYesNoOptions = (%q,%q,%v), want (%q,%q,%v)", c.name, allow, deny, ok, c.allow, c.deny, c.ok)
		}
	}
}

// TestDetectClaudeTUIApprovalDynamicKeys: a build that renumbers the options
// still detects, and the prompt carries the right keystroke numbers so web
// Approve/Deny map to the correct choice (B7) instead of always 1/3.
func TestDetectClaudeTUIApprovalDynamicKeys(t *testing.T) {
	screen := "● Write(notes.txt)\n\n Do you want to create notes.txt?\n" +
		"   2. Yes\n" +
		"   3. Yes, and always allow edits\n" +
		"   4. No\n"
	got, ok := detectClaudeTUIApproval(string(stripANSI([]byte(screen))))
	if !ok {
		t.Fatal("expected detection on renumbered options")
	}
	if got.AllowKey != "2" || got.DenyKey != "4" {
		t.Fatalf("keys = (%q,%q), want (2,4)", got.AllowKey, got.DenyKey)
	}
	if k := tuiDecisionKey("allow", got.AllowKey, got.DenyKey); k != "2\r" {
		t.Fatalf("allow keystroke = %q, want 2\\r", k)
	}
	if k := tuiDecisionKey("deny", got.AllowKey, got.DenyKey); k != "4\r" {
		t.Fatalf("deny keystroke = %q, want 4\\r", k)
	}
	// Empty keys fall back to Claude's historical 1/3 (keeps old behavior).
	if k := tuiDecisionKey("allow", "", ""); k != "1\r" {
		t.Fatalf("fallback allow = %q, want 1\\r", k)
	}
}

func TestDetectUnknownClaudeTUIApproval(t *testing.T) {
	screen := "Some custom Claude prompt\n\n Do you want to continue with this operation?\n Esc to cancel\n"
	got, ok := detectUnknownClaudeTUIApproval(screen)
	if !ok {
		t.Fatal("expected unknown local confirmation prompt")
	}
	if !got.LocalOnly {
		t.Fatal("unknown prompt must be local-only")
	}
	if got.ToolName != "Claude" {
		t.Fatalf("ToolName = %q, want Claude", got.ToolName)
	}
	if got.Input["prompt"] != "Do you want to continue with this operation?" {
		t.Fatalf("prompt = %#v", got.Input["prompt"])
	}
}

func TestDetectClaudeFileToolApprovalWrite(t *testing.T) {
	rec := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type": "tool_use",
					"name": "Write",
					"id":   "toolu_123",
					"input": map[string]any{
						"file_path": "/tmp/pockly.txt",
						"content":   "hello",
					},
				},
			},
		},
	}
	got, ok := detectClaudeFileToolApproval(rec)
	if !ok {
		t.Fatal("expected Write tool_use to require approval")
	}
	if got.ToolName != "Write" {
		t.Fatalf("ToolName = %q, want Write", got.ToolName)
	}
	if got.Input["target"] != "/tmp/pockly.txt" {
		t.Fatalf("target = %#v, want /tmp/pockly.txt", got.Input["target"])
	}
	if got.ToolUseID != "toolu_123" {
		t.Fatalf("ToolUseID = %q, want toolu_123", got.ToolUseID)
	}
	if got.Sig != permissionPromptSig("Write", "/tmp/pockly.txt", "") {
		t.Fatalf("Sig = %q, want normalized Write target signature", got.Sig)
	}
}

func TestDetectClaudeFileToolApprovalSkipsBash(t *testing.T) {
	rec := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type":  "tool_use",
					"name":  "Bash",
					"input": map[string]any{"command": "ls"},
				},
			},
		},
	}
	if _, ok := detectClaudeFileToolApproval(rec); ok {
		t.Fatal("file-tool fallback detector must not claim Bash tool_use records")
	}
}

func TestDetectClaudeBashToolApproval(t *testing.T) {
	rec := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type": "tool_use",
					"name": "Bash",
					"id":   "toolu_bash",
					"input": map[string]any{
						"command":     "rm /tmp/pockly-permission.txt",
						"description": "Delete the file",
					},
				},
			},
		},
	}
	got, ok := detectClaudeBashToolApproval(rec)
	if !ok {
		t.Fatal("expected Bash tool_use to be eligible for Claude-status-gated fallback")
	}
	if got.ToolName != "Bash" {
		t.Fatalf("ToolName = %q, want Bash", got.ToolName)
	}
	if got.Input["command"] != "rm /tmp/pockly-permission.txt" {
		t.Fatalf("command = %#v, want rm command", got.Input["command"])
	}
	if got.Input["description"] != "Delete the file" {
		t.Fatalf("description = %#v, want Delete the file", got.Input["description"])
	}
	if got.ToolUseID != "toolu_bash" {
		t.Fatalf("ToolUseID = %q, want toolu_bash", got.ToolUseID)
	}
}

func TestDetectClaudeGenericToolApprovalWebSearch(t *testing.T) {
	rec := map[string]any{
		"type": "assistant",
		"message": map[string]any{
			"content": []any{
				map[string]any{
					"type": "tool_use",
					"name": "WebSearch",
					"id":   "toolu_search",
					"input": map[string]any{
						"query": "open-design open source project",
					},
				},
			},
		},
	}
	got, ok := detectClaudeGenericToolApproval(rec)
	if !ok {
		t.Fatal("expected WebSearch tool_use to be eligible for Claude-status-gated fallback")
	}
	if got.ToolName != "WebSearch" {
		t.Fatalf("ToolName = %q, want WebSearch", got.ToolName)
	}
	if got.Input["query"] != "open-design open source project" {
		t.Fatalf("query = %#v", got.Input["query"])
	}
	if got.ToolUseID != "toolu_search" {
		t.Fatalf("ToolUseID = %q, want toolu_search", got.ToolUseID)
	}
	if got.Sig != permissionPromptSig("WebSearch", `{"query":"open-design open source project"}`, "") {
		t.Fatalf("Sig = %q, want stable WebSearch input signature", got.Sig)
	}
}

func TestDetectClaudeGenericToolApprovalSkipsSpecializedTools(t *testing.T) {
	for _, name := range []string{"Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"} {
		rec := map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"content": []any{
					map[string]any{
						"type":  "tool_use",
						"name":  name,
						"id":    "toolu_special",
						"input": map[string]any{"command": "pwd", "file_path": "/tmp/a.txt"},
					},
				},
			},
		}
		if _, ok := detectClaudeGenericToolApproval(rec); ok {
			t.Fatalf("generic detector must not claim specialized tool %s", name)
		}
	}
}

func TestTUIPermissionDecisionKeyUsesClaudeOneTimeOptions(t *testing.T) {
	if got := tuiPermissionDecisionKey("allow"); got != "1\r" {
		t.Fatalf("allow key = %q, want one-time option 1", got)
	}
	if got := tuiPermissionDecisionKey("deny"); got != "3\r" {
		t.Fatalf("deny key = %q, want option 3", got)
	}
	if got := tuiPermissionDecisionKey("allow_always"); got != "" {
		t.Fatalf("allow_always must not map to Claude persistent option 2, got %q", got)
	}
}

func TestWebPermissionKeyToWriteDropsWhenNotWaiting(t *testing.T) {
	// While Claude is still blocked on the prompt, the mapped key is forwarded.
	if got := webPermissionKeyToWrite("allow", true); got != "1\r" {
		t.Fatalf("allow while waiting = %q, want \"1\\r\"", got)
	}
	if got := webPermissionKeyToWrite("deny", true); got != "3\r" {
		t.Fatalf("deny while waiting = %q, want \"3\\r\"", got)
	}
	// Once Claude has advanced past the prompt (the user answered at the local
	// terminal first), NO key may be written — otherwise the late web decision
	// injects a stray "1"/"3" keystroke into Claude's stdin (double-decide).
	if got := webPermissionKeyToWrite("allow", false); got != "" {
		t.Fatalf("allow when no longer waiting must be dropped, got %q", got)
	}
	if got := webPermissionKeyToWrite("deny", false); got != "" {
		t.Fatalf("deny when no longer waiting must be dropped, got %q", got)
	}
	// Unmapped decisions never produce a key, regardless of waiting state.
	if got := webPermissionKeyToWrite("allow_always", true); got != "" {
		t.Fatalf("allow_always must not map to a key, got %q", got)
	}
}

func TestClaudeSessionWaitingForPermission(t *testing.T) {
	home := t.TempDir()
	setTestClaudeHome(t, home)
	dir := filepath.Join(home, ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1234.json"), []byte(`{"pid":1234,"status":"waiting","waitingFor":"permission prompt"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if !(&daemonBridge{pid: 1234}).claudeSessionWaitingForPermission() {
		t.Fatal("expected waiting permission status")
	}
	if (&daemonBridge{pid: 5678}).claudeSessionWaitingForPermission() {
		t.Fatal("missing status file must not count as waiting for permission")
	}
}

func TestClaudeSessionWaitingForPermissionHonorsConfigDir(t *testing.T) {
	home := t.TempDir()
	configDir := t.TempDir()
	setTestClaudeHome(t, home)
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.MkdirAll(filepath.Join(configDir, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "sessions", "2468.json"), []byte(`{"pid":2468,"status":"waiting","waitingFor":"permission prompt"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if !(&daemonBridge{pid: 2468}).claudeSessionWaitingForPermission() {
		t.Fatal("expected waiting permission status under CLAUDE_CONFIG_DIR")
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "sessions", "2468.json")); !os.IsNotExist(err) {
		t.Fatalf("test should not depend on HOME .claude status file, stat err=%v", err)
	}
}

func TestTUIPermissionWatcherScheduledFallbackRequiresClaudeWaitingStatus(t *testing.T) {
	home := t.TempDir()
	setTestClaudeHome(t, home)
	dir := filepath.Join(home, ".claude", "sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "1234.json"), []byte(`{"pid":1234,"status":"ready","waitingFor":""}`), 0o644); err != nil {
		t.Fatal(err)
	}
	w := newTUIPermissionWatcher(&daemonBridge{pid: 1234}, func([]byte) (int, error) { return 0, nil })
	prompt := tuiPermissionPrompt{
		ToolName:  "Bash",
		Sig:       permissionPromptSig("Bash", "rm /tmp/a.txt", ""),
		ToolUseID: "toolu_not_waiting",
	}
	w.mu.Lock()
	w.fallbackTimers[prompt.Sig] = time.NewTimer(time.Hour)
	w.toolUseFallback[prompt.ToolUseID] = prompt.Sig
	w.mu.Unlock()

	w.StartScheduledFallback(prompt)

	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.active[prompt.Sig]; ok {
		t.Fatal("fallback must not start unless Claude status is waiting for permission")
	}
	if w.fallbackTimers[prompt.Sig] != nil {
		t.Fatal("suppressed fallback should still clear its stale timer")
	}
	if w.toolUseFallback[prompt.ToolUseID] != "" {
		t.Fatal("suppressed fallback should clear its tool-use mapping")
	}
}

func TestDetectClaudeToolResultIDs(t *testing.T) {
	rec := map[string]any{
		"type": "user",
		"message": map[string]any{
			"content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_1"},
				map[string]any{"type": "text", "text": "done"},
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_2"},
			},
		},
	}
	got := detectClaudeToolResultIDs(rec)
	if fmt.Sprintf("%v", got) != "[toolu_1 toolu_2]" {
		t.Fatalf("tool result ids = %v, want [toolu_1 toolu_2]", got)
	}
}

func TestTUIPermissionWatcherDedupesOnlyInFlight(t *testing.T) {
	w := newTUIPermissionWatcher(&daemonBridge{}, func([]byte) (int, error) { return 0, nil })
	w.recentTTL = -time.Second
	prompt := tuiPermissionPrompt{ToolName: "Write", Sig: permissionPromptSig("Write", "/tmp/a.txt", "")}

	w.mu.Lock()
	if !w.startLocked(prompt) {
		w.mu.Unlock()
		t.Fatal("first prompt should start")
	}
	if w.startLocked(prompt) {
		w.mu.Unlock()
		t.Fatal("in-flight duplicate should be suppressed")
	}
	w.mu.Unlock()

	w.finish(prompt)

	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.startLocked(prompt) {
		t.Fatal("same prompt should be allowed again after the prior request finishes")
	}
}

func TestTUIPermissionWatcherCancelsJSONLFallbackOnToolResult(t *testing.T) {
	w := newTUIPermissionWatcher(&daemonBridge{}, func([]byte) (int, error) { return 0, nil })
	w.fallbackDelay = time.Hour
	prompt := tuiPermissionPrompt{
		ToolName:  "Write",
		Sig:       permissionPromptSig("Write", "/tmp/a.txt", ""),
		ToolUseID: "toolu_cancel",
	}
	w.ScheduleFallback(prompt)

	w.mu.Lock()
	if w.fallbackTimers[prompt.Sig] == nil {
		w.mu.Unlock()
		t.Fatal("expected scheduled fallback timer")
	}
	w.mu.Unlock()

	w.CancelFallback("toolu_cancel")

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.fallbackTimers[prompt.Sig] != nil {
		t.Fatal("fallback timer should be removed after matching tool_result")
	}
}

func TestTUIPermissionWatcherScheduledFallbackClearsTimerWhenSuppressed(t *testing.T) {
	w := newTUIPermissionWatcher(&daemonBridge{}, func([]byte) (int, error) { return 0, nil })
	prompt := tuiPermissionPrompt{
		ToolName:  "Write",
		Sig:       permissionPromptSig("Write", "/tmp/a.txt", ""),
		ToolUseID: "toolu_suppressed",
	}

	w.mu.Lock()
	w.active[prompt.Sig] = struct{}{}
	w.fallbackTimers[prompt.Sig] = time.NewTimer(time.Hour)
	w.toolUseFallback[prompt.ToolUseID] = prompt.Sig
	w.mu.Unlock()

	w.StartScheduledFallback(prompt)

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.fallbackTimers[prompt.Sig] != nil {
		t.Fatal("scheduled fallback should remove stale timer entry even when start is suppressed")
	}
	if w.toolUseFallback[prompt.ToolUseID] != "" {
		t.Fatal("scheduled fallback should remove stale tool-use mapping even when start is suppressed")
	}
}

// TestEmitRetriesOn5xx is the v0.2.2 regression for bug #150 — pre-v0.2.2
// the wrapper silently dropped events on 5xx responses (single attempt,
// no retry, no queue). Now it retries up to 4x with exponential backoff,
// so a transient 503 (relay deploying, daemon GC pause, etc.) doesn't
// permanently lose the event.
//
// Scenario: first 2 hits return 503, third returns 202. Emit should
// succeed without queuing.
func TestEmitRetriesOn5xx(t *testing.T) {
	var (
		mu       sync.Mutex
		attempts int
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/dev/terminal-sessions/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempts++
		n := attempts
		mu.Unlock()
		if n < 3 {
			http.Error(w, "transient", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	bridge := &daemonBridge{
		client: srv.Client(),
		base:   srv.URL,
		cwd:    "/tmp/test",
		done:   make(chan struct{}),
		id:     "ts_initial",
	}

	bridge.Emit("message_added", "live", "streaming", "hello", "")

	mu.Lock()
	defer mu.Unlock()
	if attempts != 3 {
		t.Fatalf("expected 3 attempts (2 fails + 1 success), got %d", attempts)
	}
	bridge.pendingMu.Lock()
	pending := len(bridge.pending)
	bridge.pendingMu.Unlock()
	if pending != 0 {
		t.Fatalf("expected no pending events after eventual success, got %d", pending)
	}
}

// TestEmitQueuesAndDrainsPending is the v0.2.2 core guarantee — events
// that fail all retries DON'T get lost. They go into bridge.pending and
// drain FIFO on the next Emit call (or 10s keepalive tick).
//
// Scenario: daemon returns 503 forever for the first event → it queues.
// Then daemon flips to 202 → next Emit drains the queued event + emits
// the new one. Order: pending first, then new (FIFO).
func TestEmitQueuesAndDrainsPending(t *testing.T) {
	var (
		mu       sync.Mutex
		mode     = "fail"
		received []string
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/dev/terminal-sessions/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		m := mode
		mu.Unlock()
		if m == "fail" {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		// Capture which event arrived by sniffing the payload field.
		defer r.Body.Close()
		var body struct {
			Payload string `json:"payload"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		received = append(received, body.Payload)
		mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	bridge := &daemonBridge{
		client: srv.Client(),
		base:   srv.URL,
		cwd:    "/tmp/test",
		done:   make(chan struct{}),
		id:     "ts_initial",
	}

	// Phase 1: daemon down — event queues after 4 retries.
	bridge.Emit("message_added", "live", "streaming", "first", "")
	bridge.pendingMu.Lock()
	if len(bridge.pending) != 1 {
		bridge.pendingMu.Unlock()
		t.Fatalf("expected 1 event queued, got %d", len(bridge.pending))
	}
	bridge.pendingMu.Unlock()

	// Phase 2: daemon recovers. Next Emit should drain pending FIRST,
	// then send the new event. Order received: ["first", "second"].
	mu.Lock()
	mode = "ok"
	mu.Unlock()
	bridge.Emit("message_added", "live", "streaming", "second", "")

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 {
		t.Fatalf("expected 2 events received, got %d (%v)", len(received), received)
	}
	if received[0] != "first" || received[1] != "second" {
		t.Fatalf("FIFO violated: got %v", received)
	}
	bridge.pendingMu.Lock()
	pending := len(bridge.pending)
	bridge.pendingMu.Unlock()
	if pending != 0 {
		t.Fatalf("queue not fully drained, %d left", pending)
	}
}

// TestPendingQueueCappedDropsOldest verifies the bounded-memory
// guarantee: if daemon is permanently down and the wrapper keeps
// generating events, the queue can't grow past pendingEmitMax. Oldest
// events get dropped (FIFO) so recent ones have the best chance of
// landing when daemon recovers.
func TestPendingQueueCappedDropsOldest(t *testing.T) {
	bridge := &daemonBridge{
		client: &http.Client{}, // unused in this test
		base:   "",
		cwd:    "/tmp/test",
		done:   make(chan struct{}),
		id:     "ts_initial",
	}
	// Pre-fill to the cap.
	for i := 0; i < pendingEmitMax; i++ {
		bridge.queuePending(pendingEmit{kind: "message_added", payload: fmt.Sprintf("payload-%d", i)})
	}
	// Push one more — should drop oldest (payload-0).
	bridge.queuePending(pendingEmit{kind: "message_added", payload: "newest"})

	bridge.pendingMu.Lock()
	defer bridge.pendingMu.Unlock()
	if len(bridge.pending) != pendingEmitMax {
		t.Fatalf("queue should stay capped at %d, got %d", pendingEmitMax, len(bridge.pending))
	}
	// The first entry should now be payload-1 (payload-0 was evicted).
	if bridge.pending[0].payload != "payload-1" {
		t.Fatalf("expected oldest payload-0 to be evicted, head is %q", bridge.pending[0].payload)
	}
	if bridge.pending[pendingEmitMax-1].payload != "newest" {
		t.Fatalf("expected newest at tail, got %q", bridge.pending[pendingEmitMax-1].payload)
	}
}
