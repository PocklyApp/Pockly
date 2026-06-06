// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	iofs "io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	sentinelStart     = "# >>> pockly remote-control (do not edit) >>>"
	sentinelEnd       = "# <<< pockly remote-control <<<"
	wrapperBinaryName = "pockly-claude-wrapper"
	// Must stay in sync with the daemon's --listen default (cmd/pockly-daemon/main.go)
	// and the wrapper's --daemon-url default (cmd/pockly-claude-wrapper/main.go).
	// The old 8948 default predated the listen-port consolidation and made the
	// preflight always report "daemon bridge: NOT reachable" even when daemon
	// was running fine — surfaced while smoke-testing the docker image.
	defaultDaemonBridge  = "http://127.0.0.1:8947"
	knownIssuesURL       = "https://github.com/PocklyApp/Pockly/daemon/issues"
	remoteControlStateFn = "remote-control.json"
)

type shellKind string

const (
	shellZsh        shellKind = "zsh"
	shellBash       shellKind = "bash"
	shellFish       shellKind = "fish"
	shellPowerShell shellKind = "powershell"
)

type shellTarget struct {
	Kind shellKind
	Path string
}

type rcRecord struct {
	Path  string    `json:"path"`
	Shell shellKind `json:"shell"`
}

type remoteControlState struct {
	EnabledAt      time.Time  `json:"enabled_at"`
	WrapperPath    string     `json:"wrapper_path"`
	WrapperVersion string     `json:"wrapper_version,omitempty"`
	RCFiles        []rcRecord `json:"rc_files"`
}

type preflightConflict struct {
	Path   string
	Reason string
}

type preflightResult struct {
	RealClaude      string
	Wrapper         string
	DaemonReachable bool
	DaemonError     string
	Shells          []shellTarget
	Conflicts       []preflightConflict
}

// --- subcommand entry points ---

// installRemoteControlBestEffort is the non-interactive sibling of
// runEnableRemoteControl, invoked at the tail of `pockly-daemon setup` so
// new users get the `claude` wrapper alias wired up without an extra
// manual step. It is intentionally quiet on the no-op path (already
// installed, no shells to modify) and prints a clear actionable line on
// real failure modes (conflicting alias, missing wrapper) so the user
// knows what to fix.
//
// We do NOT abort setup on failure here — pairing already succeeded and
// the user can still send/receive once they run enable-remote-control
// themselves. The only goal is to remove the "wait, why is web→terminal
// silently read-only after a clean install" footgun the review flagged.
func installRemoteControlBestEffort() {
	pf, err := runPreflight("", "auto")
	if err != nil {
		fmt.Println()
		fmt.Printf("⚠ Pockly couldn't wire up the `claude` wrapper automatically: %v\n", err)
		fmt.Println("  Run `pockly-daemon enable-remote-control` later to retry.")
		return
	}
	if pf.Wrapper == "" {
		fmt.Println()
		fmt.Println("⚠ Pockly couldn't locate `pockly-claude-wrapper`. Install it to ~/.local/bin")
		fmt.Println("  (or run `pockly-daemon enable-remote-control --wrapper <path>`) to enable")
		fmt.Println("  Web ↔ Terminal duplex.")
		return
	}
	if len(pf.Conflicts) > 0 {
		fmt.Println()
		fmt.Println("⚠ Found an existing `claude` alias/function outside Pockly's sentinel block.")
		fmt.Println("  Pockly is leaving your shell config alone. To enable Web ↔ Terminal duplex,")
		fmt.Println("  resolve the conflict and then run: pockly-daemon enable-remote-control")
		return
	}
	if len(pf.Shells) == 0 {
		// No supported shell rc files — nothing to do, don't spam the user.
		return
	}
	stateFile, err := remoteControlStatePath()
	if err != nil {
		fmt.Println()
		fmt.Printf("⚠ Pockly couldn't determine remote-control state path: %v\n", err)
		return
	}
	written := make([]rcRecord, 0, len(pf.Shells))
	for _, t := range pf.Shells {
		if err := upsertSentinelBlock(t, pf.Wrapper); err != nil {
			fmt.Printf("⚠ Pockly couldn't update %s: %v\n", t.Path, err)
			continue
		}
		written = append(written, rcRecord{Path: t.Path, Shell: t.Kind})
	}
	if len(written) == 0 {
		return
	}
	st := &remoteControlState{
		EnabledAt:      time.Now().UTC(),
		WrapperPath:    pf.Wrapper,
		WrapperVersion: wrapperReportedVersion(pf.Wrapper),
		RCFiles:        written,
	}
	_ = saveRemoteControlState(stateFile, st)
	fmt.Println()
	fmt.Println("✓ Pockly Web ↔ Terminal duplex enabled.")
	for _, r := range written {
		fmt.Printf("    modified %s\n", r.Path)
	}
	fmt.Println("    Open a new terminal (or `source` the file above), then run `claude` as usual.")
	fmt.Println("    Disable any time: pockly-daemon disable-remote-control")
}

func daemonBridgeURL() string {
	if value := strings.TrimSpace(os.Getenv("POCKLY_DAEMON_URL")); value != "" {
		return strings.TrimRight(value, "/")
	}
	return defaultDaemonBridge
}

func runEnableRemoteControl(args []string) error {
	fs := flag.NewFlagSet("enable-remote-control", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	autoYes := fs.Bool("yes", false, "skip the consent prompt (non-interactive)")
	shellsFlag := fs.String("shells", "auto", "comma-separated shells to modify (auto|zsh,bash,fish,powershell)")
	printOnly := fs.Bool("print-only", false, "show what would change without writing anything")
	wrapperFlag := fs.String("wrapper", "", "explicit wrapper binary path; defaults to discovery")
	if err := fs.Parse(args); err != nil {
		return err
	}

	pf, err := runPreflight(*wrapperFlag, *shellsFlag)
	if err != nil {
		return err
	}

	printPreflight(os.Stdout, pf)

	if len(pf.Conflicts) > 0 {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "Refusing to continue: existing `claude` alias/function found outside Pockly's sentinel block.")
		fmt.Fprintln(os.Stderr, "Remove the conflicting line(s) above and re-run.")
		return errors.New("conflicting claude alias detected")
	}

	if *printOnly {
		fmt.Println()
		fmt.Println("--print-only set; no files modified.")
		return nil
	}

	if !*autoYes {
		printWarning(os.Stdout, pf)
		if !promptYesNo(os.Stdin, os.Stdout, "Continue?") {
			return errors.New("aborted by user")
		}
	}

	stateFile, err := remoteControlStatePath()
	if err != nil {
		return err
	}

	written := make([]rcRecord, 0, len(pf.Shells))
	for _, t := range pf.Shells {
		if err := upsertSentinelBlock(t, pf.Wrapper); err != nil {
			return fmt.Errorf("write %s: %w", t.Path, err)
		}
		written = append(written, rcRecord{Path: t.Path, Shell: t.Kind})
	}

	st := &remoteControlState{
		EnabledAt:      time.Now().UTC(),
		WrapperPath:    pf.Wrapper,
		WrapperVersion: wrapperReportedVersion(pf.Wrapper),
		RCFiles:        written,
	}
	if err := saveRemoteControlState(stateFile, st); err != nil {
		return fmt.Errorf("save state: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Pockly remote control enabled.")
	for _, r := range written {
		fmt.Printf("    modified %s\n", r.Path)
	}
	fmt.Printf("    wrapper  %s\n", pf.Wrapper)
	fmt.Println()
	fmt.Println("Open a new terminal (or `source` the file above) for the alias to take effect.")
	fmt.Println("Then run `claude` as usual; mirroring starts on first launch.")
	fmt.Println("Disable any time:  pockly-daemon disable-remote-control")
	return nil
}

func runDisableRemoteControl(args []string) error {
	fs := flag.NewFlagSet("disable-remote-control", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	autoYes := fs.Bool("yes", false, "skip the consent prompt (non-interactive)")
	force := fs.Bool("force", false, "proceed even if recorded rc file no longer has our sentinel block")
	if err := fs.Parse(args); err != nil {
		return err
	}

	stateFile, err := remoteControlStatePath()
	if err != nil {
		return err
	}
	st, err := loadRemoteControlState(stateFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Println("Pockly remote control is not enabled. Nothing to do.")
			return nil
		}
		return err
	}

	fmt.Println("Will remove the Pockly sentinel block from:")
	for _, r := range st.RCFiles {
		fmt.Printf("    %s (%s)\n", r.Path, r.Shell)
	}
	fmt.Printf("State file to delete: %s\n", stateFile)
	fmt.Println()

	if !*autoYes {
		if !promptYesNo(os.Stdin, os.Stdout, "Continue?") {
			return errors.New("aborted by user")
		}
	}

	var firstErr error
	for _, r := range st.RCFiles {
		removed, err := removeSentinelBlockFromFile(r.Path)
		switch {
		case err != nil && errors.Is(err, iofs.ErrNotExist):
			fmt.Printf("    skip %s (file no longer exists)\n", r.Path)
		case err != nil:
			fmt.Fprintf(os.Stderr, "    error %s: %v\n", r.Path, err)
			if firstErr == nil {
				firstErr = err
			}
		case !removed && !*force:
			fmt.Fprintf(os.Stderr, "    %s: sentinel block not found; pass --force to ignore and delete state anyway\n", r.Path)
			if firstErr == nil {
				firstErr = fmt.Errorf("sentinel block missing in %s", r.Path)
			}
		case !removed && *force:
			fmt.Printf("    skip %s (no sentinel block; --force)\n", r.Path)
		default:
			fmt.Printf("    cleaned %s\n", r.Path)
		}
	}

	if firstErr != nil {
		return firstErr
	}

	if err := os.Remove(stateFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove state file: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Pockly remote control disabled.")
	fmt.Println("Open a new terminal for the alias removal to take effect.")
	return nil
}

func runRemoteControl(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: pockly-daemon remote-control status")
	}
	switch args[0] {
	case "status":
		return runRemoteControlStatus(args[1:])
	default:
		return fmt.Errorf("unknown remote-control subcommand %q (try `status`)", args[0])
	}
}

func runRemoteControlStatus(args []string) error {
	fs := flag.NewFlagSet("remote-control status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	asJSON := fs.Bool("json", false, "emit machine-readable JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}

	stateFile, err := remoteControlStatePath()
	if err != nil {
		return err
	}
	st, stErr := loadRemoteControlState(stateFile)

	report := struct {
		Enabled        bool                 `json:"enabled"`
		StateFile      string               `json:"state_file"`
		WrapperPath    string               `json:"wrapper_path,omitempty"`
		WrapperVersion string               `json:"wrapper_version,omitempty"`
		EnabledAt      *time.Time           `json:"enabled_at,omitempty"`
		RCFiles        []rcFileStatus       `json:"rc_files,omitempty"`
		ClaudeResolves string               `json:"claude_resolves_to,omitempty"`
		ShellOverrides []string             `json:"shell_overrides,omitempty"`
		DaemonReach    bool                 `json:"daemon_bridge_reachable"`
		DaemonError    string               `json:"daemon_bridge_error,omitempty"`
		RecentCrashes  []wrapperCrashRecord `json:"recent_wrapper_crashes,omitempty"`
	}{
		StateFile: stateFile,
	}

	if stErr == nil && st != nil {
		report.Enabled = true
		report.WrapperPath = st.WrapperPath
		report.WrapperVersion = st.WrapperVersion
		report.EnabledAt = &st.EnabledAt
		report.RCFiles = make([]rcFileStatus, 0, len(st.RCFiles))
		for _, r := range st.RCFiles {
			report.RCFiles = append(report.RCFiles, inspectRCFile(r))
		}
		report.ShellOverrides = activeShellOverrides(report.RCFiles)
	}

	if resolved, err := exec.LookPath("claude"); err == nil {
		report.ClaudeResolves = resolved
	}

	bridgeURL := daemonBridgeURL()
	ok, errStr := pingDaemonBridge(bridgeURL)
	report.DaemonReach = ok
	report.DaemonError = errStr

	if runtime.GOOS == "darwin" {
		report.RecentCrashes = recentWrapperCrashes(7 * 24 * time.Hour)
	}

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}

	if !report.Enabled {
		fmt.Println("Pockly remote control: disabled")
	} else {
		fmt.Printf("Pockly remote control: enabled  (since %s)\n", st.EnabledAt.Local().Format(time.RFC3339))
		fmt.Printf("    wrapper: %s", report.WrapperPath)
		if report.WrapperVersion != "" {
			fmt.Printf("  (%s)", report.WrapperVersion)
		}
		fmt.Println()
		for _, r := range report.RCFiles {
			marker := "✓"
			if !r.SentinelPresent {
				marker = "✗"
			}
			fmt.Printf("    %s %s  (%s)\n", marker, r.Path, r.Shell)
		}
	}
	if report.ClaudeResolves != "" {
		fmt.Printf("\n`claude` on PATH resolves to: %s\n", report.ClaudeResolves)
	} else {
		fmt.Println("\n`claude` not found on PATH")
	}
	for _, override := range report.ShellOverrides {
		fmt.Printf("shell override active: %s\n", override)
	}
	if report.DaemonReach {
		fmt.Printf("daemon bridge: reachable at %s\n", bridgeURL)
	} else {
		fmt.Printf("daemon bridge: UNREACHABLE at %s (%s)\n", bridgeURL, report.DaemonError)
	}
	if len(report.RecentCrashes) > 0 {
		fmt.Printf("\nRecent wrapper crashes (last 7 days): %d\n", len(report.RecentCrashes))
		for _, c := range report.RecentCrashes {
			fmt.Printf("    %s  %s\n", c.At.Local().Format(time.RFC3339), c.Reason)
		}
	}
	return nil
}

// --- preflight ---

func runPreflight(explicitWrapper, shellsFlag string) (*preflightResult, error) {
	out := &preflightResult{}

	real, err := resolveRealClaude()
	if err != nil {
		return nil, err
	}
	out.RealClaude = real

	wrapper, err := resolveWrapperPath(explicitWrapper)
	if err != nil {
		return nil, err
	}
	out.Wrapper = wrapper

	out.DaemonReachable, out.DaemonError = pingDaemonBridge(daemonBridgeURL())

	shells, err := chooseShells(shellsFlag)
	if err != nil {
		return nil, err
	}
	if len(shells) == 0 {
		return nil, errors.New("no supported shell rc file detected; pass --shells=zsh,bash,fish to be explicit")
	}
	out.Shells = shells

	for _, t := range shells {
		conflicts, err := detectClaudeAliasConflicts(t)
		if err != nil {
			return nil, fmt.Errorf("inspect %s: %w", t.Path, err)
		}
		out.Conflicts = append(out.Conflicts, conflicts...)
	}

	return out, nil
}

func printPreflight(w *os.File, pf *preflightResult) {
	fmt.Fprintln(w, "Pre-flight:")
	fmt.Fprintf(w, "    real claude:      %s\n", pf.RealClaude)
	fmt.Fprintf(w, "    wrapper binary:   %s\n", pf.Wrapper)
	if pf.DaemonReachable {
		fmt.Fprintf(w, "    daemon bridge:    reachable (%s)\n", daemonBridgeURL())
	} else {
		fmt.Fprintf(w, "    daemon bridge:    NOT reachable (%s) — start it before using `claude`\n", daemonBridgeURL())
	}
	fmt.Fprintln(w, "    shells to update:")
	for _, t := range pf.Shells {
		exists := "(will be created)"
		if _, err := os.Stat(t.Path); err == nil {
			exists = "(exists)"
		}
		fmt.Fprintf(w, "        %s %s %s\n", t.Kind, t.Path, exists)
	}
	if len(pf.Conflicts) > 0 {
		fmt.Fprintln(w, "    CONFLICTS:")
		for _, c := range pf.Conflicts {
			fmt.Fprintf(w, "        %s: %s\n", c.Path, c.Reason)
		}
	}
}

func printWarning(w *os.File, pf *preflightResult) {
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Pockly remote control will replace the `claude` command in your interactive shells")
	fmt.Fprintln(w, "with a Pockly wrapper.")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "What you gain:")
	fmt.Fprintln(w, "  • Your local Claude sessions are mirrored to your phone in real time")
	fmt.Fprintln(w, "  • You can type from your phone into your local Claude session")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Trade-offs to know:")
	fmt.Fprintln(w, "  • Modifies the rc files listed above. The change is wrapped in sentinel")
	fmt.Fprintln(w, "    comments and is cleanly reverted with `disable-remote-control`.")
	fmt.Fprintln(w, "  • Only interactive shells are affected. Scripts, IDE invocations, and CI")
	fmt.Fprintln(w, "    that call `claude` directly keep using the original Claude.")
	fmt.Fprintln(w, "  • If pockly-daemon stops responding, your local `claude` still launches —")
	fmt.Fprintln(w, "    mirroring and remote control silently stop until daemon recovers.")
	fmt.Fprintf(w, "  • The wrapper is in beta. Known issues: %s\n", knownIssuesURL)
	if runtime.GOOS == "darwin" {
		fmt.Fprintln(w, "  • macOS: until our binaries are notarized, first launch may be blocked by")
		fmt.Fprintln(w, "    Gatekeeper. If so, allow it under System Settings → Privacy & Security.")
	}
	fmt.Fprintln(w)
}

// --- shell discovery ---

func chooseShells(flagVal string) ([]shellTarget, error) {
	if strings.TrimSpace(flagVal) == "" || strings.EqualFold(flagVal, "auto") {
		return autoDetectShells(), nil
	}
	var out []shellTarget
	seen := map[shellKind]bool{}
	for _, raw := range strings.Split(flagVal, ",") {
		k := shellKind(strings.TrimSpace(strings.ToLower(raw)))
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		if k == shellPowerShell && runtime.GOOS == "windows" {
			home, err := os.UserHomeDir()
			if err != nil || strings.TrimSpace(home) == "" {
				return nil, errors.New("cannot determine home directory")
			}
			for _, path := range windowsPowerShellProfilePaths(home) {
				out = append(out, shellTarget{Kind: shellPowerShell, Path: path})
			}
			continue
		}
		path, err := rcFilePathFor(k)
		if err != nil {
			return nil, err
		}
		out = append(out, shellTarget{Kind: k, Path: path})
	}
	return out, nil
}

func autoDetectShells() []shellTarget {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return autoDetectShellsFor(home, runtime.GOOS, os.Getenv("SHELL"), fileExists, dirExists)
}

func autoDetectShellsFor(home, goos, shellEnv string, fileExistsFn, dirExistsFn func(string) bool) []shellTarget {
	var out []shellTarget
	if goos == "windows" {
		for _, path := range windowsPowerShellProfilePaths(home) {
			appendShellTargetIfMissing(&out, shellTarget{Kind: shellPowerShell, Path: path})
		}
	}

	if fileExistsFn(filepath.Join(home, ".zshrc")) {
		appendShellTargetIfMissing(&out, shellTarget{Kind: shellZsh, Path: filepath.Join(home, ".zshrc")})
	}
	if fileExistsFn(filepath.Join(home, ".bashrc")) {
		appendShellTargetIfMissing(&out, shellTarget{Kind: shellBash, Path: filepath.Join(home, ".bashrc")})
	} else if goos == "darwin" && fileExistsFn(filepath.Join(home, ".bash_profile")) {
		appendShellTargetIfMissing(&out, shellTarget{Kind: shellBash, Path: filepath.Join(home, ".bash_profile")})
	}
	if dirExistsFn(filepath.Join(home, ".config", "fish")) {
		appendShellTargetIfMissing(&out, shellTarget{Kind: shellFish, Path: filepath.Join(home, ".config", "fish", "conf.d", "pockly.fish")})
	}

	if fallback, ok := shellTargetFromEnv(home, goos, shellEnv); ok {
		appendShellTargetIfMissing(&out, fallback)
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out
}

func shellTargetFromEnv(home, goos, shellEnv string) (shellTarget, bool) {
	// Fall back to $SHELL guess; create the file fresh if the current shell's rc
	// file was not discovered by existence checks.
	switch filepath.Base(shellEnv) {
	case "zsh":
		return shellTarget{Kind: shellZsh, Path: filepath.Join(home, ".zshrc")}, true
	case "bash":
		rc := filepath.Join(home, ".bashrc")
		if goos == "darwin" {
			rc = filepath.Join(home, ".bash_profile")
		}
		return shellTarget{Kind: shellBash, Path: rc}, true
	case "fish":
		return shellTarget{Kind: shellFish, Path: filepath.Join(home, ".config", "fish", "conf.d", "pockly.fish")}, true
	case "powershell", "pwsh", "powershell.exe", "pwsh.exe":
		if goos == "windows" {
			return shellTarget{Kind: shellPowerShell, Path: windowsPowerShellProfilePath(home)}, true
		}
	}
	return shellTarget{}, false
}

func appendShellTargetIfMissing(out *[]shellTarget, target shellTarget) {
	for _, existing := range *out {
		if existing.Kind == target.Kind && existing.Path == target.Path {
			return
		}
	}
	*out = append(*out, target)
}

func rcFilePathFor(k shellKind) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch k {
	case shellZsh:
		return filepath.Join(home, ".zshrc"), nil
	case shellBash:
		if runtime.GOOS == "darwin" {
			return filepath.Join(home, ".bash_profile"), nil
		}
		return filepath.Join(home, ".bashrc"), nil
	case shellFish:
		return filepath.Join(home, ".config", "fish", "conf.d", "pockly.fish"), nil
	case shellPowerShell:
		if runtime.GOOS != "windows" {
			return "", errors.New("powershell remote-control setup is only supported on Windows")
		}
		return windowsPowerShellProfilePath(home), nil
	default:
		return "", fmt.Errorf("unknown shell %q", k)
	}
}

func windowsPowerShellProfilePath(home string) string {
	return filepath.Join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")
}

func windowsPowerShellProfilePaths(home string) []string {
	paths := []string{windowsPowerShellProfilePath(home)}
	pwshProfile := filepath.Join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
	if pwshProfile != paths[0] {
		paths = append(paths, pwshProfile)
	}
	return paths
}

// --- conflict detection ---

func detectClaudeAliasConflicts(t shellTarget) ([]preflightConflict, error) {
	raw, err := os.ReadFile(t.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	content := string(raw)

	// Strip our own sentinel block from the search content; any alias outside it
	// counts as a conflict.
	stripped := stripSentinelBlock(content)

	var conflicts []preflightConflict
	scanner := bufio.NewScanner(strings.NewReader(stripped))
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if t.Kind == shellFish {
			if strings.HasPrefix(line, "alias claude ") || strings.HasPrefix(line, "alias claude=") {
				conflicts = append(conflicts, preflightConflict{
					Path:   t.Path,
					Reason: fmt.Sprintf("line %d: %s", lineNum, line),
				})
			}
			if strings.HasPrefix(line, "function claude") {
				conflicts = append(conflicts, preflightConflict{
					Path:   t.Path,
					Reason: fmt.Sprintf("line %d: %s", lineNum, line),
				})
			}
			continue
		}
		if t.Kind == shellPowerShell {
			lower := strings.ToLower(line)
			if strings.HasPrefix(lower, "function claude") || strings.HasPrefix(lower, "function global:claude") ||
				strings.HasPrefix(lower, "set-alias claude ") || strings.HasPrefix(lower, "set-alias -name claude ") ||
				strings.HasPrefix(lower, "new-alias claude ") || strings.HasPrefix(lower, "new-alias -name claude ") {
				conflicts = append(conflicts, preflightConflict{
					Path:   t.Path,
					Reason: fmt.Sprintf("line %d: %s", lineNum, line),
				})
			}
			continue
		}
		// zsh / bash
		if strings.HasPrefix(line, "alias claude=") || strings.HasPrefix(line, "alias claude ") {
			conflicts = append(conflicts, preflightConflict{
				Path:   t.Path,
				Reason: fmt.Sprintf("line %d: %s", lineNum, line),
			})
		}
		if strings.HasPrefix(line, "claude()") || strings.HasPrefix(line, "function claude") {
			conflicts = append(conflicts, preflightConflict{
				Path:   t.Path,
				Reason: fmt.Sprintf("line %d: %s", lineNum, line),
			})
		}
	}
	return conflicts, nil
}

// --- sentinel block read/write ---

func formatAliasBlock(k shellKind, wrapper string) string {
	var aliasLine string
	switch k {
	case shellFish:
		aliasLine = fmt.Sprintf("alias claude '%s'", wrapper)
	case shellPowerShell:
		aliasLine = fmt.Sprintf("function claude { & %s @args }", powerShellSingleQuoted(wrapper))
	default:
		aliasLine = fmt.Sprintf("alias claude='%s'", wrapper)
	}
	return sentinelStart + "\n" + aliasLine + "\n" + sentinelEnd + "\n"
}

func powerShellSingleQuoted(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func stripSentinelBlock(content string) string {
	startIdx := strings.Index(content, sentinelStart)
	if startIdx < 0 {
		return content
	}
	rest := content[startIdx:]
	endIdx := strings.Index(rest, sentinelEnd)
	if endIdx < 0 {
		return content[:startIdx]
	}
	endIdx += len(sentinelEnd)
	if endIdx < len(rest) && rest[endIdx] == '\n' {
		endIdx++
	}
	return content[:startIdx] + rest[endIdx:]
}

func upsertSentinelBlock(t shellTarget, wrapper string) error {
	block := formatAliasBlock(t.Kind, wrapper)

	if err := os.MkdirAll(filepath.Dir(t.Path), 0o755); err != nil {
		return err
	}

	existing, err := os.ReadFile(t.Path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}

	content := stripSentinelBlock(string(existing))
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += block

	return atomicWriteFile(t.Path, []byte(content), 0o644)
}

func removeSentinelBlockFromFile(path string) (bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	stripped := stripSentinelBlock(string(raw))
	if stripped == string(raw) {
		return false, nil
	}
	return true, atomicWriteFile(path, []byte(stripped), 0o644)
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".pockly-rc-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // no-op if rename succeeded
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

// --- state file ---

func remoteControlStatePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(dir, "pockly-daemon", remoteControlStateFn), nil
}

func loadRemoteControlState(path string) (*remoteControlState, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st remoteControlState
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, fmt.Errorf("decode remote-control state: %w", err)
	}
	return &st, nil
}

func saveRemoteControlState(path string, st *remoteControlState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return atomicWriteFile(path, raw, 0o600)
}

// --- resolution helpers ---

func resolveRealClaude() (string, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return "", errors.New("`claude` not found on PATH. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code/quickstart")
	}
	// Defensive: if claude already points at our wrapper, refuse to set up a
	// loop. (Should not happen because we set up via shell alias, not PATH
	// shim, but a user may have manually replaced /usr/local/bin/claude.)
	if base := filepath.Base(bin); base == wrapperBinaryName || base == "pockly-claude" {
		return "", fmt.Errorf("`claude` on PATH points at %s; refusing to wrap a wrapper", bin)
	}
	return bin, nil
}

func resolveWrapperPath(explicit string) (string, error) {
	if strings.TrimSpace(explicit) != "" {
		if _, err := os.Stat(explicit); err != nil {
			return "", fmt.Errorf("explicit wrapper path %s: %w", explicit, err)
		}
		return explicit, nil
	}
	self, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(self), wrapperBinaryName)
		if runtime.GOOS == "windows" {
			candidate += ".exe"
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	if path, err := exec.LookPath(wrapperBinaryName); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("%s not found next to pockly-daemon and not on PATH — reinstall with curl|bash to get the latest pockly bundle", wrapperBinaryName)
}

func wrapperReportedVersion(path string) string {
	cmd := exec.Command(path, "--help")
	out, _ := cmd.Output()
	// The wrapper has no --version flag today; we keep this hook for when it does.
	first := strings.SplitN(string(out), "\n", 2)[0]
	if strings.Contains(first, "pockly-claude-wrapper") {
		return strings.TrimSpace(first)
	}
	return ""
}

// --- daemon liveness ---

func pingDaemonBridge(baseURL string) (bool, string) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + "/api/dev/terminal-sessions")
	if err != nil {
		// connection refused is fine info; pass it through
		var netErr *net.OpError
		if errors.As(err, &netErr) {
			return false, netErr.Err.Error()
		}
		return false, err.Error()
	}
	defer resp.Body.Close()
	// Any HTTP response means the daemon is up; 4xx/5xx is still alive.
	return true, ""
}

// --- status helpers ---

type rcFileStatus struct {
	Path            string    `json:"path"`
	Shell           shellKind `json:"shell"`
	SentinelPresent bool      `json:"sentinel_present"`
	AliasTarget     string    `json:"alias_target,omitempty"`
}

func inspectRCFile(r rcRecord) rcFileStatus {
	out := rcFileStatus{Path: r.Path, Shell: r.Shell}
	raw, err := os.ReadFile(r.Path)
	if err != nil {
		return out
	}
	content := string(raw)
	startIdx := strings.Index(content, sentinelStart)
	if startIdx < 0 {
		return out
	}
	out.SentinelPresent = true
	rest := content[startIdx:]
	endIdx := strings.Index(rest, sentinelEnd)
	if endIdx < 0 {
		return out
	}
	body := rest[:endIdx]
	for _, ln := range strings.Split(body, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, "alias claude=") {
			out.AliasTarget = strings.Trim(strings.TrimPrefix(ln, "alias claude="), "'\"")
		} else if strings.HasPrefix(ln, "alias claude ") {
			out.AliasTarget = strings.Trim(strings.TrimPrefix(ln, "alias claude "), "'\"")
		} else if strings.HasPrefix(ln, "function claude") {
			out.AliasTarget = ln
		}
	}
	return out
}

func activeShellOverrides(files []rcFileStatus) []string {
	var out []string
	for _, f := range files {
		if !f.SentinelPresent || strings.TrimSpace(f.AliasTarget) == "" {
			continue
		}
		switch f.Shell {
		case shellPowerShell:
			out = append(out, fmt.Sprintf("new PowerShell sessions define function claude -> %s", f.AliasTarget))
		case shellFish, shellBash, shellZsh:
			out = append(out, fmt.Sprintf("new %s sessions define claude -> %s", f.Shell, f.AliasTarget))
		default:
			out = append(out, fmt.Sprintf("new %s sessions define claude -> %s", f.Shell, f.AliasTarget))
		}
	}
	return out
}

type wrapperCrashRecord struct {
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
	Path   string    `json:"path"`
}

func recentWrapperCrashes(window time.Duration) []wrapperCrashRecord {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	dir := filepath.Join(home, "Library", "Logs", "DiagnosticReports")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	cutoff := time.Now().Add(-window)
	var out []wrapperCrashRecord
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "pockly-claude-wrapper-") || !strings.HasSuffix(name, ".ips") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Before(cutoff) {
			continue
		}
		out = append(out, wrapperCrashRecord{
			At:     info.ModTime(),
			Reason: classifyCrash(filepath.Join(dir, name)),
			Path:   filepath.Join(dir, name),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

func classifyCrash(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "unknown"
	}
	// The .ips file is a JSONL header + JSON body.
	parts := strings.SplitN(string(raw), "\n", 2)
	if len(parts) != 2 {
		return "malformed"
	}
	var body struct {
		Exception   struct{ Signal string } `json:"exception"`
		Termination struct {
			Namespace string
			Indicator string
		} `json:"termination"`
	}
	if err := json.Unmarshal([]byte(parts[1]), &body); err != nil {
		return "unparseable"
	}
	if body.Termination.Namespace == "CODESIGNING" {
		return "codesigning (unsigned binary; ad-hoc dev artifact)"
	}
	if body.Exception.Signal != "" {
		return body.Exception.Signal
	}
	return "unknown"
}

// --- misc helpers ---

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func promptYesNo(in *os.File, out *os.File, q string) bool {
	fmt.Fprintf(out, "%s [y/N] ", q)
	r := bufio.NewReader(in)
	line, _ := r.ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}
