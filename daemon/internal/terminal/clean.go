// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import "regexp"

var ansiRE = regexp.MustCompile(`\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]`)

func CleanOutput(value string) string {
	value = ansiRE.ReplaceAllString(value, "")
	out := make([]rune, 0, len(value))
	for _, r := range value {
		switch r {
		case '\r':
			if len(out) == 0 || out[len(out)-1] != '\n' {
				out = append(out, '\n')
			}
		case '\n', '\t':
			out = append(out, r)
		default:
			if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
				continue
			}
			out = append(out, r)
		}
	}
	return string(out)
}
