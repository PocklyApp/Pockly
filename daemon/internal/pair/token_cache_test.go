// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package pair

import (
	"testing"
	"time"
)

func TestDeviceTokenCache(t *testing.T) {
	const dev = "dd_test_cache"
	const aud = "daemon-ws"
	invalidateDeviceToken(dev, aud)

	// Absent → miss.
	if _, ok := cachedDeviceTokenFor(dev, aud); ok {
		t.Fatal("expected miss for empty cache")
	}

	// Stored → hit, returns the token.
	storeDeviceToken(dev, aud, "tok-1")
	if tok, ok := cachedDeviceTokenFor(dev, aud); !ok || tok != "tok-1" {
		t.Fatalf("expected hit tok-1, got %q ok=%v", tok, ok)
	}

	// Different audience is a separate key → miss.
	if _, ok := cachedDeviceTokenFor(dev, "other"); ok {
		t.Fatal("expected miss for different audience")
	}

	// Invalidate → miss.
	invalidateDeviceToken(dev, aud)
	if _, ok := cachedDeviceTokenFor(dev, aud); ok {
		t.Fatal("expected miss after invalidate")
	}

	// Expired entry → miss (simulate by back-dating expiresAt).
	deviceTokenMu.Lock()
	deviceTokenCache[deviceTokenCacheKey(dev, aud)] = cachedDeviceToken{token: "stale", expiresAt: time.Now().Add(-time.Second)}
	deviceTokenMu.Unlock()
	if _, ok := cachedDeviceTokenFor(dev, aud); ok {
		t.Fatal("expected miss for expired entry")
	}
	invalidateDeviceToken(dev, aud)
}

func TestDeviceAccessTokenTTLByAudience(t *testing.T) {
	if got := deviceAccessTokenTTL(audienceDaemonWS); got != daemonAccessTokenTTL {
		t.Fatalf("daemon-ws TTL = %v, want %v", got, daemonAccessTokenTTL)
	}
	if got := deviceAccessTokenTTL(audienceDaemonPairing); got != defaultDeviceAccessTokenTTL {
		t.Fatalf("daemon-pairing TTL = %v, want %v", got, defaultDeviceAccessTokenTTL)
	}
	if got := deviceAccessTokenTTL("browser-ws"); got != defaultDeviceAccessTokenTTL {
		t.Fatalf("browser-ws TTL = %v, want %v", got, defaultDeviceAccessTokenTTL)
	}
}

func TestIsAuthFailure(t *testing.T) {
	cases := []struct {
		errStr string
		want   bool
	}{
		{"Nexus POST /api/daemon/sync: status=401 error=unauthorized", true},
		{"Nexus POST /api/daemon/sync: status=403 error=forbidden", true},
		{"Nexus POST /api/device-challenge: status=429 error=too many challenge requests", false},
		{"Nexus POST /api/daemon/sync: status=500 body=\"oops\"", false},
		{"dial tcp: connection refused", false},
		{"", false},
	}
	for _, c := range cases {
		var err error
		if c.errStr != "" {
			err = &stringErr{c.errStr}
		}
		if got := isAuthFailure(err); got != c.want {
			t.Errorf("isAuthFailure(%q) = %v, want %v", c.errStr, got, c.want)
		}
	}
}

type stringErr struct{ s string }

func (e *stringErr) Error() string { return e.s }
