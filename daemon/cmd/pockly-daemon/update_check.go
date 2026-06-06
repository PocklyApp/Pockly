// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/api"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
)

// updateChecker keeps a most-recent snapshot of "is there a newer
// pockly-daemon on the CDN?" for the /api/status endpoint to surface to
// the web UI. It is the read-only counterpart to the `pockly-daemon
// update` subcommand — never installs anything, only reports.
//
// Polling cadence: every 24 hours. The CDN's checksums.txt is tiny
// (~600 bytes) and cached aggressively, so this could run hourly
// without measurable cost, but 24h is what users expect from a daemon
// upgrade indicator. First check fires immediately on serve start so
// the indicator is accurate from the first /api/status hit instead of
// going "no update info" for 24 hours.
type updateChecker struct {
	mu       sync.RWMutex
	latest   api.UpdateInfo
	interval time.Duration
}

func newUpdateChecker(interval time.Duration) *updateChecker {
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	current := "v" + version.Version
	return &updateChecker{
		interval: interval,
		latest: api.UpdateInfo{
			Current:   current,
			Available: false,
		},
	}
}

// Snapshot returns the latest known update info. Safe to call from
// any goroutine including the HTTP handler.
func (u *updateChecker) Snapshot() api.UpdateInfo {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.latest
}

// Run blocks until ctx is cancelled, doing an immediate check then
// looping on u.interval. Intended to run in a daemon-lifetime
// goroutine spawned from runServe.
func (u *updateChecker) Run(ctx context.Context) {
	// Initial check fires now so /api/status has fresh data within
	// seconds of daemon start (instead of stale until tomorrow). We
	// tolerate failure quietly — the first /api/status response will
	// just lack a latest version, which the web treats as "no update
	// info available."
	u.runOnce()
	ticker := time.NewTicker(u.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			u.runOnce()
		}
	}
}

func (u *updateChecker) runOnce() {
	current := "v" + version.Version
	info := api.UpdateInfo{
		Current:   current,
		CheckedAt: time.Now().UTC().Format(time.RFC3339),
	}
	defer func() {
		u.mu.Lock()
		u.latest = info
		u.mu.Unlock()
	}()

	manifest, err := fetchChecksumManifest("latest", false)
	if err != nil {
		info.Error = err.Error()
		return
	}
	asset, err := pickPlatformAsset(manifest)
	if err != nil {
		info.Error = err.Error()
		return
	}
	info.Latest = asset.Version
	info.Available = isNewerOrPinned(current, asset.Version, "")
}
