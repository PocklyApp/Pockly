//go:build !darwin

// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

func enableLaunchAgent(uid string) error {
	return nil
}
