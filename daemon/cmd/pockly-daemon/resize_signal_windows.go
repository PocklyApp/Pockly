//go:build windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import "os"

func terminalResizeSignals() []os.Signal {
	return nil
}
