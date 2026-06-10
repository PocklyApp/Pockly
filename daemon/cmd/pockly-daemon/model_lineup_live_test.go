// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"testing"

	"github.com/PocklyApp/Pockly/daemon/internal/agentsettings"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/sdkdriver"
)

// End-to-end check of BOTH model-lineup branches with the EXACT resolver
// wiring main.go uses (sdkdriver.ResolveExecutable, which skips the Pockly
// PTY wrapper). Spawns the real installed claude CLI, so it's gated:
//
//	POCKLY_LIVE_MODEL_TEST=1 go test ./cmd/pockly-daemon/ -run TestModelLineupBranchesLive -v
func TestModelLineupBranchesLive(t *testing.T) {
	if os.Getenv("POCKLY_LIVE_MODEL_TEST") == "" {
		t.Skip("set POCKLY_LIVE_MODEL_TEST=1 to run against the real claude CLI")
	}

	bin, err := sdkdriver.ResolveExecutable("claude")
	if err != nil {
		t.Fatalf("ResolveExecutable(claude): %v — main.go's wiring would silently fall back to the static lineup", err)
	}
	t.Logf("ResolveExecutable(claude) → %s", bin)

	// Wire the resolver exactly like main.go does.
	agentsettings.SetClaudeBinaryResolver(func() (string, error) {
		return sdkdriver.ResolveExecutable("claude")
	})
	defer agentsettings.SetClaudeBinaryResolver(nil)

	// ── Branch 1: first-party (no custom provider env) ──────────────────
	for _, key := range []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
	} {
		t.Setenv(key, "")
	}
	official := agentsettings.ReadModelOptionDetails("")
	if len(official) == 0 {
		t.Fatal("official branch returned no models")
	}
	sawLive := false
	for _, opt := range official {
		t.Logf("official: value=%q label=%q resolved=%q source=%q", opt.Value, opt.Label, opt.ResolvedModel, opt.Source)
		if opt.Source == "claude_cli" {
			sawLive = true
		}
	}
	if !sawLive {
		t.Fatal("official branch did NOT use the live CLI query (fell back to the static lineup)")
	}

	// ── Branch 2: custom provider (ANTHROPIC_MODEL set) ─────────────────
	t.Setenv("ANTHROPIC_MODEL", "anthropic-compatible-fast")
	custom := agentsettings.ReadModelOptionDetails("")
	values := map[string]string{}
	for _, opt := range custom {
		t.Logf("custom: value=%q label=%q source=%q", opt.Value, opt.Label, opt.Source)
		values[opt.Value] = opt.Source
	}
	for _, alias := range []string{"sonnet", "opus", "haiku"} {
		if _, ok := values[alias]; !ok {
			t.Errorf("custom branch missing alias %q", alias)
		}
	}
	if _, ok := values["anthropic-compatible-fast"]; !ok {
		t.Error("custom branch missing the provider model from ANTHROPIC_MODEL")
	}
	for value, source := range values {
		if source == "claude_cli" {
			t.Errorf("custom branch must not serve live-CLI entries, got %q", value)
		}
	}
}
