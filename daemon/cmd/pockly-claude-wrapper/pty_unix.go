//go:build !windows

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"os/exec"

	"github.com/PocklyApp/Pockly/daemon/internal/claudelauncher"
	"github.com/creack/pty"
)

type unixPTYSession struct {
	file *os.File
	cmd  *exec.Cmd
}

func startPTY(spec claudelauncher.CommandSpec, args []string, cwd string, env []string, size terminalSize) (ptySession, error) {
	cmd := exec.Command(spec.Path, spec.Args(args)...)
	cmd.Dir = cwd
	cmd.Env = env
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: size.Cols, Rows: size.Rows})
	if err != nil {
		return nil, err
	}
	return &unixPTYSession{file: file, cmd: cmd}, nil
}

func (s *unixPTYSession) Read(p []byte) (int, error) {
	return s.file.Read(p)
}

func (s *unixPTYSession) Write(p []byte) (int, error) {
	return s.file.Write(p)
}

func (s *unixPTYSession) Close() error {
	return s.file.Close()
}

func (s *unixPTYSession) Resize(cols, rows uint16) error {
	return pty.Setsize(s.file, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *unixPTYSession) Pid() int {
	if s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}

func (s *unixPTYSession) Signal(sig os.Signal) error {
	return forwardSignalToProcess(s.cmd, sig)
}

func (s *unixPTYSession) Wait() error {
	return s.cmd.Wait()
}
