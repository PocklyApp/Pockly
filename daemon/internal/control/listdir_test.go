// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHandleListDirDefaultsToHomeAndHidesDotfiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}

	mustMkdir(t, filepath.Join(home, "project-a"))
	mustMkdir(t, filepath.Join(home, "project-b"))
	mustWriteFile(t, filepath.Join(home, "notes.txt"))
	mustWriteFile(t, filepath.Join(home, ".secret"))

	resp := handleListDir(ListDirRequest{RequestID: "req_1"})
	if resp.Error != "" {
		t.Fatalf("handleListDir returned error: %s", resp.Error)
	}
	if resp.RequestID != "req_1" {
		t.Fatalf("request id mismatch: got %q", resp.RequestID)
	}
	if resp.Path != filepath.Clean(home) {
		t.Fatalf("path = %q, want %q", resp.Path, filepath.Clean(home))
	}

	names := map[string]ListDirEntry{}
	for _, entry := range resp.Entries {
		names[entry.Name] = entry
		if entry.Name == ".secret" {
			t.Fatal("dotfile should not be listed")
		}
	}
	if !names["project-a"].IsDir || !names["project-b"].IsDir {
		t.Fatalf("expected project directories in response: %#v", names)
	}
	if names["notes.txt"].IsDir {
		t.Fatal("file should not be marked as directory")
	}
	if len(resp.Entries) < 3 {
		t.Fatalf("expected at least 3 entries, got %d", len(resp.Entries))
	}
	if !resp.Entries[0].IsDir || !resp.Entries[1].IsDir {
		t.Fatalf("directories should sort before files: %#v", resp.Entries)
	}
}

func TestHandleListDirReportsGitAndDirectorySymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory symlink creation requires elevated privileges on Windows")
	}

	root := t.TempDir()
	project := filepath.Join(root, "repo")
	mustMkdir(t, filepath.Join(project, ".git"))
	if err := os.Symlink(project, filepath.Join(root, "repo-link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	resp := handleListDir(ListDirRequest{RequestID: "req_2", Path: root})
	if resp.Error != "" {
		t.Fatalf("handleListDir returned error: %s", resp.Error)
	}
	entries := map[string]ListDirEntry{}
	for _, entry := range resp.Entries {
		entries[entry.Name] = entry
	}
	if got := entries["repo"]; !got.IsDir || !got.IsGit {
		t.Fatalf("repo entry = %#v, want git directory", got)
	}
	if got := entries["repo-link"]; !got.IsDir || !got.IsLink {
		t.Fatalf("repo-link entry = %#v, want directory symlink", got)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func mustWriteFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
