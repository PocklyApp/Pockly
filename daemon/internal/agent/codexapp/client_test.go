// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package codexapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("POCKLY_CODEXAPP_HELPER") == "1" {
		os.Exit(runCodexAppClientHelperProcess())
	}
	os.Exit(m.Run())
}

func TestClientInitializeModelListAndNotification(t *testing.T) {
	clientToServerR, clientToServerW := io.Pipe()
	serverToClientR, serverToClientW := io.Pipe()
	defer clientToServerR.Close()
	defer serverToClientR.Close()
	go fakeCodexRPCServer(t, clientToServerR, serverToClientW)

	notifications := make(chan Notification, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c := &Client{
		cfg: Config{OnNotification: func(n Notification) {
			notifications <- n
		}},
		ctx:     ctx,
		writer:  clientToServerW,
		pending: map[string]chan rpcResponse{},
		done:    make(chan struct{}),
	}
	go c.readLoop(serverToClientR)
	defer c.Close()
	if err := c.initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	models, err := c.ModelList(ctx)
	if err != nil {
		t.Fatalf("ModelList: %v", err)
	}
	if len(models) != 1 || models[0].ID != "gpt-5.4" {
		t.Fatalf("models = %+v", models)
	}
	select {
	case n := <-notifications:
		if n.Method != "remoteControl/status/changed" {
			t.Fatalf("notification method = %q", n.Method)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("expected initialized-side notification")
	}
}

func TestTurnStartParamsTextInputMatchesSchema(t *testing.T) {
	params := TurnStartParams{ThreadID: "thread_1", Text: "hello", Effort: "minimal"}
	raw := params.toMap()
	inputs, ok := raw["input"].([]map[string]any)
	if !ok || len(inputs) != 1 {
		t.Fatalf("input = %#v", raw["input"])
	}
	if inputs[0]["type"] != "text" || inputs[0]["text"] != "hello" {
		t.Fatalf("bad text input: %#v", inputs[0])
	}
	if _, ok := inputs[0]["text_elements"].([]any); !ok {
		t.Fatalf("text input missing text_elements array: %#v", inputs[0])
	}
	if raw["effort"] != "minimal" {
		t.Fatalf("effort = %#v, want minimal", raw["effort"])
	}
}

func TestThreadResumeParamsMatchesSchema(t *testing.T) {
	raw := ThreadResumeParams{
		ThreadID:       "thread_1",
		Cwd:            "/tmp/project",
		Model:          "gpt-5.1-codex",
		ApprovalPolicy: "on-request",
	}.toMap()
	if raw["threadId"] != "thread_1" {
		t.Fatalf("threadId = %#v", raw["threadId"])
	}
	if _, ok := raw["excludeTurns"]; ok {
		t.Fatalf("thread/resume must not send schema-unknown excludeTurns: %#v", raw)
	}
	// An empty path must be omitted (the schema treats "" as absent).
	if _, ok := raw["path"]; ok {
		t.Fatalf("empty path must be omitted: %#v", raw)
	}
}

func TestThreadResumeParamsSendsPathWhenSet(t *testing.T) {
	// Resuming by path lets a freshly-spawned app-server load the thread from
	// disk (resuming by threadId alone yields "thread not found").
	raw := ThreadResumeParams{
		ThreadID: "019eaafd",
		Path:     "/Users/me/.codex/sessions/2026/06/09/rollout-...-019eaafd.jsonl",
	}.toMap()
	if raw["path"] != "/Users/me/.codex/sessions/2026/06/09/rollout-...-019eaafd.jsonl" {
		t.Fatalf("path = %#v, want the rollout path", raw["path"])
	}
	if raw["threadId"] != "019eaafd" {
		t.Fatalf("threadId still required alongside path: %#v", raw)
	}
}

func TestRequestTimeoutCoversBlockedWrite(t *testing.T) {
	writer := &blockingWriteCloser{release: make(chan struct{})}
	c := &Client{writer: writer, pending: map[string]chan rpcResponse{}, done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := c.Request(ctx, "turn/start", map[string]any{"threadId": "thread_1"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Request error = %v, want DeadlineExceeded", err)
	}
	close(writer.release)
}

func TestReadLoopHandlesLargeJSONLines(t *testing.T) {
	r, w := io.Pipe()
	notifications := make(chan Notification, 1)
	c := &Client{
		cfg: Config{OnNotification: func(n Notification) {
			notifications <- n
		}},
		pending: map[string]chan rpcResponse{},
		done:    make(chan struct{}),
	}
	go c.readLoop(r)
	large := strings.Repeat("x", 17*1024*1024)
	go func() {
		_, _ = w.Write([]byte(`{"method":"item/agentMessage/delta","params":{"itemId":"i","delta":"` + large + `"}}` + "\n"))
		_ = w.Close()
	}()
	select {
	case n := <-notifications:
		if n.Method != "item/agentMessage/delta" {
			t.Fatalf("method = %q", n.Method)
		}
		if !strings.Contains(string(n.Params), large[:1024]) {
			t.Fatalf("large params were not delivered")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for large notification")
	}
}

func TestReadLineLimitedRejectsOversizedLine(t *testing.T) {
	reader := bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", 32)), 8)
	line, err := readLineLimited(reader, 16)
	if err == nil {
		t.Fatal("expected oversized line error")
	}
	if len(line) <= 16 {
		t.Fatalf("line len = %d, want over limit", len(line))
	}
}

func TestNotifyOmitsNilParams(t *testing.T) {
	r, w := io.Pipe()
	defer r.Close()
	c := &Client{writer: w, pending: map[string]chan rpcResponse{}, done: make(chan struct{})}
	done := make(chan map[string]any, 1)
	go func() {
		scanner := bufio.NewScanner(r)
		if scanner.Scan() {
			var msg map[string]any
			_ = json.Unmarshal(scanner.Bytes(), &msg)
			done <- msg
		}
	}()
	if err := c.Notify("initialized", nil); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	select {
	case msg := <-done:
		if msg["method"] != "initialized" {
			t.Fatalf("method = %#v", msg["method"])
		}
		if _, ok := msg["params"]; ok {
			t.Fatalf("nil notification params must be omitted: %#v", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out reading notification")
	}
}

func TestStartAutoUsesExistingProxy(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: true,
		Exec: helperExec(t, map[string]string{
			"app-server proxy": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceProxyExisting || c.FallbackReason != "" {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
	if got := strings.Join(calls, "|"); got != "app-server proxy" {
		t.Fatalf("calls=%s", got)
	}
}

func TestStartAutoStartsDaemonThenProxy(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: true,
		Exec: helperExec(t, map[string]string{
			"app-server proxy":        "fail_once_then_ok",
			"app-server daemon start": "ok_exit",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceDaemonStartedProxy || c.FallbackReason != "" {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
	if got := strings.Join(calls, "|"); got != "app-server proxy|app-server daemon start|app-server proxy" {
		t.Fatalf("calls=%s", got)
	}
}

func TestStartAutoTimesOutHungProxyAndFallsBack(t *testing.T) {
	oldProbe := transportProbeTimeout
	transportProbeTimeout = 30 * time.Millisecond
	defer func() { transportProbeTimeout = oldProbe }()

	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: true,
		Exec: helperExec(t, map[string]string{
			"app-server proxy":             "hang_once_then_fail",
			"app-server daemon start":      "ok_exit",
			"app-server --listen stdio://": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceProxyFailedFallbackStdio || c.FallbackReason != FallbackReasonProxyFailed {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
	if got := strings.Join(calls, "|"); got != "app-server proxy|app-server daemon start|app-server proxy|app-server --listen stdio://" {
		t.Fatalf("calls=%s", got)
	}
}

func TestStartAutoFallsBackToStdioWhenDaemonStartFails(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: true,
		Exec: helperExec(t, map[string]string{
			"app-server proxy":             "fail",
			"app-server daemon start":      "fail_exit",
			"app-server --listen stdio://": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceDaemonStartFailedFallbackStdio || c.FallbackReason != FallbackReasonDaemonStartFailed {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
	if got := strings.Join(calls, "|"); got != "app-server proxy|app-server daemon start|app-server --listen stdio://" {
		t.Fatalf("calls=%s", got)
	}
}

func TestStartAutoReportsMissingProxySocket(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: false,
		Exec: helperExec(t, map[string]string{
			"app-server proxy":             "missing_socket",
			"app-server --listen stdio://": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceProxyFailedFallbackStdio || c.FallbackReason != FallbackReasonProxySocketMissing {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
}

func TestStartAutoReportsMissingStandaloneInstall(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath:       "codex",
		Transport:        TransportAuto,
		AllowDaemonStart: true,
		Exec: helperExec(t, map[string]string{
			"app-server proxy":             "missing_socket",
			"app-server daemon start":      "missing_standalone",
			"app-server --listen stdio://": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceDaemonStartFailedFallbackStdio || c.FallbackReason != FallbackReasonStandaloneMissing {
		t.Fatalf("source=%q fallback=%q", c.Source, c.FallbackReason)
	}
}

func TestStartProxyModeDoesNotFallback(t *testing.T) {
	oldProbe := transportProbeTimeout
	transportProbeTimeout = 30 * time.Millisecond
	defer func() { transportProbeTimeout = oldProbe }()

	var calls []string
	_, err := Start(context.Background(), Config{
		BinaryPath: "codex",
		Transport:  TransportProxy,
		Exec: helperExec(t, map[string]string{
			"app-server proxy --sock /tmp/codex.sock": "hang",
			"app-server --listen stdio://":            "ok",
		}, &calls),
		SocketPath: "/tmp/codex.sock",
	})
	if err == nil {
		t.Fatal("expected proxy failure")
	}
	if got := strings.Join(calls, "|"); got != "app-server proxy --sock /tmp/codex.sock" {
		t.Fatalf("calls=%s", got)
	}
}

func TestStartStdioModeDoesNotProbeProxy(t *testing.T) {
	var calls []string
	c, err := Start(context.Background(), Config{
		BinaryPath: "codex",
		Transport:  TransportStdio,
		Exec: helperExec(t, map[string]string{
			"app-server --listen stdio://": "ok",
		}, &calls),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer c.Close()
	if c.Source != SourceStdioIsolated {
		t.Fatalf("source=%q", c.Source)
	}
	if got := strings.Join(calls, "|"); got != "app-server --listen stdio://" {
		t.Fatalf("calls=%s", got)
	}
}

type blockingWriteCloser struct {
	release chan struct{}
}

func (w *blockingWriteCloser) Write(p []byte) (int, error) {
	<-w.release
	return len(p), nil
}

func (w *blockingWriteCloser) Close() error { return nil }

func TestCommandExecParamsAvoidsMutuallyExclusiveTimeoutAndOutputCap(t *testing.T) {
	raw := CommandExecParams{ProcessID: "proc_1", Command: []string{"sh"}, TTY: true}.toMap()
	if raw["disableTimeout"] != true || raw["disableOutputCap"] != true {
		t.Fatalf("expected disabled timeout/output caps: %#v", raw)
	}
	if _, ok := raw["timeoutMs"]; ok {
		t.Fatalf("timeoutMs must be omitted when disableTimeout=true: %#v", raw)
	}
	if _, ok := raw["outputBytesCap"]; ok {
		t.Fatalf("outputBytesCap must be omitted when disableOutputCap=true: %#v", raw)
	}
	if raw["processId"] != "proc_1" {
		t.Fatalf("processId = %#v", raw["processId"])
	}
}

func helperExec(t *testing.T, behavior map[string]string, calls *[]string) ExecFunc {
	t.Helper()
	counts := map[string]int{}
	return func(ctx context.Context, name string, args ...string) *exec.Cmd {
		key := strings.Join(args, " ")
		*calls = append(*calls, key)
		counts[key]++
		mode := behavior[key]
		if mode == "fail_once_then_ok" && counts[key] > 1 {
			mode = "ok"
		}
		if mode == "hang_once_then_fail" {
			if counts[key] == 1 {
				mode = "hang"
			} else {
				mode = "fail"
			}
		}
		if runtime.GOOS == "windows" {
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCodexAppClientHelperProcess$")
			cmd.Env = append(os.Environ(), "POCKLY_CODEXAPP_HELPER=1", "POCKLY_CODEXAPP_HELPER_MODE="+mode)
			return cmd
		}
		return exec.CommandContext(ctx, "/bin/sh", "-c", helperShellScript(mode))
	}
}

func helperShellScript(mode string) string {
	switch mode {
	case "hang", "hang_once_then_fail":
		return "while true; do sleep 1; done"
	case "fail", "fail_once_then_ok":
		return "exit 2"
	case "fail_exit":
		return "exit 3"
	case "missing_socket":
		return "printf '%s\\n' 'Error: failed to connect to socket at /Users/test/.codex/app-server-control/app-server-control.sock' >&2; printf '%s\\n' 'Caused by: No such file or directory (os error 2)' >&2; exit 5"
	case "missing_standalone":
		return "printf '%s\\n' 'Error: managed standalone Codex install not found at /Users/test/.codex/packages/standalone/current/codex' >&2; exit 6"
	case "ok_exit":
		return "exit 0"
	case "ok":
		return "while IFS= read -r line; do case \"$line\" in *'\"method\":\"initialize\"'*) printf '%s\\n' '{\"id\":\"1\",\"result\":{}}';; esac; done"
	default:
		return "exit 4"
	}
}

func TestCodexAppClientHelperProcess(t *testing.T) {
	if os.Getenv("POCKLY_CODEXAPP_HELPER") != "1" {
		return
	}
	os.Exit(runCodexAppClientHelperProcess())
}

func runCodexAppClientHelperProcess() int {
	mode := os.Getenv("POCKLY_CODEXAPP_HELPER_MODE")
	switch mode {
	case "hang", "hang_once_then_fail":
		select {}
	case "fail", "fail_once_then_ok":
		return 2
	case "fail_exit":
		return 3
	case "missing_socket":
		_, _ = os.Stderr.WriteString("Error: failed to connect to socket at /Users/test/.codex/app-server-control/app-server-control.sock\nCaused by: No such file or directory (os error 2)\n")
		return 5
	case "missing_standalone":
		_, _ = os.Stderr.WriteString("Error: managed standalone Codex install not found at /Users/test/.codex/packages/standalone/current/codex\n")
		return 6
	case "ok_exit":
		return 0
	case "ok":
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, `"method":"initialize"`) {
				_, _ = os.Stdout.WriteString(`{"id":"1","result":{}}` + "\n")
			}
		}
		return 0
	default:
		return 4
	}
}

func fakeCodexRPCServer(t *testing.T, r io.Reader, w *io.PipeWriter) {
	t.Helper()
	defer w.Close()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.Contains(line, `"method":"initialized"`):
			_, _ = w.Write([]byte(`{"method":"remoteControl/status/changed","params":{"enabled":false}}` + "\n"))
		case strings.Contains(line, `"method":"initialize"`):
			_, _ = w.Write([]byte(`{"id":"1","result":{}}` + "\n"))
		case strings.Contains(line, `"method":"model/list"`):
			_, _ = w.Write([]byte(`{"id":"2","result":{"data":[{"id":"gpt-5.4","model":"gpt-5.4","displayName":"GPT-5.4","hidden":false,"isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningEfforts":[]}]}}` + "\n"))
		}
	}
}
