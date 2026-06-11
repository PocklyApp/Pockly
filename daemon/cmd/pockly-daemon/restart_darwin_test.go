//go:build darwin

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"
)

func TestDarwinReloadCommandClearsDisabledOverride(t *testing.T) {
	cmd := reloadCommand()
	if !strings.Contains(cmd, "launchctl enable gui/$(id -u)/com.pockly.daemon") {
		t.Fatalf("reload command must clear launchd disabled override before restart: %q", cmd)
	}
	if !strings.Contains(cmd, "launchctl kickstart -k gui/$(id -u)/com.pockly.daemon") {
		t.Fatalf("reload command must still restart the LaunchAgent: %q", cmd)
	}
}
