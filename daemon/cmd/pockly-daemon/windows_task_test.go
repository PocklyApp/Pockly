// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

// windowsTaskXML / utf16LEWithBOM are platform-independent string builders
// (the actual schtasks call is Windows-only), so they're unit-testable here.

func TestWindowsTaskXMLEmbedsCommandAndArgs(t *testing.T) {
	xml := windowsTaskXML(
		`C:\Program Files\Pockly\pockly-daemon.exe`,
		"https://pocklyapp.com",
		`C:\Users\me\id.json`,
		`C:\Users\me\state.json`,
	)
	for _, want := range []string{
		// exe goes in <Command> verbatim — spaces and backslashes are fine.
		`<Command>C:\Program Files\Pockly\pockly-daemon.exe</Command>`,
		// flags go in <Arguments>; the quoted relay URL survives as escaped quotes.
		`serve --connect-relay`,
		`--relay-url &quot;https://pocklyapp.com&quot;`,
		`--identity-file &quot;C:\Users\me\id.json&quot;`,
		// daemon-appropriate settings the /TR form couldn't set.
		`<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
		`<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
		`<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
		`<LogonTrigger>`,
	} {
		if !strings.Contains(xml, want) {
			t.Fatalf("task xml missing %q\n---\n%s", want, xml)
		}
	}
}

func TestWindowsTaskXMLEscapesSpecialChars(t *testing.T) {
	// An & in the relay URL must be XML-escaped or the action XML is malformed
	// and schtasks rejects it.
	xml := windowsTaskXML("daemon.exe", "https://relay.example/?a=1&b=2", "id", "state")
	if !strings.Contains(xml, "a=1&amp;b=2") {
		t.Fatalf("ampersand not escaped:\n%s", xml)
	}
	if strings.Contains(xml, "a=1&b=2") {
		t.Fatalf("raw unescaped ampersand present:\n%s", xml)
	}
}

func TestUTF16LEWithBOM(t *testing.T) {
	got := utf16LEWithBOM("A€") // 'A' = U+0041, '€' = U+20AC
	want := []byte{0xFF, 0xFE, 0x41, 0x00, 0xAC, 0x20}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (% X)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("byte %d = 0x%02X, want 0x%02X (% X)", i, got[i], want[i], got)
		}
	}
}
