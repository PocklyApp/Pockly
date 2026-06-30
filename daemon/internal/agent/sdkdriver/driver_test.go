// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package sdkdriver

import (
	"bufio"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/terminal"
)

func TestPumpStdoutHandlesLargeStreamJSONLines(t *testing.T) {
	r, w := io.Pipe()
	ext := terminal.NewExternalSession()
	events, unsubscribe := ext.Subscribe(4)
	defer unsubscribe()
	d := New(Config{
		Agent:     AgentClaude,
		SessionID: "test-session",
		Logger:    func(string, ...any) {},
	}, ext)
	d.stdout = r

	go d.pumpStdout()
	large := strings.Repeat("x", 17*1024*1024)
	go func() {
		_, _ = w.Write([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"` + large + `"}]}}` + "\n"))
		_ = w.Close()
	}()

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.Kind != terminal.EventMessageAdded {
				continue
			}
			if !strings.Contains(event.Payload, large[:1024]) {
				t.Fatalf("large payload was not delivered")
			}
			return
		case <-deadline:
			t.Fatal("timed out waiting for large stdout event")
		}
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
