// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSetupHookBridgeDoesNotInstallPreToolUse(t *testing.T) {
	tmp := t.TempDir()
	cfgDir := filepath.Join(tmp, ".claude")
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	t.Setenv(hookEnvDisable, "")

	cleanup, err := setupHookBridge("/usr/local/bin/pockly-daemon")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if cleanup == nil {
		t.Fatal("cleanup func nil")
	}
	cleanup()
	if _, err := os.Stat(filepath.Join(cfgDir, "settings.json")); !os.IsNotExist(err) {
		t.Fatalf("settings.json should not be created when no stale hook exists: %v", err)
	}
}

func TestSetupHookBridgeRemovesStalePocklyHooks(t *testing.T) {
	tmp := t.TempDir()
	cfgDir := filepath.Join(tmp, ".claude")
	settingsPath := filepath.Join(cfgDir, "settings.json")
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	t.Setenv(hookEnvDisable, "")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	seed := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "*",
					"hooks": []any{
						map[string]any{"type": "command", "command": "/old/pockly-daemon hook-bridge --timeout=60s"},
					},
				},
				map[string]any{
					"matcher": "Bash",
					"hooks": []any{
						map[string]any{"type": "command", "command": "/usr/bin/user-audit"},
					},
				},
			},
			"PostToolUse": []any{map[string]any{"matcher": "*"}},
		},
		"theme": "dark",
	}
	body, _ := json.Marshal(seed)
	if err := os.WriteFile(settingsPath, body, 0o600); err != nil {
		t.Fatal(err)
	}

	cleanup, err := setupHookBridge("/new/pockly-daemon")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	cleanup()

	got, err := readSettings(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if got["theme"] != "dark" {
		t.Fatalf("theme mutated: %v", got["theme"])
	}
	hooks := got["hooks"].(map[string]any)
	pre := hooks["PreToolUse"].([]any)
	if len(pre) != 1 {
		t.Fatalf("PreToolUse count = %d, want user-only 1: %v", len(pre), pre)
	}
	entry := pre[0].(map[string]any)
	if entry["matcher"] != "Bash" {
		t.Fatalf("user hook mutated: %v", entry)
	}
	if _, ok := hooks["PostToolUse"]; !ok {
		t.Fatal("PostToolUse should be preserved")
	}
}

func TestSetupHookBridgeRespectsDisableEnv(t *testing.T) {
	tmp := t.TempDir()
	cfgDir := filepath.Join(tmp, ".claude")
	t.Setenv("CLAUDE_CONFIG_DIR", cfgDir)
	t.Setenv(hookEnvDisable, "1")

	cleanup, err := setupHookBridge("/usr/local/bin/pockly-daemon")
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if cleanup == nil {
		t.Fatal("cleanup nil")
	}
	cleanup()
	if _, err := os.Stat(filepath.Join(cfgDir, "settings.json")); !os.IsNotExist(err) {
		t.Errorf("expected no settings.json when disabled, got err=%v", err)
	}
}
