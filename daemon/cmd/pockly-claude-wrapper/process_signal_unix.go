//go:build !windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func forwardSignalToProcess(cmd *exec.Cmd, sig os.Signal) error {
	if unixSig, ok := sig.(syscall.Signal); ok && cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, unixSig)
	}
	return cmd.Process.Signal(sig)
}
