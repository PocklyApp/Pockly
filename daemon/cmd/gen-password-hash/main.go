// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// gen-password-hash prints a Nexus-compatible password hash to stdout.
// Used by local E2E helpers to seed the Nexus DB with a known password.
//
// Usage: gen-password-hash <password>
//
// The output format and parameters must match verifyPassword in
// nexus/src/app.js, which accepts only:
//
//	pbkdf2_sha256$<iterations>$<base64url salt>$<base64url derived key>
//
// PBKDF2-HMAC-SHA256, 100000 iterations, 16-byte salt, 256-bit output,
// unpadded base64url. A hash in any other format is rejected outright, so
// keep this in sync if the Nexus parameters ever change.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"

	"golang.org/x/crypto/pbkdf2"
)

const (
	pbkdf2Iterations = 100000
	pbkdf2KeyLength  = 32
	saltLength       = 16
)

func main() {
	password := ""
	if len(os.Args) > 1 {
		password = os.Args[1]
	}
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		fmt.Fprintf(os.Stderr, "gen-password-hash: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(encodePasswordHash(password, salt))
}

// encodePasswordHash renders the Nexus password hash encoding. Split out from
// main so a test can assert the exact wire format against a known vector.
func encodePasswordHash(password string, salt []byte) string {
	key := pbkdf2.Key([]byte(password), salt, pbkdf2Iterations, pbkdf2KeyLength, sha256.New)
	return fmt.Sprintf("pbkdf2_sha256$%d$%s$%s",
		pbkdf2Iterations,
		base64.RawURLEncoding.EncodeToString(salt),
		base64.RawURLEncoding.EncodeToString(key),
	)
}
