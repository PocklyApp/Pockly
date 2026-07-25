// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

// TestStripANSIColumnPositioningBecomesSpace guards the PTY permission fix.
// Claude's TUI lays out a line by jumping the cursor to each word's column
// with CHA (CSI n G) / cursor-forward (CSI n C) rather than writing literal
// spaces — e.g. "Do\x1b[5Gyou". Dropping the escape concatenated the words
// ("Doyou"), which broke the permission-prompt detector's literal-space
// matches so PTY approvals never reached the web. stripANSI must emit a
// space for those finals so word breaks survive.
func TestStripANSIColumnPositioningBecomesSpace(t *testing.T) {
	cases := []struct{ name, in, wantSub string }{
		{"prompt line (real claude bytes)", "\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?", "Do you want to proceed?"},
		{"option line with colors", "\x1b[4G\x1b[38;2;1;1;1m1.\x1b[7G\x1b[39mYes", "1. Yes"},
		{"no option line", "\x1b[4G3.\x1b[7GNo", "3. No"},
		{"bash command via CHA", "touch\x1b[7G/tmp/x\x1b[16G&&\x1b[19Gls", "touch /tmp/x && ls"},
		{"cursor-forward (CSI C)", "a\x1b[1Cb", "a b"},
	}
	for _, c := range cases {
		if got := string(stripANSI([]byte(c.in))); !strings.Contains(got, c.wantSub) {
			t.Errorf("%s: stripANSI=%q, want contains %q", c.name, got, c.wantSub)
		}
	}
}

// TestStripANSI documents what gets killed before text_delta hits the
// wire. The bug that motivated stripANSI: Claude TUI repaints the
// whole screen on every assistant token, so without this strip the
// web sees thousands of cursor-move + color-change escape sequences
// interleaved with the actual chat text, rendering as garbage like:
//
//	"◆ Pockly · ⚡ PTY duplex[38;2;153;153;153m · 1 paired"
func TestStripANSI(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plaintext untouched", "hello world", "hello world"},
		{"keeps newlines", "line1\nline2", "line1\nline2"},
		{"keeps tabs", "col1\tcol2", "col1\tcol2"},
		{"CSI color code stripped", "\x1b[38;2;153;153;153m grey \x1b[0m", " grey"}, // leading space is literal (was between ESC] and 'grey')
		{"SGR reset stripped", "\x1b[0m", ""},
		{"CSI cursor movement stripped", "before\x1b[2;5Hafter", "beforeafter"},
		{"OSC title-set stripped (BEL terminator)", "before\x1b]0;Window Title\x07after", "beforeafter"},
		{"OSC stripped with ST terminator", "x\x1b]52;c;abc\x1b\\y", "xy"},
		{"two-byte ESC sequence stripped", "\x1b=keypad\x1b>app", "keypadapp"},
		{"DCS stripped to ST", "x\x1bP1;2|content\x1b\\y", "xy"},
		{"trailing ESC at chunk boundary dropped", "abc\x1b", "abc"},
		{"CR LF collapsed to LF", "a\r\nb", "a\nb"},
		{"lone CR becomes LF", "a\rb", "a\nb"},
		{"backspace dropped", "abc\bd", "abcd"},
		{"DEL dropped", "a\x7fb", "ab"},
		{
			"real Claude statusLine repaint",
			"⏺ Hello world.\x1b[38;2;153;153;153m\n◆ Pockly · ⚡ PTY duplex\x1b[0m · 1 paired",
			"⏺ Hello world.\n◆ Pockly · ⚡ PTY duplex · 1 paired",
		},
		{"empty input returns empty", "", ""},
		{"pure repaint becomes empty (web skips Emit)", "\x1b[2J\x1b[H\x1b[0m", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(stripANSI([]byte(tc.in)))
			if got != tc.want {
				t.Fatalf("stripANSI(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestIncompleteTailLen guards the carry logic that makes per-chunk ANSI
// stripping split-safe: bytes that are an incomplete escape / UTF-8 rune / a
// trailing CR must be held back for the next read.
func TestIncompleteTailLen(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want int
	}{
		{"empty", []byte{}, 0},
		{"plain ascii", []byte("hello"), 0},
		{"bare trailing ESC", []byte("ab\x1b"), 1},
		{"split CSI mid-params", []byte("ab\x1b[5"), 3}, // ESC [ 5  (no final yet)
		{"split CSI just opened", []byte("ab\x1b["), 2}, // ESC [
		{"complete CSI", []byte("ab\x1b[5G"), 0},        // final 'G' present
		{"complete SGR", []byte("\x1b[38;5;9m"), 0},
		{"split OSC (no terminator)", []byte("x\x1b]0;title"), 9}, // ESC + "]0;title" (9 bytes held)
		{"complete OSC (BEL)", []byte("x\x1b]0;t\x07"), 0},
		{"trailing CR (maybe \\r\\n split)", []byte("ab\r"), 1},
		{"complete two-byte ESC", []byte("\x1b="), 0},
		{"split 3-byte UTF-8 (1 byte)", []byte("ab\xe4"), 1},      // 你 leader, 0/2 continuations
		{"split 3-byte UTF-8 (2 bytes)", []byte("ab\xe4\xbd"), 2}, // 你 leader + 1 continuation
		{"complete 3-byte UTF-8", []byte("ab\xe4\xbd\xa0"), 0},    // 你
		{"split 2-byte UTF-8", []byte("ab\xc3"), 1},
		{"oversized unterminated escape is let through", append([]byte("\x1b]"), make([]byte, ansiCarryLimit+10)...), 0},
	}
	for _, c := range cases {
		if got := incompleteTailLen(c.in); got != c.want {
			t.Errorf("%s: incompleteTailLen(%q) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}

// TestStripANSIChunkSplitInvariant is the core A1/A2 regression: feeding the
// real CHA-rendered permission prompt through stripANSIChunk in EVERY possible
// two-way split must (a) reconstruct exactly what a single stripANSICore over
// the whole stream produces, and (b) still let detectClaudeTUIApproval fire.
// Before the carry, a split escape leaked its trailer ("5G") as literal text
// into the buffer and the trailing-space trim joined words ("toproceed"), so
// PTY approvals silently vanished whenever a read boundary fell mid-prompt.
func TestStripANSIChunkSplitInvariant(t *testing.T) {
	lines := []string{
		"\x1b[2G\x1b[38;5;153m⏺\x1b[4GBash(touch\x1b[15G/tmp/x.txt)\x1b[39m",
		"",
		"\x1b[2GDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gproceed?",
		"\x1b[2G\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1.\x1b[7G\x1b[39mYes",
		"\x1b[4G2.\x1b[7GYes,\x1b[12Gand\x1b[16Gallow",
		"\x1b[4G3.\x1b[7GNo",
	}
	raw := []byte(strings.Join(lines, "\r\n"))
	want := string(stripANSICore(raw))

	// Sanity: the un-split result detects, with the word spaces intact.
	if !strings.Contains(want, "Do you want to ") || !strings.Contains(want, "1. Yes") || !strings.Contains(want, "3. No") {
		t.Fatalf("fixture stripANSICore lost word spacing: %q", want)
	}
	if _, ok := detectClaudeTUIApproval(want); !ok {
		t.Fatalf("detector did not fire on un-split fixture: %q", want)
	}

	for i := 0; i <= len(raw); i++ {
		clean1, p1 := stripANSIChunk(nil, raw[:i])
		clean2, p2 := stripANSIChunk(p1, raw[i:])
		if len(p2) != 0 {
			t.Fatalf("split at %d: leftover pending tail %q (stream ended complete)", i, p2)
		}
		got := clean1 + clean2
		if got != want {
			t.Fatalf("split at %d not invariant:\n got: %q\nwant: %q", i, got, want)
		}
		if _, ok := detectClaudeTUIApproval(got); !ok {
			t.Fatalf("split at %d: detector failed to fire on %q", i, got)
		}
	}
}

// TestStripANSI_DoesNotPanicOnRandomGarbage feeds malformed sequences
// to catch index-out-of-bounds in the manual parser. The function is
// allowed to produce nonsense output for nonsense input; it just can't
// crash.
func TestStripANSI_DoesNotPanicOnRandomGarbage(t *testing.T) {
	inputs := [][]byte{
		{0x1b},
		{0x1b, '['},
		{0x1b, '[', ';'},
		{0x1b, '['},                // CSI start, no terminator
		{0x1b, ']'},                // OSC start, no terminator
		{0x1b, ']', '0', ';', 'x'}, // OSC missing terminator
		{0x1b, 'P', 'a'},           // DCS missing terminator
		{0xff, 0xfe, 0xfd},         // raw garbage bytes
	}
	for _, in := range inputs {
		_ = stripANSI(in)
	}
}
