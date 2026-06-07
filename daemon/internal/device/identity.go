// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package device

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/zalando/go-keyring"
)

const keyringService = "pockly-daemon"

// allowPlaintextKey returns true when the caller has explicitly accepted
// storing the device private key alongside device.json (instead of in the
// OS keyring). Required for headless Linux environments where Secret
// Service / dbus is unavailable — namely containers, CI runners,
// SSH-only servers. The Dockerfile bakes this env var into the
// pockly-tester image. NOT set in normal Mac installs, so production
// users keep the keyring-backed path with no behavior change.
func allowPlaintextKey() bool {
	return os.Getenv("POCKLY_ALLOW_PLAINTEXT_KEY") == "1"
}

type Identity struct {
	DeviceID   string `json:"device_id"`
	DeviceName string `json:"device_name"`
	Hostname   string `json:"hostname,omitempty"`
	OS         string `json:"os,omitempty"`

	PublicKey          string `json:"public_key"`
	PrivateKey         string `json:"private_key,omitempty"`
	ComputerID         string `json:"computer_id,omitempty"`
	ComputerPublicKey  string `json:"computer_public_key,omitempty"`
	ComputerPrivateKey string `json:"computer_private_key,omitempty"`
}

type StableComputerIdentity struct {
	ComputerID         string `json:"computer_id"`
	ComputerPublicKey  string `json:"computer_public_key"`
	ComputerPrivateKey string `json:"computer_private_key,omitempty"`
	HostnameFirstSeen  string `json:"hostname_first_seen,omitempty"`
	OS                 string `json:"os,omitempty"`
	OSUserScope        string `json:"os_user_scope,omitempty"`
	IdentityVersion    int    `json:"identity_version"`
	CreatedAt          string `json:"created_at"`
}

func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(dir, "pockly-daemon", "device.json"), nil
}

func ComputerDefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(dir, "pockly-daemon", "computer.json"), nil
}

func Load(path string) (Identity, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Identity{}, err
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return Identity{}, fmt.Errorf("decode identity: %w", err)
	}
	id.PrivateKey = ""
	id.ComputerPrivateKey = ""
	return id, nil
}

func LoadOrCreate(path string, deviceName string) (Identity, error) {
	computer, err := LoadOrCreateComputer(filepath.Join(filepath.Dir(path), "computer.json"))
	if err != nil {
		return Identity{}, err
	}
	if raw, err := os.ReadFile(path); err == nil {
		var id Identity
		if err := json.Unmarshal(raw, &id); err != nil {
			return Identity{}, fmt.Errorf("decode identity: %w", err)
		}
		if id.DeviceName == "" && deviceName != "" {
			id.DeviceName = deviceName
		}
		if id.PrivateKey != "" {
			if err := keyring.Set(keyringService, keyringUsername(id.DeviceID), id.PrivateKey); err != nil {
				if !allowPlaintextKey() {
					return Identity{}, fmt.Errorf("migrate identity private key to secure storage: %w", err)
				}
				// Headless fallback: keep PrivateKey inline in device.json.
				// PrivateKeyBytes() reads i.PrivateKey before falling back to
				// the keyring, so this path keeps working across restarts.
				log.Printf("warning: keyring unavailable, keeping plaintext private key in %s (POCKLY_ALLOW_PLAINTEXT_KEY=1)", path)
				if id.ComputerID == "" || id.ComputerPublicKey == "" {
					id.ComputerID = computer.ComputerID
					id.ComputerPublicKey = computer.ComputerPublicKey
					if err := persistIdentity(path, id); err != nil {
						return Identity{}, err
					}
				}
				return id, nil
			}
			id.PrivateKey = ""
		}
		if id.ComputerID == "" || id.ComputerPublicKey == "" {
			id.ComputerID = computer.ComputerID
			id.ComputerPublicKey = computer.ComputerPublicKey
		}
		if allowPlaintextKey() && id.ComputerPrivateKey == "" {
			id.ComputerPrivateKey = computer.ComputerPrivateKey
		}
		if err := persistIdentity(path, id); err != nil {
			return Identity{}, err
		}
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Identity{}, fmt.Errorf("read identity: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, fmt.Errorf("generate ed25519 keypair: %w", err)
	}
	hostname := resolveHostname()
	id := Identity{
		DeviceID:           "dd_" + randToken(18),
		DeviceName:         fallback(deviceName, hostname, "Pockly Daemon"),
		Hostname:           hostname,
		OS:                 runtime.GOOS,
		PublicKey:          base64.RawURLEncoding.EncodeToString(pub),
		ComputerID:         computer.ComputerID,
		ComputerPublicKey:  computer.ComputerPublicKey,
		ComputerPrivateKey: computer.ComputerPrivateKey,
	}
	privateKey := base64.RawURLEncoding.EncodeToString(priv)
	if err := keyring.Set(keyringService, keyringUsername(id.DeviceID), privateKey); err != nil {
		if !allowPlaintextKey() {
			return Identity{}, fmt.Errorf("store identity private key in secure storage: %w", err)
		}
		// Headless fallback: store the key in device.json. The file is
		// already mode 0o600 via persistIdentity. Logged loudly so this
		// never silently degrades in environments where a keyring IS
		// available but momentarily broken.
		log.Printf("warning: keyring unavailable, storing plaintext private key in %s (POCKLY_ALLOW_PLAINTEXT_KEY=1)", path)
		id.PrivateKey = privateKey
	}
	if err := persistIdentity(path, id); err != nil {
		return Identity{}, err
	}
	return id, nil
}

func (i Identity) PrivateKeyBytes() (ed25519.PrivateKey, error) {
	encoded := i.PrivateKey
	if encoded == "" {
		var err error
		encoded, err = keyring.Get(keyringService, keyringUsername(i.DeviceID))
		if err != nil {
			return nil, fmt.Errorf("load identity private key from secure storage: %w", err)
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	return ed25519.PrivateKey(raw), nil
}

func LoadOrCreateComputer(path string) (StableComputerIdentity, error) {
	if raw, err := os.ReadFile(path); err == nil {
		var id StableComputerIdentity
		if err := json.Unmarshal(raw, &id); err != nil {
			return StableComputerIdentity{}, fmt.Errorf("decode computer identity: %w", err)
		}
		if id.ComputerID == "" || id.ComputerPublicKey == "" {
			return StableComputerIdentity{}, errors.New("computer identity is missing computer_id or computer_public_key")
		}
		if id.ComputerPrivateKey != "" {
			if err := keyring.Set(keyringService, computerKeyringUsername(id.ComputerID), id.ComputerPrivateKey); err != nil {
				if !allowPlaintextKey() {
					return StableComputerIdentity{}, fmt.Errorf("migrate computer private key to secure storage: %w", err)
				}
				log.Printf("warning: keyring unavailable, keeping plaintext computer private key in %s (POCKLY_ALLOW_PLAINTEXT_KEY=1)", path)
				return id, nil
			}
			id.ComputerPrivateKey = ""
			if err := persistComputerIdentity(path, id); err != nil {
				return StableComputerIdentity{}, err
			}
		}
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return StableComputerIdentity{}, fmt.Errorf("read computer identity: %w", err)
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return StableComputerIdentity{}, fmt.Errorf("generate computer ed25519 keypair: %w", err)
	}
	hostname := resolveHostname()
	id := StableComputerIdentity{
		ComputerID:        "dc_" + randToken(18),
		ComputerPublicKey: base64.RawURLEncoding.EncodeToString(pub),
		HostnameFirstSeen: hostname,
		OS:                runtime.GOOS,
		OSUserScope:       "user",
		IdentityVersion:   2,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}
	privateKey := base64.RawURLEncoding.EncodeToString(priv)
	if err := keyring.Set(keyringService, computerKeyringUsername(id.ComputerID), privateKey); err != nil {
		if !allowPlaintextKey() {
			return StableComputerIdentity{}, fmt.Errorf("store computer private key in secure storage: %w", err)
		}
		log.Printf("warning: keyring unavailable, storing plaintext computer private key in %s (POCKLY_ALLOW_PLAINTEXT_KEY=1)", path)
		id.ComputerPrivateKey = privateKey
	}
	if err := persistComputerIdentity(path, id); err != nil {
		return StableComputerIdentity{}, err
	}
	return id, nil
}

func (i Identity) ComputerPrivateKeyBytes() (ed25519.PrivateKey, error) {
	if i.ComputerID == "" {
		return nil, errors.New("computer_id is empty")
	}
	encoded := i.ComputerPrivateKey
	var err error
	if encoded == "" {
		encoded, err = keyring.Get(keyringService, computerKeyringUsername(i.ComputerID))
	}
	if err != nil {
		if allowPlaintextKey() {
			if path, pathErr := ComputerDefaultPath(); pathErr == nil {
				if raw, readErr := os.ReadFile(path); readErr == nil {
					var stored StableComputerIdentity
					if json.Unmarshal(raw, &stored) == nil && stored.ComputerID == i.ComputerID && stored.ComputerPrivateKey != "" {
						encoded = stored.ComputerPrivateKey
						err = nil
					}
				}
			}
		}
		if err != nil {
			return nil, fmt.Errorf("load computer private key from secure storage: %w", err)
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	return ed25519.PrivateKey(raw), nil
}

func (i Identity) SignComputerBinding() (string, error) {
	priv, err := i.ComputerPrivateKeyBytes()
	if err != nil {
		return "", err
	}
	message := []byte(ComputerBindingMessage(i.ComputerID, i.ComputerPublicKey, i.DeviceID, i.PublicKey))
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, message)), nil
}

func ComputerBindingMessage(computerID, computerPublicKey, daemonDeviceID, daemonPublicKey string) string {
	return computerID + ":" + computerPublicKey + ":" + daemonDeviceID + ":" + daemonPublicKey
}

func persistIdentity(path string, id Identity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir identity dir: %w", err)
	}
	// Default policy: NEVER write the private key to disk. Keyring holds
	// it. The opt-in plaintext-key mode (POCKLY_ALLOW_PLAINTEXT_KEY=1) is
	// for headless environments where the keyring is unavailable; in that
	// case we DO need to persist the key so daemon restarts don't lose it.
	// Without this conditional, our fallback would silently wipe the key
	// on every save and the next daemon restart would have no way to
	// recover it.
	if !allowPlaintextKey() {
		id.PrivateKey = ""
		id.ComputerPrivateKey = ""
	}
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return fmt.Errorf("encode identity: %w", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write identity: %w", err)
	}
	return nil
}

func persistComputerIdentity(path string, id StableComputerIdentity) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir computer identity dir: %w", err)
	}
	if !allowPlaintextKey() {
		id.ComputerPrivateKey = ""
	}
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return fmt.Errorf("encode computer identity: %w", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write computer identity: %w", err)
	}
	return nil
}

func keyringUsername(deviceID string) string {
	return "device:" + deviceID
}

func computerKeyringUsername(computerID string) string {
	return "computer:" + computerID
}

func randToken(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func fallback(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// resolveHostname returns a best-effort human-readable hostname for the
// computer running this daemon. os.Hostname() works fine on macOS and
// Linux but can return an empty string on Windows in restricted
// environments (firewall, WMI unavailable, service-account contexts).
// When that happens, COMPUTERNAME — exported by every Windows install
// since NT — provides a stable human-readable fallback.
//
// Without this, the web app's device dropdown displays the raw
// device_id (e.g. "01ZnxSj01468764") instead of a real machine name,
// because both Identity.Hostname and StableComputerIdentity
// .HostnameFirstSeen propagated empty strings through to Nexus'
// `hostname` column and there's no upstream fallback.
func resolveHostname() string {
	h, err := os.Hostname()
	return resolveHostnameFrom(h, err, os.Getenv, runtime.GOOS)
}

// resolveHostnameFrom is the testable seam for resolveHostname — the
// args mirror the side-effecting dependencies so unit tests can drive
// every branch deterministically without spoofing the real OS state.
func resolveHostnameFrom(baseHost string, baseErr error, getenv func(string) string, goos string) string {
	if baseErr == nil && baseHost != "" {
		return baseHost
	}
	if goos == "windows" && getenv != nil {
		if v := getenv("COMPUTERNAME"); v != "" {
			return v
		}
	}
	return ""
}
