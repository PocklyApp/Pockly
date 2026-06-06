// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package runner classifies the Claude runner the daemon will hand off to.
//
// The runner alias is a display/diagnostic signal that flows daemon -> relay
// -> web. It does not influence routing decisions: connection_mode and the
// PTY duplex gate are derived independently from live terminal presence.
//
// Detection is intentionally conservative — when a user's PATH doesn't make
// the runner obvious, the env override POCKLY_RUNNER_ALIAS is the honest knob.
package runner

import (
	"os"
	"os/exec"
	"strings"
)

type Alias string

const (
	AliasUnknown   Alias = ""
	AliasClaude    Alias = "claude"
	AliasClaudeCCR Alias = "claude_ccr"
	AliasCustom    Alias = "custom"
)

const EnvOverride = "POCKLY_RUNNER_ALIAS"

// Profile holds the resolved runner alias per agent family.
type Profile struct {
	ClaudeAlias Alias
}

// AliasFor returns the wire-format runner alias for a given agent string.
// Returns "" for agents without a runner alias mapping (e.g. codex, unknowns).
func (p Profile) AliasFor(agent string) string {
	switch agent {
	case "claude-code":
		return string(p.ClaudeAlias)
	default:
		return ""
	}
}

// Detect inspects the local environment and returns the best-effort profile.
func Detect() Profile {
	return Profile{ClaudeAlias: detectClaudeAlias(os.Getenv, exec.LookPath)}
}

// detectClaudeAlias is the testable core of Detect.
func detectClaudeAlias(env func(string) string, lookPath func(string) (string, error)) Alias {
	if override := normalizeOverride(env(EnvOverride)); override != AliasUnknown {
		return override
	}
	if _, err := lookPath("claude"); err == nil {
		return AliasClaude
	}
	if _, err := lookPath("ccr"); err == nil {
		return AliasClaudeCCR
	}
	return AliasClaude
}

func normalizeOverride(raw string) Alias {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "claude":
		return AliasClaude
	case "claude_ccr", "claude-ccr", "ccr":
		return AliasClaudeCCR
	case "custom":
		return AliasCustom
	default:
		return AliasUnknown
	}
}
