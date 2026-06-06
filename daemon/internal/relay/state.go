// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package relay

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type State struct {
	RelayURL           string    `json:"relay_url"`
	DaemonDeviceID     string    `json:"daemon_device_id"`
	UserEmail          string    `json:"user_email,omitempty"`
	RemoteAccess       bool      `json:"remote_access_enabled"`
	DeviceAccessToken  string    `json:"device_access_token,omitempty"`
	DeviceRefreshToken string    `json:"device_refresh_token,omitempty"`
	BrowserDeviceCount *int      `json:"browser_device_count,omitempty"`
	LastLoginAt        time.Time `json:"last_login_at,omitempty"`
	LastPairedAt       time.Time `json:"last_paired_at"`
}

func DefaultStatePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(dir, "pockly-daemon", "relay-state.json"), nil
}

func LoadState(path string) (State, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return State{}, fmt.Errorf("decode relay state: %w", err)
	}
	return state, nil
}

func SaveState(path string, state State) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir relay state dir: %w", err)
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode relay state: %w", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write relay state: %w", err)
	}
	return nil
}
