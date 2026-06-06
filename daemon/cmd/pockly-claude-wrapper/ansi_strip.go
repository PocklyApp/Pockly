// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import "bytes"

// ansiCarryLimit caps how many trailing bytes the permission watcher will hold
// back waiting for a split ANSI escape to complete on the next PTY read. The
// escapes we care about (CHA, SGR colors, cursor moves, SS3) are far shorter;
// a longer unterminated sequence (rare — e.g. a giant OSC title split across
// reads) is let through rather than buffered unboundedly.
const ansiCarryLimit = 128

// incompleteTailLen reports how many trailing bytes of b are an INCOMPLETE ANSI
// escape sequence OR an incomplete trailing UTF-8 rune — i.e. bytes that must be
// carried to the next chunk instead of stripped now. PTY reads land on 4096-byte
// boundaries that routinely split an escape ("\x1b[" ends one read, "5G" starts
// the next) or a multi-byte rune; stripANSI is stateless and per-chunk, so
// without carrying the tail the broken trailer ("5G", a replacement char) leaks
// into the detection buffer and breaks the literal-space permission matching.
// Stateless: only inspects the tail.
func incompleteTailLen(b []byte) int {
	n := len(b)
	if n == 0 {
		return 0
	}
	// Incomplete trailing escape: walk back to the last ESC within the carry
	// window; if the sequence from there isn't terminated yet, hold it.
	lo := n - ansiCarryLimit
	if lo < 0 {
		lo = 0
	}
	for k := n - 1; k >= lo; k-- {
		if b[k] != 0x1b {
			continue
		}
		if escapeIncomplete(b[k:]) {
			return n - k
		}
		break // the last ESC in range is already complete → nothing to hold
	}
	// A trailing CR may be the first half of a "\r\n" split across reads; hold
	// it so stripANSI's CR→LF collapse stays atomic (otherwise the split emits
	// two newlines instead of one).
	if b[n-1] == '\r' {
		return 1
	}
	// Incomplete trailing UTF-8 multi-byte rune.
	return incompleteUTF8TailLen(b)
}

// escapeIncomplete reports whether seq (which starts with ESC, 0x1b) is an
// escape sequence that has NOT yet received its terminating byte(s).
func escapeIncomplete(seq []byte) bool {
	if len(seq) < 2 {
		return true // bare trailing ESC
	}
	switch seq[1] {
	case '[': // CSI: params (0x30-0x3f), intermediates (0x20-0x2f), final (0x40-0x7e)
		j := 2
		for j < len(seq) && seq[j] >= 0x30 && seq[j] <= 0x3f {
			j++
		}
		for j < len(seq) && seq[j] >= 0x20 && seq[j] <= 0x2f {
			j++
		}
		return !(j < len(seq) && seq[j] >= 0x40 && seq[j] <= 0x7e)
	case ']', 'P', 'X', '^', '_': // OSC / DCS / SOS / PM / APC: until BEL or ST (ESC\)
		for j := 2; j < len(seq); j++ {
			if seq[j] == 0x07 {
				return false
			}
			if seq[j] == 0x1b && j+1 < len(seq) && seq[j+1] == '\\' {
				return false
			}
		}
		return true
	default:
		return false // two-byte escape (ESC =, ESC c, …): complete once the 2nd byte is present
	}
}

// incompleteUTF8TailLen returns the number of trailing bytes of b that form an
// incomplete UTF-8 multi-byte rune (a leader byte without enough continuation
// bytes yet), or 0 if the tail ends on a complete rune / ASCII byte.
func incompleteUTF8TailLen(b []byte) int {
	n := len(b)
	for i := 1; i <= 4 && i <= n; i++ {
		c := b[n-i]
		if c < 0x80 {
			return 0 // ASCII byte → tail is complete
		}
		if c >= 0xc0 { // leader byte
			size := utf8LeadLen(c)
			if size == 0 {
				return 0 // invalid leader → don't hold it back
			}
			if i < size {
				return i // not all continuation bytes arrived yet → hold them
			}
			return 0 // full rune present
		}
		// continuation byte (0x80-0xbf) → keep walking back to its leader
	}
	return 0
}

// stripANSIChunk is the stateful, split-safe wrapper around stripANSI used on
// the PTY read stream. It prepends `pending` (the incomplete tail held back
// from the previous read), holds back this combined buffer's own incomplete
// trailing escape / UTF-8 rune, strips the rest, and returns the cleaned text
// plus the new tail to pass into the next call. Feeding a byte stream through
// stripANSIChunk in ANY chunking is invariant — it yields the same cleaned
// output as a single stripANSI over the whole stream (modulo the final tail,
// which flushes once the sequence completes).
func stripANSIChunk(pending, chunk []byte) (string, []byte) {
	combined := chunk
	if len(pending) > 0 {
		combined = append(append([]byte(nil), pending...), chunk...)
	}
	var tail []byte
	if hold := incompleteTailLen(combined); hold > 0 {
		tail = append([]byte(nil), combined[len(combined)-hold:]...)
		combined = combined[:len(combined)-hold]
	}
	return string(stripANSICore(combined)), tail
}

// utf8LeadLen returns the total byte length encoded by a UTF-8 leader byte, or
// 0 if lead is not a valid leader.
func utf8LeadLen(lead byte) int {
	switch {
	case lead < 0xc0:
		return 0
	case lead < 0xe0:
		return 2
	case lead < 0xf0:
		return 3
	case lead < 0xf8:
		return 4
	default:
		return 0
	}
}

// stripANSI removes ANSI escape sequences (CSI / OSC / SS3) plus
// stray C0 / DEL control bytes from a chunk of bytes read off the PTY
// before we emit it as a text_delta over the wire. Without this, web
// clients receive Claude's full TUI re-paint stream — cursor moves,
// color codes, and statusLine repaints — interleaved with the actual
// assistant text, which renders as garbage in the chat view.
//
// We do the strip BEFORE Emit so every downstream consumer (today's
// web, tomorrow's mobile / telemetry) gets clean text without each
// having to re-implement an ANSI parser. The terminal that the user
// actually sees still gets the raw bytes — those go to os.Stdout
// via writeStdout, untouched.
//
// Trade-offs:
//   - We don't try to RENDER the ANSI (no xterm.js / vt100 state).
//     Streaming preview loses cursor-positioned overwrites; the final
//     turn always arrives clean via the jsonl-based sync path. This
//     is the right call for a chat UI — terminal emulation in a phone
//     browser is the wrong abstraction.
//   - Chunk boundaries can split an escape sequence (e.g. ESC arrives
//     in one read, "[38;5;9m" in the next). When that happens this
//     pass leaves the broken trailer in the stream; it's better than
//     bytes pretending to be text but visibly wrong. A future buffered
//     parser could carry the dangling ESC across reads.
func stripANSI(b []byte) []byte {
	// Trailing-whitespace trim is correct for a whole-buffer strip, but WRONG
	// across chunk boundaries: a CHA-emitted word-separator space landing at the
	// end of a read ("to\x1b[17G" → "to ") would be trimmed and the next chunk
	// would join as "toproceed". The chunked path (stripANSIChunk) uses
	// stripANSICore (no trim) so boundary spaces survive; only callers stripping
	// a complete buffer want the trim.
	return bytes.TrimRight(stripANSICore(b), " \t\n")
}

func stripANSICore(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	out := make([]byte, 0, len(b))
	i := 0
	for i < len(b) {
		ch := b[i]
		switch {
		case ch == 0x1b: // ESC
			// Look at the byte after ESC to dispatch.
			if i+1 >= len(b) {
				// Trailing ESC at chunk boundary; drop it. The next
				// read's regex/parser will see a stray "[xxx" and
				// have to live with it — see trade-off note above.
				return out
			}
			next := b[i+1]
			switch next {
			case '[':
				// CSI: ESC [ params (0x30-0x3f) intermediates
				// (0x20-0x2f) final (0x40-0x7e). Skip to and including
				// the final byte.
				j := i + 2
				for j < len(b) && b[j] >= 0x30 && b[j] <= 0x3f {
					j++ // params
				}
				for j < len(b) && b[j] >= 0x20 && b[j] <= 0x2f {
					j++ // intermediates
				}
				if j < len(b) && b[j] >= 0x40 && b[j] <= 0x7e {
					// Claude's TUI lays out a line by jumping the cursor to
					// each word's column with CHA (CSI n G) / cursor-forward
					// (CSI n C) instead of writing literal spaces — e.g.
					// "Do\x1b[5Gyou\x1b[9Gwant". Dropping the escape outright
					// concatenated the words ("Doyouwant"), which broke the
					// permission-prompt detector's literal-space matches
					// ("Do you want to ", "1. Yes", "3. No") so PTY approvals
					// never reached the web. Emit a single space for these
					// horizontal-positioning finals to put the word break back
					// (one CSI per gap → single space). Other finals (colors,
					// erase, vertical moves) are still dropped.
					if final := b[j]; final == 'G' || final == 'C' {
						out = append(out, ' ')
					}
					j++ // final byte
				}
				i = j
			case ']':
				// OSC: ESC ] ... terminator (BEL=0x07 or ESC\ ST).
				j := i + 2
				for j < len(b) {
					if b[j] == 0x07 {
						j++
						break
					}
					if b[j] == 0x1b && j+1 < len(b) && b[j+1] == '\\' {
						j += 2
						break
					}
					j++
				}
				i = j
			case 'P', 'X', '^', '_':
				// DCS / SOS / PM / APC — terminated by ST (ESC\) or
				// BEL. Same scanner as OSC.
				j := i + 2
				for j < len(b) {
					if b[j] == 0x07 {
						j++
						break
					}
					if b[j] == 0x1b && j+1 < len(b) && b[j+1] == '\\' {
						j += 2
						break
					}
					j++
				}
				i = j
			default:
				// Two-byte escape (e.g. ESC =, ESC >, ESC c). Drop both.
				i += 2
			}
		case ch == '\r':
			// CR alone is overstrike noise on TTYs but in a chat
			// transcript it's almost always followed by LF — collapse
			// to LF to avoid weird line behavior in the web view.
			// (compactTerminalPayload also normalizes \r\n but kill
			// lone \r here to be defensive.)
			out = append(out, '\n')
			i++
			if i < len(b) && b[i] == '\n' {
				i++ // already emitted \n; skip the LF
			}
		case ch < 0x20 && ch != '\n' && ch != '\t':
			// Stray C0 control characters (\b \v \f etc.). Skip.
			// We keep \n and \t because they carry semantic value
			// for chat-style rendering.
			i++
		case ch == 0x7f:
			// DEL: drop.
			i++
		default:
			out = append(out, ch)
			i++
		}
	}
	return out
}
