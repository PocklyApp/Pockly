// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFormatAliasBlockPowerShell(t *testing.T) {
	block := formatAliasBlock(shellPowerShell, `C:\Users\me\AppData\Local\Pockly\bin\pockly-claude-wrapper.exe`)
	if !strings.Contains(block, "function claude { & 'C:\\Users\\me\\AppData\\Local\\Pockly\\bin\\pockly-claude-wrapper.exe' @args }") {
		t.Fatalf("PowerShell alias block missing wrapper function:\n%s", block)
	}
	if !strings.Contains(block, sentinelStart) || !strings.Contains(block, sentinelEnd) {
		t.Fatalf("PowerShell alias block missing sentinel:\n%s", block)
	}
}

func TestFormatAliasBlockPowerShellEscapesSingleQuotes(t *testing.T) {
	block := formatAliasBlock(shellPowerShell, `C:\Users\O'Neil\AppData\Local\Pockly\bin\pockly-claude-wrapper.exe`)
	if !strings.Contains(block, "function claude { & 'C:\\Users\\O''Neil\\AppData\\Local\\Pockly\\bin\\pockly-claude-wrapper.exe' @args }") {
		t.Fatalf("PowerShell alias block did not escape single quote:\n%s", block)
	}
}

func TestPowerShellConflictDetection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Microsoft.PowerShell_profile.ps1")
	if err := os.WriteFile(path, []byte("Set-Alias claude C:\\tools\\claude.ps1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	conflicts, err := detectClaudeAliasConflicts(shellTarget{Kind: shellPowerShell, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conflicts) != 1 {
		t.Fatalf("conflicts = %d, want 1: %#v", len(conflicts), conflicts)
	}
}

func TestPowerShellSentinelDoesNotConflictWithItself(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Microsoft.PowerShell_profile.ps1")
	if err := upsertSentinelBlock(shellTarget{Kind: shellPowerShell, Path: path}, `C:\Pockly\pockly-claude-wrapper.exe`); err != nil {
		t.Fatal(err)
	}
	conflicts, err := detectClaudeAliasConflicts(shellTarget{Kind: shellPowerShell, Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(conflicts) != 0 {
		t.Fatalf("conflicts = %#v, want none", conflicts)
	}
	status := inspectRCFile(rcRecord{Path: path, Shell: shellPowerShell})
	if !status.SentinelPresent {
		t.Fatalf("sentinel not detected in %s", path)
	}
	if !strings.Contains(status.AliasTarget, "pockly-claude-wrapper.exe") {
		t.Fatalf("AliasTarget = %q, want wrapper function", status.AliasTarget)
	}
}

func TestAutoDetectShellsWindowsKeepsShellFallback(t *testing.T) {
	home := `C:\Users\me`
	targets := autoDetectShellsFor(home, "windows", "bash", func(string) bool { return false }, func(string) bool { return false })

	var hasWindowsPowerShell, hasPowerShell, hasBash bool
	for _, target := range targets {
		switch {
		case target.Kind == shellPowerShell && strings.Contains(target.Path, `WindowsPowerShell`):
			hasWindowsPowerShell = true
		case target.Kind == shellPowerShell && strings.Contains(target.Path, `PowerShell`):
			hasPowerShell = true
		case target.Kind == shellBash && strings.HasSuffix(target.Path, `.bashrc`):
			hasBash = true
		}
	}
	if !hasWindowsPowerShell || !hasPowerShell || !hasBash {
		t.Fatalf("targets = %#v, want Windows PowerShell, PowerShell 7, and bash fallback", targets)
	}
}

func TestWindowsPowerShellProfilePaths(t *testing.T) {
	paths := windowsPowerShellProfilePaths(`C:\Users\me`)
	if len(paths) != 2 {
		t.Fatalf("paths len = %d, want 2: %#v", len(paths), paths)
	}
	if !strings.Contains(paths[0], `WindowsPowerShell`) {
		t.Fatalf("first profile = %q, want WindowsPowerShell profile", paths[0])
	}
	if !strings.Contains(paths[1], `PowerShell`) {
		t.Fatalf("second profile = %q, want PowerShell profile", paths[1])
	}
}

func TestActiveShellOverridesPowerShell(t *testing.T) {
	overrides := activeShellOverrides([]rcFileStatus{{
		Path:            `C:\Users\me\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`,
		Shell:           shellPowerShell,
		SentinelPresent: true,
		AliasTarget:     `function claude { & 'C:\Pockly\pockly-claude-wrapper.exe' @args }`,
	}})
	if len(overrides) != 1 {
		t.Fatalf("overrides len = %d, want 1: %#v", len(overrides), overrides)
	}
	if !strings.Contains(overrides[0], "new PowerShell sessions define function claude") {
		t.Fatalf("override = %q, want PowerShell function status", overrides[0])
	}
}
