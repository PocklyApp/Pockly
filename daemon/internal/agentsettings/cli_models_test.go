// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package agentsettings

import (
	"context"
	"os"
	"testing"
	"time"
)

// Shape captured verbatim (trimmed) from claude 2.1.159's initialize
// control_response over the stream-json control protocol.
const capturedInitializeLine = `{"type":"control_response","response":{"subtype":"success","request_id":"pockly_models","response":{"commands":[],"output_styles":["default"],"available_output_styles":["default"],"models":[{"value":"default","displayName":"Default (recommended)","description":"Opus 4.8 with 1M context · Most capable for complex work","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"sonnet","displayName":"Sonnet","description":"Sonnet 4.6 · Best for everyday tasks","supportsEffort":true},{"value":"haiku","displayName":"Haiku","description":"Haiku 4.5 · Fastest for quick answers"}]}}}`

func TestParseClaudeCLIModelsLine(t *testing.T) {
	t.Parallel()
	// Non-control lines are skipped without finishing.
	if _, done, err := parseClaudeCLIModelsLine([]byte(`{"type":"system","subtype":"init"}`)); done || err != nil {
		t.Fatalf("system line: done=%v err=%v, want skip", done, err)
	}
	if _, done, err := parseClaudeCLIModelsLine([]byte("not json")); done || err != nil {
		t.Fatalf("garbage line: done=%v err=%v, want skip", done, err)
	}

	options, done, err := parseClaudeCLIModelsLine([]byte(capturedInitializeLine))
	if err != nil || !done {
		t.Fatalf("captured line: done=%v err=%v", done, err)
	}
	if len(options) != 3 {
		t.Fatalf("expected 3 models, got %v", options)
	}
	if options[0].Value != "default" || options[0].Label != "Default (recommended)" {
		t.Fatalf("first option = %+v", options[0])
	}
	if options[0].ResolvedModel != "Opus 4.8 with 1M context" {
		t.Fatalf("resolved hint = %q", options[0].ResolvedModel)
	}
	if options[1].Value != "sonnet" || options[2].Value != "haiku" {
		t.Fatalf("order/values wrong: %+v", options)
	}

	// An error control_response surfaces as an error.
	if _, done, err := parseClaudeCLIModelsLine([]byte(`{"type":"control_response","response":{"subtype":"error","error":"boom"}}`)); !done || err == nil {
		t.Fatalf("error response: done=%v err=%v, want done+error", done, err)
	}
}

// Live handshake against the real installed CLI. Local-only (network-free,
// auth-free — initialize is answered before any API call). Gated so CI and
// machines without claude skip it:
//
//	POCKLY_CLAUDE_BIN=$(readlink -f ~/.local/bin/claude) \
//	go test ./internal/agentsettings/ -run TestQueryClaudeCLIModelsLive -v
func TestQueryClaudeCLIModelsLive(t *testing.T) {
	bin := os.Getenv("POCKLY_CLAUDE_BIN")
	if bin == "" {
		t.Skip("set POCKLY_CLAUDE_BIN to run against the real CLI")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	options, err := QueryClaudeCLIModels(ctx, bin)
	if err != nil {
		t.Fatalf("QueryClaudeCLIModels: %v", err)
	}
	if len(options) == 0 {
		t.Fatal("expected at least one model from the live CLI")
	}
	for _, opt := range options {
		t.Logf("model: value=%q label=%q resolved=%q", opt.Value, opt.Label, opt.ResolvedModel)
		if opt.Value == "" || opt.Label == "" {
			t.Fatalf("malformed option: %+v", opt)
		}
	}
}
