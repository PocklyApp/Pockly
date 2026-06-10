// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package agentsettings

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// This file queries the INSTALLED claude CLI for its model picker list at
// runtime, instead of hardcoding a lineup that rots between releases.
//
// Mechanism: the documented Agent-SDK stream-json control protocol. Spawn
//
//	claude --print --verbose --input-format stream-json --output-format stream-json
//
// write a {"type":"control_request","request":{"subtype":"initialize"}} line,
// and the CLI answers a control_response whose payload includes `models` —
// the exact entries its own /model picker shows (value, displayName,
// description, per-model supportedEffortLevels). Local handshake only: no
// prompt is sent and no API call is made, so it works regardless of auth and
// costs nothing. Verified against claude 2.1.159.

// ClaudeBinaryResolver locates the real claude binary (skipping the Pockly
// PTY wrapper). Set once from main.go at startup; nil keeps the CLI query
// disabled and ReadModelOptionDetails serves the static fallback lineup —
// which also keeps unit tests hermetic (no surprise subprocess spawns).
var claudeBinaryResolver struct {
	mu sync.Mutex
	fn func() (string, error)
}

func SetClaudeBinaryResolver(fn func() (string, error)) {
	claudeBinaryResolver.mu.Lock()
	claudeBinaryResolver.fn = fn
	claudeBinaryResolver.mu.Unlock()
	// A new resolver invalidates whatever the old one produced.
	cliModelsCache.mu.Lock()
	cliModelsCache.fetchedAt = time.Time{}
	cliModelsCache.options = nil
	cliModelsCache.mu.Unlock()
}

// cliModelsCache memoizes the CLI's answer: the list only changes when the
// installed CLI changes, and the query costs a ~1s subprocess spawn that must
// not run on every agent-settings GET. Errors are cached briefly too so a
// broken install can't trigger a spawn storm.
var cliModelsCache struct {
	mu        sync.Mutex
	fetchedAt time.Time
	options   []ModelOption
}

const (
	cliModelsTTL        = 10 * time.Minute
	cliModelsErrorTTL   = time.Minute
	cliModelsQueryLimit = 15 * time.Second
)

// claudeCLIModelOptions returns the installed CLI's model picker entries, or
// nil when no resolver is configured / the query failed (callers fall back to
// the static lineup).
func claudeCLIModelOptions() []ModelOption {
	claudeBinaryResolver.mu.Lock()
	resolve := claudeBinaryResolver.fn
	claudeBinaryResolver.mu.Unlock()
	if resolve == nil {
		return nil
	}

	cliModelsCache.mu.Lock()
	defer cliModelsCache.mu.Unlock()
	if !cliModelsCache.fetchedAt.IsZero() {
		age := time.Since(cliModelsCache.fetchedAt)
		if (len(cliModelsCache.options) > 0 && age < cliModelsTTL) ||
			(len(cliModelsCache.options) == 0 && age < cliModelsErrorTTL) {
			return append([]ModelOption(nil), cliModelsCache.options...)
		}
	}

	options := func() []ModelOption {
		binary, err := resolve()
		if err != nil || strings.TrimSpace(binary) == "" {
			return nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), cliModelsQueryLimit)
		defer cancel()
		opts, err := QueryClaudeCLIModels(ctx, binary)
		if err != nil {
			return nil
		}
		return opts
	}()
	cliModelsCache.fetchedAt = time.Now()
	cliModelsCache.options = options
	return append([]ModelOption(nil), options...)
}

// QueryClaudeCLIModels performs one control-protocol handshake against the
// given claude binary and returns its model picker entries.
func QueryClaudeCLIModels(ctx context.Context, binary string) ([]ModelOption, error) {
	cmd := exec.CommandContext(ctx, binary,
		"--print", "--verbose",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	// Always reap: cancel kills the process via CommandContext, Wait clears it.
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	if _, err := stdin.Write([]byte(`{"type":"control_request","request_id":"pockly_models","request":{"subtype":"initialize"}}` + "\n")); err != nil {
		return nil, err
	}

	scanner := bufio.NewScanner(stdout)
	// The initialize response carries commands/styles/models — ~15KB on
	// 2.1.159; allow for growth.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		options, done, err := parseClaudeCLIModelsLine(scanner.Bytes())
		if err != nil {
			return nil, err
		}
		if done {
			return options, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("claude exited before answering initialize")
}

// parseClaudeCLIModelsLine inspects one stream-json line. done=true when the
// line is the initialize control_response (success or error).
func parseClaudeCLIModelsLine(line []byte) (options []ModelOption, done bool, err error) {
	var msg struct {
		Type     string `json:"type"`
		Response struct {
			Subtype  string `json:"subtype"`
			Error    string `json:"error,omitempty"`
			Response struct {
				Models []struct {
					Value       string `json:"value"`
					DisplayName string `json:"displayName"`
					Description string `json:"description"`
				} `json:"models"`
			} `json:"response"`
		} `json:"response"`
	}
	if json.Unmarshal(line, &msg) != nil || msg.Type != "control_response" {
		return nil, false, nil
	}
	if msg.Response.Subtype == "error" {
		return nil, true, fmt.Errorf("initialize failed: %s", msg.Response.Error)
	}
	if msg.Response.Subtype != "success" {
		return nil, false, nil
	}
	for _, m := range msg.Response.Response.Models {
		value := strings.TrimSpace(m.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(m.DisplayName)
		if label == "" {
			label = value
		}
		// The description's first segment names the concrete model
		// ("Opus 4.8 with 1M context · Most capable…") — surface it as the
		// resolved-model hint the web shows next to the label.
		resolved := strings.TrimSpace(strings.SplitN(m.Description, "·", 2)[0])
		options = append(options, ModelOption{
			Value:         value,
			Label:         label,
			ResolvedModel: resolved,
			Source:        "claude_cli",
		})
	}
	return options, true, nil
}
