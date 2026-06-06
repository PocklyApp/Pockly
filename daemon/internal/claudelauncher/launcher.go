// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package claudelauncher

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/PocklyApp/Pockly/daemon/internal/agentexec"
)

const (
	RealClaudeEnv     = "POCKLY_REAL_CLAUDE"
	LauncherJSONEnv   = "POCKLY_CLAUDE_LAUNCHER_JSON"
	SettingsEnvSource = "claude_settings_env"
)

// CommandSpec is the local-only command shape used to launch Claude Code.
// Path is the executable to spawn; PrefixArgs are prepended before the
// ordinary Claude CLI args. PrefixArgs lets users supply a safe argv launcher
// without shell evaluation.
type CommandSpec struct {
	Path       string
	PrefixArgs []string
	Source     string
}

func (s CommandSpec) Args(args []string) []string {
	out := make([]string, 0, len(s.PrefixArgs)+len(args))
	out = append(out, s.PrefixArgs...)
	out = append(out, args...)
	return out
}

func (s CommandSpec) LauncherArgCount() int {
	return len(s.PrefixArgs)
}

// Resolve returns the command used to launch Claude Code. It deliberately
// avoids shell strings: POCKLY_CLAUDE_LAUNCHER_JSON must be a JSON argv array.
func Resolve(explicit, selfPath string) (CommandSpec, error) {
	return ResolveWithEnv(explicit, selfPath, os.Getenv, os.Getenv("PATH"))
}

func ResolveWithEnv(explicit, selfPath string, getenv func(string) string, pathEnv string) (CommandSpec, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if value := strings.TrimSpace(explicit); value != "" {
		return commandFromPath(value, nil, "explicit", selfPath)
	}
	if value := strings.TrimSpace(getenv(RealClaudeEnv)); value != "" {
		return commandFromPath(value, nil, RealClaudeEnv, selfPath)
	}
	if raw := strings.TrimSpace(getenv(LauncherJSONEnv)); raw != "" {
		spec, err := parseLauncherJSON(raw, selfPath, pathEnv, getenv)
		if err != nil {
			return CommandSpec{}, err
		}
		return spec, nil
	}
	resolved, err := agentexec.Resolve("claude", pathEnv, selfPath, getenv)
	if err != nil {
		return CommandSpec{}, err
	}
	return CommandSpec{Path: resolved.Path, Source: resolved.Source}, nil
}

func parseLauncherJSON(raw, selfPath, pathEnv string, getenv func(string) string) (CommandSpec, error) {
	var argv []string
	if err := json.Unmarshal([]byte(raw), &argv); err != nil {
		return CommandSpec{}, fmt.Errorf("%s must be a JSON string array: %w", LauncherJSONEnv, err)
	}
	clean := make([]string, 0, len(argv))
	for _, arg := range argv {
		arg = strings.TrimSpace(arg)
		if arg != "" {
			clean = append(clean, arg)
		}
	}
	if len(clean) == 0 {
		return CommandSpec{}, fmt.Errorf("%s must contain at least one argv item", LauncherJSONEnv)
	}
	path := clean[0]
	if !hasPathSeparator(path) {
		resolved, err := agentexec.Resolve(path, pathEnv, selfPath, getenv)
		if err != nil {
			return CommandSpec{}, fmt.Errorf("resolve %s launcher %q: %w", LauncherJSONEnv, path, err)
		}
		path = resolved.Path
	}
	return commandFromPath(path, clean[1:], LauncherJSONEnv, selfPath)
}

func commandFromPath(path string, prefix []string, source, selfPath string) (CommandSpec, error) {
	if strings.TrimSpace(path) == "" {
		return CommandSpec{}, fmt.Errorf("empty Claude launcher path from %s", source)
	}
	if samePath(path, selfPath) {
		return CommandSpec{}, fmt.Errorf("resolved Claude launcher points to pockly-claude-wrapper itself; set %s, --real, or %s", RealClaudeEnv, LauncherJSONEnv)
	}
	return CommandSpec{Path: path, PrefixArgs: append([]string(nil), prefix...), Source: source}, nil
}

func hasPathSeparator(path string) bool {
	return strings.ContainsRune(path, os.PathSeparator) || (runtime.GOOS == "windows" && strings.Contains(path, `/`))
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ar, aerr := os.Stat(a)
	br, berr := os.Stat(b)
	return aerr == nil && berr == nil && os.SameFile(ar, br)
}

// EnvSnapshot is safe to log: it exposes only key names and source metadata,
// never values.
type EnvSnapshot struct {
	Env              []string
	SettingsPath     string
	SettingsEnvKeys  []string
	SettingsEnvError string
}

func Env(base []string) EnvSnapshot {
	if base == nil {
		base = os.Environ()
	}
	settingsEnv, path, err := ReadSettingsEnv()
	out := append([]string(nil), base...)
	keys := make([]string, 0, len(settingsEnv))
	for key, value := range settingsEnv {
		out = setEnv(out, key, value)
		keys = append(keys, key)
	}
	sortStrings(keys)
	snap := EnvSnapshot{Env: out, SettingsPath: path, SettingsEnvKeys: keys}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		snap.SettingsEnvError = err.Error()
	}
	return snap
}

func ReadSettingsEnv() (map[string]string, string, error) {
	path, err := SettingsPath()
	if err != nil {
		return map[string]string{}, "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]string{}, path, nil
		}
		return map[string]string{}, path, err
	}
	var payload struct {
		Env map[string]any `json:"env"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return map[string]string{}, path, fmt.Errorf("parse Claude settings env: %w", err)
	}
	out := make(map[string]string, len(payload.Env))
	for key, raw := range payload.Env {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		switch value := raw.(type) {
		case string:
			out[key] = value
		case nil:
		default:
			out[key] = fmt.Sprint(value)
		}
	}
	return out, path, nil
}

func SettingsPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); override != "" {
		return filepath.Join(override, "settings.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	replaced := false
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			out = append(out, prefix+value)
			replaced = true
		} else {
			out = append(out, item)
		}
	}
	if !replaced {
		out = append(out, prefix+value)
	}
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
