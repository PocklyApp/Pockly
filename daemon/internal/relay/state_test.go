// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package relay

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestSaveAndLoadState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay-state.json")
	want := State{
		RelayURL:           "https://pocklyapp.test",
		DaemonDeviceID:     "dd_123",
		DeviceAccessToken:  "at_123",
		DeviceRefreshToken: "rt_123",
		LastPairedAt:       time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC),
	}

	if err := SaveState(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadState(path)
	if err != nil {
		t.Fatal(err)
	}

	if got != want {
		t.Fatalf("state mismatch\ngot:  %+v\nwant: %+v", got, want)
	}
	// Windows doesn't honor POSIX file-mode bits via os.WriteFile;
	// the file reads back as 666 even when we passed 0600. Access
	// control on Windows happens via NTFS ACLs (W3 hardening). The
	// SaveState content + roundtrip parity above is the part that
	// matters cross-platform; the mode bit check is POSIX-only.
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
}
