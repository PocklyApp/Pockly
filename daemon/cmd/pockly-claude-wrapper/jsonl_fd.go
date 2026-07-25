// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// activeJSONL returns the session_id + absolute jsonl path that `pid` (or
// any of its descendants) currently has open, restricted to files under
// projectDir. Returns ("","",false) if no candidate is found.
//
// Why fd-based, not mtime-based: claude writes its jsonl into a project
// dir that may already contain dozens of historical sessions. mtime alone
// can be ambiguous (concurrent claudes, slow IO, `--print` racing) and is
// silently wrong when claude rotates sessions via in-app /resume. The
// kernel's open-fd table is the only authoritative answer to "which jsonl
// is THIS claude process writing to right now."
//
// Tradeoff: lsof on darwin is ~5-20ms per call. Caller polls at 1s
// cadence, so the budget is comfortable.
func activeJSONL(pid int, projectDir string) (sid string, path string, ok bool) {
	if pid <= 0 {
		return "", "", false
	}
	cleanProjectDir := strings.TrimRight(filepath.Clean(projectDir), string(filepath.Separator))
	pids := descendantPIDs(pid)
	for _, p := range pids {
		if sid, path, ok = jsonlForPID(p, cleanProjectDir); ok {
			return sid, path, true
		}
	}
	return "", "", false
}

// jsonlForPID returns the most-recently-modified jsonl under projectDir
// that pid has open, or zero values if pid has none open there.
//
// "Most recently modified" matters because during /resume, claude may
// briefly hold both old and new jsonls open. The active one is the one
// currently being appended to.
//
// Filters out jsonls whose entrypoint marker shows they're owned by
// Claude Desktop or other non-CLI producers (see jsonl_entrypoint.go).
// When user `/resume`s a Desktop session, CLI claude opens that file
// READ-only for context and writes new turns to a fresh jsonl; without
// this filter the resumed (Desktop-owned) file could be picked.
func jsonlForPID(pid int, projectDir string) (string, string, bool) {
	paths := openJSONLPaths(pid)
	if len(paths) == 0 {
		return "", "", false
	}
	var best string
	var bestModTime time.Time
	for _, p := range paths {
		if !strings.HasSuffix(p, ".jsonl") {
			continue
		}
		if projectDir != "" && !pathUnder(p, projectDir) {
			continue
		}
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		if !jsonlOwnsCLI(p) {
			continue
		}
		if best == "" || info.ModTime().After(bestModTime) {
			best = p
			bestModTime = info.ModTime()
		}
	}
	if best == "" {
		return "", "", false
	}
	sid := strings.TrimSuffix(filepath.Base(best), ".jsonl")
	return sid, best, sid != ""
}

func pathUnder(path, dir string) bool {
	cleanPath := filepath.Clean(path)
	cleanDir := strings.TrimRight(filepath.Clean(dir), string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(cleanPath, cleanDir)
}

// openJSONLPaths returns absolute paths of regular files matching *.jsonl
// that the kernel reports pid has open. Empty on error (caller decides
// whether to fall back to mtime scanning).
func openJSONLPaths(pid int) []string {
	switch runtime.GOOS {
	case "linux":
		return openJSONLPathsProc(pid)
	case "darwin":
		return openJSONLPathsLsof(pid)
	default:
		return nil
	}
}

// openJSONLPathsProc reads /proc/<pid>/fd/* on Linux. Symlinks resolve to
// the absolute path of the open file; we filter by .jsonl suffix.
func openJSONLPathsProc(pid int) []string {
	fdDir := filepath.Join("/proc", strconv.Itoa(pid), "fd")
	entries, err := os.ReadDir(fdDir)
	if err != nil {
		return nil
	}
	out := make([]string, 0, 4)
	for _, entry := range entries {
		target, err := os.Readlink(filepath.Join(fdDir, entry.Name()))
		if err != nil {
			continue
		}
		if strings.HasSuffix(target, ".jsonl") {
			out = append(out, target)
		}
	}
	return out
}

// openJSONLPathsLsof shells out to lsof on macOS. -Fn formats output one
// field per line: "p<pid>", "f<fd>", "n<name>". We just collect "n" lines
// ending in .jsonl.
//
// Why not cgo proc_pidinfo: avoiding the cgo dependency keeps cross-compile
// of pockly-daemon (linux+darwin x amd64+arm64) simple. The 1s polling
// cadence absorbs lsof's startup cost.
func openJSONLPathsLsof(pid int) []string {
	cmd := exec.Command("lsof", "-nP", "-p", strconv.Itoa(pid), "-Fn")
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var paths []string
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "n") {
			continue
		}
		path := strings.TrimPrefix(line, "n")
		if strings.HasSuffix(path, ".jsonl") {
			paths = append(paths, path)
		}
	}
	return paths
}

// descendantPIDs returns root plus every descendant PID. claude is
// typically a single node process (the shim script execs into node), but
// some MCP servers or sub-tools may spawn children that hold the jsonl
// transiently. Walking the tree avoids missing the file when the
// immediate child isn't the one writing.
func descendantPIDs(root int) []int {
	pids := []int{root}
	parentToChildren := childrenIndex()
	if len(parentToChildren) == 0 {
		return pids
	}
	queue := []int{root}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		for _, c := range parentToChildren[next] {
			pids = append(pids, c)
			queue = append(queue, c)
		}
	}
	return pids
}

// childrenIndex builds pid→[child pids] for the current host. Empty on
// platforms we don't bother to support (Windows etc.).
func childrenIndex() map[int][]int {
	switch runtime.GOOS {
	case "linux":
		return childrenIndexProc()
	case "darwin":
		return childrenIndexPs()
	default:
		return nil
	}
}

func childrenIndexProc() map[int][]int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	out := map[int][]int{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		// /proc/<pid>/stat format: "pid (comm) state ppid ..."
		// comm can contain spaces and parens; scan from the last ')' to
		// skip past it before reading PPID.
		idx := bytes.LastIndex(data, []byte(")"))
		if idx < 0 || idx+2 >= len(data) {
			continue
		}
		fields := strings.Fields(string(data[idx+2:]))
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		out[ppid] = append(out[ppid], pid)
	}
	return out
}

// childrenIndexPs shells out to `ps -axo pid=,ppid=` on macOS, which prints
// each running process as "PID PPID" with whitespace separators.
func childrenIndexPs() map[int][]int {
	cmd := exec.Command("ps", "-axo", "pid=,ppid=")
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	result := map[int][]int{}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil {
			continue
		}
		result[ppid] = append(result[ppid], pid)
	}
	return result
}
