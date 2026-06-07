// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

// TestDetectPermissionFromRealClaudeCHARenderedPrompt is the regression guard
// for "PTY sessions don't surface permission approvals on the web".
//
// Claude's TUI does NOT write literal spaces between words — it jumps the
// cursor to each word's column with CHA (CSI n G). These are the actual bytes
// captured from `claude` (2.1.156 in the linux container AND 2.1.158 on
// macOS, identical) at a Bash approval prompt. The wrapper's stripANSI must
// turn the CHA positioning back into spaces, otherwise the screen reads
// "Doyouwantto"/"3.No" and detectClaudeTUIApproval's literal-space matches
// fail — so no permission_request is ever emitted and the web shows nothing.
//
// This runs the exact production path (stripANSI → detectClaudeTUIApproval)
// on the real byte stream, so reverting either the stripANSI space-restore or
// the detector breaks it. It needs no real claude or Nexus, so it's a
// fast, deterministic guard (full-stack e2e can't reliably catch this — the
// Nexus replays buffered events, which masked the bug during manual testing).
func TestDetectPermissionFromRealClaudeCHARenderedPrompt(t *testing.T) {
	// Each TUI line below positions words via CSI n G, mirroring the captured
	// bytes: "\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?".
	lines := []string{
		"\x1b[2G\x1b[38;5;153m⏺\x1b[4GBash(touch\x1b[15G/tmp/x.txt\x1b[26G&&\x1b[29Grm\x1b[32G/tmp/x.txt)\x1b[39m",
		"",
		"\x1b[2GBash\x1b[7Gcommand",
		"\x1b[2Gtouch\x1b[8G/tmp/x.txt\x1b[19G&&\x1b[22Grm\x1b[25G/tmp/x.txt",
		"\x1b[2GCreate\x1b[9Gthen\x1b[14Gdelete\x1b[21Ga\x1b[23Gtemp\x1b[28Gfile",
		"",
		"\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?",
		"\x1b[2G\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1.\x1b[7G\x1b[39mYes",
		"\x1b[4G2.\x1b[7GYes,\x1b[12Gand\x1b[16Gallow\x1b[22Gtmp/\x1b[27Gaccess",
		"\x1b[4G3.\x1b[7GNo",
		"\x1b[2GEsc\x1b[6Gto\x1b[9Gcancel",
	}
	raw := strings.Join(lines, "\r\n")

	screen := string(stripANSI([]byte(raw)))

	prompt, ok := detectClaudeTUIApproval(screen)
	if !ok {
		t.Fatalf("detectClaudeTUIApproval returned ok=false for a real Bash approval prompt.\nstripANSI screen:\n%s", screen)
	}
	if prompt.ToolName != "Bash" {
		t.Errorf("ToolName = %q, want Bash", prompt.ToolName)
	}
	if prompt.Sig == "" {
		t.Error("Sig is empty — the watcher would not be able to dedup/forward it")
	}
	cmd, _ := prompt.Input["command"].(string)
	if !strings.Contains(cmd, "touch /tmp/x.txt") || !strings.Contains(cmd, "&& rm") {
		t.Errorf("command = %q, want it to contain the spaced command (touch /tmp/x.txt && rm …)", cmd)
	}
	promptText, _ := prompt.Input["prompt"].(string)
	if !strings.Contains(promptText, "Do you want to") {
		t.Errorf("prompt = %q, want it to contain 'Do you want to'", promptText)
	}
}
