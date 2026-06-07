// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// gen-password-hash prints an argon2id password hash to stdout.
// Used by local E2E helpers to seed the Nexus DB with a known password.
//
// Usage: gen-password-hash <password>
//
// The hash uses Nexus default parameters (m=65536, t=3, p=1) with
// no pepper (Nexus started without --password-pepper in dev/e2e mode).
package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"

	"golang.org/x/crypto/argon2"
)

func main() {
	password := ""
	if len(os.Args) > 1 {
		password = os.Args[1]
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		fmt.Fprintf(os.Stderr, "gen-password-hash: %v\n", err)
		os.Exit(1)
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
	fmt.Printf("$argon2id$v=19$m=65536,t=3,p=1$%s$%s\n",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	)
}
