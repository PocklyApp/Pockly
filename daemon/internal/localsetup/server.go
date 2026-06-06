// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package localsetup runs a short-lived loopback HTTP server that the user's
// browser posts back to after they finish "Install Pockly" on the web app.
//
// The local install flow looks like this:
//
//  1. Daemon starts an HTTP server bound to 127.0.0.1 on an OS-chosen port.
//  2. Daemon generates a one-shot 256-bit nonce and embeds it in the URL it
//     opens in the user's browser (in the fragment, so it never hits Referer
//     or relay logs).
//  3. The web /local-setup page reads the nonce out of the fragment, runs the
//     existing login flow against the relay, asks the relay to mint a
//     "local-claim" (device tokens + daemon device id, scoped to that nonce),
//     and POSTs the result back to http://127.0.0.1:<port>/callback.
//  4. Daemon validates Origin, validates nonce, hands the Claim to the caller
//     via Wait(), and shuts down.
//
// Why not just use the existing device_authorization polling flow? On a local
// machine the user is literally at the keyboard — making them stare at a y/N
// prompt is friction for no security gain (a hostile process on the same
// machine can already trivially scrape state). Remote installs keep the y/N
// because there the daemon and the user's eyeballs are on different machines.
//
// Security notes:
//   - Bound to 127.0.0.1 only, never 0.0.0.0.
//   - Nonce is single-use; the server stops accepting once consumed.
//   - Origin must match the configured relay origin (defaults to
//     https://pockly.example).
//   - Method is POST + Content-Type application/json only.
//   - Server enforces a hard deadline (default 10 minutes) and shuts itself
//     down if Wait() is not satisfied.
package localsetup

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Claim is the payload the web page posts back to the daemon after it has
// authenticated the user with the relay. Field names match the relay's
// /api/daemon/local-claim response.
type Claim struct {
	DaemonDeviceID      string `json:"daemon_device_id"`
	UserEmail           string `json:"user_email"`
	UserID              string `json:"user_id,omitempty"`
	DeviceAccessToken   string `json:"device_access_token"`
	DeviceRefreshToken  string `json:"device_refresh_token"`
	RemoteAccessEnabled bool   `json:"remote_access_enabled"`
	BrowserDeviceID     string `json:"browser_device_id,omitempty"`
	BrowserDeviceName   string `json:"browser_device_name,omitempty"`
}

// Server is a single-shot loopback handshake server.
type Server struct {
	// AllowedOrigins lists the URL origins the web page may POST from.
	// If nil, defaults to {"https://pockly.example"}. Schemes must match
	// (https vs http).
	AllowedOrigins []string

	// Deadline is the maximum time we will keep listening before giving up.
	// Zero means 10 minutes.
	Deadline time.Duration

	listener net.Listener
	server   *http.Server
	nonce    string
	port     int

	once   sync.Once
	doneCh chan struct{}

	mu     sync.Mutex
	claim  *Claim
	err    error
	used   bool
	closed atomic.Bool
}

// Start binds to 127.0.0.1 on an OS-chosen port and begins serving. It does
// not block; call Wait to receive the Claim (or an error / timeout).
func (s *Server) Start() error {
	if s.doneCh != nil {
		return errors.New("localsetup: server already started")
	}
	s.doneCh = make(chan struct{})

	nonceBytes := make([]byte, 32)
	if _, err := rand.Read(nonceBytes); err != nil {
		return fmt.Errorf("localsetup: generate nonce: %w", err)
	}
	s.nonce = base64.RawURLEncoding.EncodeToString(nonceBytes)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("localsetup: listen: %w", err)
	}
	s.listener = ln
	s.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", s.handleCallback)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	s.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  15 * time.Second,
	}

	go func() {
		_ = s.server.Serve(ln)
	}()

	// Hard deadline: if no callback arrives, fail Wait().
	deadline := s.Deadline
	if deadline <= 0 {
		deadline = 10 * time.Minute
	}
	go func() {
		t := time.NewTimer(deadline)
		defer t.Stop()
		select {
		case <-s.doneCh:
			return
		case <-t.C:
			s.finish(nil, errors.New("localsetup: handshake timed out"))
		}
	}()

	return nil
}

// Port returns the loopback port the server is bound to. Useful for telemetry
// and tests.
func (s *Server) Port() int { return s.port }

// Nonce returns the URL-safe nonce assigned to this handshake. Caller embeds
// it in the URL fragment opened in the browser.
func (s *Server) Nonce() string { return s.nonce }

// CallbackURL is the full http://127.0.0.1:<port>/callback URL the web page
// should POST to. Web also needs the nonce, which the daemon includes
// separately in the fragment.
func (s *Server) CallbackURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/callback", s.port)
}

// SetupURL builds the URL the daemon opens in the local browser. It mounts
// nonce and cb in the fragment so they are not forwarded as a Referer header
// or recorded in the relay's access log.
func (s *Server) SetupURL(relayBaseURL string) (string, error) {
	u, err := url.Parse(relayBaseURL)
	if err != nil {
		return "", fmt.Errorf("localsetup: parse relay url: %w", err)
	}
	u.Path = "/local-setup"
	u.RawQuery = ""
	u.Fragment = ""
	// Build the fragment manually: url.URL re-escapes whatever we put in
	// Fragment, so passing an already-encoded string yields %25 sequences.
	frag := "nonce=" + url.QueryEscape(s.nonce) + "&cb=" + url.QueryEscape(s.CallbackURL())
	return u.String() + "#" + frag, nil
}

// Wait blocks until a Claim arrives, the deadline elapses, or ctx is
// canceled. It is safe to call exactly once per Server.
func (s *Server) Wait(ctx context.Context) (*Claim, error) {
	select {
	case <-s.doneCh:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.err != nil {
			return nil, s.err
		}
		return s.claim, nil
	case <-ctx.Done():
		s.finish(nil, ctx.Err())
		return nil, ctx.Err()
	}
}

// Close shuts the server down immediately. It is safe to call multiple times.
func (s *Server) Close() {
	if s.closed.Swap(true) {
		return
	}
	if s.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = s.server.Shutdown(ctx)
	}
	if s.listener != nil {
		_ = s.listener.Close()
	}
}

func (s *Server) finish(c *Claim, err error) {
	s.once.Do(func() {
		s.mu.Lock()
		s.claim = c
		s.err = err
		s.mu.Unlock()
		close(s.doneCh)
		// Tear down listener in the background so the HTTP response can
		// flush before the socket disappears.
		go func() {
			time.Sleep(200 * time.Millisecond)
			s.Close()
		}()
	})
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	// CORS preflight from the relay origin — relay's /local-setup is
	// loaded under https://pockly.example, so the POST is cross-origin
	// against http://127.0.0.1:<port>.
	if r.Method == http.MethodOptions {
		s.writeCORS(w, r)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.originAllowed(r.Header.Get("Origin")) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		http.Error(w, "content-type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	s.writeCORS(w, r)

	var body struct {
		Nonce string `json:"nonce"`
		Claim Claim  `json:"claim"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Nonce), []byte(s.nonce)) != 1 {
		http.Error(w, "bad nonce", http.StatusForbidden)
		return
	}
	if body.Claim.DeviceAccessToken == "" || body.Claim.DaemonDeviceID == "" {
		http.Error(w, "claim missing required fields", http.StatusBadRequest)
		return
	}

	// One-shot: refuse to consume a second callback.
	s.mu.Lock()
	already := s.used
	if !already {
		s.used = true
	}
	s.mu.Unlock()
	if already {
		http.Error(w, "already consumed", http.StatusConflict)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))

	c := body.Claim
	s.finish(&c, nil)
}

func (s *Server) writeCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.originAllowed(origin) {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Vary", "Origin")
}

func (s *Server) originAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	allowed := s.AllowedOrigins
	if len(allowed) == 0 {
		allowed = []string{"https://pockly.example"}
	}
	for _, want := range allowed {
		if strings.EqualFold(origin, want) {
			return true
		}
	}
	return false
}
