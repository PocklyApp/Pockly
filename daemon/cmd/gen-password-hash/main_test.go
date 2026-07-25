// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
)

// TestEncodePasswordHashMatchesNexusFormat pins the encoding that
// verifyPassword in nexus/src/app.js accepts. That function rejects anything
// whose scheme prefix is not exactly "pbkdf2_sha256", so a drift here silently
// breaks every E2E helper that seeds a password.
func TestEncodePasswordHashMatchesNexusFormat(t *testing.T) {
	salt := []byte("0123456789abcdef")
	encoded := encodePasswordHash("correct horse battery staple", salt)

	parts := strings.Split(encoded, "$")
	if len(parts) != 4 {
		t.Fatalf("expected 4 $-separated fields, got %d in %q", len(parts), encoded)
	}
	if parts[0] != "pbkdf2_sha256" {
		t.Errorf("scheme = %q, want pbkdf2_sha256 (Nexus rejects any other scheme)", parts[0])
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil {
		t.Fatalf("iterations field %q is not an integer: %v", parts[1], err)
	}
	if iterations != 100000 {
		t.Errorf("iterations = %d, want 100000 to match Nexus", iterations)
	}

	// Nexus decodes with a base64url alphabet and re-pads itself, so the
	// encoding must be unpadded base64url.
	for name, field := range map[string]string{"salt": parts[2], "key": parts[3]} {
		if strings.ContainsAny(field, "+/=") {
			t.Errorf("%s field %q must be unpadded base64url", name, field)
		}
		if _, err := base64.RawURLEncoding.DecodeString(field); err != nil {
			t.Errorf("%s field %q does not decode as base64url: %v", name, field, err)
		}
	}

	decodedSalt, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode salt: %v", err)
	}
	if string(decodedSalt) != string(salt) {
		t.Errorf("salt round-trip = %q, want %q", decodedSalt, salt)
	}
	decodedKey, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		t.Fatalf("decode key: %v", err)
	}
	if len(decodedKey) != 32 {
		t.Errorf("derived key = %d bytes, want 32 (Nexus derives 256 bits)", len(decodedKey))
	}
}

func TestEncodePasswordHashIsDeterministicForAFixedSalt(t *testing.T) {
	salt := []byte("fixed-salt-16byt")
	first := encodePasswordHash("hunter2", salt)
	second := encodePasswordHash("hunter2", salt)
	if first != second {
		t.Errorf("same password and salt produced different hashes:\n%s\n%s", first, second)
	}
	if encodePasswordHash("hunter3", salt) == first {
		t.Error("different passwords produced the same hash")
	}
}
