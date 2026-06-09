// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package codexapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

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
