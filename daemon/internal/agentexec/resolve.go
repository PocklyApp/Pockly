// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package agentexec

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Result struct {
	Path   string
	Source string
}

func Resolve(name, pathEnv, selfPath string, getenv func(string) string) (Result, error) {
	if strings.TrimSpace(name) == "" {
		return Result{}, fmt.Errorf("executable name required")
	}
	if getenv == nil {
		getenv = os.Getenv
	}
	searchPath := SearchPath(pathEnv, getenv)
	originalDirs := dirsSet(filepath.SplitList(pathEnv))
	for _, dir := range filepath.SplitList(searchPath) {
		if dir == "" {
			dir = "."
		}
		for _, candidate := range candidatePaths(dir, name, getenv) {
			if !isExecutable(candidate) {
				continue
			}
			if samePath(candidate, selfPath) {
				continue
			}
			source := "common_path"
			if originalDirs[dir] {
				source = "path"
			}
			return Result{Path: candidate, Source: source}, nil
		}
	}
	return Result{}, fmt.Errorf("%s executable file not found in PATH or common local install locations", name)
}

func SearchPath(pathEnv string, getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	dirs := filepath.SplitList(pathEnv)
	dirs = append(dirs, CommonDirs(getenv)...)
	return strings.Join(dedupDirs(dirs), string(os.PathListSeparator))
}

func CommonDirs(getenv func(string) string) []string {
	if getenv == nil {
		getenv = os.Getenv
	}
	dirs := []string{}
	home := strings.TrimSpace(getenv("HOME"))
	if runtime.GOOS == "windows" {
		if userProfile := strings.TrimSpace(getenv("USERPROFILE")); home == "" && userProfile != "" {
			home = userProfile
		}
		if appData := strings.TrimSpace(getenv("APPDATA")); appData != "" {
			dirs = append(dirs, filepath.Join(appData, "npm"))
		}
		if localAppData := strings.TrimSpace(getenv("LOCALAPPDATA")); localAppData != "" {
			dirs = append(dirs,
				filepath.Join(localAppData, "Programs", "nodejs"),
				filepath.Join(localAppData, "Microsoft", "WindowsApps"),
			)
		}
	} else if home == "" {
		if resolved, err := os.UserHomeDir(); err == nil {
			home = resolved
		}
	}
	if home != "" {
		if runtime.GOOS == "windows" {
			dirs = append(dirs, filepath.Join(home, "AppData", "Roaming", "npm"))
		} else {
			dirs = append(dirs,
				filepath.Join(home, ".local", "bin"),
				filepath.Join(home, "bin"),
				filepath.Join(home, ".bin"),
				filepath.Join(home, ".npm-global", "bin"),
				filepath.Join(home, ".bun", "bin"),
			)
		}
	}
	switch runtime.GOOS {
	case "darwin":
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")
	case "linux":
		dirs = append(dirs, "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin")
	}
	return dedupDirs(dirs)
}

func candidatePaths(dir, name string, getenv func(string) string) []string {
	if runtime.GOOS != "windows" || filepath.Ext(name) != "" {
		return []string{filepath.Join(dir, name)}
	}
	exts := strings.TrimSpace(getenv("PATHEXT"))
	if exts == "" {
		exts = ".COM;.EXE;.BAT;.CMD"
	}
	out := []string{filepath.Join(dir, name)}
	for _, ext := range strings.Split(exts, ";") {
		ext = strings.TrimSpace(ext)
		if ext == "" {
			continue
		}
		out = append(out, filepath.Join(dir, name+ext))
	}
	return out
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ar, aerr := os.Stat(a)
	br, berr := os.Stat(b)
	return aerr == nil && berr == nil && os.SameFile(ar, br)
}

func dirsSet(dirs []string) map[string]bool {
	out := map[string]bool{}
	for _, dir := range dedupDirs(dirs) {
		out[dir] = true
	}
	return out
}

func dedupDirs(dirs []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		clean := filepath.Clean(dir)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		out = append(out, clean)
	}
	return out
}
