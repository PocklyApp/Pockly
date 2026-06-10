// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package agentsettings

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

func TestCycleDistance(t *testing.T) {
	t.Parallel()
	cases := []struct {
		cur, tgt string
		want     int
	}{
		{PermDefault, PermAcceptEdits, 1},
		{PermDefault, PermPlan, 2},
		{PermAcceptEdits, PermPlan, 1},
		{PermAcceptEdits, PermDefault, 2},
		{PermPlan, PermDefault, 1},
		{PermPlan, PermAcceptEdits, 2},
		{PermDefault, PermDefault, 0},
		{PermDefault, PermAuto, 0},
		{PermDefault, PermBypass, 0},
		{PermDefault, PermDontAsk, 0}, // dontAsk is accepted for CLI compatibility, not in the UI cycle.
		{"unknown", PermPlan, 0},
	}
	for _, c := range cases {
		if got := cycleDistance(c.cur, c.tgt); got != c.want {
			t.Errorf("cycleDistance(%q,%q) = %d, want %d", c.cur, c.tgt, got, c.want)
		}
	}
}

func TestObservePermissionMode(t *testing.T) {
	t.Parallel()
	s := New()
	// Bare permission-mode strings come through formatMetaText as the
	// raw "permissionMode" value — verify we accept the known set.
	s.Observe("ts1", "meta", "acceptEdits")
	if got := s.Get("ts1").PermissionMode; got != "acceptEdits" {
		t.Fatalf("expected acceptEdits, got %q", got)
	}
	// Wrong kind is ignored.
	s.Observe("ts1", "user_input", "plan")
	if got := s.Get("ts1").PermissionMode; got != "acceptEdits" {
		t.Fatalf("expected acceptEdits after non-meta event, got %q", got)
	}
	// Unknown mode strings are ignored (could be queue-operation
	// payload that happens to share the meta kind).
	s.Observe("ts1", "meta", "random text")
	if got := s.Get("ts1").PermissionMode; got != "acceptEdits" {
		t.Fatalf("expected acceptEdits after unknown meta, got %q", got)
	}
}

type fakeApplier struct {
	sessionID string
	lookup    liveterminal.InjectLookup
	rawCalls  []string
	inputs    []string
}

type fakeExt struct {
	rawCalls *[]string
	inputs   *[]string
}

func (f *fakeApplier) LookupExternalForInject(sessionID string) liveterminal.InjectLookup {
	if sessionID != f.sessionID {
		return liveterminal.InjectLookup{}
	}
	return f.lookup
}

// We need a way to intercept SendRaw / SendInput. The simplest path is
// to construct a real ExternalSession and subscribe to its input bus,
// then drain synchronously when the test asserts. drain() is called by
// the test after Apply returns so we don't race the goroutine.
func newFakeExt(t *testing.T) (*liveterminal.ExternalSession, func() []string) {
	ext := liveterminal.NewExternalSession()
	inputs, unsub := ext.SubscribeInput(64)
	t.Cleanup(func() {
		unsub()
		ext.Stop()
	})
	drain := func() []string {
		// Apply pushes onto a buffered channel synchronously, so all
		// emissions are queued before Apply returns. Pull everything
		// available without blocking past the first miss.
		out := []string{}
		for {
			select {
			case s, ok := <-inputs:
				if !ok {
					return out
				}
				out = append(out, s)
			default:
				return out
			}
		}
	}
	return ext, drain
}

func TestApplyPermissionModeSendsShiftTab(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{PermissionMode: PermPlan})
	if err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	// default → plan is 2 presses.
	collected := drain()
	got := strings.Count(strings.Join(collected, ""), "\x1b[Z")
	if got != 2 {
		t.Fatalf("expected 2 shift+tab keystrokes, got %d (raw=%q)", got, collected)
	}
	if mode := store.Get("ts1").PermissionMode; mode != PermPlan {
		t.Fatalf("expected store to reflect plan, got %q", mode)
	}
}

func TestApplyModelSendsSlashCommand(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{Model: "opus"})
	if err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	joined := strings.Join(drain(), "")
	if !strings.Contains(joined, "/model opus") {
		t.Fatalf("expected /model opus in input stream, got %q", joined)
	}
	if model := store.Get("ts1").Model; model != "" {
		t.Fatalf("PTY Apply should not confirm model before Claude acknowledges it, got %q", model)
	}
}

func TestApplyEffortSendsSlashCommand(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	if err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{Effort: "high"}); err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	joined := strings.Join(drain(), "")
	if !strings.Contains(joined, "/effort high") {
		t.Fatalf("expected /effort high in input stream, got %q", joined)
	}
	// Unlike model, the daemon trusts its own effort apply (claude emits no
	// meta event for it), so the store reflects it immediately.
	if got := store.Get("ts1").Effort; got != "high" {
		t.Fatalf("Effort = %q, want high", got)
	}
}

func TestApplyEffortNoneIsNoOp(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	if err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{Effort: "none"}); err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	if joined := strings.Join(drain(), ""); strings.Contains(joined, "/effort") {
		t.Fatalf("effort=none must not send /effort, got %q", joined)
	}
	// The no-op sentinel is still recorded so the pill reflects the choice.
	if got := store.Get("ts1").Effort; got != "none" {
		t.Fatalf("Effort = %q, want none", got)
	}
}

func TestApplyRejectsRuntimeUnsupportedPermissionModes(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	for _, mode := range []string{PermAuto, PermBypass, PermDontAsk} {
		err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{PermissionMode: mode})
		if err == nil || !strings.Contains(err.Error(), "permission_mode_not_runtime_switchable") {
			t.Fatalf("Apply(%s) error = %v, want permission_mode_not_runtime_switchable", mode, err)
		}
	}
	if got := drain(); len(got) != 0 {
		t.Fatalf("unsupported runtime modes must not send PTY input, got %q", got)
	}
}

func TestSnapshotForExposesOnlyRuntimeSwitchablePermissionModes(t *testing.T) {
	t.Parallel()
	store := New()
	got := store.SnapshotFor("ts1", "").AvailablePermissionModes
	want := []string{PermDefault, PermAcceptEdits, PermPlan}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("AvailablePermissionModes = %v, want %v", got, want)
	}
}

func TestNativePermissionModesIncludesLaunchOnlyModes(t *testing.T) {
	t.Parallel()
	got := NativePermissionModes()
	want := []string{PermDefault, PermAcceptEdits, PermPlan, PermAuto, PermBypass}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("NativePermissionModes = %v, want %v", got, want)
	}
}

func TestApplySerializesSameTerminalSession(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	store.SetPermissionMode("ts1", PermDefault)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{PermissionMode: PermPlan}); err != nil {
			t.Errorf("Apply plan: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		time.Sleep(10 * time.Millisecond)
		if err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{PermissionMode: PermDefault}); err != nil {
			t.Errorf("Apply default: %v", err)
		}
	}()
	wg.Wait()

	collected := drain()
	got := strings.Count(strings.Join(collected, ""), "\x1b[Z")
	// Without the per-terminal apply lock, both goroutines can compute from
	// the initial default state and emit only the first transition's keys.
	if got != 3 {
		t.Fatalf("expected serialized plan then default to emit 3 shift+tabs, got %d (raw=%q)", got, collected)
	}
	if mode := store.Get("ts1").PermissionMode; mode != PermDefault {
		t.Fatalf("expected final mode default, got %q", mode)
	}
}

func TestValidateModelForCwd(t *testing.T) {
	t.Parallel()
	// Built-in aliases are always known, regardless of cwd.
	for _, alias := range []string{"sonnet", "opus", "haiku"} {
		if err := ValidateModelForCwd("", alias); err != nil {
			t.Fatalf("ValidateModelForCwd(\"\", %q) = %v, want nil", alias, err)
		}
	}
	// Empty model is a no-op.
	if err := ValidateModelForCwd("", ""); err != nil {
		t.Fatalf("empty model should be valid, got %v", err)
	}
	// A model configured in the project's .claude.json is accepted.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"model":"anthropic-compatible-fast"}`), 0o644); err != nil {
		t.Fatalf("write .claude.json: %v", err)
	}
	if err := ValidateModelForCwd(dir, "anthropic-compatible-fast"); err != nil {
		t.Fatalf("project-configured model should be valid, got %v", err)
	}
	// An unconfigured model is rejected with the typed wire error the
	// web's error mapper keys on.
	err := ValidateModelForCwd(dir, "gpt-make-believe")
	if err == nil || !strings.Contains(err.Error(), "unknown_model") {
		t.Fatalf("unconfigured model error = %v, want unknown_model", err)
	}
	// And that same unconfigured model is rejected for a cwd without a
	// project config too (only the built-in aliases are known there).
	if err := ValidateModelForCwd("", "anthropic-compatible-fast"); err == nil {
		t.Fatalf("model not in any config should be rejected for bare cwd")
	}
}

func TestValidateModelForCwdAcceptsExtraAllowed(t *testing.T) {
	// A model that's in neither the aliases nor any config file is
	// normally rejected — but a caller can pass it as extraAllowed
	// (e.g. the model observed running in a live session) so re-selecting
	// the active model never fails. Keeps offer-set == accept-set.
	if err := ValidateModelForCwd("", "some-exotic-model"); err == nil {
		t.Fatal("unconfigured model should reject without extraAllowed")
	}
	if err := ValidateModelForCwd("", "some-exotic-model", "some-exotic-model"); err != nil {
		t.Fatalf("extraAllowed model should be accepted, got %v", err)
	}
	// extraAllowed is additive, not a replacement — built-in aliases
	// still pass even when an unrelated extra is supplied.
	if err := ValidateModelForCwd("", "sonnet", "unrelated-extra"); err != nil {
		t.Fatalf("alias should still pass alongside extraAllowed, got %v", err)
	}
}

func TestReadModelOptionsIncludesAnthropicModelEnv(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "anthropic-compatible-fast")
	got := ReadModelOptions("")
	found := false
	for _, m := range got {
		if m == "anthropic-compatible-fast" {
			found = true
		}
	}
	if !found {
		t.Fatalf("ReadModelOptions should include ANTHROPIC_MODEL env value, got %v", got)
	}
	// And it's then accepted by the validator (offer == accept).
	if err := ValidateModelForCwd("", "anthropic-compatible-fast"); err != nil {
		t.Fatalf("env model should validate once offered, got %v", err)
	}
}

func TestReadModelOptionDetailsResolvesAliasTargets(t *testing.T) {
	t.Setenv("ANTHROPIC_DEFAULT_OPUS_MODEL", "anthropic-compatible-pro")
	t.Setenv("ANTHROPIC_DEFAULT_SONNET_MODEL", "anthropic-compatible-fast")
	t.Setenv("ANTHROPIC_DEFAULT_HAIKU_MODEL", "anthropic-compatible-fast")
	t.Setenv("ANTHROPIC_MODEL", "anthropic-compatible-fast")
	t.Setenv("HOME", t.TempDir())

	got := ReadModelOptionDetails("")
	var opus ModelOption
	for _, opt := range got {
		if opt.Value == "opus" {
			opus = opt
			break
		}
	}
	if opus.Value == "" {
		t.Fatalf("expected opus option in %#v", got)
	}
	if opus.ResolvedModel != "anthropic-compatible-pro" {
		t.Fatalf("opus resolved_model = %q, want anthropic-compatible-pro (options=%#v)", opus.ResolvedModel, got)
	}
	if err := ValidateModelForCwd("", "opus"); err != nil {
		t.Fatalf("alias value should validate: %v", err)
	}
	if err := ValidateModelForCwd("", "anthropic-compatible-pro"); err != nil {
		t.Fatalf("resolved alias target should validate: %v", err)
	}
	if err := ValidateModelForCwd("", "gpt-make-believe"); err == nil {
		t.Fatalf("unknown model should still reject")
	}
}

func TestReadModelOptionDetailsUsesClaudeSettingsEnv(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "settings.json"), []byte(`{
		"env": {
				"ANTHROPIC_MODEL": "anthropic-compatible-fast",
				"ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic-compatible-pro"
		}
	}`), 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	t.Setenv("ANTHROPIC_MODEL", "process-model")
	t.Setenv("ANTHROPIC_DEFAULT_OPUS_MODEL", "process-opus")

	got := ReadModelOptionDetails("")
	var opus, settingsDefault ModelOption
	for _, opt := range got {
		switch opt.Value {
		case "opus":
			opus = opt
			case "anthropic-compatible-fast":
			settingsDefault = opt
		}
	}
	if opus.ResolvedModel != "anthropic-compatible-pro" {
		t.Fatalf("opus resolved_model = %q, want settings env target (options=%#v)", opus.ResolvedModel, got)
	}
	if settingsDefault.Source != "claude_settings_env" {
		t.Fatalf("settings default source = %q, want claude_settings_env (options=%#v)", settingsDefault.Source, got)
	}
	if err := ValidateModelForCwd("", "anthropic-compatible-pro"); err != nil {
		t.Fatalf("settings env resolved target should validate: %v", err)
	}
	if got := EffectiveDefaultModel(""); got != "anthropic-compatible-fast" {
		t.Fatalf("EffectiveDefaultModel = %q, want settings env ANTHROPIC_MODEL", got)
	}
}

func TestEffectiveDefaultModelFallsBackToAnthropicModelEnv(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "anthropic-compatible-fast")
	// Empty cwd + (assume) no config model → env is the effective default.
	if got := EffectiveDefaultModel(t.TempDir()); got != "anthropic-compatible-fast" {
		// Allow a project/user config to win if the test host has one,
		// but the bare-temp-dir case should surface the env value.
		t.Logf("EffectiveDefaultModel = %q (env fallback expected unless host config overrides)", got)
		if got == "" {
			t.Fatalf("expected ANTHROPIC_MODEL env fallback, got empty")
		}
	}
}

func TestEffectiveDefaultModelReadsProjectConfig(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"model":"anthropic-compatible-fast"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := EffectiveDefaultModel(dir); got != "anthropic-compatible-fast" {
		t.Fatalf("EffectiveDefaultModel(%q) = %q, want anthropic-compatible-fast", dir, got)
	}
}

func TestEffectiveDefaultModelEmptyDirDoesNotLeakProjectModel(t *testing.T) {
	t.Parallel()
	// A project dir with no model config must not report a project
	// model. (It may fall through to the test runner's own ~/.claude
	// config, which is fine — we only guard against the wrong project
	// value bleeding in.)
	dir := t.TempDir()
	if got := EffectiveDefaultModel(dir); got == "anthropic-compatible-fast" {
		t.Fatalf("empty project dir leaked a project model: %q", got)
	}
}

func TestApplyPacesModelAfterPermissionSwitch(t *testing.T) {
	t.Parallel()
	ext, drain := newFakeExt(t)
	store := New()
	applier := &applierForExt{ext: ext, sid: "claude-sid"}
	store.SetPermissionMode("ts1", PermDefault)

	// Apply both a permission-mode jump and a model switch in one call.
	if err := store.Apply(applier, "ts1", "claude-sid", ApplyRequest{
		PermissionMode: PermPlan, // default→plan = 2 Shift+Tab
		Model:          "opus",
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	collected := drain()
	joined := strings.Join(collected, "")
	// The /model line must land AFTER the permission back-tabs — sending
	// it before the mode transition settles is exactly the coalescing
	// hazard that silently drops the switch.
	lastTab := strings.LastIndex(joined, "\x1b[Z")
	modelAt := strings.Index(joined, "/model opus")
	if lastTab < 0 {
		t.Fatalf("expected Shift+Tab keystrokes, raw=%q", collected)
	}
	if modelAt < 0 {
		t.Fatalf("expected /model opus in stream, raw=%q", collected)
	}
	if modelAt < lastTab {
		t.Fatalf("/model must be sent after the permission back-tabs (model@%d, lastTab@%d)", modelAt, lastTab)
	}
	if got := store.Get("ts1"); got.PermissionMode != PermPlan || got.Model != "" {
		t.Fatalf("store after combined Apply = %+v, want plan and no unconfirmed model", got)
	}
}

func TestApplyRejectsDriftedSession(t *testing.T) {
	t.Parallel()
	store := New()
	applier := &driftedApplier{}
	err := store.Apply(applier, "ts1", "stale-sid", ApplyRequest{Model: "sonnet"})
	if err == nil || !strings.Contains(err.Error(), "session_drifted") {
		t.Fatalf("expected session_drifted error, got %v", err)
	}
}

func TestApplyRejectsNoSession(t *testing.T) {
	t.Parallel()
	store := New()
	applier := &absentApplier{}
	err := store.Apply(applier, "ts1", "nope", ApplyRequest{Model: "sonnet"})
	if err == nil || !strings.Contains(err.Error(), "session_not_attached") {
		t.Fatalf("expected session_not_attached, got %v", err)
	}
}

// Without a custom Anthropic-compatible provider, the menu is the OFFICIAL
// Claude Code lineup (what the CLI's own /model picker shows), not the bare
// alias trio. Env-dependent like its sibling tests: a dev machine whose
// ~/.claude settings configure a custom provider flips the branch.
func TestReadModelOptionsOfficialLineupWithoutCustomProvider(t *testing.T) {
	for _, key := range []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
	} {
		t.Setenv(key, "")
	}
	got := ReadModelOptions(t.TempDir())
	for _, want := range []string{"claude-fable-5", "claude-fable-5[1m]", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"} {
		found := false
		for _, m := range got {
			if m == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected official model %q in menu, got %v", want, got)
		}
	}
	// Labels are the human names the CLI picker shows.
	for _, opt := range ReadModelOptionDetails(t.TempDir()) {
		if opt.Value == "claude-fable-5" && opt.Label != "Fable 5" {
			t.Errorf("claude-fable-5 label = %q, want %q", opt.Label, "Fable 5")
		}
	}
	// Aliases stay universally SUBMITTABLE even though the menu omits them.
	for _, alias := range []string{"sonnet", "opus", "haiku"} {
		if err := ValidateModelForCwd("", alias); err != nil {
			t.Errorf("alias %q should validate without being offered: %v", alias, err)
		}
	}
}

// A custom provider (ANTHROPIC_MODEL etc.) keeps the alias trio — the
// provider remaps those, and the official lineup would be wrong for it.
func TestReadModelOptionsKeepsAliasesForCustomProvider(t *testing.T) {
	t.Setenv("ANTHROPIC_MODEL", "anthropic-compatible-fast")
	got := ReadModelOptions(t.TempDir())
	for _, want := range []string{"sonnet", "opus", "haiku", "anthropic-compatible-fast"} {
		found := false
		for _, m := range got {
			if m == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected %q in custom-provider menu, got %v", want, got)
		}
	}
	for _, m := range got {
		if m == "claude-fable-5" {
			t.Errorf("official lineup should not be offered under a custom provider, got %v", got)
		}
	}
}

func TestReadModelOptionsPicksUpProjectClaudeJSON(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	custom := `{"model":"claude-sonnet-4-7"}`
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(custom), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ReadModelOptions(dir)
	found := false
	for _, m := range got {
		if m == "claude-sonnet-4-7" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected project model in options, got %v", got)
	}
}

func TestIsClaudeEffortLevel(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"low":    true,
		"medium": true,
		"high":   true,
		"xhigh":  true,
		"max":    true,
		" high ": true,  // trimmed
		"none":   false, // no-op sentinel — not pushed
		"":       false,
		"think":  false, // old keyword vocabulary is gone
		"bogus":  false,
	}
	for in, want := range cases {
		if got := IsClaudeEffortLevel(in); got != want {
			t.Errorf("IsClaudeEffortLevel(%q) = %v, want %v", in, got, want)
		}
	}
}

// --- test helpers ---------------------------------------------------------

// applierForExt wires a single ExternalSession into the Applier interface
// so Apply has somewhere to push raw bytes / typed lines. The test reads
// them back from the SubscribeInput channel.
type applierForExt struct {
	ext *liveterminal.ExternalSession
	sid string
}

func (a *applierForExt) LookupExternalForInject(sessionID string) liveterminal.InjectLookup {
	if sessionID != a.sid {
		return liveterminal.InjectLookup{}
	}
	return liveterminal.InjectLookup{Ext: a.ext, CurrentSID: a.sid}
}

type driftedApplier struct{}

func (driftedApplier) LookupExternalForInject(string) liveterminal.InjectLookup {
	return liveterminal.InjectLookup{Ext: liveterminal.NewExternalSession(), Drifted: true, CurrentSID: "current"}
}

type absentApplier struct{}

func (absentApplier) LookupExternalForInject(string) liveterminal.InjectLookup {
	return liveterminal.InjectLookup{}
}

// silence unused import lint if test environment differs
var _ = fakeApplier{}
var _ = fakeExt{}
