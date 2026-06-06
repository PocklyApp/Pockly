//go:build windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/UserExistsError/conpty"
)

type windowsPTYSession struct {
	pty      *conpty.ConPty
	exitCode int
}

type ptyExitError struct {
	code int
}

func (e ptyExitError) Error() string {
	return fmt.Sprintf("process exited with code %d", e.code)
}

func (e ptyExitError) ExitCode() int {
	return e.code
}

func startPTY(spec claudelauncher.CommandSpec, args []string, cwd string, env []string, size terminalSize) (ptySession, error) {
	commandLine := windowsCommandLine(spec, args)
	pty, err := conpty.Start(
		commandLine,
		conpty.ConPtyDimensions(int(size.Cols), int(size.Rows)),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return nil, err
	}
	return &windowsPTYSession{pty: pty}, nil
}

func windowsCommandLine(spec claudelauncher.CommandSpec, args []string) string {
	ext := strings.ToLower(filepath.Ext(spec.Path))
	argv := append([]string{spec.Path}, spec.Args(args)...)
	if ext == ".cmd" || ext == ".bat" {
		comspec := strings.TrimSpace(os.Getenv("COMSPEC"))
		if comspec == "" {
			comspec = `C:\Windows\System32\cmd.exe`
		}
		inner := quoteWindowsArg(spec.Path)
		for _, arg := range spec.Args(args) {
			inner += " " + quoteWindowsArg(arg)
		}
		return quoteWindowsArg(comspec) + ` /d /s /c "` + inner + `"`
	}
	parts := make([]string, 0, len(argv))
	for _, arg := range argv {
		parts = append(parts, quoteWindowsArg(arg))
	}
	return strings.Join(parts, " ")
}

func quoteWindowsArg(arg string) string {
	return syscall.EscapeArg(arg)
}

func (s *windowsPTYSession) Read(p []byte) (int, error) {
	return s.pty.Read(p)
}

func (s *windowsPTYSession) Write(p []byte) (int, error) {
	return s.pty.Write(p)
}

func (s *windowsPTYSession) Close() error {
	return s.pty.Close()
}

func (s *windowsPTYSession) Resize(cols, rows uint16) error {
	return s.pty.Resize(int(cols), int(rows))
}

func (s *windowsPTYSession) Pid() int {
	return s.pty.Pid()
}

func (s *windowsPTYSession) Signal(sig os.Signal) error {
	if sig == os.Interrupt {
		_, err := s.Write([]byte{0x03})
		return err
	}
	return s.Close()
}

func (s *windowsPTYSession) Wait() error {
	code, err := s.pty.Wait(context.Background())
	s.exitCode = int(code)
	if err != nil {
		return err
	}
	if code != 0 {
		return ptyExitError{code: int(code)}
	}
	return nil
}
