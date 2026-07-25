// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package version exposes the daemon's build identity.
//
// `Version` is the semver string. `Commit` and `Date` are populated at link
// time via -ldflags from the Makefile. They default to "dev" / "unknown" so
// `go run` works without flags.
package version

import "fmt"

var (
	Version = "0.0.0-dev"
	Commit  = "dev"
	Date    = "unknown"
)

// String returns "pockly-daemon vX.Y.Z (commit, date)".
func String() string {
	return fmt.Sprintf("pockly-daemon v%s (%s, %s)", Version, Commit, Date)
}
