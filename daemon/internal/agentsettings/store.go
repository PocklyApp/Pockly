// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package agentsettings tracks per-terminal-session "agent settings" the
// web composer's pills control: model, permission mode, effort. The
// daemon is the authoritative source for these values because it owns
// the live wrapper PTY and reads the jsonl meta events (e.g.
// permission-mode) that update them. Effort is purely web-side state
// today (it's prepended to each prompt as a thinking keyword), but is
// included in the GET response so the UI can persist the last choice
// across reloads.
package agentsettings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	liveterminal "github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

// Settings is the snapshot returned by Store.Get. Fields are zero-value
// safe; the daemon fills in defaults when the wrapper hasn't reported a
// permission-mode yet.
type Settings struct {
	Model          string `json:"model,omitempty"`
	ResolvedModel  string `json:"resolved_model,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	Effort         string `json:"effort,omitempty"`
}

// ModelOption is the structured form of a model pill option. Value is the
// string the web submits back to Claude (for example "opus"). ResolvedModel is
// the concrete model that value maps to when known (for example
// "deepseek-v4-pro" via ANTHROPIC_DEFAULT_OPUS_MODEL).
type ModelOption struct {
	Value         string `json:"value"`
	Label         string `json:"label,omitempty"`
	ResolvedModel string `json:"resolved_model,omitempty"`
	Source        string `json:"source,omitempty"`
}

// Snapshot bundles the settings together with the menu options the web
// pills render. Available_models is the deduped union of CC's official
// aliases and any "model" string the daemon found in the user's CC
// settings or the project's .claude.json. Available_permission_modes
// mirrors Claude Code's native permission-mode choices.
type Snapshot struct {
	Current                  Settings      `json:"current"`
	AvailableModels          []string      `json:"available_models"`
	AvailableModelOptions    []ModelOption `json:"available_model_options,omitempty"`
	AvailablePermissionModes []string      `json:"available_permission_modes"`
	AvailableEfforts         []string      `json:"available_efforts"`
}

const (
	PermDefault     = "default"
	PermAcceptEdits = "acceptEdits"
	PermPlan        = "plan"
	PermAuto        = "auto"
	PermBypass      = "bypassPermissions"
	PermDontAsk     = "dontAsk"
)

// nativePermissionModes are the values Claude Code accepts at session start via
// `claude --permission-mode ...`.
var nativePermissionModes = []string{PermDefault, PermAcceptEdits, PermPlan, PermAuto, PermBypass}

// cycleOrder is the order Claude Code's interactive TUI exposes at runtime via
// Shift+Tab. As of Claude Code 2.1.x, auto and bypassPermissions are accepted
// CLI launch modes but are not reachable in an already-running TUI session.
var cycleOrder = []string{PermDefault, PermAcceptEdits, PermPlan}

// ttySettle paces raw key/line input into Claude Code's TUI. The
// React/TUI layer coalesces or drops a burst of escape sequences and
// slash commands delivered faster than a human types — the same
// hazard that made multi-step permission-mode jumps (default→plan)
// land on the wrong mode. We space (a) consecutive Shift+Tab
// permission cycles and (b) a /model slash command that immediately
// follows a mode switch in the same Apply.
const ttySettle = 180 * time.Millisecond

// EffortLevels are the labels the web pill exposes. "none" is the no-op
// sentinel (don't override — claude uses its built-in default); the rest
// are claude's real reasoning-effort levels, applied for real via the
// `/effort <level>` slash command (PTY route) or the `--effort <level>`
// spawn flag (SDK route) — the same dual-route model as model/permission.
// (Pre-v0.4.22 these were extended-thinking keywords the web prepended to
// the prompt; that prompt-prefix hack is gone.)
var EffortLevels = []string{"none", "low", "medium", "high", "xhigh", "max"}

// claudeEffortLevels is the set claude's --effort / /effort accept. Used to
// gate what we actually push so a stale "none" sentinel never reaches the
// CLI (which would reject it).
var claudeEffortLevels = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}

// IsClaudeEffortLevel reports whether effort is a real claude effort level
// (i.e. something to push via /effort or --effort), as opposed to the
// "none"/empty no-op sentinel.
func IsClaudeEffortLevel(effort string) bool {
	return claudeEffortLevels[strings.TrimSpace(effort)]
}

// Store is a goroutine-safe map of terminal_session_id → Settings. It
// is the daemon's single source of truth for what the web pills should
// reflect. Mutations come from two sources: the wrapper's permission-mode
// jsonl events (via Observe) and explicit set requests from the web (via
// Apply). The store does NOT persist across daemon restarts; the wrapper's
// next permission-mode event after restart re-seeds it.
type Store struct {
	mu         sync.Mutex
	current    map[string]Settings // keyed by terminal_session_id
	applyLocks map[string]*sync.Mutex
}

func New() *Store {
	return &Store{current: map[string]Settings{}, applyLocks: map[string]*sync.Mutex{}}
}

// Get returns the current settings for the given terminal_session_id,
// or zero-values if nothing has been recorded yet.
func (s *Store) Get(terminalSessionID string) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current[terminalSessionID]
}

// Observe is called by the daemon's terminal event sink whenever the
// wrapper emits a meta event so the store can update its tracked
// permission_mode without waiting for the web to ask. payload is the
// raw "permission-mode" record (Claude jsonl meta type). Other meta
// kinds are ignored.
func (s *Store) Observe(terminalSessionID, kind, payload string) {
	if terminalSessionID == "" || kind == "" {
		return
	}
	// The wrapper forwards meta events as kind="meta" with payload
	// being the formatted text of the meta record (see
	// internal/agent/claude/blocks.go::formatMetaText). For
	// permission-mode that's the bare permissionMode string. We can't
	// distinguish permission-mode from queue-operation here without
	// re-parsing the raw record, so we accept any meta payload that
	// matches the known mode set.
	if kind != "meta" {
		return
	}
	mode := strings.TrimSpace(payload)
	if !isKnownPermissionMode(mode) {
		return
	}
	s.mu.Lock()
	cur := s.current[terminalSessionID]
	cur.PermissionMode = mode
	s.current[terminalSessionID] = cur
	s.mu.Unlock()
}

func (s *Store) lockApply(terminalSessionID string) func() {
	s.mu.Lock()
	lock := s.applyLocks[terminalSessionID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.applyLocks[terminalSessionID] = lock
	}
	s.mu.Unlock()
	lock.Lock()
	return lock.Unlock
}

// SetEffort records the user's effort choice. Returns the new settings.
func (s *Store) SetEffort(terminalSessionID, effort string) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.current[terminalSessionID]
	cur.Effort = effort
	s.current[terminalSessionID] = cur
	return cur
}

// SetModel records the model the daemon just applied via /model. The
// wrapper would normally tell us back via a meta event but Claude
// Code doesn't currently emit one for model changes, so we trust our
// own apply.
func (s *Store) SetModel(terminalSessionID, model string) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.current[terminalSessionID]
	cur.Model = model
	s.current[terminalSessionID] = cur
	return cur
}

// SetPermissionMode records the mode after a successful Apply.
func (s *Store) SetPermissionMode(terminalSessionID, mode string) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.current[terminalSessionID]
	cur.PermissionMode = mode
	s.current[terminalSessionID] = cur
	return cur
}

// SnapshotFor returns the menu options + current values for the given
// terminal session. cwd may be empty; if non-empty the function scans
// the project's .claude.json for a "model" field to merge into the
// available_models list.
func (s *Store) SnapshotFor(terminalSessionID, cwd string) Snapshot {
	cur := s.Get(terminalSessionID)
	if cur.PermissionMode == "" {
		cur.PermissionMode = PermDefault
	}
	if cur.Effort == "" {
		cur.Effort = "none"
	}
	if cur.ResolvedModel == "" && cur.Model != "" {
		cur.ResolvedModel = ResolveModelAlias(cur.Model, cwd)
	}
	return Snapshot{
		Current:                  cur,
		AvailableModels:          ReadModelOptions(cwd),
		AvailableModelOptions:    ReadModelOptionDetails(cwd),
		AvailablePermissionModes: append([]string(nil), cycleOrder...),
		AvailableEfforts:         append([]string(nil), EffortLevels...),
	}
}

// ApplyRequest is the body of an AGENT_SETTINGS_SET control WS message
// (and the corresponding /api/sessions/<sid>/agent-settings POST). Only
// non-empty fields are applied.
type ApplyRequest struct {
	Model          string `json:"model,omitempty"`
	PermissionMode string `json:"permission_mode,omitempty"`
	Effort         string `json:"effort,omitempty"`
}

// Applier knows how to find the live wrapper for a Claude session_id
// and push raw bytes / typed lines into its PTY. The control runner
// satisfies this with its existing TerminalManager.
type Applier interface {
	LookupExternalForInject(sessionID string) liveterminal.InjectLookup
}

// Apply applies the given changes to the wrapper bound to claudeSessionID
// (the same id the inject path uses). The store is also updated so
// subsequent SnapshotFor calls reflect the change immediately.
//
// Order of operations matters: permission_mode changes are applied first
// (so the user's next prompt runs under the new mode), then model, then
// effort — each paced by ttySettle so a slash command isn't swallowed by
// the still-rendering previous transition.
func (s *Store) Apply(applier Applier, terminalSessionID, claudeSessionID string, req ApplyRequest) error {
	unlock := s.lockApply(terminalSessionID)
	defer unlock()

	if applier == nil {
		return errors.New("no applier configured")
	}
	if strings.TrimSpace(claudeSessionID) == "" {
		return errors.New("session_id_required")
	}
	lookup := applier.LookupExternalForInject(claudeSessionID)
	if lookup.Ext == nil {
		return errors.New("session_not_attached")
	}
	if lookup.Drifted {
		return fmt.Errorf("session_drifted current=%s", lookup.CurrentSID)
	}

	if err := ValidateApplyRequest(req); err != nil {
		return err
	}
	sentPermissionKeys := false
	if mode := strings.TrimSpace(req.PermissionMode); mode != "" {
		if !isRuntimeSwitchablePermissionMode(mode) {
			return fmt.Errorf("permission_mode_not_runtime_switchable: %s", mode)
		}
		cur := s.Get(terminalSessionID).PermissionMode
		if cur == "" {
			cur = PermDefault
		}
		presses := cycleDistance(cur, mode)
		// One Shift+Tab in xterm: ESC [ Z. SendRaw bypasses the
		// SendInput "\r" suffix so the keystroke is delivered as a
		// raw escape sequence the TUI can interpret as a key event.
		for i := 0; i < presses; i++ {
			if err := lookup.Ext.SendRaw("\x1b[Z"); err != nil {
				return fmt.Errorf("send shift+tab: %w", err)
			}
			sentPermissionKeys = true
			// Claude Code's React/TUI layer can drop or coalesce a burst of
			// back-tab escape sequences. Permission-mode jumps such as
			// default -> auto require multiple cycles, so pace them as real
			// keypresses instead of a single byte burst.
			if i < presses-1 {
				time.Sleep(ttySettle)
			}
		}
		s.SetPermissionMode(terminalSessionID, mode)
	}

	if model := strings.TrimSpace(req.Model); model != "" {
		// When this Apply also just cycled the permission mode, let the
		// TUI finish that transition before submitting /model. Otherwise
		// the slash command can be swallowed by the still-rendering mode
		// indicator and the model switch silently no-ops — the same
		// coalescing hazard the back-tab pacing above addresses.
		if sentPermissionKeys {
			time.Sleep(ttySettle)
		}
		// /model <alias> directly switches without showing the picker.
		// SendInput appends \r so the line is submitted as a slash
		// command. Claude Code recognises both the short aliases
		// (sonnet/opus/haiku) and the full model id. The caller is
		// expected to have validated the name against ReadModelOptions
		// (see ValidateModelForCwd) so we never push a /model line for
		// a model the agent would reject — which would otherwise leave
		// the recorded state disagreeing with the live session.
		if err := lookup.Ext.SendInput("/model " + model); err != nil {
			return fmt.Errorf("send /model: %w", err)
		}
	}

	if effort := strings.TrimSpace(req.Effort); effort != "" {
		// Validated by ValidateApplyRequest above. A real effort level is
		// pushed to the live PTY via claude's /effort slash command (the
		// PTY route, mirroring /model); "none" is the no-op sentinel and
		// only updates recorded state. SDK sessions apply it on the next
		// spawn via the --effort flag (see sdkdriver buildArgs).
		if IsClaudeEffortLevel(effort) {
			if sentPermissionKeys || strings.TrimSpace(req.Model) != "" {
				time.Sleep(ttySettle)
			}
			if err := lookup.Ext.SendInput("/effort " + effort); err != nil {
				return fmt.Errorf("send /effort: %w", err)
			}
		}
		s.SetEffort(terminalSessionID, effort)
	}
	return nil
}

func isKnownPermissionMode(mode string) bool {
	if mode == PermDontAsk {
		return true
	}
	for _, candidate := range nativePermissionModes {
		if mode == candidate {
			return true
		}
	}
	return false
}

func isRuntimeSwitchablePermissionMode(mode string) bool {
	for _, candidate := range cycleOrder {
		if mode == candidate {
			return true
		}
	}
	return false
}

func NativePermissionModes() []string {
	return append([]string(nil), nativePermissionModes...)
}

func isKnownEffort(effort string) bool {
	for _, e := range EffortLevels {
		if e == effort {
			return true
		}
	}
	return false
}

// ValidateApplyRequest checks an ApplyRequest against Claude Code's
// native value vocabulary — without adding a Pockly permission policy.
//
// Returns a nil error when every non-empty field is valid, or a typed
// error matching the wire vocabulary the PTY path already emits so the
// web's error mapper stays consistent.
func ValidateApplyRequest(req ApplyRequest) error {
	if mode := strings.TrimSpace(req.PermissionMode); mode != "" {
		if !isKnownPermissionMode(mode) {
			return fmt.Errorf("unknown permission_mode: %s", mode)
		}
	}
	if effort := strings.TrimSpace(req.Effort); effort != "" {
		if !isKnownEffort(effort) {
			return fmt.Errorf("unknown effort: %s", effort)
		}
	}
	// Model is intentionally NOT validated here: this function has no
	// cwd, and the known-model set is cwd-derived (ReadModelOptions).
	// Callers that have a cwd validate the model with ValidateModelForCwd
	// before Apply / SDK spawn; see agentSettingsAdapter.Set.
	return nil
}

// ValidateModelForCwd rejects a model the daemon doesn't recognize for
// the given cwd. The accepted set is ReadModelOptions(cwd) PLUS any
// extraAllowed the caller passes — the exact list the web's model pill
// is populated from. extraAllowed exists because a live session's pill
// menu can include a model that ReadModelOptions (config + aliases +
// ANTHROPIC_MODEL) wouldn't list — e.g. a model the running claude was
// switched to mid-session and observed from its jsonl. Callers that
// augment the offered menu with such a model MUST pass it here too, so
// the offer-set and the accept-set stay identical; re-selecting the
// active model must never be rejected. Keeping apply-time vocabulary ==
// offer-time vocabulary means a stale or hand-crafted request naming an
// unoffered model is rejected up front — instead of sending
// `/model <bogus>` (a silent no-op in Claude) and recording a model the
// agent never switched to. Empty model is a no-op and always valid.
func ValidateModelForCwd(cwd, model string, extraAllowed ...string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	for _, extra := range extraAllowed {
		if strings.TrimSpace(extra) == model {
			return nil
		}
	}
	for _, known := range ReadModelOptions(cwd) {
		if known == model {
			return nil
		}
	}
	for _, opt := range ReadModelOptionDetails(cwd) {
		if opt.Value == model || strings.TrimSpace(opt.ResolvedModel) == model {
			return nil
		}
	}
	return fmt.Errorf("unknown_model: %s", model)
}

// cycleDistance returns how many Shift+Tab presses move the current
// mode forward to the target along the TUI's cycle order. Returns 0
// when current == target or target isn't in the cycle.
func cycleDistance(current, target string) int {
	curIdx := -1
	tgtIdx := -1
	for i, m := range cycleOrder {
		if m == current {
			curIdx = i
		}
		if m == target {
			tgtIdx = i
		}
	}
	if curIdx < 0 || tgtIdx < 0 || curIdx == tgtIdx {
		return 0
	}
	d := tgtIdx - curIdx
	if d < 0 {
		d += len(cycleOrder)
	}
	return d
}

// ReadModelOptions returns the deduped list of model aliases the web's
// model pill should show. Sources, in order of preference for the
// "first" position in the menu:
//
//  1. The official Claude Code aliases (opus, sonnet, haiku).
//  2. The "model" field in the user's Claude settings.
//  3. The "model" field in the project's .claude.json (when cwd is
//     supplied and that file exists).
//  4. The Claude settings env.ANTHROPIC_MODEL value (for CC Switch-style
//     provider managers).
//  5. The ANTHROPIC_MODEL process env var — Claude Code's launch default when no
//     --model flag is passed. The daemon only sees this when it shares an
//     environment with claude (e.g. the e2e container, or a daemon
//     started from the same shell); under a macOS LaunchAgent it's
//     typically absent, in which case this is a harmless no-op and the
//     observed-from-jsonl path fills it in once the session has a turn.
//
// We always include the three aliases so the pill is usable even on a
// fresh install where no settings file has been written. Custom names
// from settings/env get appended only if they aren't already covered
// by an alias.
func ReadModelOptions(cwd string) []string {
	opts := ReadModelOptionDetails(cwd)
	out := make([]string, 0, len(opts))
	for _, opt := range opts {
		out = append(out, opt.Value)
	}
	return out
}

// ReadModelOptionDetails returns the structured version of ReadModelOptions.
// It keeps the submitted value stable while exposing alias target resolution for
// UI and diagnostics.
func ReadModelOptionDetails(cwd string) []ModelOption {
	settingsEnv, _, _ := claudelauncher.ReadSettingsEnv()
	seen := map[string]bool{}
	out := []ModelOption{}
	add := func(name, resolved, source string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		resolved = strings.TrimSpace(resolved)
		out = append(out, ModelOption{
			Value:         name,
			Label:         name,
			ResolvedModel: resolved,
			Source:        strings.TrimSpace(source),
		})
	}
	for _, alias := range []string{"sonnet", "opus", "haiku"} {
		add(alias, resolveModelAliasWithEnv(alias, settingsEnv), "alias")
	}
	if settingsPath, err := claudelauncher.SettingsPath(); err == nil {
		add(readModelField(settingsPath), "", "user_config")
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(readModelField(filepath.Join(home, ".claude.json")), "", "user_config")
	}
	if cwd != "" {
		add(readModelField(filepath.Join(cwd, ".claude.json")), "", "project_config")
		add(readModelField(filepath.Join(cwd, ".claude", "settings.json")), "", "project_config")
	}
	add(settingsEnv["ANTHROPIC_MODEL"], "", claudelauncher.SettingsEnvSource)
	add(os.Getenv("ANTHROPIC_MODEL"), "", "env")
	// Keep the official aliases first; sort the rest for stable UI.
	if len(out) > 3 {
		sort.SliceStable(out[3:], func(i, j int) bool {
			return out[3+i].Value < out[3+j].Value
		})
	}
	return out
}

// ResolveModelAlias returns the concrete model target for a Claude alias when
// the current environment/config exposes one. Empty means the daemon cannot
// know and Claude will resolve the alias internally.
func ResolveModelAlias(model, cwd string) string {
	settingsEnv, _, _ := claudelauncher.ReadSettingsEnv()
	return resolveModelAliasWithEnv(model, settingsEnv)
}

func resolveModelAliasWithEnv(model string, settingsEnv map[string]string) string {
	switch strings.TrimSpace(model) {
	case "opus":
		return firstNonEmpty(settingsEnv["ANTHROPIC_DEFAULT_OPUS_MODEL"], os.Getenv("ANTHROPIC_DEFAULT_OPUS_MODEL"))
	case "sonnet":
		return firstNonEmpty(settingsEnv["ANTHROPIC_DEFAULT_SONNET_MODEL"], os.Getenv("ANTHROPIC_DEFAULT_SONNET_MODEL"))
	case "haiku":
		return firstNonEmpty(settingsEnv["ANTHROPIC_DEFAULT_HAIKU_MODEL"], os.Getenv("ANTHROPIC_DEFAULT_HAIKU_MODEL"))
	case "":
		return ""
	default:
		return strings.TrimSpace(model)
	}
}

// EffectiveDefaultModel returns the model claude would launch with when
// no `--model` flag is passed — the "model" field resolved from project
// then user config, in the same precedence ReadModelOptions uses.
// Returns "" when no config sets one (claude then uses its built-in
// default, which the daemon can't name without observing a turn). Used
// as the fallback for the web's model pill so a freshly-launched session
// — or a draft — still shows a concrete name instead of a bare "default".
func EffectiveDefaultModel(cwd string) string {
	if cwd != "" {
		if m := readModelField(filepath.Join(cwd, ".claude.json")); m != "" {
			return m
		}
		if m := readModelField(filepath.Join(cwd, ".claude", "settings.json")); m != "" {
			return m
		}
	}
	if settingsPath, err := claudelauncher.SettingsPath(); err == nil {
		if m := readModelField(settingsPath); m != "" {
			return m
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if m := readModelField(filepath.Join(home, ".claude.json")); m != "" {
			return m
		}
	}
	settingsEnv, _, _ := claudelauncher.ReadSettingsEnv()
	if m := strings.TrimSpace(settingsEnv["ANTHROPIC_MODEL"]); m != "" {
		return m
	}
	// ANTHROPIC_MODEL is Claude's launch default when no config file pins
	// a model. Visible only when the daemon shares claude's environment
	// (see ReadModelOptions); a no-op under a LaunchAgent that doesn't.
	return strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func readModelField(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	// Tolerate top-level "model" or nested {"defaults":{"model":...}}.
	var payload struct {
		Model    string `json:"model"`
		Defaults struct {
			Model string `json:"model"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return ""
	}
	if payload.Model != "" {
		return payload.Model
	}
	return payload.Defaults.Model
}
