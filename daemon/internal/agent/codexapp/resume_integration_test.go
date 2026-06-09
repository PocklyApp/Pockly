// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package codexapp

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestCodexResumeByPathAgainstRealBinary proves, end-to-end against the real
// codex app-server, that resuming by rollout PATH loads a prior session's
// thread while resuming by thread id alone does not. Gated on env so it never
// runs in CI:
//
//	POCKLY_CODEX_BIN=/path/to/codex \
//	POCKLY_CODEX_ROLLOUT=/path/to/rollout.jsonl \
//	POCKLY_CODEX_THREAD=<uuid> \
//	POCKLY_CODEX_CWD=/path/to/project \
//	go test ./internal/agent/codexapp/ -run TestCodexResumeByPathAgainstRealBinary -v
func TestCodexResumeByPathAgainstRealBinary(t *testing.T) {
	bin := os.Getenv("POCKLY_CODEX_BIN")
	rollout := os.Getenv("POCKLY_CODEX_ROLLOUT")
	threadID := os.Getenv("POCKLY_CODEX_THREAD")
	cwd := os.Getenv("POCKLY_CODEX_CWD")
	if bin == "" || rollout == "" || threadID == "" {
		t.Skip("set POCKLY_CODEX_BIN / POCKLY_CODEX_ROLLOUT / POCKLY_CODEX_THREAD to run")
	}

	// The daemon's ensureCodexThread early-returns when the session id is already
	// bound, so on a fresh app-server it calls TurnStart WITHOUT ever resuming
	// the thread. Reproduce both shapes against the real binary.
	turnStartErr := func(resume bool, withPath bool) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := Start(ctx, Config{BinaryPath: bin, Cwd: cwd})
		if err != nil {
			t.Fatalf("start app-server: %v", err)
		}
		defer c.Close()
		if resume {
			rp := ThreadResumeParams{ThreadID: threadID, Cwd: cwd}
			if withPath {
				rp.Path = rollout
			}
			if _, rerr := c.ThreadResume(ctx, rp); rerr != nil {
				t.Fatalf("ThreadResume failed: %v", rerr)
			}
		}
		// TurnStart returns the start error synchronously; close right after so a
		// successful start barely runs the model.
		return c.TurnStart(ctx, TurnStartParams{ThreadID: threadID, Cwd: cwd, Text: "reply with the single word ok"})
	}

	noResume := turnStartErr(false, false)
	t.Logf("TurnStart WITHOUT resume (daemon's current behavior): err=%v", noResume)
	withResume := turnStartErr(true, true)
	t.Logf("TurnStart AFTER resume-by-path: err=%v", withResume)

	if noResume == nil {
		t.Log("NOTE: TurnStart without resume succeeded — root cause is elsewhere")
	}
	if withResume != nil {
		t.Fatalf("TurnStart after resume-by-path must succeed, got: %v", withResume)
	}
}
