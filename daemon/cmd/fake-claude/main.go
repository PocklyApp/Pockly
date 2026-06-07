// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Command fake-claude is a stand-in for `@anthropic-ai/claude-code` used by
// daemon integration tests. It does NOT talk to any LLM; it just writes jsonl
// events with the same shape claude does so that:
//
//   - the wrapper's discoverSessionIDFromProjectsDir (mtime-bump
//     detection in ~/.claude/projects/<encoded-cwd>/*.jsonl) fires
//   - daemon's catalog sync surfaces a session to Nexus
//   - inject from the web reaches the wrapper's PTY, which forwards
//     to this fake's stdin; we append a user_message + assistant event,
//     letting the Nexus turn correlator see the round-trip.
//
// On startup, writes a single `system` event to seed the jsonl. Then
// reads stdin line-by-line; each line becomes a `user` event followed
// by an `assistant` event echoing the text back ("echo: <text>").
// It also supports the subset of Claude's stream-json mode that the
// SDK/headless e2e harness needs.
//
// Exit on SIGINT/SIGTERM or stdin EOF.
//
// Hard-code identity to "0.0.0-fake" so anyone inspecting the file or
// the running process can tell at a glance that this is the test
// binary, not a real Claude install.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const fakeVersion = "0.0.0-fake (Pockly e2e fake claude)"

func main() {
	// Mimic the few flags pockly-claude-wrapper's shouldPassThrough()
	// special-cases so the wrapper doesn't try to bypass us into a
	// nonexistent "real claude" sibling. Honor --session-id so the
	// wrapper's locked watcher and this fake agent write/read the same
	// JSONL path.
	var injectedSID string
	var requestedModel string
	var streamJSON bool
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--version" || arg == "-v":
			fmt.Println(fakeVersion)
			return
		case arg == "--help" || arg == "-h":
			fmt.Println(fakeVersion)
			fmt.Println("Echoes each line of stdin back to stdout and writes user+assistant")
			fmt.Println("events to ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl.")
			return
		case arg == "--session-id" && i+1 < len(args):
			injectedSID = args[i+1]
			i++
		case strings.HasPrefix(arg, "--session-id="):
			injectedSID = strings.TrimPrefix(arg, "--session-id=")
		case arg == "--resume" && i+1 < len(args):
			injectedSID = args[i+1]
			i++
		case strings.HasPrefix(arg, "--resume="):
			injectedSID = strings.TrimPrefix(arg, "--resume=")
		case arg == "--model" && i+1 < len(args):
			requestedModel = args[i+1]
			i++
		case strings.HasPrefix(arg, "--model="):
			requestedModel = strings.TrimPrefix(arg, "--model=")
		case arg == "--output-format=stream-json" || arg == "--input-format=stream-json":
			streamJSON = true
		}
	}
	currentModel := resolveModel(requestedModel)

	cwd, err := os.Getwd()
	if err != nil || cwd == "" {
		cwd = "/tmp"
	}

	sessionID := injectedSID
	if sessionID == "" {
		sessionID = newUUID()
	}
	projectDir, err := claudeProjectDir(cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-claude: resolve project dir:", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "fake-claude: mkdir project dir:", err)
		os.Exit(1)
	}

	jsonlPath := filepath.Join(projectDir, sessionID+".jsonl")
	f, err := os.OpenFile(jsonlPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake-claude: open jsonl:", err)
		os.Exit(1)
	}
	defer f.Close()

	// Seed the file with a system event so the wrapper's mtime-bump
	// discovery has something to find right away — otherwise we'd
	// have to wait for the first user input before the wrapper could
	// bind session_id.
	writeEvent(f, map[string]any{
		"type":       "system",
		"sessionId":  sessionID,
		"cwd":        cwd,
		"uuid":       newUUID(),
		"parentUuid": nil,
		"timestamp":  now(),
		"subtype":    "session_start",
		"version":    "0.0.0-fake",
		"userType":   "external",
		"entrypoint": "cli",
	})

	if streamJSON {
		writeLine(os.Stdout, map[string]any{
			"type":       "system",
			"session_id": sessionID,
			"cwd":        cwd,
		})
	} else {
		fmt.Printf("Pockly fake claude · session %s · cwd %s\n", sessionID, cwd)
		fmt.Print("> ")
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	lines := make(chan string)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()

	var lastUUID string
	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-lines:
			if !ok {
				return
			}
			text := strings.TrimSpace(line)
			if streamJSON {
				text = strings.TrimSpace(streamJSONInputText(text))
			}
			if text == "" {
				if !streamJSON {
					fmt.Print("> ")
				}
				continue
			}

			// user event
			userUUID := newUUID()
			writeEvent(f, map[string]any{
				"type":       "user",
				"sessionId":  sessionID,
				"cwd":        cwd,
				"uuid":       userUUID,
				"parentUuid": parentOrNil(lastUUID),
				"timestamp":  now(),
				"userType":   "external",
				"message": map[string]any{
					"role":    "user",
					"content": text,
				},
			})

			// Pretend to "think" for a bit so the timing looks plausible
			// in the Nexus turn timeline.
			time.Sleep(50 * time.Millisecond)

			// assistant event
			reply := "echo: " + text
			if nextModel, ok := parseModelCommand(text); ok {
				currentModel = resolveModel(nextModel)
				reply = "Set model to \x1b[1m" + currentModel + "\x1b[22m for this session"
			}
			assistantUUID := newUUID()
			assistantEvent := map[string]any{
				"type":       "assistant",
				"sessionId":  sessionID,
				"cwd":        cwd,
				"uuid":       assistantUUID,
				"parentUuid": userUUID,
				"timestamp":  now(),
				"message": map[string]any{
					"role":  "assistant",
					"model": currentModel,
					"content": []map[string]any{
						{"type": "text", "text": reply},
					},
				},
			}
			writeEvent(f, assistantEvent)
			lastUUID = assistantUUID

			if streamJSON {
				writeLine(os.Stdout, map[string]any{
					"type":       "assistant",
					"session_id": sessionID,
					"message": map[string]any{
						"role":  "assistant",
						"model": currentModel,
						"content": []map[string]any{
							{"type": "text", "text": reply},
						},
					},
				})
				writeLine(os.Stdout, map[string]any{
					"type":        "result",
					"session_id":  sessionID,
					"subtype":     "success",
					"duration_ms": 50,
				})
			} else {
				fmt.Println(reply)
				fmt.Print("> ")
			}
		}
	}
}

func writeEvent(f *os.File, e map[string]any) {
	raw, err := json.Marshal(e)
	if err != nil {
		return
	}
	_, _ = f.Write(append(raw, '\n'))
	_ = f.Sync()
}

func writeLine(f *os.File, e map[string]any) {
	raw, err := json.Marshal(e)
	if err != nil {
		return
	}
	_, _ = f.Write(append(raw, '\n'))
	_ = f.Sync()
}

func now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// newUUID returns an RFC4122 v4 UUID (dashed lowercase hex). Matches
// the format real claude uses for session ids + event uuids.
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]))
}

// claudeProjectDir is the same encoding the wrapper's
// discoverSessionIDFromProjectsDir expects: ~/.claude/projects/<cwd
// with / replaced by ->.
func claudeProjectDir(cwd string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	encoded := strings.ReplaceAll(strings.TrimSuffix(cwd, "/"), "/", "-")
	if encoded == "" {
		return "", fmt.Errorf("empty encoded cwd")
	}
	return filepath.Join(home, ".claude", "projects", encoded), nil
}

func parentOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func resolveModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		model = strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
	}
	switch model {
	case "opus":
		if v := strings.TrimSpace(os.Getenv("ANTHROPIC_DEFAULT_OPUS_MODEL")); v != "" {
			return v
		}
	case "sonnet":
		if v := strings.TrimSpace(os.Getenv("ANTHROPIC_DEFAULT_SONNET_MODEL")); v != "" {
			return v
		}
	case "haiku":
		if v := strings.TrimSpace(os.Getenv("ANTHROPIC_DEFAULT_HAIKU_MODEL")); v != "" {
			return v
		}
	}
	if model == "" {
		return "fake-model"
	}
	return model
}

func parseModelCommand(text string) (string, bool) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "/model") {
		return "", false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(text, "/model"))
	if rest == "" {
		return "", false
	}
	return strings.Fields(rest)[0], true
}

func streamJSONInputText(line string) string {
	var payload struct {
		Message struct {
			Content any `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &payload); err != nil {
		return line
	}
	switch content := payload.Message.Content.(type) {
	case string:
		return content
	case []any:
		var parts []string
		for _, raw := range content {
			obj, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := obj["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return line
	}
}
