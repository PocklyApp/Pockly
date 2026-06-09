// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package sdkdriver

import "testing"

func TestCodexApprovalAndSandboxMapping(t *testing.T) {
	cases := []struct {
		mode         string
		wantApproval string
		wantSandbox  string
	}{
		// Unset → omit both so codex uses its own config.toml defaults.
		{"", "", ""},
		// The three codex presets.
		{CodexModeRequestApproval, "on-request", "workspace-write"},
		{CodexModeApproveForMe, "on-failure", "workspace-write"},
		{CodexModeFullAccess, "never", "danger-full-access"},
		// Legacy claude-vocabulary tokens still map sensibly.
		{"default", "on-request", "workspace-write"},
		{"plan", "on-request", "workspace-write"},
		{"acceptEdits", "on-failure", "workspace-write"},
		{"auto", "on-failure", "workspace-write"},
		{"bypassPermissions", "never", "danger-full-access"},
		{"dontAsk", "never", "danger-full-access"},
		// Unknown → cautious workspace-write + on-request, never silently full-access.
		{"garbage", "on-request", "workspace-write"},
	}
	for _, tc := range cases {
		if got := codexApprovalPolicy(tc.mode); got != tc.wantApproval {
			t.Errorf("codexApprovalPolicy(%q)=%q want %q", tc.mode, got, tc.wantApproval)
		}
		if got := codexSandbox(tc.mode); got != tc.wantSandbox {
			t.Errorf("codexSandbox(%q)=%q want %q", tc.mode, got, tc.wantSandbox)
		}
	}
	// Safety invariant: full disk/network (dangerFullAccess) is reachable ONLY
	// from the explicit full-access preset (or its legacy aliases), never from
	// a cautious or unknown token.
	for _, mode := range []string{"", CodexModeRequestApproval, CodexModeApproveForMe, "default", "plan", "acceptEdits", "auto", "garbage"} {
		if codexSandbox(mode) == "dangerFullAccess" {
			t.Errorf("codexSandbox(%q) unexpectedly granted dangerFullAccess", mode)
		}
	}
}

func TestCodexPresetLists(t *testing.T) {
	if got := CodexPermissionModes(); len(got) != 3 ||
		got[0] != CodexModeRequestApproval || got[1] != CodexModeApproveForMe || got[2] != CodexModeFullAccess {
		t.Errorf("CodexPermissionModes()=%v want the 3 presets in order", got)
	}
	want := []string{"low", "medium", "high", "xhigh"}
	got := CodexEffortLevels()
	if len(got) != len(want) {
		t.Fatalf("CodexEffortLevels()=%v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("CodexEffortLevels()[%d]=%q want %q", i, got[i], want[i])
		}
	}
}
