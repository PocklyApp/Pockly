// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const listDirMaxEntries = 500

// handleListDir reads a single directory level on behalf of the relay/web UI.
// Empty path resolves to the user's home directory. Dotfiles are hidden by
// default. Directory symlinks are reported as links and shown as navigable
// directories so the web picker behaves like a normal file browser.
func handleListDir(req ListDirRequest) ListDirResponse {
	resp := ListDirResponse{RequestID: req.RequestID}

	path := strings.TrimSpace(req.Path)
	if path == "" || path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			resp.Error = "home directory unavailable"
			return resp
		}
		path = home
	} else if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			path = filepath.Join(home, path[2:])
		}
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	abs = filepath.Clean(abs)

	info, err := os.Stat(abs)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	if !info.IsDir() {
		resp.Error = "not a directory"
		return resp
	}

	dirEntries, err := os.ReadDir(abs)
	if err != nil {
		resp.Error = err.Error()
		return resp
	}

	resp.Path = abs
	if parent := filepath.Dir(abs); parent != abs {
		resp.Parent = parent
	}

	for _, e := range dirEntries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		entry := ListDirEntry{Name: name, IsDir: e.IsDir()}
		if e.Type()&os.ModeSymlink != 0 {
			entry.IsLink = true
			// Resolve to learn whether it points to a directory.
			if target, err := os.Stat(filepath.Join(abs, name)); err == nil && target.IsDir() {
				entry.IsDir = true
			}
		}
		if entry.IsDir {
			if gitInfo, err := os.Stat(filepath.Join(abs, name, ".git")); err == nil {
				_ = gitInfo
				entry.IsGit = true
			}
		}
		resp.Entries = append(resp.Entries, entry)
	}

	sort.SliceStable(resp.Entries, func(i, j int) bool {
		if resp.Entries[i].IsDir != resp.Entries[j].IsDir {
			return resp.Entries[i].IsDir
		}
		return strings.ToLower(resp.Entries[i].Name) < strings.ToLower(resp.Entries[j].Name)
	})
	if len(resp.Entries) > listDirMaxEntries {
		resp.Truncated = true
		resp.Entries = resp.Entries[:listDirMaxEntries]
	}

	return resp
}
