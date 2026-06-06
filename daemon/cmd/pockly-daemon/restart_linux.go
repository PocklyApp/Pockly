//go:build linux

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// reloadCommandPlatform returns the shell command for Linux. The
// daemon's runSetup installs a systemd --user unit, so the canonical
// restart goes through systemctl. We include a kill-by-pgrep fallback
// for non-systemd Linux installs.
func reloadCommandPlatform() string {
	return "systemctl --user restart pockly-daemon  # or kill -HUP $(pgrep pockly-daemon)"
}

// reloadDaemonProcessPlatform attempts a systemctl --user restart
// (matching the unit installed by installSystemdUserService). If
// systemctl isn't on PATH (containers, minimal distros) we report
// that to the caller so it can fall back to printing the manual
// command instead of silently doing nothing.
func reloadDaemonProcessPlatform() error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return fmt.Errorf("systemctl not found; restart pockly-daemon manually: %w", err)
	}
	cmd := exec.Command("systemctl", "--user", "restart", "pockly-daemon")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl --user restart pockly-daemon: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}
