// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
)

type Event struct {
	Name      string `json:"name"`
	Command   string `json:"command,omitempty"`
	Status    string `json:"status,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	// Optional telemetry providers can use this for session-scoped
	// diagnostics. Empty for events that are not per-session.
	SessionID  string        `json:"session_id,omitempty"`
	DurationMS time.Duration `json:"-"`
	// Metrics carries low-cardinality numeric diagnostics for opt-in telemetry.
	// It must never include paths, prompts, commands, tokens, or user content.
	Metrics map[string]int64 `json:"-"`
}

type wireEvent struct {
	Name       string           `json:"name"`
	Command    string           `json:"command,omitempty"`
	Status     string           `json:"status,omitempty"`
	ErrorCode  string           `json:"error_code,omitempty"`
	SessionID  string           `json:"session_id,omitempty"`
	DurationMS int64            `json:"duration_ms,omitempty"`
	Timestamp  string           `json:"timestamp,omitempty"`
	Metrics    map[string]int64 `json:"metrics,omitempty"`
}

type wireRequest struct {
	InstallID string      `json:"install_id"`
	DeviceID  string      `json:"device_id,omitempty"`
	Version   string      `json:"version"`
	OS        string      `json:"os"`
	Arch      string      `json:"arch"`
	Events    []wireEvent `json:"events"`
}

func Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POCKLY_TELEMETRY"))) {
	case "on", "true", "1", "enabled", "yes":
		return true
	case "", "off", "false", "0", "disabled":
		return false
	default:
		return false
	}
}

func Endpoint(relayURL string) string {
	if endpoint := strings.TrimSpace(os.Getenv("POCKLY_TELEMETRY_ENDPOINT")); endpoint != "" {
		return endpoint
	}
	return strings.TrimRight(relayURL, "/") + "/api/telemetry/daemon"
}

func Send(ctx context.Context, relayURL string, id device.Identity, events ...Event) {
	if !Enabled() || len(events) == 0 {
		return
	}
	endpoint := Endpoint(relayURL)
	if strings.TrimSpace(endpoint) == "" {
		return
	}
	installID := installID()
	body := wireRequest{
		InstallID: installID,
		DeviceID:  id.DeviceID,
		Version:   version.String(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, evt := range events {
		body.Events = append(body.Events, wireEvent{
			Name:       clean(evt.Name, 80),
			Command:    clean(evt.Command, 40),
			Status:     clean(evt.Status, 40),
			ErrorCode:  SafeErrorCode(evt.ErrorCode),
			SessionID:  clean(evt.SessionID, 80),
			DurationMS: evt.DurationMS.Milliseconds(),
			Timestamp:  now,
			Metrics:    cleanMetrics(evt.Metrics),
		})
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err == nil && resp != nil {
		_ = resp.Body.Close()
	}
}

func cleanMetrics(metrics map[string]int64) map[string]int64 {
	if len(metrics) == 0 {
		return nil
	}
	out := make(map[string]int64, len(metrics))
	for key, value := range metrics {
		key = normalizeCode(key)
		if key == "" {
			continue
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func CommandFinished(command string, started time.Time, err error) Event {
	evt := Event{
		Name:       command + "_completed",
		Command:    command,
		Status:     "ok",
		DurationMS: time.Since(started),
	}
	if err != nil {
		evt.Name = command + "_failed"
		evt.Status = "error"
		evt.ErrorCode = SafeErrorCode(err.Error())
	}
	return evt
}

func SafeErrorCode(value string) string {
	value = clean(value, 160)
	if value == "" {
		return ""
	}
	lower := strings.ToLower(value)
	switch {
	case strings.Contains(lower, "cancelled_or_timed_out"):
		return "cancelled_or_timed_out"
	case strings.Contains(lower, "session not found"):
		return "session_not_found"
	case strings.Contains(lower, "cwd is required"):
		return "cwd_required"
	case strings.Contains(lower, "cwd invalid"):
		return "cwd_invalid"
	case strings.Contains(lower, "unsupported agent"):
		return "unsupported_agent"
	case strings.Contains(lower, "executable file not found"):
		return "agent_binary_missing"
	case strings.Contains(lower, "permission"):
		return "permission_error"
	case strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded"):
		return "timeout"
	case strings.Contains(lower, "token") || strings.Contains(lower, "authorization") || strings.Contains(lower, "bearer") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "refresh"):
		return "redacted_error"
	case strings.ContainsAny(lower, `/\`):
		if prefix := strings.TrimSpace(strings.SplitN(lower, ":", 2)[0]); prefix != "" && !strings.ContainsAny(prefix, `/\`) {
			return normalizeCode(prefix)
		}
		return "path_error"
	default:
		return normalizeCode(lower)
	}
}

func installID() string {
	if value := strings.TrimSpace(os.Getenv("POCKLY_TELEMETRY_INSTALL_ID")); value != "" {
		return clean(value, 80)
	}
	path, err := installIDPath()
	if err != nil {
		return ""
	}
	if raw, err := os.ReadFile(path); err == nil {
		return clean(string(raw), 80)
	}
	var buf [18]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return ""
	}
	id := "pti_" + base64.RawURLEncoding.EncodeToString(buf[:])
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	_ = os.WriteFile(path, []byte(id), 0o600)
	return id
}

func installIDPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "pockly-daemon", "telemetry-install-id"), nil
}

func clean(value string, max int) string {
	value = strings.TrimSpace(value)
	value = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, value)
	if len(value) > max {
		value = value[:max]
	}
	return value
}

var nonCodeChars = regexp.MustCompile(`[^a-z0-9]+`)

func normalizeCode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = nonCodeChars.ReplaceAllString(value, "_")
	value = strings.Trim(value, "_")
	if value == "" {
		return "error"
	}
	if len(value) > 80 {
		value = strings.Trim(value[:80], "_")
	}
	if value == "" {
		return "error"
	}
	return value
}
