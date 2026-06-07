// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agentsettings"
	"github.com/PocklyApp/Pockly/daemon/internal/control"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// TestAgentSettingsGetSucceedsForSDKHeadless covers the M8 regression
// fix: AGENT_SETTINGS_GET against a session that has no live wrapper
// must return ok+defaults, not session_not_attached. Pre-fix the web's
// ClaudeCodePillsRow would mount (because connection_mode is
// sdk_headless + writable=true under the new model) and immediately
// blow up with session_not_attached the first time it asked for the
// composer state.
func TestAgentSettingsGetSucceedsForSDKHeadless(t *testing.T) {
	tmp := t.TempDir()
	// Index treats ClaudeHome as the directory holding per-project
	// subdirectories with <sid>.jsonl files (see internal/index test
	// layout). Match that or FindSession won't return anything.
	claudeHome := filepath.Join(tmp, "claude-projects")
	codexHome := filepath.Join(tmp, "codex-sessions")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("mkdir codex home: %v", err)
	}
	const sid = "11111111-1111-1111-1111-111111111111"
	jsonl := `{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"user","message":{"role":"user","content":"hi"}}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sid+".jsonl"), []byte(jsonl), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}
	if _, ok := idx.FindSession(sid); !ok {
		t.Fatal("test setup broken: index couldn't find sid")
	}

	adapter := agentSettingsAdapter{
		store:    agentsettings.New(),
		terminal: liveterminal.NewManager(),
		index:    idx,
	}
	res := adapter.Get(control.AgentSettingsGet{
		RequestID: "req_get",
		SessionID: sid,
	})
	if res.Status != "ok" {
		t.Fatalf("Get failed: status=%q error=%q", res.Status, res.Error)
	}
	if res.PermissionMode == "" {
		t.Errorf("expected default permission mode, got empty")
	}
	if len(res.AvailableModels) == 0 {
		t.Errorf("expected available models list")
	}
	// SDK/headless sessions apply the permission mode at the next
	// `claude --resume --permission-mode ...` spawn, so the pill must
	// offer Claude's full native launch list (incl. auto/bypass) — not
	// the runtime-only Shift+Tab cycle a live PTY is limited to.
	wantModes := strings.Join([]string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}, ",")
	if got := strings.Join(res.AvailablePermissionModes, ","); got != wantModes {
		t.Errorf("SDK session AvailablePermissionModes = %q, want %q", got, wantModes)
	}
}

func TestAgentSettingsGetExposesResolvedModelFromJsonl(t *testing.T) {
	t.Setenv("ANTHROPIC_DEFAULT_OPUS_MODEL", "anthropic-compatible-pro")

	tmp := t.TempDir()
	claudeHome := filepath.Join(tmp, "claude-projects")
	codexHome := filepath.Join(tmp, "codex-sessions")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("mkdir codex home: %v", err)
	}
	const sid = "12121212-1212-1212-1212-121212121212"
	jsonl := strings.Join([]string{
		`{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"user","message":{"role":"user","content":"hi"}}`,
		`{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:01Z","type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-fast","content":[]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sid+".jsonl"), []byte(jsonl), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}
	store := agentsettings.New()
	store.SetModel(sdkSettingsKey(sid), "opus")
	adapter := agentSettingsAdapter{store: store, terminal: liveterminal.NewManager(), index: idx}

	res := adapter.Get(control.AgentSettingsGet{RequestID: "req_get", SessionID: sid})
	if res.Status != "ok" {
		t.Fatalf("Get failed: status=%q error=%q", res.Status, res.Error)
	}
	if res.Model != "opus" {
		t.Fatalf("Model = %q, want selected alias opus", res.Model)
	}
	if res.ResolvedModel != "anthropic-compatible-fast" {
		t.Fatalf("ResolvedModel = %q, want jsonl ground truth anthropic-compatible-fast", res.ResolvedModel)
	}
}

func TestAgentSettingsGetUsesConfirmedModelCommandBeforeNextAssistant(t *testing.T) {
	t.Setenv("ANTHROPIC_DEFAULT_OPUS_MODEL", "anthropic-compatible-pro")

	tmp := t.TempDir()
	claudeHome := filepath.Join(tmp, "claude-projects")
	codexHome := filepath.Join(tmp, "codex-sessions")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("mkdir codex home: %v", err)
	}
	const sid = "34343434-3434-3434-3434-343434343434"
	jsonl := strings.Join([]string{
		`{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"assistant","message":{"role":"assistant","model":"anthropic-compatible-fast","content":[]}}`,
		`{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:01Z","type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1manthropic-compatible-pro\u001b[22m for this session</local-command-stdout>"}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sid+".jsonl"), []byte(jsonl), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}

	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}
	store := agentsettings.New()
	store.SetModel(sdkSettingsKey(sid), "opus")
	adapter := agentSettingsAdapter{store: store, terminal: liveterminal.NewManager(), index: idx}

	res := adapter.Get(control.AgentSettingsGet{RequestID: "req_get", SessionID: sid})
	if res.Status != "ok" {
		t.Fatalf("Get failed: status=%q error=%q", res.Status, res.Error)
	}
	if res.Model != "opus" {
		t.Fatalf("Model = %q, want selected alias opus", res.Model)
	}
	if res.ResolvedModel != "anthropic-compatible-pro" {
		t.Fatalf("ResolvedModel = %q, want confirmed /model stdout target anthropic-compatible-pro", res.ResolvedModel)
	}
}

func TestModelCommandConfirmationIsScopedToSession(t *testing.T) {
	tmp := t.TempDir()
	claudeHome := filepath.Join(tmp, "claude-projects")
	codexHome := filepath.Join(tmp, "codex-sessions")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("mkdir codex home: %v", err)
	}
	const sidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	const sidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	sessionLine := func(sid, content string) string {
		return `{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"user","message":{"role":"user","content":"` + content + `"}}` + "\n"
	}
	if err := os.WriteFile(filepath.Join(projectDir, sidA+".jsonl"), []byte(sessionLine(sidA, "hi")), 0o644); err != nil {
		t.Fatalf("seed sidA: %v", err)
	}
	proStdout := `<local-command-stdout>Set model to \u001b[1manthropic-compatible-pro\u001b[22m for this session</local-command-stdout>`
	if err := os.WriteFile(filepath.Join(projectDir, sidB+".jsonl"), []byte(sessionLine(sidB, proStdout)), 0o644); err != nil {
		t.Fatalf("seed sidB: %v", err)
	}
	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}
	adapter := agentSettingsAdapter{store: agentsettings.New(), terminal: liveterminal.NewManager(), index: idx}
	gotA, err := adapter.countModelCommandTargetForSession(sidA, "anthropic-compatible-pro")
	if err != nil {
		t.Fatalf("count sidA: %v", err)
	}
	if gotA != 0 {
		t.Fatalf("sidA count = %d, want 0; sidB stdout must not confirm sidA", gotA)
	}
	gotB, err := adapter.countModelCommandTargetForSession(sidB, "anthropic-compatible-pro")
	if err != nil {
		t.Fatalf("count sidB: %v", err)
	}
	if gotB != 1 {
		t.Fatalf("sidB count = %d, want 1", gotB)
	}
}

// TestAgentSettingsSetSDKHeadlessStoresButDoesNotPushToPTY verifies the
// Set path for sdk_headless mode: the new values must be persisted in
// the store (so the next `claude --resume` spawn picks them up via
// sdkSettingsReader) but Apply must NOT be called — there is no PTY
// to Shift+Tab or send /model into.
func TestAgentSettingsSetSDKHeadlessStoresButDoesNotPushToPTY(t *testing.T) {
	tmp := t.TempDir()
	claudeHome := filepath.Join(tmp, "claude-projects")
	codexHome := filepath.Join(tmp, "codex-sessions")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("mkdir codex home: %v", err)
	}
	const sid = "22222222-2222-2222-2222-222222222222"
	jsonl := `{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"user","message":{"role":"user","content":"hi"}}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sid+".jsonl"), []byte(jsonl), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}
	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: codexHome, RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}

	store := agentsettings.New()
	adapter := agentSettingsAdapter{
		store:    store,
		terminal: liveterminal.NewManager(),
		index:    idx,
	}
	// Use values from the published label sets. effort=high is a real
	// claude reasoning-effort level (EffortLevels = none/low/medium/high/
	// xhigh/max); sdkSettingsReader picks it up and buildArgs forwards it
	// as --effort at SDK spawn time.
	res := adapter.Set(control.AgentSettingsSet{
		RequestID:      "req_set",
		SessionID:      sid,
		Model:          "opus",
		PermissionMode: "auto",
		Effort:         "high",
	})
	if res.Status != "ok" {
		t.Fatalf("Set failed: status=%q error=%q", res.Status, res.Error)
	}

	// Adapter-internal: store should have the values keyed under
	// sdkSettingsKey(sid). sdkSettingsReader will pick them up at SDK
	// spawn time.
	key := sdkSettingsKey(sid)
	got := store.Get(key)
	if got.Model != "opus" {
		t.Errorf("Model = %q, want opus", got.Model)
	}
	if got.PermissionMode != "auto" {
		t.Errorf("PermissionMode = %q, want auto", got.PermissionMode)
	}
	if got.Effort != "high" {
		t.Errorf("Effort = %q, want high", got.Effort)
	}
}

// TestAgentSettingsSetRejectsUnknownValuesInSDKMode covers
// M12: the SDK branch must reject unknown permission_mode / unknown
// effort before touching the store. Pre-fix
// these silently persisted as "ok" while the actual SDK spawn ignored
// or refused the value — the worst UX failure mode (the pill says
// "set" but nothing changes).
func TestAgentSettingsSetRejectsUnknownValuesInSDKMode(t *testing.T) {
	tmp := t.TempDir()
	claudeHome := filepath.Join(tmp, "claude-projects")
	projectDir := filepath.Join(claudeHome, "-tmp-proj")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("mkdir project dir: %v", err)
	}
	const sid = "22222222-2222-2222-2222-222222222222"
	jsonl := `{"sessionId":"` + sid + `","cwd":"/tmp/proj","timestamp":"2026-05-25T00:00:00Z","type":"user","message":{"role":"user","content":"hi"}}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sid+".jsonl"), []byte(jsonl), 0o644); err != nil {
		t.Fatalf("seed jsonl: %v", err)
	}
	idx := index.New(index.Config{ClaudeHome: claudeHome, CodexHome: filepath.Join(tmp, "codex"), RefreshInterval: time.Hour})
	if err := idx.Refresh(); err != nil {
		t.Fatalf("idx.Refresh: %v", err)
	}

	for _, tc := range []struct {
		name string
		req  control.AgentSettingsSet
		want string
	}{
		{"unknown permission mode", control.AgentSettingsSet{RequestID: "r2", SessionID: sid, PermissionMode: "yolo"}, "unknown permission_mode"},
		{"unknown effort", control.AgentSettingsSet{RequestID: "r3", SessionID: sid, Effort: "ultrathink"}, "unknown effort"},
		// Model is validated against ReadModelOptions(cwd). The sid's cwd
		// (/tmp/proj) has no .claude.json, so only the built-in aliases
		// are known — a made-up model must be rejected before it reaches
		// the SDK store, mirroring the permission/effort guards.
		{"unknown model", control.AgentSettingsSet{RequestID: "r4", SessionID: sid, Model: "gpt-make-believe"}, "unknown_model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := agentsettings.New()
			adapter := agentSettingsAdapter{store: store, terminal: liveterminal.NewManager(), index: idx}
			res := adapter.Set(tc.req)
			if res.Status == "ok" {
				t.Fatalf("Set should have rejected %s, got ok: %+v", tc.name, res)
			}
			if !strings.Contains(res.Error, tc.want) {
				t.Errorf("error %q should contain %q", res.Error, tc.want)
			}
			got := store.Get(sdkSettingsKey(sid))
			if got.PermissionMode != "" || got.Effort != "" || got.Model != "" {
				t.Errorf("rejected request still wrote to store: %+v", got)
			}
		})
	}
}

func TestAgentSettingsDefaultsExposeNativePermissionModes(t *testing.T) {
	store := agentsettings.New()
	adapter := agentSettingsAdapter{
		store:    store,
		terminal: liveterminal.NewManager(),
		index:    nil,
	}
	res := adapter.Defaults(control.AgentDefaultsGet{RequestID: "req_defaults", Cwd: "/tmp"})
	if res.Status != "ok" {
		t.Fatalf("Defaults failed: status=%q error=%q", res.Status, res.Error)
	}
	want := []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}
	if strings.Join(res.AvailablePermissionModes, ",") != strings.Join(want, ",") {
		t.Fatalf("AvailablePermissionModes = %#v, want %#v", res.AvailablePermissionModes, want)
	}
}

// TestAgentSettingsGetReturnsNotAttachedWhenUnknown guards the dead
// session case: if neither a live wrapper nor a local jsonl exists,
// the adapter must still surface session_not_attached so the web UI
// shows its dead-session fallback. (We can't show pills for a session
// we genuinely don't know about — there's no cwd to read .claude.json
// from.)
func TestAgentSettingsGetReturnsNotAttachedWhenUnknown(t *testing.T) {
	tmp := t.TempDir()
	idx := index.New(index.Config{ClaudeHome: filepath.Join(tmp, ".claude"), CodexHome: filepath.Join(tmp, ".codex"), RefreshInterval: time.Hour})
	// Don't seed any jsonl.
	if err := idx.Refresh(); err != nil {
		// Refresh against a non-existent dir should not panic; the
		// index returns an empty snapshot. Tolerate err == nil for
		// "no projects" outcomes.
		_ = err
	}
	adapter := agentSettingsAdapter{
		store:    agentsettings.New(),
		terminal: liveterminal.NewManager(),
		index:    idx,
	}
	res := adapter.Get(control.AgentSettingsGet{
		RequestID: "req",
		SessionID: "sess_unknown",
	})
	if res.Status == "ok" {
		t.Fatalf("expected error for unknown sid; got ok: %+v", res)
	}
	if res.Error != "session_not_attached" {
		t.Errorf("error = %q, want session_not_attached", res.Error)
	}
}

// TestSDKSettingsReaderReadsModel ensures the sdkdriver SettingsReader
// adapter pulls from the same store the adapter writes to, using the
// same sdk: prefix. This is the contract that lets pills changes flow
// into the NEXT `claude --resume` spawn without any extra wiring.
func TestSDKSettingsReaderReadsModel(t *testing.T) {
	store := agentsettings.New()
	store.SetModel(sdkSettingsKey("sess_x"), "sonnet")

	reader := sdkSettingsReader{store: store}
	got := reader.ModelForSDKSession("sess_x")
	if got != "sonnet" {
		t.Fatalf("ModelForSDKSession = %q, want sonnet", got)
	}
	// Unknown sids return empty (not an error) — caller (driver) maps
	// empty to "use claude's default", so no --model flag is added.
	if got := reader.ModelForSDKSession("sess_unknown"); got != "" {
		t.Errorf("unknown sid should return empty, got %q", got)
	}
}

// TestAgentSettingsSetRoutesSDKExternalToSDKBranch covers the M9
// regression: when an SDK driver has registered an ExternalSession and
// stamped Driver="sdk", the agent-settings resolver must NOT route Set
// through Store.Apply — that path would push `/model opus` as a
// stream-json user prompt into the running claude subprocess (because
// SendInput writes to the input bus, which the SDK driver pumps to
// claude's stdin). Pre-fix, the inject lookup matched the SDK external
// the same way it would a wrapper, and Set silently corrupted the
// conversation.
func TestAgentSettingsSetRoutesSDKExternalToSDKBranch(t *testing.T) {
	termMgr := liveterminal.NewManager()
	// Register an external that masquerades as the SDK driver:
	// SetDriver("sdk") + BindSessionMetadata so LookupExternalForInject
	// resolves it. We don't actually spawn claude — we just need the
	// shape that resolve() sees.
	_, ext, err := termMgr.RegisterExternal("")
	if err != nil {
		t.Fatalf("RegisterExternal: %v", err)
	}
	ext.SetDriver("sdk")
	ext.BindSessionMetadata("sess_sdk_a", "/tmp/proj")

	// Subscribe to the input bus so we can prove no user input ever
	// reached it during Set. A buffered channel + a quick poll after
	// Set is enough — if Store.Apply were called, /model opus would
	// have been broadcast.
	inputs, unsubscribe := ext.SubscribeInput(4)
	defer unsubscribe()

	store := agentsettings.New()
	adapter := agentSettingsAdapter{
		store:    store,
		terminal: termMgr,
		index:    nil, // SDK-external case shouldn't need the index fallback
	}
	res := adapter.Set(control.AgentSettingsSet{
		RequestID:      "req_x",
		SessionID:      "sess_sdk_a",
		Model:          "opus",
		PermissionMode: "auto",
	})
	if res.Status != "ok" {
		t.Fatalf("Set failed: status=%q error=%q", res.Status, res.Error)
	}

	// Critical assertion: no stream-json user message reached the SDK
	// driver's input bus. If we ever see /model opus here, the M9 fix
	// regressed.
	select {
	case got := <-inputs:
		t.Fatalf("Set must not write to ExternalSession input bus in SDK mode; got %q", got)
	case <-time.After(50 * time.Millisecond):
	}

	// And the store DID persist under sdkSettingsKey(sid), so the SDK
	// driver picks it up on next spawn via sdkdriver.SettingsReader.
	got := store.Get(sdkSettingsKey("sess_sdk_a"))
	if got.Model != "opus" || got.PermissionMode != "auto" {
		t.Fatalf("store under sdkSettingsKey got %+v, want Model=opus PermissionMode=auto", got)
	}
}

// TestSDKSettingsReaderReadsPermissionMode covers M10: the SettingsReader
// surface exposes PermissionModeForSDKSession (in addition to model), so
// the value persisted by Set actually flows into the next
// claude --resume spawn via Driver.Config.PermissionMode →
// buildArgs --permission-mode.
func TestSDKSettingsReaderReadsPermissionMode(t *testing.T) {
	store := agentsettings.New()
	store.SetPermissionMode(sdkSettingsKey("sess_x"), "plan")
	reader := sdkSettingsReader{store: store}
	if got := reader.PermissionModeForSDKSession("sess_x"); got != "plan" {
		t.Fatalf("PermissionModeForSDKSession = %q, want plan", got)
	}
	if got := reader.PermissionModeForSDKSession("sess_unknown"); got != "" {
		t.Errorf("unknown sid should return empty, got %q", got)
	}
}

func TestParseCodexConfigModel(t *testing.T) {
	got := parseCodexConfigModel(`
model = "openai-compatible-fast"
model_provider = "openai-compatible" # comment

[model_providers.openai-compatible]
name = "OpenAI Compatible"
base_url = "https://llm-gateway.example"
env_key = "OPENAI_COMPAT_API_KEY"
`)
	if got.model != "openai-compatible-fast" {
		t.Fatalf("model = %q, want openai-compatible-fast", got.model)
	}
	if got.modelProvider != "openai-compatible" {
		t.Fatalf("modelProvider = %q, want openai-compatible", got.modelProvider)
	}
}

func TestCodexConfigModelOption(t *testing.T) {
	opt := codexConfigModelOption(codexConfigModel{model: "openai-compatible-fast", modelProvider: "openai-compatible"})
	if opt.Value != "openai-compatible-fast" {
		t.Fatalf("Value = %q", opt.Value)
	}
	if opt.ResolvedModel != "openai-compatible-fast" {
		t.Fatalf("ResolvedModel = %q", opt.ResolvedModel)
	}
	if opt.Source != "codex_config" {
		t.Fatalf("Source = %q, want codex_config", opt.Source)
	}
	if !strings.Contains(opt.Label, "openai-compatible") {
		t.Fatalf("Label = %q, want provider hint", opt.Label)
	}
}

// Avoid unused-import warning when this file changes — keep these
// helpers referenced.
var (
	_ = context.Background
	_ = strings.TrimSpace
)
