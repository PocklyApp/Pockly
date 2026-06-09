// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package codexapp

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestCodexSandboxAcceptedByRealBinary proves the real codex app-server accepts
// the sandbox we now send at thread start — a kebab-case string enum
// (workspace-write / danger-full-access), NOT the tagged-object SandboxPolicy
// the generated schema shows. A wrong field name/shape surfaces as a JSON-RPC
// error from ThreadStart. Gated on env so CI never runs it:
//
//	POCKLY_CODEX_BIN=/path/to/codex POCKLY_CODEX_CWD=/path/to/project \
//	go test ./internal/agent/codexapp/ -run TestCodexSandboxAcceptedByRealBinary -v
func TestCodexSandboxAcceptedByRealBinary(t *testing.T) {
	bin := os.Getenv("POCKLY_CODEX_BIN")
	cwd := os.Getenv("POCKLY_CODEX_CWD")
	if bin == "" {
		t.Skip("set POCKLY_CODEX_BIN (and POCKLY_CODEX_CWD) to run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	c, err := Start(ctx, Config{BinaryPath: bin, Cwd: cwd})
	if err != nil {
		t.Fatalf("start app-server: %v", err)
	}
	defer c.Close()

	res, err := c.ThreadStart(ctx, ThreadStartParams{
		Cwd:            cwd,
		ApprovalPolicy: "on-request",
		Sandbox:        "workspace-write",
	})
	if err != nil {
		t.Fatalf("ThreadStart with sandbox object rejected: %v", err)
	}
	t.Logf("ThreadStart ok thread=%s", res.ThreadID)

	if err := c.TurnStart(ctx, TurnStartParams{
		ThreadID:       res.ThreadID,
		Cwd:            cwd,
		Effort:         "low",
		ApprovalPolicy: "on-request",
		Text:           "reply with the single word ok",
	}); err != nil {
		t.Fatalf("TurnStart (effort) rejected: %v", err)
	}
	t.Log("ThreadStart sandbox=workspace-write + TurnStart effort accepted")
}
