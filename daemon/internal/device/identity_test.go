// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package device

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestLoadOrCreateStoresPrivateKeyOutsideIdentityFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.json")

	id, err := LoadOrCreate(path, "Test Daemon")
	if err != nil {
		if isUnavailableKeyringError(err) {
			t.Skipf("secure keyring unavailable in this environment: %v", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = keyring.Delete(keyringService, keyringUsername(id.DeviceID))
	})

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private_key") {
		t.Fatalf("identity file leaked private key: %s", raw)
	}
	priv, err := id.PrivateKeyBytes()
	if err != nil {
		t.Fatal(err)
	}
	if len(priv) == 0 {
		t.Fatal("expected private key bytes from secure storage")
	}
}

func TestStableComputerIdentitySurvivesDaemonIdentityRecreate(t *testing.T) {
	t.Setenv("POCKLY_ALLOW_PLAINTEXT_KEY", "1")
	dir := t.TempDir()
	devicePath := filepath.Join(dir, "device.json")

	first, err := LoadOrCreate(devicePath, "Test Daemon")
	if err != nil {
		t.Fatal(err)
	}
	if first.ComputerID == "" || first.ComputerPublicKey == "" {
		t.Fatalf("missing stable computer identity: %+v", first)
	}
	if first.MachineFingerprint == "" {
		t.Fatalf("missing machine fingerprint: %+v", first)
	}
	firstDeviceID := first.DeviceID
	if _, err := first.ComputerPrivateKeyBytes(); err != nil {
		t.Fatalf("computer private key should be readable in plaintext fallback: %v", err)
	}

	if err := os.Remove(devicePath); err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreate(devicePath, "Test Daemon")
	if err != nil {
		t.Fatal(err)
	}
	if second.DeviceID == firstDeviceID {
		t.Fatalf("expected daemon device_id to be recreated after deleting device.json")
	}
	if second.MachineFingerprint != first.MachineFingerprint {
		t.Fatalf("machine fingerprint changed after daemon identity recreate: first=%q second=%q", first.MachineFingerprint, second.MachineFingerprint)
	}
	if second.ComputerID != first.ComputerID || second.ComputerPublicKey != first.ComputerPublicKey {
		t.Fatalf("stable computer identity changed: first=%+v second=%+v", first, second)
	}
	if sig, err := second.SignComputerBinding(); err != nil || sig == "" {
		t.Fatalf("computer binding signature failed: sig=%q err=%v", sig, err)
	}
}

// TestResolveHostnameFrom exercises the testable seam of resolveHostname
// against the matrix of (os.Hostname result, error, GOOS) combinations
// that motivate the COMPUTERNAME fallback. Pre-fix, a Windows install
// that returned an empty hostname propagated as empty all the way to
// Nexus' device row, causing the web app's dropdown to fall back to
// displaying the raw device_id (e.g. "01ZnxSj01468764").
func TestResolveHostnameFrom(t *testing.T) {
	cases := []struct {
		name     string
		baseHost string
		baseErr  error
		envVal   string
		goos     string
		want     string
	}{
		{
			name:     "happy path: os.Hostname wins on any platform",
			baseHost: "my-mac.local",
			envVal:   "SHOULD-NOT-USE",
			goos:     "darwin",
			want:     "my-mac.local",
		},
		{
			name:     "windows: empty base falls back to COMPUTERNAME",
			baseHost: "",
			envVal:   "DESKTOP-ABC123",
			goos:     "windows",
			want:     "DESKTOP-ABC123",
		},
		{
			name:     "windows: os.Hostname errored, COMPUTERNAME still wins",
			baseHost: "",
			baseErr:  errors.New("syscall failed"),
			envVal:   "DESKTOP-XYZ",
			goos:     "windows",
			want:     "DESKTOP-XYZ",
		},
		{
			name:     "linux: no COMPUTERNAME fallback when base is empty",
			baseHost: "",
			envVal:   "SHOULD-NOT-USE",
			goos:     "linux",
			want:     "",
		},
		{
			name:     "windows: both sources empty stays empty",
			baseHost: "",
			envVal:   "",
			goos:     "windows",
			want:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveHostnameFrom(tc.baseHost, tc.baseErr, func(string) string { return tc.envVal }, tc.goos)
			if got != tc.want {
				t.Fatalf("resolveHostnameFrom(%q, %v, env=%q, %q) = %q, want %q", tc.baseHost, tc.baseErr, tc.envVal, tc.goos, got, tc.want)
			}
		})
	}
}

func isUnavailableKeyringError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "org.freedesktop.secrets") ||
		strings.Contains(msg, "secret service") ||
		strings.Contains(msg, "dbus") ||
		strings.Contains(msg, "keyring unavailable")
}
