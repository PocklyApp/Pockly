// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package agentexec

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveFindsCommonUserBinWhenPathIsEmpty(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	target := touchExecutable(t, bin, "codex")

	resolved, err := Resolve("codex", "", "", func(key string) string {
		if key == "HOME" {
			return home
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Resolve codex: %v", err)
	}
	if resolved.Path != target || resolved.Source != "common_path" {
		t.Fatalf("resolved = %#v, want path=%q source=common_path", resolved, target)
	}
}

func TestResolveSkipsSelfWrapperThenFindsCommonPath(t *testing.T) {
	home := t.TempDir()
	pathDir := t.TempDir()
	self := touchExecutable(t, pathDir, "claude")
	target := touchExecutable(t, filepath.Join(home, ".npm-global", "bin"), "claude")

	resolved, err := Resolve("claude", pathDir, self, func(key string) string {
		if key == "HOME" {
			return home
		}
		return ""
	})
	if err != nil {
		t.Fatalf("Resolve claude: %v", err)
	}
	if resolved.Path != target || resolved.Source != "common_path" {
		t.Fatalf("resolved = %#v, want path=%q source=common_path", resolved, target)
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
