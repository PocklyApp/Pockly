// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/sdkdriver"
)

func TestParseCodexConfigModelApprovalSandboxEffort(t *testing.T) {
	raw := `
model = "gpt-5.4-codex"
approval_policy = "on-failure"
sandbox_mode = "workspace-write"   # inline comment
model_reasoning_effort = "high"
`
	cfg := parseCodexConfigModel(raw)
	if cfg.approvalPolicy != "on-failure" || cfg.sandboxMode != "workspace-write" || cfg.reasoningEffort != "high" {
		t.Fatalf("parsed %+v, want approval=on-failure sandbox=workspace-write effort=high", cfg)
	}
}

func TestCodexDefaultsFollowConfig(t *testing.T) {
	cases := []struct {
		name     string
		toml     string
		wantMode string
		wantEff  string
	}{
		{
			name:     "full access config",
			toml:     "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\nmodel_reasoning_effort = \"high\"\n",
			wantMode: sdkdriver.CodexModeFullAccess,
			wantEff:  "high",
		},
		{
			name:     "on-failure → approve-for-me, minimal clamps to low",
			toml:     "approval_policy = \"on-failure\"\nsandbox_mode = \"workspace-write\"\nmodel_reasoning_effort = \"minimal\"\n",
			wantMode: sdkdriver.CodexModeApproveForMe,
			wantEff:  "low",
		},
		{
			name:     "on-request → request-approval, no effort → medium",
			toml:     "approval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n",
			wantMode: sdkdriver.CodexModeRequestApproval,
			wantEff:  "medium",
		},
		{
			name:     "danger sandbox alone forces full-access",
			toml:     "sandbox_mode = \"danger-full-access\"\n",
			wantMode: sdkdriver.CodexModeFullAccess,
			wantEff:  "medium",
		},
		{
			name:     "empty config → cautious default",
			toml:     "",
			wantMode: sdkdriver.CodexModeRequestApproval,
			wantEff:  "medium",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(tc.toml), 0o600); err != nil {
				t.Fatalf("write config: %v", err)
			}
			t.Setenv("CODEX_HOME", home)
			if got := codexDefaultPermissionMode(); got != tc.wantMode {
				t.Errorf("codexDefaultPermissionMode()=%q want %q", got, tc.wantMode)
			}
			if got := codexDefaultEffort(); got != tc.wantEff {
				t.Errorf("codexDefaultEffort()=%q want %q", got, tc.wantEff)
			}
		})
	}
}
