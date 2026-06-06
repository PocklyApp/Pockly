//go:build windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"os/exec"
)

func forwardSignalToProcess(cmd *exec.Cmd, sig os.Signal) error {
	return cmd.Process.Signal(sig)
}
