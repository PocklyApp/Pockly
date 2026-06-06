//go:build darwin

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// reloadCommandPlatform returns the shell command that restarts the
// daemon on this platform. Printed when we choose NOT to auto-reload
// (e.g. dry-run path) so the user can do it manually.
func reloadCommandPlatform() string {
	return "launchctl kickstart -k gui/$(id -u)/com.pockly.daemon"
}

// reloadDaemonProcessPlatform performs the auto-reload. macOS path
// uses `launchctl kickstart -k` which gracefully terminates the
// current process and re-launches it from the plist's
// ProgramArguments (which point at the binary path we just
// replaced).
func reloadDaemonProcessPlatform() error {
	uid := os.Getuid()
	cmd := exec.Command("launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/com.pockly.daemon", uid))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl kickstart: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}
