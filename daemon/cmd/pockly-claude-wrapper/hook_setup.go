// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// hookSentinel is the literal substring we look for in a hook
// entry's `command` field to identify entries we own. Using the
// binary name (rather than a separate "managed":true JSON tag) keeps
// the settings.json shape pure to claude's published spec — anyone
// (claude itself, a different tool, the user) reading the file just
// sees a normal hook config they can edit freely without breaking
// claude. We only ever REMOVE matches on cleanup, never overwrite
// adjacent user-owned entries.
const hookSentinel = "pockly-daemon hook-bridge"

// hookEnvDisable is the env var the user sets to suppress hook
// installation entirely. Honored even when daemonBin resolves —
// gives a fast off-switch when something goes wrong without
// reverting wrapper code.
const hookEnvDisable = "POCKLY_DISABLE_PERMISSION_HOOK"

// setupHookBridge no longer installs Pockly as a Claude permission hook.
// Claude Code's native permission model is authoritative; Pockly bridges
// permission-prompt-tool and PTY approval sheets only. This function now
// only removes stale hook entries left by older wrapper versions.
//
// Returns:
//   - no-op cleanup func; stale entries are removed immediately
//   - error if reading / writing settings.json failed; caller logs +
//     continues silently (claude still runs, just w/o auto-mode)
//
// Atomic write: temp file in same dir + rename. Even if the wrapper
// crashes mid-write, the worst case is a leftover temp file — never
// a half-written settings.json.
//
// If a prior wrapper crashed without cleanup, the next wrapper's cleanup
// removes its stale entry too — self-healing.
//
// Skipped silently when POCKLY_DISABLE_PERMISSION_HOOK=1 or when
// daemonBin can't be located.
func setupHookBridge(daemonBin string) (func(), error) {
	if strings.TrimSpace(os.Getenv(hookEnvDisable)) == "1" {
		return func() {}, nil
	}
	if strings.TrimSpace(daemonBin) == "" {
		return func() {}, nil
	}
	settingsPath, err := claudeUserSettingsPath()
	if err != nil {
		return func() {}, fmt.Errorf("locate settings.json: %w", err)
	}

	current, err := readSettings(settingsPath)
	if err != nil {
		return func() {}, fmt.Errorf("read %s: %w", settingsPath, err)
	}
	updated, changed := removeOurHookEntries(current)
	if !changed {
		return func() {}, nil
	}
	if err := writeSettingsAtomic(settingsPath, updated); err != nil {
		return func() {}, fmt.Errorf("write %s: %w", settingsPath, err)
	}
	return func() {}, nil
}

// claudeUserSettingsPath returns the canonical user-scoped settings
// file path. Honors $CLAUDE_CONFIG_DIR (claude's documented override)
// so headless / container installs that point claude elsewhere stay
// consistent — wrapper writes to the same file claude reads.
func claudeUserSettingsPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); override != "" {
		return filepath.Join(override, "settings.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// readSettings loads + JSON-parses the current settings. Treats
// missing-file as an empty {} (first-run scenario where claude has
// never been launched). Returns parse errors verbatim so the caller
// surfaces them rather than overwriting a user's hand-edited config
// that happens to have a typo.
func readSettings(path string) (map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	defer f.Close()
	body, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 {
		return map[string]any{}, nil
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("parse JSON: %w", err)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	return raw, nil
}

// removeOurHookEntries strips PreToolUse entries whose inner
// hooks[].command contains hookSentinel. If the PreToolUse list
// becomes empty we delete the key; if hooks{} becomes empty we
// delete the parent. Keeps settings.json minimal — a user opening
// the file shouldn't see leftover empty branches we created.
func removeOurHookEntries(settings map[string]any) (map[string]any, bool) {
	if settings == nil {
		return settings, false
	}
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		return settings, false
	}
	preToolUse, _ := hooks["PreToolUse"].([]any)
	if len(preToolUse) == 0 {
		return settings, false
	}
	kept := make([]any, 0, len(preToolUse))
	removed := false
	for _, raw := range preToolUse {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			kept = append(kept, raw)
			continue
		}
		inner, _ := entry["hooks"].([]any)
		isOurs := false
		for _, h := range inner {
			hm, _ := h.(map[string]any)
			if hm == nil {
				continue
			}
			cmd, _ := hm["command"].(string)
			if strings.Contains(cmd, hookSentinel) {
				isOurs = true
				break
			}
		}
		if isOurs {
			removed = true
			continue
		}
		kept = append(kept, raw)
	}
	if !removed {
		return settings, false
	}
	if len(kept) == 0 {
		delete(hooks, "PreToolUse")
	} else {
		hooks["PreToolUse"] = kept
	}
	if len(hooks) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooks
	}
	return settings, true
}

// writeSettingsAtomic writes the JSON to a temp file in the same
// directory and renames into place. The same-dir constraint is
// required for the rename to be atomic on POSIX (cross-fs rename
// silently degrades to copy+unlink which isn't atomic).
//
// File mode preserved if the target existed; falls back to 0600
// (settings can contain MCP server paths and other not-secret-but-
// not-public data, conservative default).
func writeSettingsAtomic(path string, settings map[string]any) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(dir, ".pockly-settings-*.json.tmp")
	if err != nil {
		return err
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(settings); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
