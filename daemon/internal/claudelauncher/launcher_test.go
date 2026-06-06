// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package claudelauncher

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestResolveHonorsExplicitAndRealClaudeEnv(t *testing.T) {
	self := touchExecutable(t, t.TempDir(), "pockly-claude-wrapper")
	explicit := touchExecutable(t, t.TempDir(), "claude-explicit")
	envClaude := touchExecutable(t, t.TempDir(), "claude-env")

	spec, err := ResolveWithEnv(explicit, self, func(key string) string {
		if key == RealClaudeEnv {
			return envClaude
		}
		return ""
	}, "")
	if err != nil {
		t.Fatalf("ResolveWithEnv explicit: %v", err)
	}
	if spec.Path != explicit || spec.Source != "explicit" {
		t.Fatalf("explicit spec = %#v, want path=%q source=explicit", spec, explicit)
	}

	spec, err = ResolveWithEnv("", self, func(key string) string {
		if key == RealClaudeEnv {
			return envClaude
		}
		return ""
	}, "")
	if err != nil {
		t.Fatalf("ResolveWithEnv env: %v", err)
	}
	if spec.Path != envClaude || spec.Source != RealClaudeEnv {
		t.Fatalf("env spec = %#v, want path=%q source=%s", spec, envClaude, RealClaudeEnv)
	}
}

func TestResolveLauncherJSONBuildsPrefixArgs(t *testing.T) {
	self := touchExecutable(t, t.TempDir(), "pockly-claude-wrapper")
	launcher := touchExecutable(t, t.TempDir(), "cc-launcher")
	spec, err := ResolveWithEnv("", self, func(key string) string {
		if key == LauncherJSONEnv {
			return `["` + launcher + `","switch","exec","claude"]`
		}
		return ""
	}, "")
	if err != nil {
		t.Fatalf("ResolveWithEnv launcher json: %v", err)
	}
	if spec.Path != launcher || spec.Source != LauncherJSONEnv {
		t.Fatalf("launcher spec = %#v", spec)
	}
	if !reflect.DeepEqual(spec.PrefixArgs, []string{"switch", "exec", "claude"}) {
		t.Fatalf("prefix args = %#v", spec.PrefixArgs)
	}
	if got := spec.Args([]string{"--resume", "sid"}); !reflect.DeepEqual(got, []string{"switch", "exec", "claude", "--resume", "sid"}) {
		t.Fatalf("Args() = %#v", got)
	}
}

func TestResolvePathSkipsSelfWrapper(t *testing.T) {
	dir1 := t.TempDir()
	dir2 := t.TempDir()
	self := touchExecutable(t, dir1, "claude")
	real := touchExecutable(t, dir2, "claude")
	spec, err := ResolveWithEnv("", self, func(string) string { return "" }, strings.Join([]string{dir1, dir2}, string(os.PathListSeparator)))
	if err != nil {
		t.Fatalf("ResolveWithEnv path: %v", err)
	}
	if spec.Path != real || spec.Source != "path" {
		t.Fatalf("path spec = %#v, want real %q", spec, real)
	}
}

func TestResolveFallsBackToCommonUserBin(t *testing.T) {
	home := t.TempDir()
	self := touchExecutable(t, t.TempDir(), "pockly-claude-wrapper")
	real := touchExecutable(t, filepath.Join(home, ".local", "bin"), "claude")

	spec, err := ResolveWithEnv("", self, func(key string) string {
		if key == "HOME" {
			return home
		}
		return ""
	}, "")
	if err != nil {
		t.Fatalf("ResolveWithEnv common path: %v", err)
	}
	if spec.Path != real || spec.Source != "common_path" {
		t.Fatalf("common path spec = %#v, want real %q", spec, real)
	}
}

func TestEnvOverlaysClaudeSettingsEnv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	settingsDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		t.Fatalf("mkdir settings: %v", err)
	}
	settingsPath := filepath.Join(settingsDir, "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"env":{"ANTHROPIC_MODEL":"deepseek-v4-flash","ANTHROPIC_AUTH_TOKEN":"sk-secret"}}`), 0o600); err != nil {
		t.Fatalf("write settings: %v", err)
	}

	snap := Env([]string{"ANTHROPIC_MODEL=old", "TERM=xterm"})
	if got := valueForEnv(snap.Env, "ANTHROPIC_MODEL"); got != "deepseek-v4-flash" {
		t.Fatalf("ANTHROPIC_MODEL = %q", got)
	}
	if got := valueForEnv(snap.Env, "ANTHROPIC_AUTH_TOKEN"); got != "sk-secret" {
		t.Fatalf("ANTHROPIC_AUTH_TOKEN missing/changed: %q", got)
	}
	if !reflect.DeepEqual(snap.SettingsEnvKeys, []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"}) {
		t.Fatalf("SettingsEnvKeys = %#v", snap.SettingsEnvKeys)
	}
	if strings.Contains(strings.Join(snap.SettingsEnvKeys, ","), "sk-secret") || strings.Contains(snap.SettingsEnvError, "sk-secret") {
		t.Fatalf("snapshot leaked secret: %#v", snap)
	}
}

func touchExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write executable: %v", err)
	}
	return path
}

func valueForEnv(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}
