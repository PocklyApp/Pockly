// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package sdkdriver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/agent/codexapp"
	"github.com/PocklyApp/Pockly/daemon/internal/permission"
	"github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

type CodexAppRuntime interface {
	ThreadStart(context.Context, codexapp.ThreadStartParams) (codexapp.ThreadStartResult, error)
	ThreadResume(context.Context, codexapp.ThreadResumeParams) (codexapp.ThreadStartResult, error)
	TurnStart(context.Context, codexapp.TurnStartParams) error
	ModelList(context.Context) ([]codexapp.Model, error)
	Close() error
}

type CodexAppFactory func(context.Context, codexapp.Config) (CodexAppRuntime, error)

type codexItemState struct {
	Type           string
	Command        string
	Cwd            string
	ToolUseEmitted bool
}

var codexTurnTimeout = 120 * time.Second

func defaultCodexAppFactory(ctx context.Context, cfg codexapp.Config) (CodexAppRuntime, error) {
	return codexapp.Start(ctx, cfg)
}

func (d *Driver) startCodexApp(ctx context.Context) error {
	d.mu.Lock()
	if d.codex != nil {
		d.mu.Unlock()
		return nil
	}
	factory := d.cfg.CodexAppFactory
	if factory == nil {
		factory = defaultCodexAppFactory
	}
	d.mu.Unlock()

	cfg := codexapp.Config{
		BinaryPath: d.cfg.BinaryPath,
		Cwd:        d.cfg.Cwd,
		Logger:     d.cfg.Logger,
		OnNotification: func(n codexapp.Notification) {
			d.handleCodexNotification(n)
		},
		OnServerRequest: func(ctx context.Context, req codexapp.ServerRequest) (json.RawMessage, error) {
			return d.handleCodexServerRequest(ctx, req)
		},
	}
	if execFn := d.cfg.Exec; execFn != nil {
		cfg.Exec = func(ctx context.Context, name string, args ...string) *exec.Cmd {
			return execFn(ctx, name, args...)
		}
	}
	app, err := factory(ctx, cfg)
	if err != nil {
		return err
	}
	d.mu.Lock()
	if d.codex != nil {
		d.mu.Unlock()
		_ = app.Close()
		return nil
	}
	d.codex = app
	d.mu.Unlock()
	return nil
}

func codexAppServerUnavailableError(err error) error {
	if err == nil {
		return errors.New("codex_app_server_unavailable: please upgrade Codex CLI to >= 0.130.0")
	}
	return fmt.Errorf("codex_app_server_unavailable: please upgrade Codex CLI to >= 0.130.0: %w", err)
}

func (d *Driver) closeCodexApp() {
	d.mu.Lock()
	app := d.codex
	d.codex = nil
	// The next app-server is a fresh process with no loaded threads, so force
	// ensureCodexThread to start/resume again before the next TurnStart.
	d.codexThreadID = ""
	d.mu.Unlock()
	if app != nil {
		_ = app.Close()
	}
}

func (d *Driver) ensureCodexThread(ctx context.Context) (string, error) {
	d.mu.Lock()
	loaded := d.codexThreadID
	app := d.codex
	d.mu.Unlock()
	if app == nil {
		return "", errors.New("codex app-server not started")
	}
	// Skip start/resume only when THIS app-server instance has already loaded
	// the thread. The session's bound id is not a proxy for that: the driver
	// pre-binds it on spawn, so keying the skip off it meant ThreadResume was
	// never called on a freshly-spawned app-server, and the subsequent
	// TurnStart failed with "thread not found".
	if loaded != "" {
		return loaded, nil
	}
	approvalPolicy := codexApprovalPolicy(d.cfg.PermissionMode)
	sandbox := codexSandbox(d.cfg.PermissionMode)
	var res codexapp.ThreadStartResult
	var err error
	if d.cfg.NewSession {
		res, err = app.ThreadStart(ctx, codexapp.ThreadStartParams{
			Cwd:            d.cfg.Cwd,
			Model:          strings.TrimSpace(d.cfg.Model),
			ApprovalPolicy: approvalPolicy,
			Sandbox:        sandbox,
		})
	} else {
		res, err = app.ThreadResume(ctx, codexapp.ThreadResumeParams{
			ThreadID:       d.cfg.SessionID,
			Path:           d.cfg.ResumePath,
			Cwd:            d.cfg.Cwd,
			Model:          strings.TrimSpace(d.cfg.Model),
			ApprovalPolicy: approvalPolicy,
			Sandbox:        sandbox,
		})
	}
	if err != nil {
		return "", err
	}
	cwd := firstNonEmpty(res.Cwd, d.cfg.Cwd)
	d.mu.Lock()
	d.codexThreadID = res.ThreadID
	d.mu.Unlock()
	d.session.BindSessionMetadata(res.ThreadID, cwd)
	return res.ThreadID, nil
}

func (d *Driver) runCodexTurn(ctx context.Context, prompt string) {
	if err := d.startCodexApp(ctx); err != nil {
		d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", codexAppServerUnavailableError(err).Error())
		d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
		return
	}
	d.cfg.Logger("sdkdriver: codex turn starting sid=%s", d.cfg.SessionID)
	threadID, err := d.ensureCodexThread(ctx)
	if err != nil {
		d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", err.Error())
		d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
		return
	}
	d.cfg.Logger("sdkdriver: codex thread ready sid=%s thread=%s", d.cfg.SessionID, threadID)
	d.mu.Lock()
	app := d.codex
	d.turnInFlight = true
	d.codexTurnID++
	turnID := d.codexTurnID
	d.codexTurnHadSignal = false
	d.codexTurnHadDurableOutput = false
	d.codexTurnLastError = ""
	d.lastActivity = time.Now()
	d.mu.Unlock()
	d.session.Emit(terminal.EventUserInput, terminal.SessionLive, terminal.TurnSubmitted, prompt, "")
	go d.watchCodexTurnCompletion(ctx, turnID, threadID)
	turnCtx, cancel := context.WithTimeout(ctx, codexTurnTimeout)
	defer cancel()
	if err := app.TurnStart(turnCtx, codexapp.TurnStartParams{
		ThreadID:       threadID,
		Cwd:            d.cfg.Cwd,
		Model:          strings.TrimSpace(d.cfg.Model),
		Effort:         strings.TrimSpace(d.cfg.Effort),
		ApprovalPolicy: codexApprovalPolicy(d.cfg.PermissionMode),
		Text:           prompt,
	}); err != nil {
		d.mu.Lock()
		if d.codexTurnID != turnID {
			d.mu.Unlock()
			return
		}
		d.turnInFlight = false
		d.codexTurnID++
		d.lastActivity = time.Now()
		d.mu.Unlock()
		msg := err.Error()
		if errors.Is(err, context.DeadlineExceeded) {
			msg = fmt.Sprintf("codex_turn_timeout: turn/start produced no result within %s", codexTurnTimeout)
			d.closeCodexApp()
		}
		d.cfg.Logger("sdkdriver: codex turn failed sid=%s thread=%s err=%s", d.cfg.SessionID, threadID, msg)
		d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", msg)
		d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
		return
	}
}

func (d *Driver) watchCodexTurnCompletion(ctx context.Context, turnID int64, threadID string) {
	d.cfg.Logger("sdkdriver: codex turn watchdog started sid=%s thread=%s turn_id=%d timeout=%s", d.cfg.SessionID, threadID, turnID, codexTurnTimeout)
	timer := time.NewTimer(codexTurnTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		d.cfg.Logger("sdkdriver: codex turn watchdog cancelled sid=%s thread=%s turn_id=%d err=%v", d.cfg.SessionID, threadID, turnID, ctx.Err())
		return
	case <-timer.C:
	}
	d.mu.Lock()
	if !d.turnInFlight || d.codexTurnID != turnID {
		inFlight := d.turnInFlight
		currentTurnID := d.codexTurnID
		d.mu.Unlock()
		d.cfg.Logger("sdkdriver: codex turn watchdog skipped sid=%s thread=%s turn_id=%d in_flight=%v current_turn_id=%d", d.cfg.SessionID, threadID, turnID, inFlight, currentTurnID)
		return
	}
	d.turnInFlight = false
	d.codexTurnID++
	d.lastActivity = time.Now()
	d.mu.Unlock()
	msg := fmt.Sprintf("codex_turn_timeout: turn did not complete within %s", codexTurnTimeout)
	d.cfg.Logger("sdkdriver: codex turn completion timeout sid=%s thread=%s turn_id=%d", d.cfg.SessionID, threadID, turnID)
	d.closeCodexApp()
	d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", msg)
	d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
}

func (d *Driver) timeoutCodexTurnFromReaper(now time.Time) bool {
	if d.cfg.Agent != AgentCodex {
		return false
	}
	d.mu.Lock()
	if !d.turnInFlight || now.Sub(d.lastActivity) < codexTurnTimeout {
		inFlight := d.turnInFlight
		idleFor := now.Sub(d.lastActivity)
		d.mu.Unlock()
		d.cfg.Logger("sdkdriver: codex turn reaper timeout skipped sid=%s in_flight=%v idle_for=%s", d.cfg.SessionID, inFlight, idleFor)
		return false
	}
	d.turnInFlight = false
	d.codexTurnID++
	d.lastActivity = now
	d.mu.Unlock()
	msg := fmt.Sprintf("codex_turn_timeout: turn did not complete within %s", codexTurnTimeout)
	d.cfg.Logger("sdkdriver: codex turn reaper timeout sid=%s", d.cfg.SessionID)
	d.closeCodexApp()
	d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", msg)
	d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
	return true
}

func (d *Driver) handleCodexNotification(n codexapp.Notification) {
	d.cfg.Logger("sdkdriver: codex notification sid=%s method=%s bytes=%d", d.cfg.SessionID, n.Method, len(n.Params))
	switch n.Method {
	case "item/started":
		d.markCodexTurnSignal()
		d.handleCodexItemStarted(n.Params)
	case "item/completed":
		d.markCodexTurnSignal()
		d.handleCodexItemCompleted(n.Params)
	case "item/commandExecution/outputDelta":
		d.markCodexTurnSignal()
		d.handleCodexCommandOutputDelta(n.Params)
	case "item/agentMessage/delta":
		// Live-only feedback; the durable assistant_text row is emitted when
		// Codex sends item/completed with the full item text.
		var p struct {
			Delta string `json:"delta"`
		}
		if json.Unmarshal(n.Params, &p) == nil && strings.TrimSpace(p.Delta) != "" {
			d.markCodexTurnSignal()
			d.session.Emit(terminal.EventTextDelta, terminal.SessionLive, terminal.TurnStreaming, p.Delta, "")
		}
	case "error":
		d.markCodexTurnSignal()
		if msg := codexNotificationErrorMessage(n.Params); msg != "" {
			d.mu.Lock()
			d.codexTurnLastError = msg
			d.mu.Unlock()
			d.cfg.Logger("sdkdriver: codex error notification sid=%s error=%s", d.cfg.SessionID, msg)
		}
	case "turn/completed":
		d.mu.Lock()
		hadSignal := d.codexTurnHadSignal
		hadDurableOutput := d.codexTurnHadDurableOutput
		lastError := d.codexTurnLastError
		d.turnInFlight = false
		d.codexTurnID++
		d.lastActivity = time.Now()
		d.mu.Unlock()
		d.cfg.Logger("sdkdriver: codex turn completed sid=%s had_signal=%v had_durable_output=%v", d.cfg.SessionID, hadSignal, hadDurableOutput)
		if !hadDurableOutput {
			msg := "codex_turn_empty: Codex completed the turn without emitting any message or tool event"
			if strings.TrimSpace(lastError) != "" {
				msg = "codex_turn_error: " + strings.TrimSpace(lastError)
			}
			d.cfg.Logger("sdkdriver: codex turn completed without durable output sid=%s had_signal=%v", d.cfg.SessionID, hadSignal)
			d.markCodexTurnDurableOutput()
			d.session.Emit(terminal.EventAgentError, terminal.SessionLive, terminal.TurnAwaitingInput, "", msg)
		}
		d.session.Emit(terminal.EventPromptReady, terminal.SessionLive, terminal.TurnAwaitingInput, "", "")
	default:
		d.markCodexTurnSignal()
	}
}

func (d *Driver) markCodexTurnSignal() {
	d.mu.Lock()
	d.codexTurnHadSignal = true
	d.mu.Unlock()
}

func (d *Driver) markCodexTurnDurableOutput() {
	d.mu.Lock()
	d.codexTurnHadSignal = true
	d.codexTurnHadDurableOutput = true
	d.mu.Unlock()
}

func codexNotificationErrorMessage(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return strings.TrimSpace(string(raw))
	}
	parts := codexErrorParts(value, 0)
	if len(parts) == 0 {
		return strings.TrimSpace(string(raw))
	}
	return strings.Join(parts, ": ")
}

func codexErrorParts(value any, depth int) []string {
	if depth > 4 || value == nil {
		return nil
	}
	switch v := value.(type) {
	case string:
		if s := strings.TrimSpace(v); s != "" {
			return []string{s}
		}
	case map[string]any:
		var parts []string
		for _, key := range []string{"code", "type", "reason", "message", "error", "details", "detail"} {
			if child, ok := v[key]; ok {
				parts = append(parts, codexErrorParts(child, depth+1)...)
			}
		}
		return compactStringParts(parts)
	case []any:
		var parts []string
		for _, child := range v {
			parts = append(parts, codexErrorParts(child, depth+1)...)
		}
		return compactStringParts(parts)
	}
	return nil
}

func compactStringParts(parts []string) []string {
	out := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		out = append(out, part)
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

func (d *Driver) handleCodexItemStarted(raw json.RawMessage) {
	var p struct {
		Item json.RawMessage `json:"item"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || len(p.Item) == 0 {
		return
	}
	var item struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Command string `json:"command,omitempty"`
		Cwd     string `json:"cwd,omitempty"`
	}
	if err := json.Unmarshal(p.Item, &item); err != nil || item.ID == "" {
		return
	}
	d.mu.Lock()
	state := d.codexItems[item.ID]
	state.Type = item.Type
	if item.Command != "" {
		state.Command = item.Command
	}
	if item.Cwd != "" {
		state.Cwd = item.Cwd
	}
	d.codexItems[item.ID] = state
	d.mu.Unlock()
	switch item.Type {
	case "commandExecution":
		d.emitCodexToolUseOnce(item.ID, "Bash", map[string]any{"command": state.Command, "cwd": state.Cwd})
	case "fileChange":
		d.emitCodexToolUseOnce(item.ID, "ApplyPatch", rawObjectOrEmpty(p.Item))
	}
}

func (d *Driver) handleCodexItemCompleted(raw json.RawMessage) {
	var p struct {
		Item json.RawMessage `json:"item"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || len(p.Item) == 0 {
		return
	}
	var item struct {
		ID               string          `json:"id"`
		Type             string          `json:"type"`
		Text             string          `json:"text,omitempty"`
		Content          []string        `json:"content,omitempty"`
		Summary          []string        `json:"summary,omitempty"`
		Command          string          `json:"command,omitempty"`
		Cwd              string          `json:"cwd,omitempty"`
		AggregatedOutput *string         `json:"aggregatedOutput,omitempty"`
		ExitCode         *int            `json:"exitCode,omitempty"`
		Status           string          `json:"status,omitempty"`
		Changes          json.RawMessage `json:"changes,omitempty"`
		Server           string          `json:"server,omitempty"`
		Tool             string          `json:"tool,omitempty"`
		Arguments        json.RawMessage `json:"arguments,omitempty"`
		Result           json.RawMessage `json:"result,omitempty"`
		Error            json.RawMessage `json:"error,omitempty"`
		Namespace        string          `json:"namespace,omitempty"`
		ContentItems     json.RawMessage `json:"contentItems,omitempty"`
		Success          *bool           `json:"success,omitempty"`
	}
	if err := json.Unmarshal(p.Item, &item); err != nil || item.ID == "" {
		return
	}
	switch item.Type {
	case "agentMessage":
		d.emitClaudeLikeText("assistant", item.ID, item.Text)
	case "reasoning":
		text := strings.Join(append(item.Summary, item.Content...), "\n\n")
		d.emitClaudeLikeThinking(item.ID, text)
	case "commandExecution":
		result := ""
		if item.AggregatedOutput != nil {
			result = *item.AggregatedOutput
		}
		if result == "" {
			result = fmt.Sprintf("status=%s", item.Status)
		}
		isErr := item.ExitCode != nil && *item.ExitCode != 0
		d.emitClaudeLikeToolResult(item.ID, result, isErr)
	case "fileChange":
		result := string(item.Changes)
		if result == "" || result == "null" {
			result = fmt.Sprintf("status=%s", item.Status)
		}
		d.emitClaudeLikeToolResult(item.ID, result, item.Status == "failed")
	case "mcpToolCall":
		tool := item.Tool
		if item.Server != "" {
			tool = item.Server + "." + item.Tool
		}
		if tool == "" {
			tool = "MCP"
		}
		d.emitCodexToolUseOnce(item.ID, tool, rawObjectOrEmpty(item.Arguments))
		result := firstNonEmpty(string(item.Result), string(item.Error), fmt.Sprintf("status=%s", item.Status))
		d.emitClaudeLikeToolResult(item.ID, result, len(item.Error) > 0 && string(item.Error) != "null")
	case "dynamicToolCall":
		tool := item.Tool
		if item.Namespace != "" {
			tool = item.Namespace + "." + item.Tool
		}
		if tool == "" {
			tool = "Tool"
		}
		d.emitCodexToolUseOnce(item.ID, tool, rawObjectOrEmpty(item.Arguments))
		result := string(item.ContentItems)
		if result == "" || result == "null" {
			result = fmt.Sprintf("status=%s", item.Status)
		}
		isErr := item.Success != nil && !*item.Success
		d.emitClaudeLikeToolResult(item.ID, result, isErr)
	}
}

func (d *Driver) handleCodexCommandOutputDelta(raw json.RawMessage) {
	var p struct {
		ItemID string `json:"itemId"`
		Delta  string `json:"delta"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.ItemID == "" || p.Delta == "" {
		return
	}
	d.session.Emit(terminal.EventTextDelta, terminal.SessionLive, terminal.TurnStreaming, p.Delta, "")
}

func (d *Driver) handleCodexServerRequest(ctx context.Context, req codexapp.ServerRequest) (json.RawMessage, error) {
	if d.cfg.PermissionStore == nil {
		return nil, errors.New("permission store not configured")
	}
	toolName, input, responseKind := codexApprovalInput(req)
	if toolName == "" {
		return nil, fmt.Errorf("unsupported codex server request: %s", req.Method)
	}
	d.emitCodexApprovalToolUse(req, toolName, input, responseKind)
	threadID := d.session.ClaudeSessionID()
	pReq := permission.Request{
		ID:                req.ID,
		TerminalSessionID: d.cfg.TerminalSessionID,
		ClaudeSessionID:   threadID,
		ToolName:          toolName,
		Input:             input,
	}
	if err := d.cfg.PermissionStore.Register(pReq); err != nil && !errors.Is(err, permission.ErrAlreadyExists) {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]any{
		"tool_name":  toolName,
		"input":      rawOrEmpty(input),
		"decision":   "pending",
		"reason":     "awaiting web decision",
		"ts":         time.Now().UTC().Format(time.RFC3339),
		"request_id": req.ID,
		"agent":      "codex",
	})
	d.session.Emit(terminal.EventKind("permission_request"), terminal.SessionLive, terminal.TurnStreaming, string(payload), "")
	out, err := d.cfg.PermissionStore.Await(ctx, req.ID, 0)
	if err != nil {
		return nil, err
	}
	accepted := out.Decision == permission.DecisionAllow
	switch responseKind {
	case "command", "file":
		decision := "decline"
		if accepted {
			decision = "accept"
		}
		return json.Marshal(map[string]any{"decision": decision})
	case "permissions":
		if accepted {
			var p struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			_ = json.Unmarshal(req.Params, &p)
			return json.Marshal(map[string]any{"permissions": rawObjectOrEmpty(p.Permissions), "scope": "turn"})
		}
		return json.Marshal(map[string]any{"permissions": map[string]any{}, "scope": "turn"})
	default:
		return nil, fmt.Errorf("unsupported codex approval response kind: %s", responseKind)
	}
}

func codexApprovalInput(req codexapp.ServerRequest) (toolName string, input json.RawMessage, responseKind string) {
	var m map[string]any
	_ = json.Unmarshal(req.Params, &m)
	input, _ = json.Marshal(m)
	switch req.Method {
	case "item/commandExecution/requestApproval":
		return "Bash", input, "command"
	case "item/fileChange/requestApproval":
		return "FileChange", input, "file"
	case "item/permissions/requestApproval":
		return "Permissions", input, "permissions"
	default:
		return "", nil, ""
	}
}

func (d *Driver) emitCodexApprovalToolUse(req codexapp.ServerRequest, toolName string, input json.RawMessage, responseKind string) {
	switch responseKind {
	case "command":
		var p struct {
			ItemID  string `json:"itemId"`
			Command string `json:"command"`
			Cwd     string `json:"cwd"`
		}
		_ = json.Unmarshal(req.Params, &p)
		id := firstNonEmpty(p.ItemID, req.ID)
		d.emitCodexToolUseOnce(id, toolName, map[string]any{"command": p.Command, "cwd": p.Cwd})
	case "file":
		var p struct {
			ItemID string `json:"itemId"`
		}
		_ = json.Unmarshal(req.Params, &p)
		d.emitCodexToolUseOnce(firstNonEmpty(p.ItemID, req.ID), toolName, rawObjectOrEmpty(input))
	}
}

func (d *Driver) emitCodexToolUseOnce(id, name string, input any) {
	if strings.TrimSpace(id) == "" {
		return
	}
	d.mu.Lock()
	state := d.codexItems[id]
	if state.ToolUseEmitted {
		d.mu.Unlock()
		return
	}
	state.ToolUseEmitted = true
	d.codexItems[id] = state
	d.mu.Unlock()
	raw, _ := json.Marshal(input)
	d.emitClaudeLikeToolUse(id, name, raw)
}

func (d *Driver) emitClaudeLikeText(role, uuid, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	d.markCodexTurnDurableOutput()
	contentType := "text"
	if role == "user" {
		contentType = "text"
	}
	raw, _ := json.Marshal(map[string]any{
		"type": role,
		"uuid": uuid,
		"message": map[string]any{
			"role": role,
			"content": []map[string]any{{
				"type": contentType,
				"text": text,
			}},
		},
	})
	d.session.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, string(raw), "")
}

func (d *Driver) emitClaudeLikeThinking(uuid, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	d.markCodexTurnDurableOutput()
	raw, _ := json.Marshal(map[string]any{
		"type": "assistant",
		"uuid": uuid,
		"message": map[string]any{
			"role": "assistant",
			"content": []map[string]any{{
				"type":     "thinking",
				"thinking": text,
			}},
		},
	})
	d.session.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, string(raw), "")
}

func (d *Driver) emitClaudeLikeToolUse(id, name string, input json.RawMessage) {
	d.markCodexTurnDurableOutput()
	raw, _ := json.Marshal(map[string]any{
		"type": "assistant",
		"uuid": id,
		"message": map[string]any{
			"role": "assistant",
			"content": []map[string]any{{
				"type":  "tool_use",
				"id":    id,
				"name":  name,
				"input": rawObjectOrEmpty(input),
			}},
		},
	})
	d.session.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, string(raw), "")
}

func (d *Driver) emitClaudeLikeToolResult(id, result string, isErr bool) {
	d.markCodexTurnDurableOutput()
	raw, _ := json.Marshal(map[string]any{
		"type": "user",
		"uuid": id + "-result",
		"message": map[string]any{
			"role": "user",
			"content": []map[string]any{{
				"type":        "tool_result",
				"tool_use_id": id,
				"content":     result,
				"is_error":    isErr,
			}},
		},
	})
	d.session.Emit(terminal.EventMessageAdded, terminal.SessionLive, terminal.TurnStreaming, string(raw), "")
}

// Codex permission presets — Pockly UI tokens, each encoding a codex
// (approvalPolicy, sandbox) pair to mirror codex's own three-way approval
// picker (see codex's TUI). The daemon's agent-settings snapshot offers
// exactly these for codex sessions; the claude-vocabulary tokens
// (default/acceptEdits/...) are still accepted as legacy aliases so a
// session that recorded one before this change keeps mapping sensibly.
const (
	// CodexModeRequestApproval — "请求批准": edit the workspace freely but ask
	// before touching files outside it or the network. on-request + workspaceWrite.
	CodexModeRequestApproval = "request-approval"
	// CodexModeApproveForMe — "替我审批": only interrupt for risky/blocked ops.
	// on-failure + workspaceWrite.
	CodexModeApproveForMe = "approve-for-me"
	// CodexModeFullAccess — "完全访问权限": no approvals, full disk + network.
	// never + dangerFullAccess.
	CodexModeFullAccess = "full-access"
)

// CodexPermissionModes is the ordered preset list the codex run-config pill shows.
func CodexPermissionModes() []string {
	return []string{CodexModeRequestApproval, CodexModeApproveForMe, CodexModeFullAccess}
}

// CodexEffortLevels are the reasoning levels codex's UI exposes (no
// none/minimal/max — those are claude-only or non-UI).
func CodexEffortLevels() []string {
	return []string{"low", "medium", "high", "xhigh"}
}

// codexApprovalPolicy maps a Pockly permission token to codex's AskForApproval
// string. Empty token returns "" so the daemon omits approvalPolicy entirely and
// codex falls back to the user's own config.toml default ("follow codex config").
func codexApprovalPolicy(mode string) string {
	switch strings.TrimSpace(mode) {
	case "":
		return ""
	case CodexModeApproveForMe, "auto", "acceptEdits":
		return "on-failure"
	case CodexModeFullAccess, "bypassPermissions", "dontAsk":
		return "never"
	case CodexModeRequestApproval, "plan", "default":
		return "on-request"
	default:
		return "on-request"
	}
}

// codexSandbox maps a Pockly permission token to a codex sandbox mode string.
// The app-server's `sandbox` field is a kebab-case enum
// (read-only | workspace-write | danger-full-access), NOT the tagged-object
// SandboxPolicy the generated schema shows — verified against the real binary.
// Empty token returns "" so the daemon omits sandbox and codex uses its own
// config.toml default. A non-empty token always pins BOTH approval and sandbox
// so an explicit pick fully defines the mode (e.g. request-approval must force
// workspace-write even if the user's config default were danger-full-access).
func codexSandbox(mode string) string {
	switch strings.TrimSpace(mode) {
	case "":
		return ""
	case CodexModeFullAccess, "bypassPermissions", "dontAsk":
		return "danger-full-access"
	default:
		return "workspace-write"
	}
}

func rawOrEmpty(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}
	}
	return json.RawMessage(raw)
}

func rawObjectOrEmpty(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}
	}
	return json.RawMessage(raw)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
