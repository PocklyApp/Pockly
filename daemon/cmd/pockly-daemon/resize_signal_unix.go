//go:build !windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"syscall"
)

func terminalResizeSignals() []os.Signal {
	return []os.Signal{syscall.SIGWINCH}
}
