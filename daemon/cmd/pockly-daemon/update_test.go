// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseAssetFilename(t *testing.T) {
	cases := []struct {
		in      string
		ok      bool
		version string
		goos    string
		goarch  string
		ext     string
	}{
		{"pockly-daemon_v0.1.29_darwin_arm64.tar.gz", true, "v0.1.29", "darwin", "arm64", "tar.gz"},
		{"pockly-daemon_v0.1.29_linux_amd64.tar.gz", true, "v0.1.29", "linux", "amd64", "tar.gz"},
		{"pockly-daemon_v0.1.29_windows_amd64.zip", true, "v0.1.29", "windows", "amd64", "zip"},
		// Non-matches we should silently skip (never crash):
		{"sha256sum.txt", false, "", "", "", ""},
		{"pockly-daemon_v0.1.29.tar.gz", false, "", "", "", ""},           // missing os_arch
		{"other-tool_v0.1.29_darwin_arm64.tar.gz", false, "", "", "", ""}, // different binary
		{"pockly-daemon_v0.1.29_darwin_arm64.rpm", false, "", "", "", ""}, // unknown ext
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := parseAssetFilename(tc.in)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !ok {
				return
			}
			if got.version != tc.version || got.goos != tc.goos || got.goarch != tc.goarch || got.ext != tc.ext {
				t.Fatalf("got %+v, want version=%s os=%s arch=%s ext=%s", got, tc.version, tc.goos, tc.goarch, tc.ext)
			}
		})
	}
}

func TestParseChecksumManifest(t *testing.T) {
	body := `# this is a comment that should be skipped
deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  pockly-daemon_v0.1.29_darwin_arm64.tar.gz
cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe  pockly-daemon_v0.1.29_linux_amd64.tar.gz
short  pockly-daemon_v0.1.29_windows_amd64.zip
malformed line without a hash
`
	manifest, err := parseChecksumManifest("latest", body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(manifest.entries) != 2 {
		t.Fatalf("expected 2 valid entries, got %d: %+v", len(manifest.entries), manifest.entries)
	}
	for _, e := range manifest.entries {
		if len(e.sha256) != 64 {
			t.Fatalf("entry %q has malformed sha: %q", e.filename, e.sha256)
		}
	}
}

func TestParseChecksumManifestRejectsEmpty(t *testing.T) {
	if _, err := parseChecksumManifest("latest", ""); err == nil {
		t.Fatal("empty body should error")
	}
}

func TestIsNewerOrPinned(t *testing.T) {
	cases := []struct {
		current  string
		remote   string
		pinned   string
		expected bool
	}{
		// Pinned mode: any non-empty pinned forces install (downgrade OK).
		{"v0.1.29", "v0.1.29", "v0.1.20", true}, // explicit downgrade
		{"v0.1.29", "v0.1.29", "v0.1.29", true}, // explicit reinstall
		// Unpinned: install only when literal labels differ.
		{"v0.1.28", "v0.1.29", "", true},
		{"v0.1.29", "v0.1.29", "", false},     // already on latest
		{"  v0.1.29  ", "v0.1.29", "", false}, // whitespace tolerated
	}
	for _, tc := range cases {
		name := tc.current + " vs " + tc.remote
		if tc.pinned != "" {
			name += " pinned=" + tc.pinned
		}
		t.Run(name, func(t *testing.T) {
			if got := isNewerOrPinned(tc.current, tc.remote, tc.pinned); got != tc.expected {
				t.Fatalf("got %v, want %v", got, tc.expected)
			}
		})
	}
}

func TestReloadCommandIsPlatformAware(t *testing.T) {
	// Just smoke-check the output isn't empty and looks shell-pasteable.
	// Case-insensitive substring match — `Pockly` (capital P) appears
	// in the Windows reload command (`schtasks /TN PocklyDaemon`),
	// and `kill` could be lowercased in some hypothetical future
	// platform.
	out := strings.ToLower(reloadCommand())
	if out == "" {
		t.Fatal("expected non-empty reload command")
	}
	// Recognized "this is plausibly a real reload command" verbs
	// across all platforms we support.
	verbs := []string{"pockly", "launchctl", "systemctl", "kill", "schtasks"}
	ok := false
	for _, v := range verbs {
		if strings.Contains(out, v) {
			ok = true
			break
		}
	}
	if !ok {
		t.Fatalf("reload command looks suspicious (no recognized verb): %q", out)
	}
}

func TestRepairPathShadowingRedirectsEarlierWritableBinary(t *testing.T) {
	root := t.TempDir()
	shadowDir := filepath.Join(root, "shadow")
	installDir := filepath.Join(root, "install")
	if err := os.MkdirAll(shadowDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(installDir, 0o755); err != nil {
		t.Fatal(err)
	}
	shadow := filepath.Join(shadowDir, "pockly-daemon")
	target := filepath.Join(installDir, "pockly-daemon")
	if err := os.WriteFile(shadow, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shadowDir+string(os.PathListSeparator)+installDir)

	if err := repairPathShadowing(target); err != nil {
		t.Fatalf("repairPathShadowing: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(shadow)
	if err != nil {
		t.Fatalf("shadow entry should be a valid symlink: %v", err)
	}
	targetResolved, _ := filepath.EvalSymlinks(target)
	if resolved != targetResolved {
		t.Fatalf("shadow resolved to %q, want %q", resolved, targetResolved)
	}
	matches, err := filepath.Glob(shadow + ".old.*")
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("backup count = %d, want 1", len(matches))
	}
}
