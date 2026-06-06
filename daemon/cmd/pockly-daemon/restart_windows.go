//go:build windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// reloadCommandPlatform: Windows hint. Scheduled task `PocklyDaemon`
// is what installWindowsScheduledTask creates; /End + /Run is the
// equivalent of macOS launchctl kickstart -k.
func reloadCommandPlatform() string {
	return `schtasks /End /TN PocklyDaemon & schtasks /Run /TN PocklyDaemon  (PowerShell users: same, no quoting needed)`
}

// reloadDaemonProcessPlatform restarts the daemon on Windows. We use
// the scheduled task `PocklyDaemon` (installed by
// installWindowsScheduledTask). Sequence:
//   1. schtasks /End — terminates the running instance (which is us)
//   2. schtasks /Run — launches a fresh instance from the registered
//      task action, which now resolves to the just-replaced binary.
//
// We start `/End` in the background and exit; the OS handles the
// re-launch via the scheduled task. We can't wait for /End to return
// because it would kill us synchronously and the /Run command would
// never queue.
//
// An alternative would be to spawn a detached child process directly
// + os.Exit(0). That works but skips the scheduled task plumbing,
// which means the auto-on-logon behavior would be intact for the
// next session but the current /End is harder to detect (no service
// abstraction). Going through schtasks keeps the daemon state model
// consistent with how it was first installed.
func reloadDaemonProcessPlatform() error {
	if _, err := exec.LookPath("schtasks.exe"); err != nil {
		return fmt.Errorf("schtasks not found; restart pockly-daemon manually: %w", err)
	}
	// Pre-verify the task exists. If runSetup never installed it
	// (manual install via zip), we can't auto-restart — fall back to
	// telling the caller so the human gets a useful message.
	if err := exec.Command("schtasks.exe", "/Query", "/TN", "PocklyDaemon").Run(); err != nil {
		return fmt.Errorf("scheduled task PocklyDaemon not registered; reinstall with `pockly-daemon setup` or restart manually: %w", err)
	}
	// Detach a child that waits a moment, then re-runs the task. We
	// exit immediately after spawning so schtasks /End can clean us
	// up before the child fires /Run.
	relauncher := exec.Command("cmd.exe", "/c", "ping -n 2 127.0.0.1 >nul & schtasks /Run /TN PocklyDaemon")
	relauncher.Stdout = nil
	relauncher.Stderr = nil
	if err := relauncher.Start(); err != nil {
		return fmt.Errorf("spawn relauncher: %w", err)
	}
	// Fire-and-forget: terminate ourselves via /End. The relauncher
	// child survives because cmd.exe was spawned independent of our
	// process group.
	endCmd := exec.Command("schtasks.exe", "/End", "/TN", "PocklyDaemon")
	out, err := endCmd.CombinedOutput()
	if err != nil {
		// /End failure isn't fatal — exit gracefully and let the
		// relauncher /Run start a fresh instance. Worst case the user
		// has two running daemons briefly; the scheduled task's
		// "InstancesPolicy: 2 (do not start new instance)" prevents
		// double-binding the relay socket.
		fmt.Fprintf(os.Stderr, "schtasks /End warning: %v (output: %s)\n", err, strings.TrimSpace(string(out)))
	}
	// Exit cleanly so /End and the relauncher can complete their
	// work without us in the way.
	os.Exit(0)
	return nil // unreachable
}
