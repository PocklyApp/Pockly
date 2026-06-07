// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package codexapp talks to the Codex CLI app-server JSON-RPC control plane.
// It is intentionally transport-level and keeps product semantics in callers:
// Pockly remains the daemon/Nexus/web bridge, while Codex owns turns,
// approvals, models, and process PTY details.
package codexapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ExecFunc func(ctx context.Context, name string, args ...string) *exec.Cmd

type Config struct {
	BinaryPath string
	Cwd        string
	Exec       ExecFunc
	Logger     func(format string, args ...any)

	OnNotification  func(Notification)
	OnServerRequest func(context.Context, ServerRequest) (json.RawMessage, error)
}

type Client struct {
	cfg Config
	ctx context.Context

	mu      sync.Mutex
	writeMu sync.Mutex
	nextID  int64
	writer  io.WriteCloser
	cmd     *exec.Cmd
	pending map[string]chan rpcResponse
	closed  bool

	done chan struct{}
}

type Notification struct {
	Method string
	Params json.RawMessage
}

type ServerRequest struct {
	ID     string
	Method string
	Params json.RawMessage
}

type rpcResponse struct {
	Result json.RawMessage
	Error  *rpcError
}

type rpcError struct {
	Code    int             `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func Start(ctx context.Context, cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.BinaryPath) == "" {
		return nil, errors.New("codex app-server binary path required")
	}
	if cfg.Exec == nil {
		cfg.Exec = exec.CommandContext
	}
	if cfg.Logger == nil {
		cfg.Logger = func(string, ...any) {}
	}
	cmd := cfg.Exec(ctx, cfg.BinaryPath, "app-server", "--listen", "stdio://")
	if strings.TrimSpace(cfg.Cwd) != "" {
		cmd.Dir = cfg.Cwd
	}
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("codex app-server stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("codex app-server stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, fmt.Errorf("spawn codex app-server: %w", err)
	}
	c := &Client{
		cfg:     cfg,
		ctx:     ctx,
		writer:  stdin,
		cmd:     cmd,
		pending: map[string]chan rpcResponse{},
		done:    make(chan struct{}),
	}
	go c.readLoop(stdout)
	go c.drainStderr(stderr)
	go c.wait()
	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) initialize(ctx context.Context) error {
	params := map[string]any{
		"clientInfo": map[string]any{
			"name":    "pockly_daemon",
			"title":   "Pockly Daemon",
			"version": "0.0.0",
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}
	if _, err := c.Request(ctx, "initialize", params); err != nil {
		return fmt.Errorf("codex app-server initialize: %w", err)
	}
	if err := c.Notify("initialized", nil); err != nil {
		return fmt.Errorf("codex app-server initialized notify: %w", err)
	}
	return nil
}

func (c *Client) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextRequestID()
	ch := make(chan rpcResponse, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("codex app-server closed")
	}
	c.pending[id] = ch
	c.mu.Unlock()
	writeDone := make(chan error, 1)
	go func() {
		writeDone <- c.write(map[string]any{"id": id, "method": method, "params": params})
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			c.removePending(id)
			return nil, err
		}
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case <-c.done:
		c.removePending(id)
		return nil, errors.New("codex app-server exited")
	}
	select {
	case res := <-ch:
		if res.Error != nil {
			msg := strings.TrimSpace(res.Error.Message)
			if msg == "" {
				msg = "codex app-server rpc error"
			}
			return nil, errors.New(msg)
		}
		return res.Result, nil
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case <-c.done:
		c.removePending(id)
		return nil, errors.New("codex app-server exited")
	}
}

func (c *Client) Notify(method string, params any) error {
	msg := map[string]any{"method": method}
	if params != nil {
		msg["params"] = params
	}
	return c.write(msg)
}

func (c *Client) Reply(id string, result any) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("server request id required")
	}
	return c.write(map[string]any{"id": id, "result": result})
}

func (c *Client) ReplyError(id string, code int, message string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("server request id required")
	}
	return c.write(map[string]any{
		"id": id,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func (c *Client) ThreadStart(ctx context.Context, params ThreadStartParams) (ThreadStartResult, error) {
	raw, err := c.Request(ctx, "thread/start", params.toMap())
	if err != nil {
		return ThreadStartResult{}, err
	}
	return parseThreadStartResult(raw)
}

func (c *Client) ThreadResume(ctx context.Context, params ThreadResumeParams) (ThreadStartResult, error) {
	raw, err := c.Request(ctx, "thread/resume", params.toMap())
	if err != nil {
		return ThreadStartResult{}, err
	}
	return parseThreadStartResult(raw)
}

func (c *Client) TurnStart(ctx context.Context, params TurnStartParams) error {
	_, err := c.Request(ctx, "turn/start", params.toMap())
	return err
}

func (c *Client) ModelList(ctx context.Context) ([]Model, error) {
	raw, err := c.Request(ctx, "model/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Data []Model `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out.Data, nil
}

func (c *Client) CommandExec(ctx context.Context, params CommandExecParams) (CommandExecResult, error) {
	raw, err := c.Request(ctx, "command/exec", params.toMap())
	if err != nil {
		return CommandExecResult{}, err
	}
	var out CommandExecResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return CommandExecResult{}, err
	}
	return out, nil
}

func (c *Client) CommandExecWrite(ctx context.Context, processID, deltaBase64 string, closeStdin bool) error {
	params := map[string]any{"processId": processID, "closeStdin": closeStdin}
	if deltaBase64 != "" {
		params["deltaBase64"] = deltaBase64
	}
	_, err := c.Request(ctx, "command/exec/write", params)
	return err
}

func (c *Client) CommandExecTerminate(ctx context.Context, processID string) error {
	_, err := c.Request(ctx, "command/exec/terminate", map[string]any{"processId": processID})
	return err
}

func (c *Client) CommandExecResize(ctx context.Context, processID string, cols, rows int) error {
	_, err := c.Request(ctx, "command/exec/resize", map[string]any{
		"processId": processID,
		"size": map[string]any{
			"cols": cols,
			"rows": rows,
		},
	})
	return err
}

func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	writer := c.writer
	cmd := c.cmd
	for id, ch := range c.pending {
		delete(c.pending, id)
		ch <- rpcResponse{Error: &rpcError{Message: "codex app-server closed"}}
	}
	c.mu.Unlock()
	if writer != nil {
		_ = writer.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	return nil
}

func (c *Client) nextRequestID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return strconv.FormatInt(c.nextID, 10)
}

func (c *Client) removePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) write(msg map[string]any) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	writer := c.writer
	closed := c.closed
	c.mu.Unlock()
	if closed || writer == nil {
		return errors.New("codex app-server closed")
	}
	raw = append(raw, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = writer.Write(raw)
	return err
}

func (c *Client) readLoop(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		c.handleLine(line)
	}
	if err := scanner.Err(); err != nil {
		c.logf("codex app-server stdout scan error: %v", err)
	}
	c.closePending("codex app-server stdout closed")
}

func (c *Client) handleLine(line []byte) {
	var env struct {
		ID     json.RawMessage `json:"id,omitempty"`
		Method string          `json:"method,omitempty"`
		Params json.RawMessage `json:"params,omitempty"`
		Result json.RawMessage `json:"result,omitempty"`
		Error  *rpcError       `json:"error,omitempty"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		c.logf("codex app-server decode: %v", err)
		return
	}
	id := compactID(env.ID)
	if id != "" && env.Method == "" {
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- rpcResponse{Result: env.Result, Error: env.Error}
		}
		return
	}
	if id != "" && env.Method != "" {
		req := ServerRequest{ID: id, Method: env.Method, Params: env.Params}
		go c.handleServerRequest(req)
		return
	}
	if env.Method != "" && c.cfg.OnNotification != nil {
		c.cfg.OnNotification(Notification{Method: env.Method, Params: env.Params})
	}
}

func (c *Client) handleServerRequest(req ServerRequest) {
	if c.cfg.OnServerRequest == nil {
		_ = c.ReplyError(req.ID, -32601, "server request handler not configured")
		return
	}
	ctx := c.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	result, err := c.cfg.OnServerRequest(ctx, req)
	if err != nil {
		_ = c.ReplyError(req.ID, -32000, err.Error())
		return
	}
	var value any = map[string]any{}
	if len(result) > 0 && string(result) != "null" {
		value = json.RawMessage(result)
	}
	if err := c.Reply(req.ID, value); err != nil {
		c.logf("codex app-server reply id=%s method=%s: %v", req.ID, req.Method, err)
	}
}

func (c *Client) drainStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 4*1024), 1*1024*1024)
	for scanner.Scan() {
		c.logf("codex app-server stderr: %s", scanner.Text())
	}
}

func (c *Client) logf(format string, args ...any) {
	if c.cfg.Logger != nil {
		c.cfg.Logger(format, args...)
	}
}

func (c *Client) wait() {
	if c.cmd != nil {
		_ = c.cmd.Wait()
	}
	c.mu.Lock()
	if !c.closed {
		c.closed = true
	}
	c.mu.Unlock()
	c.closePending("codex app-server exited")
	select {
	case <-c.done:
	default:
		close(c.done)
	}
}

func (c *Client) closePending(message string) {
	c.mu.Lock()
	pending := c.pending
	c.pending = map[string]chan rpcResponse{}
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- rpcResponse{Error: &rpcError{Message: message}}
	}
}

func compactID(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

type ThreadStartParams struct {
	Cwd            string
	Model          string
	ApprovalPolicy string
	Sandbox        string
}

func (p ThreadStartParams) toMap() map[string]any {
	out := map[string]any{}
	if p.Cwd != "" {
		out["cwd"] = p.Cwd
	}
	if p.Model != "" {
		out["model"] = p.Model
	}
	if p.ApprovalPolicy != "" {
		out["approvalPolicy"] = p.ApprovalPolicy
	}
	if p.Sandbox != "" {
		out["sandbox"] = p.Sandbox
	}
	return out
}

type ThreadResumeParams struct {
	ThreadID       string
	Cwd            string
	Model          string
	ApprovalPolicy string
}

func (p ThreadResumeParams) toMap() map[string]any {
	out := map[string]any{"threadId": p.ThreadID}
	if p.Cwd != "" {
		out["cwd"] = p.Cwd
	}
	if p.Model != "" {
		out["model"] = p.Model
	}
	if p.ApprovalPolicy != "" {
		out["approvalPolicy"] = p.ApprovalPolicy
	}
	return out
}

type TurnStartParams struct {
	ThreadID       string
	Cwd            string
	Model          string
	Effort         string
	ApprovalPolicy string
	Text           string
}

func (p TurnStartParams) toMap() map[string]any {
	out := map[string]any{
		"threadId": p.ThreadID,
		"input": []map[string]any{{
			"type":          "text",
			"text":          p.Text,
			"text_elements": []any{},
		}},
	}
	if p.Cwd != "" {
		out["cwd"] = p.Cwd
	}
	if p.Model != "" {
		out["model"] = p.Model
	}
	if p.Effort != "" && p.Effort != "max" {
		out["effort"] = p.Effort
	}
	if p.ApprovalPolicy != "" {
		out["approvalPolicy"] = p.ApprovalPolicy
	}
	return out
}

type ThreadStartResult struct {
	ThreadID string
	Cwd      string
	Model    string
}

func parseThreadStartResult(raw json.RawMessage) (ThreadStartResult, error) {
	var out struct {
		Cwd    string `json:"cwd"`
		Model  string `json:"model"`
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return ThreadStartResult{}, err
	}
	if out.Thread.ID == "" {
		return ThreadStartResult{}, errors.New("codex app-server response missing thread.id")
	}
	return ThreadStartResult{ThreadID: out.Thread.ID, Cwd: out.Cwd, Model: out.Model}, nil
}

type Model struct {
	ID                        string                  `json:"id"`
	Model                     string                  `json:"model"`
	DisplayName               string                  `json:"displayName"`
	IsDefault                 bool                    `json:"isDefault"`
	Hidden                    bool                    `json:"hidden"`
	DefaultReasoningEffort    string                  `json:"defaultReasoningEffort"`
	SupportedReasoningEfforts []ReasoningEffortOption `json:"supportedReasoningEfforts"`
}

type ReasoningEffortOption struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type CommandExecParams struct {
	ProcessID string
	Command   []string
	Cwd       string
	TTY       bool
	Cols      int
	Rows      int
}

func (p CommandExecParams) toMap() map[string]any {
	out := map[string]any{
		"command":            p.Command,
		"tty":                p.TTY,
		"streamStdin":        true,
		"streamStdoutStderr": true,
		"disableTimeout":     true,
		"disableOutputCap":   true,
	}
	if p.ProcessID != "" {
		out["processId"] = p.ProcessID
	}
	if p.Cwd != "" {
		out["cwd"] = p.Cwd
	}
	if p.TTY {
		cols := p.Cols
		if cols <= 0 {
			cols = 100
		}
		rows := p.Rows
		if rows <= 0 {
			rows = 30
		}
		out["size"] = map[string]any{"cols": cols, "rows": rows}
	}
	return out
}

type CommandExecResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func DeadlineContext(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, d)
}
