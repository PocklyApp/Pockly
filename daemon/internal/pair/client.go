// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package pair

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/PocklyApp/Pockly/daemon/internal/device"
)

// Device access tokens from /api/device-challenge/verify are short-lived
// (Nexus TTL ~15m), but every authenticated daemon→Nexus call
// (SyncHistory, …) used to re-run the full challenge→verify handshake. The
// Nexus rate-limits /api/device-challenge per-device + per-IP, so the 2s
// Nexus sync loop could blow past the limit within a minute and every sync
// failed with "too many challenge requests".
//
// Cache the verified token per (device, audience) and reuse it until
// shortly before expiry. invalidateDeviceToken is called on an auth
// failure so a Nexus restart — which rotates Nexus token signing
// key and invalidates every outstanding token — self-heals on the next
// call instead of failing for the whole TTL.
const deviceAccessTokenTTL = 10 * time.Minute

type cachedDeviceToken struct {
	token     string
	expiresAt time.Time
}

var (
	deviceTokenMu    sync.Mutex
	deviceTokenCache = map[string]cachedDeviceToken{}
)

func deviceTokenCacheKey(deviceID, audience string) string {
	return deviceID + "\x00" + audience
}

func cachedDeviceTokenFor(deviceID, audience string) (string, bool) {
	deviceTokenMu.Lock()
	defer deviceTokenMu.Unlock()
	entry, ok := deviceTokenCache[deviceTokenCacheKey(deviceID, audience)]
	if !ok || !time.Now().Before(entry.expiresAt) {
		return "", false
	}
	return entry.token, true
}

func storeDeviceToken(deviceID, audience, token string) {
	deviceTokenMu.Lock()
	defer deviceTokenMu.Unlock()
	deviceTokenCache[deviceTokenCacheKey(deviceID, audience)] = cachedDeviceToken{
		token:     token,
		expiresAt: time.Now().Add(deviceAccessTokenTTL),
	}
}

func invalidateDeviceToken(deviceID, audience string) {
	deviceTokenMu.Lock()
	defer deviceTokenMu.Unlock()
	delete(deviceTokenCache, deviceTokenCacheKey(deviceID, audience))
}

// isAuthFailure reports whether a doJSON* error came back as a 401/403 —
// i.e. the bearer token was rejected, so the cached token should be
// dropped and re-minted. doJSONAttempt formats these as "...status=401...".
func isAuthFailure(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "status=401") || strings.Contains(s, "status=403")
}

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

type CreateGrantResponse struct {
	PairingGrant string         `json:"pairing_grant"`
	ExpiresAt    time.Time      `json:"expires_at"`
	ShortCode    string         `json:"short_code"`
	QRPayload    map[string]any `json:"qr_payload"`
}

type PendingRequestsResponse struct {
	Requests []PendingRequest `json:"requests"`
}

type PendingRequest struct {
	PairingGrant      string    `json:"pairing_grant"`
	ShortCode         string    `json:"short_code"`
	UserDisplay       string    `json:"user_display"`
	BrowserDeviceName string    `json:"browser_device_name"`
	BrowserDeviceID   string    `json:"browser_device_id"`
	Exp               time.Time `json:"exp"`
}

type ConfirmResponse struct {
	Status             string `json:"status"`
	BrowserDeviceID    string `json:"browser_device_id"`
	DaemonDeviceID     string `json:"daemon_device_id"`
	DeviceAccessToken  string `json:"device_access_token"`
	DeviceRefreshToken string `json:"device_refresh_token"`
}

type MobileJoinGrantResponse struct {
	GrantToken string    `json:"grant_token"`
	ExpiresAt  time.Time `json:"expires_at"`
	QRPayload  string    `json:"qr_payload"`
}

type ChallengeResponse struct {
	ChallengeID string    `json:"challenge_id"`
	DeviceID    string    `json:"device_id"`
	Audience    string    `json:"audience"`
	Nonce       string    `json:"nonce"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type VerifyChallengeResponse struct {
	Verified          bool   `json:"verified"`
	DeviceAccessToken string `json:"device_access_token"`
}

type SyncSession struct {
	SessionID         string `json:"session_id"`
	Agent             string `json:"agent"`
	RunnerAlias       string `json:"runner_alias,omitempty"`
	Cwd               string `json:"cwd"`
	Snippet           string `json:"snippet,omitempty"`
	FirstMessage      string `json:"first_message,omitempty"`
	LastSeq           int    `json:"last_seq"`
	LastTimestamp     string `json:"last_timestamp,omitempty"`
	ChannelLastSeenAt string `json:"channel_last_seen_at,omitempty"`
	SyncState         string `json:"sync_state,omitempty"`
	TurnCount         int    `json:"turn_count,omitempty"`
	MinSeq            int    `json:"min_seq,omitempty"`
	MaxSeq            int    `json:"max_seq,omitempty"`
	HasOlder          bool   `json:"has_older,omitempty"`
}

type SyncTurn struct {
	SessionID string          `json:"session_id"`
	Seq       int             `json:"seq"`
	Agent     string          `json:"agent"`
	Kind      string          `json:"kind"`
	Timestamp string          `json:"timestamp,omitempty"`
	Payload   json.RawMessage `json:"payload"`
}

type SyncRequest struct {
	Hello    HelloMessage  `json:"hello"`
	Sessions []SyncSession `json:"sessions"`
	Turns    []SyncTurn    `json:"turns,omitempty"`
	// FullReconcile signals that Sessions is an authoritative full snapshot of
	// the daemon's catalog for this device. Nexus deletes any sessions it
	// has for this device that are NOT in this snapshot (and cascades to their
	// turns). Set ONLY on catalog syncs — never on single-session pushes that
	// carry Turns, since those are intentionally partial.
	FullReconcile bool `json:"full_reconcile,omitempty"`
}

type HelloMessage struct {
	DeviceID string `json:"device_id"`
	Version  string `json:"version"`
}

type SyncResponse struct {
	OK            bool   `json:"ok"`
	SessionCount  int    `json:"session_count"`
	TurnCount     int    `json:"turn_count"`
	DaemonDevice  string `json:"daemon_device"`
	DaemonVersion string `json:"daemon_version"`
}

type DaemonLoginResponse struct {
	User struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Name   string `json:"name"`
	} `json:"user"`
	DaemonDeviceID      string `json:"daemon_device_id"`
	RemoteAccessEnabled bool   `json:"remote_access_enabled"`
	DeviceAccessToken   string `json:"device_access_token"`
	DeviceRefreshToken  string `json:"device_refresh_token"`
}

type DeviceAuthorizationResponse struct {
	DeviceCode              string    `json:"device_code"`
	UserCode                string    `json:"user_code"`
	VerificationURI         string    `json:"verification_uri"`
	VerificationURIComplete string    `json:"verification_uri_complete"`
	PollSecret              string    `json:"poll_secret"`
	PollInterval            int       `json:"poll_interval"`
	ExpiresAt               time.Time `json:"expires_at"`
}

type DeviceAuthorizationTokenResponse struct {
	Status string `json:"status"`
	User   struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Name   string `json:"name"`
	} `json:"user"`
	DaemonDeviceID      string    `json:"daemon_device_id"`
	RemoteAccessEnabled bool      `json:"remote_access_enabled"`
	DeviceAccessToken   string    `json:"device_access_token"`
	DeviceRefreshToken  string    `json:"device_refresh_token"`
	ExpiresAt           time.Time `json:"expires_at"`
	// Populated when status == "awaiting_daemon_confirm".
	Claim            *DeviceAuthorizationClaim `json:"claim,omitempty"`
	ClaimRequestedAt *time.Time                `json:"claim_requested_at,omitempty"`
}

type DeviceAuthorizationClaim struct {
	UserEmail         string `json:"user_email"`
	UserName          string `json:"user_name"`
	BrowserDeviceName string `json:"browser_device_name"`
	UserAgent         string `json:"user_agent"`
	ClientIP          string `json:"client_ip"`
	BindBrowser       bool   `json:"bind_browser"`
}

type DeviceAuthorizationConfirmResponse struct {
	Status         string `json:"status"`
	DaemonDeviceID string `json:"daemon_device_id"`
}

type RemoteAccessResponse struct {
	DaemonDeviceID      string    `json:"daemon_device_id"`
	RemoteAccessEnabled bool      `json:"remote_access_enabled"`
	Status              string    `json:"status"`
	LastSeenAt          time.Time `json:"last_seen_at"`
}

type SetupGrantResponse struct {
	SetupGrant string    `json:"setup_grant"`
	PollSecret string    `json:"poll_secret"`
	SetupURL   string    `json:"setup_url"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type SetupResultResponse struct {
	Status string `json:"status"`
	User   struct {
		UserID string `json:"user_id"`
		Email  string `json:"email"`
		Name   string `json:"name"`
	} `json:"user"`
	DaemonDeviceID      string    `json:"daemon_device_id"`
	RemoteAccessEnabled bool      `json:"remote_access_enabled"`
	DeviceAccessToken   string    `json:"device_access_token"`
	DeviceRefreshToken  string    `json:"device_refresh_token"`
	ExpiresAt           time.Time `json:"expires_at"`
}

// nexusClientTimeout caps one HTTP attempt. Bumped from 10s to 30s because
// production Nexus /api/daemon/sync and /api/device-challenge/verify can spike
// past 10s under load. The retry wrapper below covers transient failures
// within this ceiling so a single slow attempt doesn't drop the sync.
const nexusClientTimeout = 30 * time.Second

// nexusMaxAttempts is the total attempts (including the initial one).
// Backoff schedule between attempts: 500ms, 1s, 2s — plus ±25% jitter
// so multiple daemons coming off the same outage don't thunder.
const nexusMaxAttempts = 3

func NewClient(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: nexusClientTimeout},
	}
}

func (c *Client) DaemonLogin(id device.Identity, loginCode, appVersion string) (DaemonLoginResponse, error) {
	body := map[string]any{
		"login_code":       loginCode,
		"daemon_device_id": id.DeviceID,
		"daemon_pubkey":    id.PublicKey,
		"device_name":      id.DeviceName,
		"hostname":         id.Hostname,
		"os":               id.OS,
		"app_version":      appVersion,
	}
	if err := addComputerIdentity(body, id); err != nil {
		return DaemonLoginResponse{}, err
	}
	var out DaemonLoginResponse
	if err := c.doJSON(http.MethodPost, "/api/daemon/login", body, &out); err != nil {
		return DaemonLoginResponse{}, err
	}
	return out, nil
}

func (c *Client) CreateDeviceAuthorization(id device.Identity, appVersion string) (DeviceAuthorizationResponse, error) {
	body := map[string]any{
		"daemon_device_id": id.DeviceID,
		"daemon_pubkey":    id.PublicKey,
		"device_name":      id.DeviceName,
		"hostname":         id.Hostname,
		"os":               id.OS,
		"app_version":      appVersion,
	}
	if err := addComputerIdentity(body, id); err != nil {
		return DeviceAuthorizationResponse{}, err
	}
	var out DeviceAuthorizationResponse
	if err := c.doJSON(http.MethodPost, "/api/daemon/device-authorizations", body, &out); err != nil {
		return DeviceAuthorizationResponse{}, err
	}
	return out, nil
}

func (c *Client) DeviceAuthorizationToken(deviceCode, pollSecret string) (DeviceAuthorizationTokenResponse, error) {
	var out DeviceAuthorizationTokenResponse
	route := "/api/daemon/device-authorizations/" + url.PathEscape(deviceCode) + "/token?poll_secret=" + url.QueryEscape(pollSecret)
	if err := c.doJSON(http.MethodGet, route, nil, &out); err != nil {
		return DeviceAuthorizationTokenResponse{}, err
	}
	return out, nil
}

// ConfirmDeviceAuthorization is called by the daemon after the local user
// approves or denies a pending pair claim displayed in the CLI. Nexus
// only completes registration and issues tokens after allow=true.
func (c *Client) ConfirmDeviceAuthorization(deviceCode, pollSecret string, allow bool) (DeviceAuthorizationConfirmResponse, error) {
	var out DeviceAuthorizationConfirmResponse
	route := "/api/daemon/device-authorizations/" + url.PathEscape(deviceCode) + "/confirm"
	if err := c.doJSON(http.MethodPost, route, map[string]any{
		"poll_secret": pollSecret,
		"allow":       allow,
	}, &out); err != nil {
		return DeviceAuthorizationConfirmResponse{}, err
	}
	return out, nil
}

func (c *Client) SetRemoteAccess(id device.Identity, enabled bool) (RemoteAccessResponse, error) {
	token, err := c.AuthenticateIdentity(id, audienceDaemonWS)
	if err != nil {
		return RemoteAccessResponse{}, err
	}
	var out RemoteAccessResponse
	if err := c.doJSON(http.MethodPost, "/api/daemon/remote-access", map[string]any{
		"enabled": enabled,
	}, &out, withBearer(token)); err != nil {
		return RemoteAccessResponse{}, err
	}
	return out, nil
}

func (c *Client) CreateSetupGrant(id device.Identity, appVersion string) (SetupGrantResponse, error) {
	body := map[string]any{
		"daemon_device_id": id.DeviceID,
		"daemon_pubkey":    id.PublicKey,
		"device_name":      id.DeviceName,
		"hostname":         id.Hostname,
		"os":               id.OS,
		"app_version":      appVersion,
	}
	if err := addComputerIdentity(body, id); err != nil {
		return SetupGrantResponse{}, err
	}
	var out SetupGrantResponse
	if err := c.doJSON(http.MethodPost, "/api/daemon/setup-grants", body, &out); err != nil {
		return SetupGrantResponse{}, err
	}
	return out, nil
}

func (c *Client) SetupResult(setupGrant, pollSecret string) (SetupResultResponse, error) {
	var out SetupResultResponse
	route := "/api/daemon/setup-grants/" + url.PathEscape(setupGrant) + "/result?poll_secret=" + url.QueryEscape(pollSecret)
	if err := c.doJSON(http.MethodGet, route, nil, &out); err != nil {
		return SetupResultResponse{}, err
	}
	return out, nil
}

func (c *Client) CreatePairingGrant(id device.Identity) (CreateGrantResponse, error) {
	body := map[string]any{
		"daemon_device_id": id.DeviceID,
		"daemon_pubkey":    id.PublicKey,
		"relay_url":        c.BaseURL,
		"device_name":      id.DeviceName,
		"hostname":         id.Hostname,
		"os":               id.OS,
	}
	if err := addComputerIdentity(body, id); err != nil {
		return CreateGrantResponse{}, err
	}
	var out CreateGrantResponse
	if err := c.doJSON(http.MethodPost, "/api/pairing-grants", body, &out); err != nil {
		return CreateGrantResponse{}, err
	}
	return out, nil
}

func (c *Client) PendingRequests(id device.Identity) (PendingRequestsResponse, error) {
	token, err := c.AuthenticateIdentity(id, audienceDaemonPairing)
	if err != nil {
		return PendingRequestsResponse{}, err
	}
	var out PendingRequestsResponse
	if err := c.doJSON(http.MethodGet, "/api/daemon/pairing-requests", nil, &out, withBearer(token)); err != nil {
		return PendingRequestsResponse{}, err
	}
	return out, nil
}

func (c *Client) ConfirmPairing(id device.Identity, grantID string, allow bool) (ConfirmResponse, error) {
	token, err := c.AuthenticateIdentity(id, audienceDaemonPairing)
	if err != nil {
		return ConfirmResponse{}, err
	}
	var out ConfirmResponse
	if err := c.doJSON(http.MethodPost, "/api/pairing-grants/"+grantID, map[string]any{
		"allow": allow,
	}, &out, withBearer(token)); err != nil {
		return ConfirmResponse{}, err
	}
	return out, nil
}

func (c *Client) SyncHistory(id device.Identity, req SyncRequest) (SyncResponse, error) {
	return c.SyncHistoryContext(context.Background(), id, req)
}

func (c *Client) CreateMobileJoinGrant(id device.Identity) (MobileJoinGrantResponse, error) {
	token, err := c.AuthenticateIdentity(id, audienceDaemonWS)
	if err != nil {
		return MobileJoinGrantResponse{}, err
	}
	var out MobileJoinGrantResponse
	if err := c.doJSON(http.MethodPost, "/api/daemon/mobile-join-grant", nil, &out, withBearer(token)); err != nil {
		return MobileJoinGrantResponse{}, err
	}
	return out, nil
}

func (c *Client) SyncHistoryContext(ctx context.Context, id device.Identity, req SyncRequest) (SyncResponse, error) {
	token, err := c.AuthenticateIdentityContext(ctx, id, audienceDaemonWS)
	if err != nil {
		return SyncResponse{}, err
	}
	var out SyncResponse
	err = c.doJSONContext(ctx, http.MethodPost, "/api/daemon/sync", req, &out, withBearer(token))
	if isAuthFailure(err) {
		invalidateDeviceToken(id.DeviceID, audienceDaemonWS)
		if token, err = c.AuthenticateIdentityContext(ctx, id, audienceDaemonWS); err != nil {
			return SyncResponse{}, err
		}
		out = SyncResponse{}
		err = c.doJSONContext(ctx, http.MethodPost, "/api/daemon/sync", req, &out, withBearer(token))
	}
	if err != nil {
		return SyncResponse{}, err
	}
	return out, nil
}

func (c *Client) AuthenticateIdentity(id device.Identity, audience string) (string, error) {
	return c.AuthenticateIdentityContext(context.Background(), id, audience)
}

func (c *Client) AuthenticateIdentityContext(ctx context.Context, id device.Identity, audience string) (string, error) {
	if token, ok := cachedDeviceTokenFor(id.DeviceID, audience); ok {
		return token, nil
	}
	priv, err := id.PrivateKeyBytes()
	if err != nil {
		return "", err
	}
	var challenge ChallengeResponse
	if err := c.doJSONContext(ctx, http.MethodPost, "/api/device-challenge", map[string]any{
		"device_id": id.DeviceID,
		"audience":  audience,
	}, &challenge); err != nil {
		return "", err
	}
	message := challengeMessage(challenge)
	signature := ed25519.Sign(priv, message)
	var verified VerifyChallengeResponse
	if err := c.doJSONContext(ctx, http.MethodPost, "/api/device-challenge/verify", map[string]any{
		"device_id":    id.DeviceID,
		"audience":     audience,
		"challenge_id": challenge.ChallengeID,
		"signature":    base64.RawURLEncoding.EncodeToString(signature),
	}, &verified); err != nil {
		return "", err
	}
	if !verified.Verified || verified.DeviceAccessToken == "" {
		return "", fmt.Errorf("Nexus challenge verification did not return a device access token")
	}
	storeDeviceToken(id.DeviceID, audience, verified.DeviceAccessToken)
	return verified.DeviceAccessToken, nil
}

func addComputerIdentity(body map[string]any, id device.Identity) error {
	if id.ComputerID == "" || id.ComputerPublicKey == "" {
		return nil
	}
	signature, err := id.SignComputerBinding()
	if err != nil {
		return fmt.Errorf("sign stable computer identity: %w", err)
	}
	if signature == "" {
		return fmt.Errorf("sign stable computer identity: empty signature")
	}
	body["computer_id"] = id.ComputerID
	body["computer_public_key"] = id.ComputerPublicKey
	body["computer_signature"] = signature
	return nil
}

func (c *Client) doJSON(method, route string, body any, out any, opts ...requestOption) error {
	return c.doJSONContext(context.Background(), method, route, body, out, opts...)
}

func (c *Client) doJSONContext(ctx context.Context, method, route string, body any, out any, opts ...requestOption) error {
	var rawBody []byte
	if body != nil {
		var err error
		rawBody, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	var lastErr error
	for attempt := 1; attempt <= nexusMaxAttempts; attempt++ {
		if attempt > 1 {
			// 500ms, 1s, 2s with ±25% jitter. Cap at ctx deadline.
			base := time.Duration(1<<uint(attempt-2)) * 500 * time.Millisecond
			jitter := time.Duration(rand.Int63n(int64(base)/2)) - base/4
			select {
			case <-time.After(base + jitter):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		err := c.doJSONAttempt(ctx, method, route, rawBody, body != nil, out, opts...)
		if err == nil {
			return nil
		}
		lastErr = err
		// 4xx and any other non-transient response: don't retry.
		// Mutations like /api/device-challenge/verify are one-shot
		// (challenge_id is consumed) so retrying past a real failure
		// just trades one error for another.
		if !isRetryableNexusErr(err) {
			return err
		}
	}
	return fmt.Errorf("Nexus %s %s: %d attempts exhausted: %w", method, route, nexusMaxAttempts, lastErr)
}

func (c *Client) doJSONAttempt(ctx context.Context, method, route string, rawBody []byte, hasBody bool, out any, opts ...requestOption) error {
	var reqBody *bytes.Reader
	if rawBody == nil {
		reqBody = bytes.NewReader(nil)
	} else {
		reqBody = bytes.NewReader(rawBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+route, reqBody)
	if err != nil {
		return err
	}
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, opt := range opts {
		opt(req)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err == nil {
			if message, ok := payload["error"].(string); ok && message != "" {
				return fmt.Errorf("Nexus %s %s: status=%d error=%s", method, route, resp.StatusCode, message)
			}
		}
		body := strings.TrimSpace(string(raw))
		if body == "" {
			body = resp.Status
		}
		return fmt.Errorf("Nexus %s %s: status=%d body=%q", method, route, resp.StatusCode, body)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// isRetryableNexusErr returns true when err looks transient — DNS hiccup,
// connection reset, server-side 5xx, HTTP/2 mid-stream EOF, request body
// timed out before Nexus returned headers. These all matched real production
// Nexus failures in the wild: lots of "context deadline exceeded while
// awaiting headers" and "unexpected EOF" against /api/daemon/sync +
// /api/device-challenge.
func isRetryableNexusErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return true
		}
	}
	// HTTP 5xx surfaced through the Nexus-error path in doJSONAttempt.
	msg := err.Error()
	if strings.Contains(msg, "status=502") ||
		strings.Contains(msg, "status=503") ||
		strings.Contains(msg, "status=504") {
		return true
	}
	// Bare "EOF" / "unexpected EOF" / "connection reset" / DNS error
	// strings that aren't wrapped as net.Error in older Go versions.
	return strings.Contains(msg, "EOF") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "i/o timeout")
}

type requestOption func(*http.Request)

func withBearer(token string) requestOption {
	return func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer "+token)
	}
}

func challengeMessage(challenge ChallengeResponse) []byte {
	return []byte(challenge.ChallengeID + ":" + challenge.DeviceID + ":" + challenge.Audience + ":" + challenge.Nonce)
}

const audienceDaemonPairing = "daemon-pairing"
const audienceDaemonWS = "daemon-ws"
