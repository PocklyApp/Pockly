// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func TestCodexModelOptionsUsesIsolatedStdio(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell shim uses /bin/sh")
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "codex-argv.log")
	shimPath := filepath.Join(dir, "codex")
	shim := `#!/bin/sh
printf '%s\n' "$*" >> "$POCKLY_CODEX_ARGV_LOG"
case "$*" in
  "app-server --listen stdio://"*)
    while IFS= read -r line; do
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/"\1"/p')
      [ -n "$id" ] || id=null
      case "$line" in
        *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
        *'"method":"model/list"'*) printf '{"id":%s,"result":{"data":[{"id":"codex-test-model","model":"codex-test-model","displayName":"Codex Test","isDefault":true}]}}\n' "$id" ;;
      esac
    done
    ;;
  *)
    exit 11
    ;;
esac
`
	if err := os.WriteFile(shimPath, []byte(shim), 0o755); err != nil {
		t.Fatalf("write codex shim: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("POCKLY_CODEX_ARGV_LOG", logPath)
	t.Setenv("CODEX_HOME", filepath.Join(dir, "codex-home"))

	defaultModel, resolvedDefault, models, options := codexModelOptions()
	if defaultModel != "codex-test-model" || resolvedDefault != "codex-test-model" {
		t.Fatalf("default=%q resolved=%q, want codex-test-model", defaultModel, resolvedDefault)
	}
	if len(models) != 1 || models[0] != "codex-test-model" {
		t.Fatalf("models=%#v, want codex-test-model", models)
	}
	if len(options) != 1 || options[0].Source != "codex_app_server" {
		t.Fatalf("options=%#v, want one codex_app_server option", options)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read argv log: %v", err)
	}
	got := strings.TrimSpace(string(raw))
	if got != "app-server --listen stdio://" {
		t.Fatalf("codex argv = %q, want isolated stdio only", got)
	}
	if strings.Contains(got, "proxy") || strings.Contains(got, "daemon") {
		t.Fatalf("model options must not probe proxy or start daemon, argv=%q", got)
	}
}
