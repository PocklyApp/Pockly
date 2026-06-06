// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/version"
)

// `pockly-daemon update` brings the local install up to the latest tagged
// daemon binary published on cdn.pocklyapp.com. The flow mirrors what the
// install.sh script does on first install — but without sudo (assumes the
// existing install lives somewhere writable, which is the only supported
// layout going forward) and with explicit version pinning support.
//
// Why a Go-internal subcommand instead of "just run install.sh again":
//   - install.sh runs `pockly-daemon setup` at the end. For an existing,
//     paired install that re-runs setup unnecessarily and asks the user to
//     re-authorize in the browser.
//   - install.sh's default INSTALL_DIR is /usr/local/bin which triggers
//     sudo on most setups. Users hit a password prompt and bail.
//   - In-process update can short-circuit when the daemon is already on
//     the latest tag (the most common state) without touching the FS.
//   - In-process update can detect when launchd needs a reload and do it
//     (or print the one-line command for the user).
//
// Layout we expect (matches what we ship via install.sh + tarballs):
//   ~/.local/bin/pockly-daemon          (this binary)
//   ~/.local/bin/pockly-claude-wrapper  (companion)
//
// Update writes new binaries to the same paths via os.Rename (atomic on
// the same filesystem), then either reloads launchd or prints the
// reload command depending on flags.
const (
	updateBaseURL   = "https://cdn.pocklyapp.com/pockly-daemon"
	updateUserAgent = "pockly-daemon-updater"
	// downloadTimeout caps the tarball fetch at 5 minutes — a 10 MB
	// binary on a 1 Mbps link is ~80 s, so 5 min covers worst-case
	// rural cellular while still failing closed on a stalled mirror.
	downloadTimeout = 5 * time.Minute
	// v0.1.32 is the first release that exists primarily to exercise
	// the web-triggered remote update path end-to-end (web ▶ Update
	// remotely → relay /api/hosts/{id}/update → daemon control WS
	// → PerformUpdate → launchctl kickstart). Functionally identical
	// to v0.1.31; tagging here so future readers don't wonder why a
	// trivial-looking commit got its own release. — author note
)

func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	checkOnly := fs.Bool("check", false, "only check for new versions; don't download or install")
	targetVersion := fs.String("to", "", "install this specific version (e.g. v0.1.29) instead of latest")
	noRestart := fs.Bool("no-restart", false, "don't restart the daemon process after install; you reload manually")
	binDir := fs.String("bin-dir", "", "directory holding pockly-daemon (defaults to dirname of the running binary)")
	verbose := fs.Bool("v", false, "print extra diagnostics during fetch + install")
	if err := fs.Parse(args); err != nil {
		return err
	}

	currentBinary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running binary: %w", err)
	}
	resolvedBinary, err := filepath.EvalSymlinks(currentBinary)
	if err == nil {
		currentBinary = resolvedBinary
	}
	installDir := *binDir
	if installDir == "" {
		installDir = filepath.Dir(currentBinary)
	}

	channel := *targetVersion
	if channel == "" {
		channel = "latest"
	}
	// checksums.txt is the source of truth for "what version is in this
	// channel, and what should the tarball sha256 be." We parse it for
	// both: the version label (it's in the filename) and the integrity
	// digest we'll verify after download.
	manifest, err := fetchChecksumManifest(channel, *verbose)
	if err != nil {
		return fmt.Errorf("check %s channel: %w", channel, err)
	}
	platformAsset, err := pickPlatformAsset(manifest)
	if err != nil {
		return err
	}
	currentVer := "v" + version.Version
	if *verbose {
		fmt.Fprintf(os.Stderr, "current: %s\nremote:  %s (%s)\n", currentVer, platformAsset.Version, platformAsset.Filename)
	}
	if !isNewerOrPinned(currentVer, platformAsset.Version, *targetVersion) {
		fmt.Printf("pockly-daemon is up to date (%s)\n", currentVer)
		return nil
	}

	if *checkOnly {
		fmt.Printf("update available: %s → %s\n", currentVer, platformAsset.Version)
		fmt.Printf("install: pockly-daemon update%s\n", pinFlagFor(*targetVersion))
		return nil
	}

	fmt.Printf("downloading pockly-daemon %s for %s/%s\n", platformAsset.Version, runtime.GOOS, runtime.GOARCH)
	tmpDir, err := os.MkdirTemp("", "pockly-update-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	tarballPath := filepath.Join(tmpDir, platformAsset.Filename)
	if err := downloadTarball(platformAsset, tarballPath, *verbose); err != nil {
		return err
	}
	if err := verifySha256(tarballPath, platformAsset.SHA256); err != nil {
		return fmt.Errorf("verify checksum: %w", err)
	}

	extractDir := filepath.Join(tmpDir, "extract")
	if err := extractTarballGz(tarballPath, extractDir); err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	if err := installFromExtract(extractDir, installDir); err != nil {
		return fmt.Errorf("install: %w", err)
	}
	fmt.Printf("installed pockly-daemon %s into %s\n", platformAsset.Version, installDir)

	if *noRestart {
		fmt.Println("--no-restart set; reload the daemon when ready:")
		fmt.Println("  " + reloadCommand())
		return nil
	}
	if err := reloadDaemonProcess(); err != nil {
		// Don't fail the update — the binary IS installed; just tell the user
		// how to finish manually. Common cause is non-Mac systems where we
		// haven't implemented the reload yet.
		fmt.Fprintf(os.Stderr, "warning: failed to auto-reload daemon: %v\n", err)
		fmt.Fprintf(os.Stderr, "reload manually:\n  %s\n", reloadCommand())
		return nil
	}
	fmt.Println("daemon reloaded; new version is now serving.")
	return nil
}

// PlatformAsset is one row of checksums.txt resolved for the current
// runtime — version label, expected SHA, and the resolved download URL.
type PlatformAsset struct {
	Version  string
	Filename string
	SHA256   string
	URL      string
}

// PerformUpdateOptions parameterizes PerformUpdate so non-CLI callers
// (currently the control-WS handler that receives remote update_requests
// from the relay) can drive the same code path the `pockly-daemon
// update` subcommand uses.
type PerformUpdateOptions struct {
	// TargetVersion ("v0.1.31") pins a specific release. Empty means
	// "track latest." Pinned mode forces install even if the literal
	// matches current (lets the user re-install or downgrade).
	TargetVersion string
	// InstallDir defaults to dirname of the running binary. Override
	// only in tests.
	InstallDir string
	// Restart, when true, calls reloadDaemonProcess() after install.
	// CLI defaults to true; the WS handler also sets true (the whole
	// point of remote-trigger is to take effect without user action).
	Restart bool
}

// PerformUpdateResult is what PerformUpdate returns on success. Captures
// what changed so callers can log it / report it back over the WS.
type PerformUpdateResult struct {
	PreviousVersion string
	NewVersion      string
	InstalledPath   string
	Restarted       bool
	Skipped         bool // true when already on the requested version
}

// PerformUpdate runs the full download → verify → install → reload
// sequence the `pockly-daemon update` CLI uses, but without flag
// parsing or stdout printing — suitable for invocation from the
// control-WS handler when the relay forwards a remote update request.
// All logs go through the standard log package; callers add their own
// envelope (request_id, etc).
func PerformUpdate(opts PerformUpdateOptions) (PerformUpdateResult, error) {
	res := PerformUpdateResult{}

	currentBinary, err := os.Executable()
	if err != nil {
		return res, fmt.Errorf("locate running binary: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(currentBinary); err == nil {
		currentBinary = resolved
	}
	installDir := opts.InstallDir
	if installDir == "" {
		installDir = filepath.Dir(currentBinary)
	}

	channel := opts.TargetVersion
	if channel == "" {
		channel = "latest"
	}
	manifest, err := fetchChecksumManifest(channel, false)
	if err != nil {
		return res, fmt.Errorf("check %s channel: %w", channel, err)
	}
	asset, err := pickPlatformAsset(manifest)
	if err != nil {
		return res, err
	}
	res.PreviousVersion = "v" + version.Version
	res.NewVersion = asset.Version
	if !isNewerOrPinned(res.PreviousVersion, asset.Version, opts.TargetVersion) {
		res.Skipped = true
		return res, nil
	}

	tmpDir, err := os.MkdirTemp("", "pockly-update-*")
	if err != nil {
		return res, err
	}
	defer os.RemoveAll(tmpDir)

	tarballPath := filepath.Join(tmpDir, asset.Filename)
	if err := downloadTarball(asset, tarballPath, false); err != nil {
		return res, err
	}
	if err := verifySha256(tarballPath, asset.SHA256); err != nil {
		return res, fmt.Errorf("verify checksum: %w", err)
	}
	extractDir := filepath.Join(tmpDir, "extract")
	if err := extractTarballGz(tarballPath, extractDir); err != nil {
		return res, fmt.Errorf("extract: %w", err)
	}
	if err := installFromExtract(extractDir, installDir); err != nil {
		return res, fmt.Errorf("install: %w", err)
	}
	res.InstalledPath = installDir

	if opts.Restart {
		if err := reloadDaemonProcess(); err != nil {
			return res, fmt.Errorf("install succeeded but reload failed: %w", err)
		}
		res.Restarted = true
	}
	return res, nil
}

// versionedManifest captures everything we learn from /channel/checksums.txt.
// Filenames are like "pockly-daemon_v0.1.29_darwin_arm64.tar.gz"; we parse
// (version, os, arch) out so callers don't redo the substring math.
type versionedManifest struct {
	channel string // "latest" or "vX.Y.Z"
	entries []manifestEntry
}

type manifestEntry struct {
	sha256   string
	filename string
	version  string
	goos     string
	goarch   string
	ext      string // "tar.gz" or "zip"
}

func fetchChecksumManifest(channel string, verbose bool) (versionedManifest, error) {
	url := fmt.Sprintf("%s/%s/checksums.txt", strings.TrimRight(updateBaseURL, "/"), channel)
	if verbose {
		fmt.Fprintf(os.Stderr, "GET %s\n", url)
	}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", updateUserAgent)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return versionedManifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return versionedManifest{}, fmt.Errorf("checksums.txt: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return versionedManifest{}, err
	}
	return parseChecksumManifest(channel, string(body))
}

func parseChecksumManifest(channel string, body string) (versionedManifest, error) {
	var entries []manifestEntry
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Lines look like:
		//   <sha256>  pockly-daemon_v0.1.29_darwin_arm64.tar.gz
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		sha, name := fields[0], fields[1]
		if len(sha) != 64 {
			continue
		}
		entry, ok := parseAssetFilename(name)
		if !ok {
			continue
		}
		entry.sha256 = sha
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return versionedManifest{}, errors.New("no usable entries in checksums.txt")
	}
	return versionedManifest{channel: channel, entries: entries}, nil
}

// parseAssetFilename pulls (version, os, arch, ext) out of names like:
//
//	pockly-daemon_v0.1.29_darwin_arm64.tar.gz
//	pockly-daemon_v0.1.29_windows_amd64.zip
func parseAssetFilename(name string) (manifestEntry, bool) {
	prefix := "pockly-daemon_"
	if !strings.HasPrefix(name, prefix) {
		return manifestEntry{}, false
	}
	rest := strings.TrimPrefix(name, prefix)
	var ext string
	switch {
	case strings.HasSuffix(rest, ".tar.gz"):
		ext = "tar.gz"
		rest = strings.TrimSuffix(rest, ".tar.gz")
	case strings.HasSuffix(rest, ".zip"):
		ext = "zip"
		rest = strings.TrimSuffix(rest, ".zip")
	default:
		return manifestEntry{}, false
	}
	// rest = "v0.1.29_darwin_arm64"
	parts := strings.Split(rest, "_")
	if len(parts) != 3 {
		return manifestEntry{}, false
	}
	return manifestEntry{
		filename: name,
		version:  parts[0],
		goos:     parts[1],
		goarch:   parts[2],
		ext:      ext,
	}, true
}

func pickPlatformAsset(m versionedManifest) (PlatformAsset, error) {
	for _, entry := range m.entries {
		if entry.goos == runtime.GOOS && entry.goarch == runtime.GOARCH && entry.ext == "tar.gz" {
			return PlatformAsset{
				Version:  entry.version,
				Filename: entry.filename,
				SHA256:   entry.sha256,
				URL:      fmt.Sprintf("%s/%s/%s", strings.TrimRight(updateBaseURL, "/"), m.channel, entry.filename),
			}, nil
		}
	}
	return PlatformAsset{}, fmt.Errorf("no asset for %s/%s in %s channel", runtime.GOOS, runtime.GOARCH, m.channel)
}

// isNewerOrPinned returns true when we should install. We DON'T parse
// semver because pinned mode ("user said --to v0.1.20") should let the
// user downgrade or sidegrade freely. For unpinned (latest) mode we
// only install if the remote version literal differs from current —
// equality means we're already on it.
func isNewerOrPinned(currentLabel, remoteLabel, pinned string) bool {
	if pinned != "" {
		return true
	}
	// Both labels are "vX.Y.Z" strings (we normalize current to that
	// shape at the callsite). String inequality is the right signal:
	// install.sh only ever publishes monotonically increasing tags, so
	// "different" basically means "newer."
	return strings.TrimSpace(currentLabel) != strings.TrimSpace(remoteLabel)
}

func pinFlagFor(pinned string) string {
	if pinned == "" {
		return ""
	}
	return " --to " + pinned
}

func downloadTarball(asset PlatformAsset, dest string, verbose bool) error {
	client := &http.Client{Timeout: downloadTimeout}
	if verbose {
		fmt.Fprintf(os.Stderr, "GET %s\n", asset.URL)
	}
	req, _ := http.NewRequest("GET", asset.URL, nil)
	req.Header.Set("User-Agent", updateUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch tarball: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch tarball: %s", resp.Status)
	}
	out, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create tmp file: %w", err)
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return fmt.Errorf("write tarball: %w", err)
	}
	return nil
}

func verifySha256(path, expected string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("sha256 mismatch (expected %s, got %s)", expected, actual)
	}
	return nil
}

func extractTarballGz(tarballPath, destDir string) error {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	f, err := os.Open(tarballPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		// Defense against zip-slip: reject any entry whose cleaned path
		// escapes destDir.
		target := filepath.Join(destDir, hdr.Name)
		if !strings.HasPrefix(target, filepath.Clean(destDir)+string(os.PathSeparator)) && target != destDir {
			return fmt.Errorf("refusing to extract outside dest: %q", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			outFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(hdr.Mode)&0o777)
			if err != nil {
				return err
			}
			if _, err := io.Copy(outFile, tr); err != nil {
				outFile.Close()
				return err
			}
			outFile.Close()
		default:
			// Skip symlinks/devices/etc — our tarballs are flat binaries.
		}
	}
}

// installFromExtract takes the unpacked tarball directory (which contains
// exactly one subfolder pockly-daemon_<ver>_<os>_<arch>/) and atomically
// replaces the existing binaries in installDir. Uses Rename so the file
// switch is atomic; the running daemon process keeps using its in-memory
// text segment unaffected, but new exec calls (wrapper spawns, manual
// reload) pick up the new bits.
func installFromExtract(extractDir, installDir string) error {
	entries, err := os.ReadDir(extractDir)
	if err != nil {
		return err
	}
	var srcRoot string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "pockly-daemon_") {
			srcRoot = filepath.Join(extractDir, e.Name())
			break
		}
	}
	if srcRoot == "" {
		// Some tarballs flatten the top-level directory; fall back to
		// extractDir itself if pockly-daemon binary is right there.
		if _, err := os.Stat(filepath.Join(extractDir, "pockly-daemon")); err == nil {
			srcRoot = extractDir
		} else {
			return errors.New("could not find pockly-daemon_* subdir in extract output")
		}
	}
	for _, bin := range []string{"pockly-daemon", "pockly-claude-wrapper"} {
		src := filepath.Join(srcRoot, bin)
		if _, err := os.Stat(src); err != nil {
			if bin == "pockly-claude-wrapper" {
				// Wrapper is optional in some early-version tarballs.
				continue
			}
			return fmt.Errorf("missing %s in tarball: %w", bin, err)
		}
		dst := filepath.Join(installDir, bin)
		// Stage next to dst so Rename is same-filesystem atomic.
		staged := dst + ".upgrade.tmp"
		if err := copyFile(src, staged, 0o755); err != nil {
			return err
		}
		if err := os.Rename(staged, dst); err != nil {
			os.Remove(staged)
			return fmt.Errorf("replace %s: %w", dst, err)
		}
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// reloadCommand returns the platform-specific shell command the user
// should run to restart the daemon process. Printed when we can't (or
// shouldn't) do it automatically. Implementation per-OS lives in
// restart_{darwin,linux,windows}.go via reloadCommandPlatform.
func reloadCommand() string {
	return reloadCommandPlatform()
}

// reloadDaemonProcess best-effort restarts the running daemon so the
// new binary takes over. Per-OS implementation lives in
// restart_{darwin,linux,windows}.go:
//
//   - darwin   : launchctl kickstart -k (LaunchAgent re-launches us)
//   - linux    : systemctl --user restart pockly-daemon
//   - windows  : schtasks /End + detached /Run (Scheduled Task path)
//
// Any platform without restart_*.go gets a build error — intentional,
// so a new GOOS landing in Go ecosystem doesn't silently degrade to
// "auto-update succeeded but daemon stale".
func reloadDaemonProcess() error {
	return reloadDaemonProcessPlatform()
}
